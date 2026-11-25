/**
 * `compactNow` 桥：把原生压缩能力安全地接到两个入口上。
 *
 * === 服务到底在哪（实测调用链） ===
 *
 * 原生 `/compact` 由 `@deepseek-ai/dsh-command-compact` 提供，它与
 * `@deepseek-ai/dsh-compaction-basic` 一起被**挂在 agent preset 树里**
 * （`bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` 全部有这两行），
 * 而宿主平面上的同名行被 `bundle/web-app/cordis.patch.yml:575-582` 显式禁用。
 *
 * preset 树挂在 **`isolate` 隔离域**里：`agent-preset-registry/src/mount.ts`
 * 的 `leakedServices()` 注释写得很清楚 —— "a provider inside an `isolate` realm
 * stores under a realm-private symbol and is correctly absent here"。
 * 也就是说隔离域内注册的服务**故意**用私有 symbol 存放，
 * `ctx.get('compaction')` 与 `agent.ctx.get('compaction')` 都跨不过这道边界。
 *
 * 唯一官方通路是 `agentPresets.serviceFor(agent, name)`
 * （`agent-preset-registry/src/index.ts:335-343`：*"Read a service supplied inside
 * an Agent's isolated preset group"*），它绕开普通服务继承、直接在 root service store
 * 里按 fiber 归属查找，因此能读到隔离域内的实例。
 *
 * 解析顺序（先隔离域，后宿主平面）：
 *   1. `ctx.get('agentPresets').serviceFor(agent, 'compaction')` —— 原生压缩的真实位置；
 *   2. `agent.ctx.get('compaction')` —— 非隔离组合（preset 直接挂在 agent 作用域）；
 *   3. 插件侧 optional-inject 持有的宿主实现（服务热加时装上）；
 *   4. `ctx.get('compaction')` —— 宿主平面兜底。
 *
 * === 为什么不能直接 await（源码依据） ===
 *
 * `compaction-basic/src/region.ts:191-196`：
 * ```
 * if (options.owner === null) {
 *   if (entryState.openTurn !== null) {
 *     throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
 *   }
 * }
 * ```
 * 而 `openTurn` 由 `inspectCompactionEntryState()`（同文件 566-600）**反向扫描日志**得到：
 * 最近一条回合边界是 `turn/start` → 有开放回合；是 `turn/end` → 空闲。
 *
 * 工具 handler 必然运行在开放回合内，所以在工具里 await `compactNow` **一定** busy。
 *
 * === 安全时机 ===
 *
 * `agent-loop/src/agent.ts:428` 在 turn driver 的 `finally` 里追加 `turn/end`；
 * `agent.ts:157-169` 的 `setPhase()` 在 phase 变化后才 `emit('agent/status')`。
 * 因此收到 `agent/status(idle)` 时 `turn/end` 已落盘。
 *
 * === 为什么还要重试 ===
 *
 * `agent.ts:158` 把 `maintenance` 也算作 `idle`，而活跃压缩期间会被
 * `assertCompactionInactive()`（`region.ts:185-189`）再次拒绝为 busy。
 * 所以 idle 只是"必要条件"，必须对 `busy` 做有界重试。
 *
 * @module dsh-flow/compact-bridge
 */
/** 重试间隔（毫秒）；长度即最大重试次数。 */
const RETRY_DELAYS = Object.freeze([250, 750, 1500])

/** 错误码 → 用户可读文案。码集来自 `ManualCompactionErrorCode`（封闭集合）。 */
export const COMPACT_MESSAGES = Object.freeze({
  busy: '当前回合或后台压缩还没结束，稍后再试。',
  cancelled: '压缩已取消。',
  changed: '准备压缩的历史在替换前发生了变化，这次尝试已记入会话日志。',
  summary: '没能生成有用的摘要，这次尝试已记入会话日志。',
  commit: '压缩没能干净收尾，部分历史可能已变化；建议先检查会话状态再重试。',
  persistence: '压缩完成，但会话没能保存。',
  unavailable: '当前会话的 preset 与宿主平面都没有 compaction 实现，无法执行压缩。',
  unknown: '压缩失败，原因见日志。',
})

/** 成功文案。 */
export const COMPACT_OK = '已压缩历史。'

/** 判定一个候选值是不是可用的压缩实现。 */
function isImplementation(value) {
  return value !== null && typeof value === 'object' && typeof value.compactNow === 'function'
}

/** 安全读一个可能抛错的访问器。 */
function safeGet(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * 创建压缩桥。
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getHostCompaction?: () => object | undefined,
 *   logger?: { info?: Function, warn?: Function },
 * }} deps
 *   `getHostCompaction` 由 `index.js` 通过 `ctx.inject(['compaction'], …)` 维护，
 *   服务热加时自动装上、fiber 卸载时清空；缺省时退回 `ctx.get('compaction')`。
 */
export function createCompactBridge({ ctx, getHostCompaction, logger }) {
  /** 等待空闲的 agent 集合。 */
  const waiting = new Set()
  /** 已排定的定时器，卸载时统一清掉。 */
  const timers = new Set()
  let disposed = false

  /**
   * 按 preset 隔离域 → agent 作用域 → 宿主注入 → 兜底直读 的顺序解析实现。
   *
   * @param {object | undefined} agent
   * @returns {object | undefined}
   */
  function resolve(agent) {
    // 1) preset 隔离域：原生 /compact 用的就是这份实例。
    //    跨作用域读取必须走 agentPresets.serviceFor()，普通 ctx.get 会因
    //    realm-private symbol 而永远拿到 undefined。
    const presets = safeGet(() => ctx.get('agentPresets'))
    if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function') {
      const fromPreset = safeGet(() => presets.serviceFor(agent, 'compaction'))
      if (isImplementation(fromPreset)) return fromPreset
    }
    // 2) agent 自己的作用域：非隔离组合（preset 直接挂在 agent ctx 上）。
    const local = safeGet(() => agent?.ctx?.get?.('compaction'))
    if (isImplementation(local)) return local
    // 3) 插件侧 optional-inject 捕获的宿主实现。
    const injected = typeof getHostCompaction === 'function' ? safeGet(getHostCompaction) : undefined
    if (isImplementation(injected)) return injected
    // 4) 兜底：直读当前 ctx（服务可能在插件加载后才注册）。
    const direct = safeGet(() => ctx.get('compaction'))
    if (isImplementation(direct)) return direct
    return undefined
  }

  /** 诊断用：当前 agent 绑定的 preset id（读不到就 undefined）。 */
  function presetIdOf(agent) {
    const presets = safeGet(() => ctx.get('agentPresets'))
    if (presets === undefined || presets === null || typeof presets.composedPreset !== 'function') return undefined
    return safeGet(() => presets.composedPreset(agent?.ctx))
  }

  /**
   * 直接尝试一次压缩，永不抛错。
   *
   * @param {object} agent
   * @param {AbortSignal} signal
   * @returns {Promise<{ ok: boolean, code: string, text: string, result?: object | null }>}
   */
  async function runNow(agent, signal) {
    const compaction = resolve(agent)
    if (compaction === undefined) {
      const presetId = presetIdOf(agent)
      logger?.warn?.(`flow: 未找到 compaction 实现（preset=${presetId ?? '未绑定'}；preset 隔离域与宿主平面均未提供）`)
      return { ok: false, code: 'unavailable', text: COMPACT_MESSAGES.unavailable }
    }
    try {
      const result = await compaction.compactNow(agent, signal)
      if (result === null || result === undefined) {
        return { ok: true, code: 'empty', text: '没有可压缩的历史。', result: null }
      }
      return { ok: true, code: 'compacted', text: COMPACT_OK, result }
    } catch (error) {
      if (signal?.aborted === true) {
        return { ok: false, code: 'cancelled', text: COMPACT_MESSAGES.cancelled }
      }
      const name = error !== null && typeof error === 'object' ? error.name : ''
      const rawCode = error !== null && typeof error === 'object' ? error.code : ''
      const code = typeof rawCode === 'string' ? rawCode : ''
      if (name === 'ManualCompactionError' && Object.prototype.hasOwnProperty.call(COMPACT_MESSAGES, code)) {
        return { ok: false, code, text: COMPACT_MESSAGES[code] }
      }
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown', text: `${COMPACT_MESSAGES.unknown}（${detail}）` }
    }
  }

  /** 排定一个定时器并登记，卸载时能取消。 */
  function later(delayMs, run) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (disposed) return
      run()
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
    timers.add(timer)
  }

  /**
   * 带重试的延迟压缩：只在 `busy` 时重试，其他错误一次即止。
   * @param {object} agent
   * @param {number} index 当前是第几次尝试（0 为首次）。
   */
  function attempt(agent, index) {
    if (disposed) return
    const controller = new AbortController()
    void runNow(agent, controller.signal).then((outcome) => {
      if (disposed) return
      if (outcome.ok) {
        logger?.info?.(`flow: 阶段切换后自动压缩完成（${outcome.code}）`)
        return
      }
      if (outcome.code === 'busy' && index < RETRY_DELAYS.length) {
        later(RETRY_DELAYS[index], () => { attempt(agent, index + 1) })
        return
      }
      if (outcome.code !== 'unavailable') {
        logger?.warn?.(`flow: 阶段切换后自动压缩未完成 — ${outcome.text}`)
      }
    })
  }

  /**
   * 登记"回合结束空闲后压缩一次"。
   *
   * @param {object} agent
   * @returns {boolean} 本次是否新登记（已登记过返回 false）。
   */
  function schedule(agent) {
    if (disposed) return false
    if (agent === null || typeof agent !== 'object') return false
    if (waiting.has(agent)) return false
    waiting.add(agent)
    return true
  }

  /** 是否已登记但尚未执行。 */
  function isScheduled(agent) {
    return waiting.has(agent)
  }

  /**
   * `agent/status` 监听器：只在"该 agent 已登记 + 状态为 idle"时触发。
   *
   * 用微任务让出一拍再调 `compactNow`：避免在 emit 调用栈里同步进入压缩事务，
   * 也避开"状态刚翻转、`turn/end` 刚追加"这一瞬间的重入。
   *
   * @param {{ agent?: object, status?: string }} payload
   */
  function onStatus(payload) {
    if (disposed) return
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    if (payload?.status !== 'idle') return
    if (!waiting.has(agent)) return
    waiting.delete(agent)
    void Promise.resolve().then(() => { attempt(agent, 0) })
  }

  /** 探测当前是否能看到实现（供 `/flow compact` 的诊断文案使用）。 */
  function available(agent) {
    return resolve(agent) !== undefined
  }

  /** 卸载：取消定时器并清空登记。 */
  function dispose() {
    disposed = true
    waiting.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  return { schedule, isScheduled, runNow, onStatus, available, dispose }
}
