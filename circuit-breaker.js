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
 *
 * === 状态按会话聚合，而不是按 Agent 对象 ===
 *
 * 同一个会话在重连、重绑 preset、或经过不同阶段时，可能拿到**不同的 Agent 实例**。
 * 如果状态挂在 Agent 对象上（WeakMap），两个实例就会各自记一份计数，
 * 于是同一场会话会连续触发两次熔断告警 —— 这正是线上复现到的现象。
 * 因此这里统一用 `keyOf(agent)`：优先 `session.id`，取不到才退化成 Agent 实例键。
 *
 * === 跨会话遥控（微信回 1/2/3） ===
 *
 * dsh-im 的入站接管能力只对飞书/Lark 开放（`PROACTIVE_DELIVERY.md:425`），
 * 微信拿不到原始入站文本。但任何 Agent 的 pre-step 都会经过本模块，
 * 所以用"熔断登记表"把 IM 会话里敲的 `1/2/3` 转给桌面会话。
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
 * 剥掉 dsh-im 注入的来源包裹，只留用户实际说的话。
 *
 * IM 入站消息形如：
 *   `<dsh_im_source>{"channel":"weixin","targetId":"…"}</dsh_im_source>1`
 * 若不剥离，`1` 永远匹配不上指令正则，会被当成普通消息放进 IM 会话。
 *
 * @param {string} text 原始文本。
 * @returns {string} 剥离后的文本（可能为空串）。
 */
function stripImSource(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text
    // 完整包裹：连同内容一起去掉
    .replace(/<dsh_im_source>[\s\S]*?<\/dsh_im_source>/gi, ' ')
    // 残缺包裹（未闭合）：从标签起到结尾全部丢掉
    .replace(/<dsh_im_source>[\s\S]*$/i, ' ')
    .trim()
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
 *   im?: { send?: Function },
 * }} deps
 */
export function createCircuitBreaker({ ctx, getConfig, notifier, logger, readMode, im, diagSink }) {
  /**
   * 会话键 → 状态。键 = `session:<id>`，取不到会话 id 时退化为 `agent:<n>`。
   * @type {Map<string, object>}
   */
  const states = new Map()
  /** 会话键 → 待显示的告警文本 */
  const alerts = new Map()
  /** 没有会话 id 时给 Agent 实例分配的稳定键 */
  const agentKeys = new WeakMap()
  let fallbackSeq = 0

  /**
   * 熔断登记表：会话键 → { agent, project, at, streak }。
   * 存 agent 是为了遥控时能真正作用到那个会话上（用最近一次触发时的实例）。
   * @type {Map<string, { agent: object, project: string, at: number, streak: number }>}
   */
  const tripped = new Map()

  /** 正在等待 settle 的会话键，避免重复排队 */
  const settling = new Set()
  /** 等待期间到达的后续动作，settle 后按序执行 */
  const pending = new Map()
  let disposed = false

  /**
   * 诊断日志：统一 `[flow:diag]` 前缀，方便从宿主日志里按前缀过滤。
   * 由 index.js 注入 sink（同时写宿主日志与自管文件）；未注入时退回 logger.info。
   * 日志失败绝不影响熔断主流程。
   */
  const diag = typeof diagSink === 'function'
    ? diagSink
    : (message) => {
      try {
        logger?.info?.(`[flow:diag] ${message}`)
      } catch { /* 忽略日志通道异常 */ }
    }

  /** 会话 id（缺失时给可读占位）。 */
  function sessionIdOf(agent) {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : '(无 sessionId)'
  }

  /** Agent 实例标识。 */
  function agentLabelOf(agent) {
    return String(agent?.id ?? '(无 id)')
  }

  /** 熔断登记表的可读快照。 */
  function trippedSnapshot() {
    if (tripped.size === 0) return '[]'
    return `[${[...tripped.entries()].map(([key, meta]) => `${key}/${meta.project}`).join(', ')}]`
  }

  /** 会话键：优先 sessionId，保证同一会话的不同 Agent 实例共享同一份状态。 */
  function keyOf(agent) {
    const id = agent?.session?.id
    if (typeof id === 'string' && id !== '') return `session:${id}`
    const existing = agentKeys.get(agent)
    if (existing !== undefined) return existing
    fallbackSeq += 1
    const key = `agent:${fallbackSeq}`
    agentKeys.set(agent, key)
    return key
  }

  function stateOf(agent) {
    const key = keyOf(agent)
    let state = states.get(key)
    if (state === undefined) {
      state = {
        key,
        streak: 0,
        errors: [],
        locked: false,
        /** 本轮熔断周期是否已经触发过（并发闸门）。 */
        tripped: false,
        /** 触发时的失败次数，用于告警与邮件正文。 */
        trippedStreak: 0,
        lastUser: undefined,
        mode: 'off',
      }
      states.set(key, state)
    }
    return state
  }

  /** `/flow-notice` 命令读取的告警正文。 */
  function alertTextOf(agent) {
    return alerts.get(keyOf(agent)) ?? ''
  }

  function isLocked(agent) {
    return states.get(keyOf(agent))?.locked === true
  }

  /** 会话项目名（用于告警与遥控确认文案）。 */
  function projectOf(agent) {
    const cwd = String(agent?.session?.header?.cwd ?? '')
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : '未命名工作区'
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
    const key = keyOf(agent)
    if (settling.has(key)) {
      const queue = pending.get(key)
      if (queue === undefined) pending.set(key, [action])
      else if (!queue.includes(action)) queue.push(action)
      return
    }
    settling.add(key)

    /**
     * 单次调度只允许执行一轮。
     *
     * settle 成功与 8 秒兜底定时器可能都走到这里（实测日志里间隔正好 8s 又跑了一遍
     * `notice` + `notify`），因此必须有一次性标记；重复进入直接跳过并留痕。
     */
    let done = false

    const run = () => {
      if (done) {
        diag(`afterSettle run=skip key=${key} 已执行过，忽略本次调度`)
        return
      }
      done = true
      setTimeout(() => {
        if (disposed) return
        const queued = pending.get(key) ?? []
        pending.delete(key)
        // 批处理结束才释放占位，避免间隙里又开启一条新调度。
        settling.delete(key)
        const batch = [action, ...queued]
        const seen = new Set()
        diag(`afterSettle run key=${key} batch=${batch.length}`)
        void (async () => {
          for (const item of batch) {
            if (disposed) return
            // 同一动作被排队两次时只执行一次。
            if (seen.has(item)) {
              diag(`afterSettle skip key=${key} 重复动作`)
              continue
            }
            seen.add(item)
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

  /** 多个会话同时熔断时，列出可用短码（项目名前缀）。 */
  function codeHintOf() {
    if (tripped.size <= 1) return ''
    const codes = [...tripped.values()].map(meta => meta.project).filter(Boolean)
    return codes.length === 0 ? '' : `\n- 当前有 ${codes.length} 个会话在熔断，请用 \`1#项目名\` 指定目标，例如 \`1#${codes[0]}\``
  }

  /** 组装告警 Markdown。 */
  function buildAlert(agent, state) {
    const config = getConfig()
    const modeId = readMode(agent.session)
    state.mode = modeId
    const label = modeId === 'off' ? '普通模式' : modeConfigOf(config, modeId).label
    const project = projectOf(agent)
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
      '- 回复 `3`：解除暂停，发新指令 格式 `3 + 指令` 如：`3 不要读取文件了 把成果用邮箱发送给我`',
      '- 直接发普通纠错文字：自动解除熔断并正常放行',
      `- 也可以在手机 IM（微信/飞书）里回复同样的 \`1\` / \`2\` / \`3\` 遥控本会话${codeHintOf()}`,
    ].join('\n')
  }

  /** 进入锁定态并急刹。同一会话单次周期内严格只执行一次。 */
  function lock(agent) {
    const state = stateOf(agent)
    if (state.locked || state.tripped) {
      diag(`lock skip key=${state.key} 已在熔断态（locked=${state.locked} tripped=${state.tripped}）`)
      return
    }
    if (getConfig()?.circuit?.enabled === false) {
      diag(`lock skip key=${state.key} 熔断已关闭`)
      return
    }
    diag(`lock enter key=${state.key} project=${projectOf(agent)} streak=${state.streak} trippedSize=${tripped.size}`)
    // 同步置位：这里是并发安全的关键，先占位再做事。
    // 状态本身按 sessionId 聚合，因此同一会话的任何 Agent 实例都会看到 tripped。
    state.tripped = true
    state.locked = true
    state.lastUser = lastUserMessageOf(agent.session)
    // 先登记再生成文案：多会话短码提示需要把自己也算进 tripped 里。
    tripped.set(state.key, {
      key: state.key,
      agent,
      project: projectOf(agent),
      at: Date.now(),
      streak: state.streak,
    })
    const text = buildAlert(agent, state)
    alerts.set(state.key, text)
    // 告警文案已按当前计数生成，之后再清空计数，残余回调不会再次命中阈值。
    state.trippedStreak = state.streak
    state.streak = 0
    const registered = tripped.get(state.key)
    if (registered !== undefined) registered.streak = state.trippedStreak

    try {
      agent.cancel({ kind: 'hook', reason: 'dsh-flow 连续工具失败熔断' }, { keepInbox: true })
      diag(`lock cancel=yes key=${state.key}`)
    } catch (error) {
      diag(`lock cancel=fail key=${state.key} ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`flow: 熔断急刹失败 → ${error instanceof Error ? error.message : String(error)}`)
    }

    afterSettle(agent, async () => {
      // 若期间同一会话换了 Agent 实例并已经解锁，这里就不再补发。
      if (states.get(state.key)?.tripped !== true) {
        diag(`lock notice=skip key=${state.key} 已被解锁`)
        return
      }
      // 0-Token 可见告警：走原生命令通道渲染一条命令行
      try {
        const signal = new AbortController().signal
        await ctx.commands.execute(agent, '/flow-notice', [], signal)
        diag(`lock notice=yes key=${state.key}`)
      } catch (error) {
        diag(`lock notice=fail key=${state.key} ${error instanceof Error ? error.message : String(error)}`)
        logger?.warn?.(`flow: 熔断告警渲染失败 → ${error instanceof Error ? error.message : String(error)}`)
      }
      notifier.schedule('brake', {
        title: 'Flow 熔断告警',
        project: projectOf(agent),
        markdown: text,
        agent,
        session: agent.session,
        errorContext: recentContext(state),
      })
      diag(`lock notify=brake key=${state.key} project=${projectOf(agent)}`)
    })
  }

  /** 报错上下文全文（作为邮件附件）。 */
  function recentContext(state) {
    return [
      `连续失败：${state.trippedStreak || state.streak} 次`,
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
      diag(`observe agent=${agentLabelOf(agent)} session=${sessionIdOf(agent)} tool=${exec?.name ?? 'tool'} isError=false streak=${state.streak} → 清零`)
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
    diag(`observe agent=${agentLabelOf(agent)} session=${sessionIdOf(agent)} tool=${name} isError=true streak=${state.streak}/${threshold} locked=${state.locked} tripped=${state.tripped}`)
    if (state.streak >= threshold) lock(agent)
  }

  /** 解锁（不切模型、不发消息），并清掉本轮熔断周期标记。 */
  function unlock(agent) {
    const state = stateOf(agent)
    state.locked = false
    state.tripped = false
    state.trippedStreak = 0
    state.streak = 0
    state.errors = []
    tripped.delete(state.key)
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

  /** 唯一处于熔断态的登记项；有多个时返回 undefined，交由短码消歧。 */
  function loneTripped() {
    if (tripped.size !== 1) return undefined
    return [...tripped.values()][0]
  }

  /** 按项目名前缀在多个熔断会话里定位一个。 */
  function trippedByCode(code) {
    const wanted = String(code ?? '').trim().toLowerCase()
    if (wanted === '') return undefined
    for (const meta of tripped.values()) {
      if (String(meta.project ?? '').toLowerCase().startsWith(wanted)) return meta
    }
    return undefined
  }

  /**
   * 单次远程接管（handoff）。
   *
   * 场景：人在手机上回 `3` 解除桌面会话的熔断，但此时不在电脑前；
   * 紧接着发的下一条新指令若没有绑定，就会落进 IM 自己的会话，桌面收不到。
   * 所以 `3` 之后登记一条**一次性**映射：IM 会话键 → 目标桌面会话，
   * 下一条非指令消息转交给桌面执行后立即失效，不长期劫持 IM 会话。
   *
   * @type {Map<string, { targetAgent: object, project: string, expiresAt: number }>}
   */
  const handoffs = new Map()

  /** 接管有效期：5 分钟。 */
  const HANDOFF_TTL_MS = 5 * 60_000

  /** 登记一次远程接管。 */
  function setHandoff(imKey, targetAgent, project) {
    handoffs.set(imKey, {
      targetAgent,
      project,
      expiresAt: Date.now() + HANDOFF_TTL_MS,
    })
    diag(`handoff set im=${imKey} → target=${project} ttl=5min`)
  }

  /** 取出并立即失效（单次）。过期条目只清理不返回。 */
  function takeHandoff(imKey) {
    const entry = handoffs.get(imKey)
    if (entry === undefined) return undefined
    handoffs.delete(imKey)
    if (Date.now() > entry.expiresAt) {
      diag(`handoff expired im=${imKey} project=${entry.project}`)
      return undefined
    }
    if (entry.targetAgent === undefined || entry.targetAgent === null) {
      diag(`handoff invalid im=${imKey} 目标实例已失效`)
      return undefined
    }
    diag(`handoff take im=${imKey} → target=${entry.project}`)
    return entry
  }

  /**
   * 把一条新指令投递给目标会话。
   *
   * `followup` 只接受完整的 `UserMessage`（含 `id` / `content` / `source`），
   * 所以这里以入站的那条真实消息为模板，只替换正文并换一个新的 id，
   * 既满足类型要求，也避免与 IM 会话里的消息 id 冲突。
   *
   * @param {{ targetAgent?: object, project?: string }} meta 接管目标。
   * @param {string} text 剥离来源包裹后的指令正文。
   * @param {object|undefined} template 入站的真实 UserMessage。
   * @returns {boolean} 是否投递成功。
   */
  function forwardTo(meta, text, template) {
    // 熔断登记项用 `agent`，接管映射用 `targetAgent`，这里统一取。
    const target = meta?.targetAgent ?? meta?.agent
    const label = meta?.project ?? '桌面会话'
    if (target === undefined || target === null) {
      diag('forward abort 目标会话实例失效')
      return false
    }
    if (template === undefined || template === null || typeof template !== 'object') {
      diag('forward abort 缺少可作为模板的入站消息')
      return false
    }
    try {
      const id = typeof globalThis.crypto?.randomUUID === 'function'
        ? `fwd-${globalThis.crypto.randomUUID()}`
        : `fwd-${Date.now().toString(36)}`
      target.followup({
        ...template,
        id,
        role: 'user',
        content: [{ type: 'text', text }],
      })
      diag(`forward yes → ${label} len=${text.length}`)
      return true
    } catch (error) {
      diag(`forward fail → ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`flow: 指令转交失败 → ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 给手机回一条确认（走 IM 渠道，失败只留痕）。 */
  async function replyTo(markdown) {
    try {
      const sent = await im?.send?.({ title: 'Flow 指令确认', markdown })
      diag(`reply im=${sent?.ok === true ? `ok(${sent.via ?? 'unknown'})` : `fail(${sent?.reason ?? 'no-result'})`}`)
    } catch (error) {
      diag(`reply im=throw ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`flow: 遥控确认回执发送失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 由其它会话（通常是 IM 会话）转来的 `1`/`2`/`3`。
   *
   * dsh-im 的入站接管能力只对飞书/Lark 开放，微信拿不到原始入站文本；
   * 但任何会话的 pre-step 都会走到本模块，所以用"唯一熔断会话"来对齐指令，
   * 再把动作作用到桌面会话上，并回一条确认给对方手机。
   *
   * @param {{ agent: object, project: string }} meta 熔断登记项。
   * @param {'1'|'2'|'3'} token 指令。
   */
  async function applyRemote(meta, token) {
    const target = meta?.agent
    const label = meta?.project ?? '桌面会话'
    diag(`applyRemote enter key=${meta?.key ?? '(未知)'} project=${label} token=${token}`)
    if (target === undefined || target === null) {
      diag('applyRemote abort 目标会话实例已失效')
      logger?.warn?.('flow: 遥控目标会话实例已失效，忽略本次指令')
      return
    }

    const action = token === '1' ? 'retry' : token === '2' ? 'escalate' : 'resume'
    if (token === '1') retry(target)
    else if (token === '2') await escalate(target, undefined)
    else resume(target)
    diag(`applyRemote action=${action} unlocked=${!isLocked(target)} lastUser=${stateOf(target).lastUser === undefined ? 'none' : 'yes'}`)

    const verb = token === '1'
      ? '已清零报错并继续执行'
      : token === '2' ? '已切到救场强模型重新诊断' : '已解除熔断暂停'
    logger?.info?.(`flow: IM 遥控指令 ${token} 已下发到会话「${label}」`)

    try {
      const sent = await im?.send?.({
        title: 'Flow 指令确认',
        markdown: `已收到指令 \`${token}\`，桌面会话「${label}」${verb}。`,
      })
      diag(`applyRemote im=${sent?.ok === true ? `ok(${sent.via ?? 'unknown'})` : `fail(${sent?.reason ?? 'no-result'})`}`)
    } catch (error) {
      diag(`applyRemote im=throw ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`flow: 遥控确认回执发送失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * `agent/pre-step` 拦截。
   *
   * 注册在每个 Agent 自己的 ctx 上（见 index.js 的 attach），
   * 因此 IM 绑定会话也一定经过这里。
   *
   * @param {object} payload
   * @param {() => Promise<object>} next
   * @returns {Promise<object>}
   */
  async function preStep(payload, next) {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return next()

    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const raw = messages.map(textOfMessage).join('\n').trim()
    // IM 会话里必须先把 <dsh_im_source> 包裹剥掉，否则微信回的裸 `1` 匹配不上。
    const stripped = stripImSource(raw)
    const text = stripped.toLowerCase()
    const token = text.replace(/\s+/g, ' ')

    const state = states.get(keyOf(agent))
    const locked = state?.locked === true
    diag(`preStep session=${sessionIdOf(agent)} agent=${agentLabelOf(agent)} token="${token.slice(0, 40)}" rawLen=${raw.length} locked=${locked} tripped=${trippedSnapshot()}`)

    // 指令解析：`1|2|3`，可选 `#项目名`，可选尾随正文（`3 新指令` 一步到位）。
    const cmd = /^([123])(?:\s*#\s*([^\s]+))?\s*([\s\S]*)$/.exec(stripped)
    const code = cmd?.[2]?.trim() ?? ''
    const rest = cmd?.[3]?.trim() ?? ''
    const imKey = state?.key ?? keyOf(agent)

    if (!locked) {
      if (cmd !== null) {
        const command = cmd[1]
        const meta = code !== '' ? trippedByCode(code) : loneTripped()
        const how = code !== '' ? `code:${code}` : 'lone'
        if (meta === undefined) {
          diag(`preStep match=none(${how}) → 放行（未命中熔断会话）`)
        } else if (meta.agent === agent) {
          diag(`preStep match=self(${how}) → 放行（命中自己但未锁定）`)
        } else if (command === '3') {
          // 解除暂停 + 交接：带正文就当场转交，否则登记 5 分钟单次接管。
          resume(meta.agent)
          const label = meta.project ?? '桌面会话'
          if (rest !== '') {
            const forwarded = forwardTo(meta, rest, messages[0])
            void replyTo(`已收到指令 \`3\`，桌面会话「${label}」已解除熔断。${forwarded ? '新指令已转交执行。' : '但新指令转交失败，请回电脑端确认。'}`)
          } else {
            setHandoff(imKey, meta.agent, label)
            void replyTo(`已收到指令 \`3\`，桌面会话「${label}」已解除熔断。请直接在此回复你的新指令（5 分钟内有效），我将自动转交给该桌面会话执行。`)
          }
          diag(`preStep 3 handoff key=${imKey} target=${label} inline=${rest !== ''} → reject`)
          return { kind: 'reject' }
        } else {
          diag(`preStep match=${how} target=${meta.project ?? 'single'} → reject`)
          void applyRemote(meta, command)
          return { kind: 'reject' }
        }
      } else {
        // 没有指令：看这条 IM 会话是否处在单次接管窗口内。
        const handoff = takeHandoff(imKey)
        if (handoff !== undefined && stripped !== '') {
          const forwarded = forwardTo(handoff, stripped, messages[0])
          void replyTo(`已将新指令转交桌面会话「${handoff.project}」执行${forwarded ? '。' : '，但转交失败，请回电脑端确认。'}`)
          diag(`preStep handoff forward key=${imKey} ok=${forwarded} → reject`)
          return { kind: 'reject' }
        }
        diag('preStep token 非 1/2/3 且无接管 → 放行')
      }
      return next()
    }

    if (token === '1' || token === '/flow retry') {
      diag('preStep 命中本会话 1 → retry + reject')
      retry(agent)
      return { kind: 'reject' }
    }
    if (token === '2' || token === '/flow escalate') {
      diag('preStep 命中本会话 2 → escalate + reject')
      void escalate(agent, payload.signal)
      return { kind: 'reject' }
    }
    if (token === '3' || token === '/flow resume') {
      diag('preStep 命中本会话 3 → resume + reject')
      resume(agent)
      return { kind: 'reject' }
    }

    // 普通纠错文本：解除锁定并正常放行
    diag('preStep 普通纠错文本 → unlock + 放行')
    logger?.info?.('flow: 收到普通纠错文本，已解除熔断锁定并放行')
    unlock(agent)
    return next()
  }

  function dispose() {
    disposed = true
  }

  return { observe, preStep, retry, escalate, resume, unlock, isLocked, alertTextOf, dispose }
}
