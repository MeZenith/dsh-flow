/**
 * `compactNow` 桥：跨 preset 隔离域解析原生压缩能力，在回合空闲后带重试触发。
 *
 * @module dsh-flow/modes/compact-bridge
 */
const RETRY_DELAYS = Object.freeze([250, 750, 1500])

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

export const COMPACT_OK = '已压缩历史。'

function isImplementation(value) {
  return value !== null && typeof value === 'object' && typeof value.compactNow === 'function'
}

function safeGet(read) {
  try { return read() } catch { return undefined }
}

const EXTERNAL_COMPACTOR_NAME_RE = /\b(?:bili-native|billion-context|bili-compaction-gate)\b/i

function commandListHas(cmds, target) {
  try {
    if (typeof cmds?.get === 'function') {
      return cmds.get(target) !== undefined && cmds.get(target) !== null
    }
    if (typeof cmds?.list === 'function') {
      const items = cmds.list()
      if (items && typeof items[Symbol.iterator] === 'function') {
        for (const item of items) {
          const name = typeof item === 'string' ? item : item?.name
          if (name === target) return true
        }
      }
    }
  } catch { /* best-effort: 宿主命令注册表查询异常时忽略 */ }
  return false
}

/**
 * 探测宿主是否已挂载外部增量上下文压缩插件（例如 `billion-context`）。
 * 全部服务读取经由 `safeGet`，兼容严格 Cordis Proxy。
 */
export function detectExternalCompactor(ctx) {
  const envProxy = typeof process?.env?.BILLION_CONTEXT_PROXY === 'string'
    ? process.env.BILLION_CONTEXT_PROXY.trim()
    : ''
  const envAttach = typeof process?.env?.BILLION_CONTEXT_ATTACH === 'string'
    ? process.env.BILLION_CONTEXT_ATTACH.trim()
    : ''
  if (envProxy !== '' || envAttach !== '') {
    return { detected: true, name: 'billion-context' }
  }

  const loader = safeGet(() => ctx?.get?.('loader'))
  const entries = safeGet(() => loader?.entries?.())
  if (entries && typeof entries[Symbol.iterator] === 'function') {
    for (const entry of entries) {
      if (!entry || entry.disabled === true || entry.active === false) continue
      const candidate = String(entry?.options?.name ?? entry?.name ?? entry?.plugin?.name ?? '')
      if (EXTERNAL_COMPACTOR_NAME_RE.test(candidate)) {
        return { detected: true, name: 'billion-context' }
      }
    }
  }

  const cmds = safeGet(() => ctx?.get?.('commands')) ?? safeGet(() => ctx?.commands)
  if (cmds && commandListHas(cmds, 'acp') && commandListHas(cmds, 'acp-cache')) {
    return { detected: true, name: 'billion-context' }
  }

  return { detected: false, name: '' }
}

export function createCompactBridge({ ctx, getHostCompaction, isLocked, logger }) {
  const waiting = new Set()
  const timers = new Set()
  /** 在途压缩 AbortController -> agent（P1-9 修复：会话销毁或插件卸载时主动 abort 回收）。 */
  const activeControllers = new Map()
  const forgotten = new WeakSet()
  let disposed = false
  let externalYieldLogged = false

  function noteExternalYield(name) {
    if (externalYieldLogged) return
    externalYieldLogged = true
    logger?.info?.(`flow: 检测到外部上下文压缩插件 ${name}，阶段门禁自动压缩已自动让权`)
  }

  function resolve(agent) {
    const presets = safeGet(() => ctx.get('agentPresets'))
    if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function') {
      const fromPreset = safeGet(() => presets.serviceFor(agent, 'compaction'))
      if (isImplementation(fromPreset)) return fromPreset
    }
    const local = safeGet(() => agent?.ctx?.get?.('compaction'))
    if (isImplementation(local)) return local
    const injected = typeof getHostCompaction === 'function' ? safeGet(getHostCompaction) : undefined
    if (isImplementation(injected)) return injected
    const direct = safeGet(() => ctx.get('compaction'))
    if (isImplementation(direct)) return direct
    return undefined
  }

  function presetIdOf(agent) {
    const presets = safeGet(() => ctx.get('agentPresets'))
    if (presets === undefined || presets === null || typeof presets.composedPreset !== 'function') return undefined
    return safeGet(() => presets.composedPreset(agent?.ctx))
  }

  async function runNow(agent, signal, options = {}) {
    if (options?.auto === true) {
      const ext = detectExternalCompactor(ctx)
      if (ext.detected) {
        noteExternalYield(ext.name)
        return { ok: true, code: 'delegated', provider: ext.name, text: `已由 ${ext.name} 接管上下文压缩。` }
      }
    }
    const compaction = resolve(agent)
    if (compaction === undefined) {
      const presetId = presetIdOf(agent)
      logger?.warn?.(`flow: 未找到 compaction 实现（preset=${presetId ?? '未绑定'}）`)
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

  function later(delayMs, run) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (disposed) return
      run()
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
    timers.add(timer)
  }

  function attempt(agent, index) {
    if (disposed || forgotten.has(agent)) return
    if (typeof isLocked === 'function' && isLocked(agent) === true) {
      waiting.add(agent)
      return
    }
    const controller = new AbortController()
    activeControllers.set(controller, agent)
    void runNow(agent, controller.signal, { auto: true }).then((outcome) => {
      activeControllers.delete(controller)
      if (disposed || forgotten.has(agent)) return
      if (outcome.ok) {
        logger?.info?.(`flow: 阶段切换后自动压缩完成（${outcome.code}）`)
        return
      }
      if (outcome.code === 'busy') {
        if (index < RETRY_DELAYS.length) {
          later(RETRY_DELAYS[index], () => { attempt(agent, index + 1) })
          return
        }
        // P1-7 修复：连续 busy 后重新挂回 waiting，等待下一次真正 idle 时完成压缩。
        waiting.add(agent)
        logger?.info?.('flow: 自动压缩因会话繁忙暂缓，已重新排队等待下次空闲')
        return
      }
      if (outcome.code !== 'unavailable') {
        logger?.warn?.(`flow: 阶段切换后自动压缩未完成 — ${outcome.text}`)
      }
    })
  }

  function schedule(agent) {
    if (disposed || agent === null || typeof agent !== 'object') return false
    const ext = detectExternalCompactor(ctx)
    if (ext.detected) {
      noteExternalYield(ext.name)
      return false
    }
    if (waiting.has(agent)) return false
    waiting.add(agent)
    return true
  }

  async function drainScheduled(agent) {
    if (disposed || agent === null || typeof agent !== 'object' || forgotten.has(agent) || !waiting.has(agent)) {
      return { ok: false, code: 'not-scheduled' }
    }
    if (typeof isLocked === 'function' && isLocked(agent) === true) {
      return { ok: false, code: 'locked' }
    }
    // 先同步移除 waiting，避免紧邻的 onStatus('idle') 微任务重复触发压缩
    waiting.delete(agent)
    const ext = detectExternalCompactor(ctx)
    if (ext.detected) {
      noteExternalYield(ext.name)
      return { ok: true, code: 'delegated', provider: ext.name }
    }
    const controller = new AbortController()
    activeControllers.set(controller, agent)
    let outcome
    try {
      outcome = await runNow(agent, controller.signal, { auto: true })
    } finally {
      activeControllers.delete(controller)
    }
    if (disposed || forgotten.has(agent)) {
      return { ok: false, code: 'cancelled' }
    }
    if (outcome.ok) {
      logger?.info?.(`flow: 阶段切换后自动压缩完成（${outcome.code}）`)
      return outcome
    }
    if (outcome.code === 'busy') {
      waiting.add(agent)
      later(RETRY_DELAYS[0], () => { attempt(agent, 1) })
    } else if (outcome.code !== 'unavailable') {
      logger?.warn?.(`flow: 阶段切换后自动压缩未完成 — ${outcome.text}`)
    }
    return outcome
  }

  function isScheduled(agent) {
    return waiting.has(agent)
  }

  function onStatus(payload) {
    if (disposed) return
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    if (payload?.status !== 'idle') return
    if (!waiting.has(agent)) return
    // P1-7 修复：会话处于熔断锁定时暂缓自动压缩，避免与 /flow-notice 争抢。
    if (typeof isLocked === 'function' && isLocked(agent) === true) return
    waiting.delete(agent)
    void Promise.resolve().then(() => { attempt(agent, 0) })
  }

  function available(agent) {
    return resolve(agent) !== undefined
  }

  /** P1-9 修复：会话销毁时释放对已死 Agent 的强引用并中止其在途压缩请求。 */
  function forget(agent) {
    if (agent === undefined || agent === null) return
    forgotten.add(agent)
    waiting.delete(agent)
    for (const [controller, owner] of activeControllers.entries()) {
      if (owner === agent) {
        try { controller.abort() } catch { /* dispose-path: 会话释放时中止在途压缩请求 */ }
        activeControllers.delete(controller)
      }
    }
  }

  function dispose() {
    disposed = true
    waiting.clear()
    for (const controller of activeControllers.keys()) {
      try { controller.abort() } catch { /* dispose-path: 插件卸载时中止在途压缩请求 */ }
    }
    activeControllers.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  return {
    schedule,
    isScheduled,
    drainScheduled,
    runNow,
    onStatus,
    available,
    externalCompactor: () => detectExternalCompactor(ctx),
    forget,
    dispose,
  }
}
