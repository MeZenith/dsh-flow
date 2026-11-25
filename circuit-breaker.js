/**
 * 连续报错熔断器。
 *
 * === 三个原生原语（都有源码依据） ===
 *
 * 1. **计数**：`'tools/post-execute'(exec, result, next)` waterfall
 *    （api-catalog:5580）能看到每次工具结果与 `exec.agent`；成功清零、失败累加。
 * 2. **急刹**：`agent.cancel(cause, { keepInbox: true })`
 *    （`core/agent/src/runtime-types.ts:213`，`CancelOptions` 在 :50）。
 *    cause 用 `{ kind:'hook', reason }` —— 语义就是"插件主动中止"，会落进 `turn/end.reason`。
 * 3. **0-Token 拦截**：`agent/pre-step` 是 waterfall（`runtime-types.ts:351`），
 *    返回 `{ kind:'reject' }` 即短接；`agent.ts:289-317` 先 `inbox.claim()` 再走 waterfall，
 *    所以被拒消息已被消费、不会重复提案，且**不发起模型请求**（0 token）。
 *    代价是每次拦截留下 `turn/start` + `turn/end{blocked}` 两条非 surface 事件
 *    （UI 不可见，已与用户确认接受）。
 *
 * === 时序（防撞车） ===
 *
 * 拦截 `1`/`2` 后不能在 `reject` 的同一个 tick 里就 `followup`：被拒回合正在收尾
 * （`turn/end{blocked}` 尚未落盘）。统一走 `afterSettle()`：优先用
 * `agent.settled()`（"当前整活动达到静默后 resolve"），拿不到就等一次
 * `agent/status === 'idle'`，再外加一拍 `setTimeout(0)`。
 *
 * @module dsh-flow/circuit-breaker
 */
import { resolveModelTarget } from './switch-mode.js'
import { modeConfigOf } from './modes.js'

/** 报错摘要保留条数。 */
const MAX_ERRORS = 5

/** 等待 agent 静默的兜底上限。 */
const SETTLE_TIMEOUT_MS = 8_000

/** 从消息里抽纯文本。 */
function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * 创建熔断器。
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getConfig: () => object,
 *   notifier: { schedule: Function },
 *   logger?: { warn?: Function, info?: Function },
 *   readMode: (session: object) => string,
 * }} deps
 */
export function createCircuitBreaker({ ctx, getConfig, notifier, logger, readMode }) {
  /** agent → 状态 */
  const states = new WeakMap()
  /** agent → 待显示的告警文本 */
  const alerts = new WeakMap()
  /** 正在等待 settle 的 agent，避免重复排队 */
  const settling = new WeakSet()
  /** 等待期间到达的后续动作，settle 后按序执行 */
  const pending = new WeakMap()
  let disposed = false

  function stateOf(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { streak: 0, errors: [], locked: false, lastUser: undefined, mode: 'off' }
      states.set(agent, state)
    }
    return state
  }

  /** `/flow-notice` 命令读取的告警正文。 */
  function alertTextOf(agent) {
    return alerts.get(agent) ?? ''
  }

  function isLocked(agent) {
    return states.get(agent)?.locked === true
  }

  /** 从会话日志里取最后一条用户消息（复用真实对象，避免手搓 UserMessage）。 */
  function lastUserMessageOf(session) {
    try {
      const seq = typeof session?.seq === 'number' ? session.seq : 0
      const floor = Math.max(0, seq - 2_000)
      for (let index = seq - 1; index >= floor; index -= 1) {
        const event = session.eventAt?.(index)
        if (event?.type === 'user/message' && event.data !== undefined) return event.data
      }
    } catch { /* 会话不可读，放弃 */ }
    return undefined
  }

  /**
   * 等项目/活动静默，再执行后续动作。
   *
   * 若已有一次等待在飞，后续动作**排队**而不是丢弃：
   * 熔断急刹与用户回复 `1`/`2` 可能落在同一段收尾窗口里，
   * 丢弃会让"重试"静默失效。
   */
  function afterSettle(agent, action) {
    if (settling.has(agent)) {
      const queue = pending.get(agent)
      if (queue === undefined) pending.set(agent, [action])
      else queue.push(action)
      return
    }
    settling.add(agent)

    const run = () => {
      settling.delete(agent)
      setTimeout(() => {
        if (disposed) return
        const batch = [action, ...(pending.get(agent) ?? [])]
        pending.delete(agent)
        void (async () => {
          for (const item of batch) {
            if (disposed) return
            try {
              await item()
            } catch (error) {
              logger?.warn?.(`flow: 熔断后续动作失败 → ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        })()
      }, 0)
    }

    const settled = typeof agent?.settled === 'function' ? agent.settled() : undefined
    if (settled !== undefined && typeof settled.then === 'function') {
      const timeout = new Promise(resolve => {
        const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
      })
      void Promise.race([settled, timeout]).then(run, run)
      return
    }

    // 退化路径：等一次 idle
    const off = ctx.on('agent/status', (payload) => {
      if (payload?.agent !== agent || payload?.status !== 'idle') return
      try { off() } catch { /* 已释放 */ }
      run()
    })
    const timer = setTimeout(() => {
      try { off() } catch { /* 已释放 */ }
      run()
    }, SETTLE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 组装告警 Markdown。 */
  function buildAlert(agent, state) {
    const config = getConfig()
    const modeId = readMode(agent.session)
    state.mode = modeId
    const label = modeId === 'off' ? '普通模式' : modeConfigOf(config, modeId).label
    const project = String(agent.session?.header?.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '未命名工作区'
    const recent = state.errors.slice(-MAX_ERRORS)

    return [
      '## Flow 熔断告警',
      '',
      `- 项目：${project}`,
      `- 模式：${label}`,
      `- 连续失败：${state.streak} 次（阈值 ${config?.circuit?.threshold ?? 3}）`,
      ...recent.map((line, index) => `- 报错 ${index + 1}：${line}`),
      '',
      '### 回复指令',
      '- 回复 `1`：清零计数，用当前模型继续执行',
      '- 回复 `2`：切到救场强模型，带报错摘要做一次诊断',
      '- 回复 `3`：解除暂停，等你自己发新指令',
      '- 直接发普通纠错文字：自动解除熔断并正常放行',
    ].join('\n')
  }

  /** 进入锁定态并急刹。 */
  function lock(agent) {
    const state = stateOf(agent)
    if (state.locked) return
    if (getConfig()?.circuit?.enabled === false) return
    state.locked = true
    state.lastUser = lastUserMessageOf(agent.session)
    const text = buildAlert(agent, state)
    alerts.set(agent, text)

    try {
      agent.cancel({ kind: 'hook', reason: 'dsh-flow 连续工具失败熔断' }, { keepInbox: true })
    } catch (error) {
      logger?.warn?.(`flow: 熔断急刹失败 → ${error instanceof Error ? error.message : String(error)}`)
    }

    afterSettle(agent, async () => {
      // 0-Token 可见告警：走原生命令通道渲染一条命令行
      try {
        const signal = new AbortController().signal
        await ctx.commands.execute(agent, '/flow-notice', [], signal)
      } catch (error) {
        logger?.warn?.(`flow: 熔断告警渲染失败 → ${error instanceof Error ? error.message : String(error)}`)
      }
      notifier.schedule('brake', {
        title: 'Flow 熔断告警',
        project: String(agent.session?.header?.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '未命名工作区',
        markdown: text,
        agent,
        session: agent.session,
        errorContext: recentContext(state),
      })
    })
  }

  /** 报错上下文全文（作为邮件附件）。 */
  function recentContext(state) {
    return [
      `连续失败：${state.streak} 次`,
      `时间：${new Date().toISOString()}`,
      '',
      ...state.errors.map((line, index) => `${index + 1}. ${line}`),
    ].join('\n')
  }

  /** 工具结果计数（由 index.js 在 `await next()` 之后调用）。 */
  function observe(exec, result) {
    if (disposed) return
    const agent = exec?.agent
    if (agent === undefined || agent === null) return
    const state = stateOf(agent)

    if (result?.isError !== true) {
      // 任意一次成功即清零
      if (state.streak !== 0 || state.errors.length !== 0) {
        state.streak = 0
        state.errors = []
      }
      return
    }

    const name = typeof exec?.name === 'string' ? exec.name : 'tool'
    const info = result?.error?.info ?? {}
    const reason = typeof info.reason === 'string' && info.reason !== ''
      ? info.reason
      : typeof result?.error?.message === 'string' ? result.error.message : '未提供原因'
    state.errors.push(`${name} → ${String(reason).slice(0, 240)}`)
    if (state.errors.length > MAX_ERRORS * 4) state.errors = state.errors.slice(-MAX_ERRORS * 4)
    state.streak += 1

    const threshold = Number(getConfig()?.circuit?.threshold) || 3
    if (state.streak >= threshold) lock(agent)
  }

  /** 解锁（不切模型、不发消息）。 */
  function unlock(agent) {
    const state = stateOf(agent)
    state.locked = false
    state.streak = 0
    state.errors = []
  }

  /** 把原始用户消息重新投递，触发一次新回合。 */
  function followup(agent, state, note) {
    const message = state.lastUser
    if (message === undefined) {
      logger?.warn?.('flow: 找不到可重投的用户消息，已解锁但未自动重试')
      return
    }
    try {
      agent.followup(message)
      logger?.info?.(`flow: 熔断解锁后重新投递（${note}）`)
    } catch (error) {
      logger?.warn?.(`flow: 重新投递失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 抢救：清零并重试。 */
  function retry(agent) {
    const state = stateOf(agent)
    unlock(agent)
    afterSettle(agent, () => followup(agent, state, 'retry'))
  }

  /** 抢救：切救场强模型后重试。 */
  async function escalate(agent, signal) {
    const state = stateOf(agent)
    const model = getConfig()?.circuit?.rescueModel
    unlock(agent)
    let switched = false
    if (typeof model === 'string' && model !== '') {
      const resolved = await resolveModelTarget(ctx, model, signal)
      if (resolved.ok) {
        try {
          agent.model.select({ provider: resolved.provider, model: resolved.model })
          switched = true
        } catch (error) {
          logger?.warn?.(`flow: 救场模型切换失败 → ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        logger?.warn?.(`flow: 救场模型不可用（${resolved.reason}）`)
      }
    }
    afterSettle(agent, () => followup(agent, state, switched ? 'escalate' : 'escalate(未切模型)'))
    return switched
  }

  /** 仅解锁。 */
  function resume(agent) {
    unlock(agent)
  }

  /**
   * `agent/pre-step` 拦截。
   *
   * @param {object} payload
   * @param {() => Promise<object>} next
   * @returns {Promise<object>}
   */
  async function preStep(payload, next) {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return next()
    const state = states.get(agent)
    if (state === undefined || !state.locked) return next()

    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const text = messages.map(textOfMessage).join('\n').trim().toLowerCase()
    const token = text.replace(/\s+/g, ' ')

    if (token === '1' || token === '/flow retry') {
      retry(agent)
      return { kind: 'reject' }
    }
    if (token === '2' || token === '/flow escalate') {
      void escalate(agent, payload.signal)
      return { kind: 'reject' }
    }
    if (token === '3' || token === '/flow resume') {
      resume(agent)
      return { kind: 'reject' }
    }

    // 普通纠错文本：解除锁定并正常放行
    logger?.info?.('flow: 收到普通纠错文本，已解除熔断锁定并放行')
    unlock(agent)
    return next()
  }

  function dispose() {
    disposed = true
  }

  return { observe, preStep, retry, escalate, resume, unlock, isLocked, alertTextOf, dispose }
}
