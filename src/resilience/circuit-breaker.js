/**
 * 连续报错熔断器。
 *
 * v0.6.0 修复：
 * - B-10a：严格词边界正则 `/^([123])(?:\s*#\s*([^\s]+))?(?:(?:\s+([\s\S]*))|$)$/`，
 *   绝不再误吞 `"100个文件"`、`"3个按钮"`、`"2. 方案修改"` 等正常语句；
 * - B-10b：桌面会话锁定时输入 `3 新指令` 自动剥离前缀 `3 ` 后投递，不再把字面 `"3 "` 喂给模型；
 * - B-10c：保存 `notifier.schedule('brake', ...)` 句柄并在 `unlock()` 时立即 `cancel()`，
 *   彻底消灭「用户已解锁后延迟弹出过期熔断提醒」的故障；同时通过 `onBrake` / `onUnlocked`
 *   即时同步到 RemoteHub（飞书熔断卡片立即推送，解锁后自动置灰）；
 * - M-12：补充 `forget(sessionId)` 并在 `dispose()` 时清理所有状态与待发通知。
 *
 * @module dsh-flow/resilience/circuit-breaker
 */
import { resolveModelTarget } from '../modes/switcher.js'
import { modeConfigOf } from '../modes/registry.js'
import { stripImSource, stripImTags, textOfMessage } from '../shared/message.js'

export { textOfMessage, stripImSource, stripImTags }

const MAX_ERRORS = 5
const SETTLE_TIMEOUT_MS = 8_000
const HANDOFF_TTL_MS = 5 * 60_000

/** 严格词边界熔断遥控正则：`1` / `1#proj` / `3 新指令` / `3 #proj 新指令`。 */
const CMD_RE = /^([123])(?:\s*#\s*([^\s]+))?(?:(?:\s+([\s\S]*))|$)$/

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
 *   onBrake?: (payload: object) => void,
 *   onUnlocked?: (payload: object) => void,
 *   diagSink?: (message: string) => void,
 * }} deps
 */
export function createCircuitBreaker({
  ctx, getConfig, notifier, logger, readMode, im, onBrake, onUnlocked, diagSink,
}) {
  const states = new Map()
  const alerts = new Map()
  const agentKeys = new WeakMap()
  let fallbackSeq = 0

  /** 会话键 → { key, sessionId, agent, project, at, streak, errors } */
  const tripped = new Map()
  const settling = new Set()
  const pending = new Map()
  const handoffs = new Map()
  const settleCleanups = new Set()
  let disposed = false

  const diag = typeof diagSink === 'function'
    ? diagSink
    : (message) => {
      try { logger?.info?.(`[flow:diag] ${message}`) } catch { /* best-effort: 宿主 logger 异常时不阻断熔断诊断 */ }
    }

  function sessionIdOf(agent) {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : '(无 sessionId)'
  }

  function agentLabelOf(agent) {
    return String(agent?.id ?? '(无 id)')
  }

  function trippedSnapshot() {
    if (tripped.size === 0) return '[]'
    return `[${[...tripped.entries()].map(([key, meta]) => `${key}/${meta.project}`).join(', ')}]`
  }

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
        tripped: false,
        trippedStreak: 0,
        lastUser: undefined,
        mode: 'off',
        notifyHandle: undefined,
      }
      states.set(key, state)
    }
    return state
  }

  function alertTextOf(agent) {
    return alerts.get(keyOf(agent)) ?? ''
  }

  function isLocked(agent) {
    return states.get(keyOf(agent))?.locked === true
  }

  function projectOf(agent) {
    const cwd = String(agent?.session?.header?.cwd ?? '')
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : '未命名工作区'
  }

  function lastUserMessageOf(session) {
    try {
      const seq = typeof session?.seq === 'number' ? session.seq : 0
      const floor = Math.max(0, seq - 2_000)
      for (let index = seq - 1; index >= floor; index -= 1) {
        const event = session.eventAt?.(index)
        if (event?.type === 'user/message' && event.data !== undefined) return event.data
      }
    } catch { /* 会话不可读 */ }
    return undefined
  }

  function afterSettle(agent, action) {
    const key = keyOf(agent)
    if (settling.has(key)) {
      const queue = pending.get(key)
      if (queue === undefined) pending.set(key, [action])
      else if (!queue.includes(action)) queue.push(action)
      return
    }
    settling.add(key)
    let done = false

    const run = () => {
      if (done) {
        diag(`afterSettle run=skip key=${key} 已执行过`)
        return
      }
      done = true
      const deferTimer = setTimeout(() => {
        settleCleanups.delete(cancelDefer)
        if (disposed) return
        const queued = pending.get(key) ?? []
        pending.delete(key)
        settling.delete(key)
        const batch = [action, ...queued]
        const seen = new Set()
        diag(`afterSettle run key=${key} batch=${batch.length}`)
        void (async () => {
          for (const item of batch) {
            if (disposed) return
            if (seen.has(item)) continue
            seen.add(item)
            try {
              await item()
            } catch (error) {
              logger?.warn?.(`flow: 熔断后续动作失败 → ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        })()
      }, 0)
      if (typeof deferTimer.unref === 'function') deferTimer.unref()
      const cancelDefer = () => { clearTimeout(deferTimer) }
      settleCleanups.add(cancelDefer)
    }

    // P1-4 修复：真实 DSH 宿主 Agent 空闲等待方法名为 `whenIdle()`（向后兼容旧桩 `settled()`）。
    const settled = typeof agent?.whenIdle === 'function'
      ? agent.whenIdle()
      : (typeof agent?.settled === 'function' ? agent.settled() : undefined)
    if (settled !== undefined && typeof settled.then === 'function') {
      let raceTimer
      const cancelRace = () => { if (raceTimer !== undefined) clearTimeout(raceTimer) }
      settleCleanups.add(cancelRace)
      const timeout = new Promise(resolve => {
        raceTimer = setTimeout(resolve, SETTLE_TIMEOUT_MS)
        if (typeof raceTimer.unref === 'function') raceTimer.unref()
      })
      void Promise.race([settled, timeout]).then(() => {
        cancelRace()
        settleCleanups.delete(cancelRace)
        run()
      }, () => {
        cancelRace()
        settleCleanups.delete(cancelRace)
        run()
      })
      return
    }

    let watchTimer
    const off = ctx.on('agent/status', (payload) => {
      if (payload?.agent !== agent || payload?.status !== 'idle') return
      cleanupWatcher()
      run()
    })
    const cleanupWatcher = () => {
      settleCleanups.delete(cleanupWatcher)
      if (watchTimer !== undefined) {
        clearTimeout(watchTimer)
        watchTimer = undefined
      }
      try { off?.() } catch { /* 已释放 */ }
    }
    watchTimer = setTimeout(() => {
      cleanupWatcher()
      run()
    }, SETTLE_TIMEOUT_MS)
    if (typeof watchTimer.unref === 'function') watchTimer.unref()
    settleCleanups.add(cleanupWatcher)
  }

  function codeHintOf() {
    if (tripped.size <= 1) return ''
    const codes = [...tripped.values()].map(meta => meta.project).filter(Boolean)
    return codes.length === 0 ? '' : `\n- 当前有 ${codes.length} 个会话在熔断，请用 \`1#项目名\` 指定目标，例如 \`1#${codes[0]}\``
  }

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
      '- 回复 `3`：解除暂停，发新指令 格式 `3 + 指令` 如：`3 不要读取文件了 把成果发给我`',
      '- 直接发普通纠错文字：自动解除熔断并正常放行',
      `- 也可以在飞书卡片点选或在手机 IM 里回复 \`1\` / \`2\` / \`3\` 遥控本会话${codeHintOf()}`,
    ].join('\n')
  }

  function recentContext(state) {
    return [
      `连续失败：${state.trippedStreak || state.streak} 次`,
      `时间：${new Date().toISOString()}`,
      '',
      ...state.errors.map((line, index) => `${index + 1}. ${line}`),
    ].join('\n')
  }

  function lock(agent) {
    const state = stateOf(agent)
    if (state.locked || state.tripped) {
      diag(`lock skip key=${state.key} 已在熔断态`)
      return
    }
    if (getConfig()?.circuit?.enabled === false) {
      diag(`lock skip key=${state.key} 熔断已关闭`)
      return
    }
    const project = projectOf(agent)
    const sessionId = String(agent?.session?.id ?? '')
    diag(`lock enter key=${state.key} project=${project} streak=${state.streak} trippedSize=${tripped.size}`)

    state.tripped = true
    state.locked = true
    state.lastUser = lastUserMessageOf(agent.session)
    const errorsSnapshot = state.errors.slice(-MAX_ERRORS)
    const streakSnapshot = state.streak

    tripped.set(state.key, {
      key: state.key,
      sessionId,
      agent,
      project,
      at: Date.now(),
      streak: streakSnapshot,
      errors: errorsSnapshot,
    })
    const text = buildAlert(agent, state)
    alerts.set(state.key, text)
    state.trippedStreak = streakSnapshot
    state.streak = 0

    try {
      agent.cancel({ kind: 'hook', reason: 'dsh-flow 连续工具失败熔断' }, { keepInbox: true })
      diag(`lock cancel=yes key=${state.key}`)
    } catch (error) {
      diag(`lock cancel=fail key=${state.key} ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`flow: 熔断急刹失败 → ${error instanceof Error ? error.message : String(error)}`)
    }

    // 远程中枢（飞书卡片等）即时获知熔断，不等 120s 空闲窗口。
    try {
      onBrake?.({
        key: state.key,
        sessionId,
        project,
        cwd: String(agent?.session?.header?.cwd ?? ''),
        mode: state.mode,
        streak: streakSnapshot,
        threshold: Number(getConfig()?.circuit?.threshold) || 3,
        errors: errorsSnapshot,
        markdown: text,
      })
    } catch { /* 外部回调异常不影响主流程 */ }

    afterSettle(agent, async () => {
      if (states.get(state.key)?.tripped !== true) {
        diag(`lock notice=skip key=${state.key} 已被解锁`)
        return
      }
      try {
        const signal = new AbortController().signal
        await ctx.commands.execute(agent, '/flow-notice', [], signal)
        diag(`lock notice=yes key=${state.key}`)
      } catch (error) {
        diag(`lock notice=fail key=${state.key} ${error instanceof Error ? error.message : String(error)}`)
        logger?.warn?.(`flow: 熔断告警渲染失败 → ${error instanceof Error ? error.message : String(error)}`)
      }
      // P1-7 修复：`/flow-notice` 执行期间用户可能已秒解熔断，必须二次确认仍在熔断态才挂延迟告警。
      if (disposed || states.get(state.key)?.tripped !== true) {
        diag(`lock notify=skip key=${state.key} 已在 /flow-notice 期间解锁`)
        return
      }
      // B-10c 修复：保存通知句柄，解锁时立即取消，避免延迟弹出过期提醒。
      state.notifyHandle?.cancel?.()
      state.notifyHandle = notifier.schedule('brake', {
        title: 'Flow 熔断告警',
        project,
        markdown: text,
        agent,
        session: agent.session,
        errorContext: recentContext(state),
      })
      diag(`lock notify=brake key=${state.key} project=${project}`)
    })
  }

  function observe(exec, result) {
    if (disposed) return
    const agent = exec?.agent
    if (agent === undefined || agent === null) return
    const state = stateOf(agent)

    if (result?.isError !== true) {
      diag(`observe agent=${agentLabelOf(agent)} session=${sessionIdOf(agent)} tool=${exec?.name ?? 'tool'} isError=false streak=${state.streak} → 清零`)
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

  function unlock(agent, reason = 'manual') {
    const state = stateOf(agent)
    const wasTripped = state.tripped === true || state.locked === true
    state.locked = false
    state.tripped = false
    state.trippedStreak = 0
    state.streak = 0
    state.errors = []
    // B-10c：取消尚未发出的延迟熔断告警。
    try { state.notifyHandle?.cancel?.() } catch { /* dispose-path: 延迟告警句柄已触发或清理 */ }
    state.notifyHandle = undefined
    const meta = tripped.get(state.key)
    tripped.delete(state.key)
    if (wasTripped) {
      try {
        onUnlocked?.({
          key: state.key,
          sessionId: String(agent?.session?.id ?? meta?.sessionId ?? ''),
          project: meta?.project ?? projectOf(agent),
          reason,
        })
      } catch { /* best-effort: 外部解锁监听器异常不影响本地解锁状态 */ }
    }
  }

  function normalizeUserSource(source) {
    if (source !== null && typeof source === 'object' && typeof source.kind === 'string') {
      return { ...source }
    }
    return { kind: 'user' }
  }

  function followup(agent, state, note) {
    const message = state.lastUser
    if (message === undefined) {
      logger?.warn?.('flow: 找不到可重投的用户消息，已解锁但未自动重试')
      return
    }
    try {
      // P1-7 / P1-4 修复：重投用户消息时生成全新 id 并确保 source 为对象，防止会话日志出现重复 message id。
      const newId = typeof globalThis.crypto?.randomUUID === 'function'
        ? `retry-${globalThis.crypto.randomUUID()}`
        : `retry-${Date.now().toString(36)}`
      agent.followup({
        ...message,
        id: newId,
        role: message.role ?? 'user',
        source: normalizeUserSource(message.source),
      })
      logger?.info?.(`flow: 熔断解锁后重新投递（${note}）`)
    } catch (error) {
      logger?.warn?.(`flow: 重新投递失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function retry(agent) {
    const state = stateOf(agent)
    unlock(agent, 'retry')
    afterSettle(agent, () => followup(agent, state, 'retry'))
  }

  async function escalate(agent, signal) {
    const state = stateOf(agent)
    const model = getConfig()?.circuit?.rescueModel
    unlock(agent, 'escalate')
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

  function resume(agent) {
    unlock(agent, 'resume')
  }

  /** 按 sessionId 查找已熔断项（供 RemoteHub / 飞书卡片调用）。 */
  function trippedBySession(sessionId) {
    const key = `session:${String(sessionId ?? '')}`
    return tripped.get(key)
  }

  function loneTripped() {
    if (tripped.size !== 1) return undefined
    return [...tripped.values()][0]
  }

  function trippedByCode(code) {
    const wanted = String(code ?? '').trim().toLowerCase()
    if (wanted === '') return undefined
    for (const meta of tripped.values()) {
      if (String(meta.project ?? '').toLowerCase().startsWith(wanted)) return meta
    }
    return undefined
  }

  function setHandoff(imKey, targetAgent, project) {
    const now = Date.now()
    for (const [k, v] of handoffs.entries()) {
      if (now > v.expiresAt) handoffs.delete(k)
    }
    handoffs.delete(imKey)
    handoffs.set(imKey, {
      targetAgent,
      project,
      expiresAt: now + HANDOFF_TTL_MS,
    })
    while (handoffs.size > 100) {
      const oldest = handoffs.keys().next().value
      if (oldest === undefined) break
      handoffs.delete(oldest)
    }
    diag(`handoff set im=${imKey} → target=${project} ttl=5min`)
  }

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

  function forwardTo(meta, text, template) {
    const target = meta?.targetAgent ?? meta?.agent
    const label = meta?.project ?? '桌面会话'
    if (target === undefined || target === null) {
      diag('forward abort 目标会话实例失效')
      return false
    }
    const baseMsg = template !== undefined && template !== null && typeof template === 'object'
      ? { ...template }
      : {}
    try {
      const id = typeof globalThis.crypto?.randomUUID === 'function'
        ? `fwd-${globalThis.crypto.randomUUID()}`
        : `fwd-${Date.now().toString(36)}`
      target.followup({
        ...baseMsg,
        id,
        role: 'user',
        source: normalizeUserSource(baseMsg.source),
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

  async function replyTo(markdown) {
    try {
      const sent = await im?.send?.({ title: 'Flow 指令确认', markdown })
      diag(`reply im=${sent?.ok === true ? `ok(${sent.via ?? 'unknown'})` : `fail(${sent?.reason ?? 'no-result'})`}`)
    } catch (error) {
      diag(`reply im=throw ${error instanceof Error ? error.message : String(error)}`)
      logger?.warn?.(`flow: 遥控确认回执发送失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function applyRemote(meta, token) {
    const target = meta?.agent
    const label = meta?.project ?? '桌面会话'
    diag(`applyRemote enter key=${meta?.key ?? '(未知)'} project=${label} token=${token}`)
    if (target === undefined || target === null) {
      logger?.warn?.('flow: 遥控目标会话实例已失效，忽略本次指令')
      return { ok: false, reason: '目标会话实例已失效' }
    }

    if (token === '1') retry(target)
    else if (token === '2') await escalate(target, undefined)
    else resume(target)

    const verb = token === '1'
      ? '已清零报错并继续执行'
      : token === '2' ? '已切到救场强模型重新诊断' : '已解除熔断暂停'
    logger?.info?.(`flow: 遥控指令 ${token} 已下发到会话「${label}」`)

    try {
      const sent = await im?.send?.({
        title: 'Flow 指令确认',
        markdown: `已收到指令 \`${token}\`，桌面会话「${label}」${verb}。`,
      })
      diag(`applyRemote im=${sent?.ok === true ? `ok(${sent.via ?? 'unknown'})` : `fail(${sent?.reason ?? 'no-result'})`}`)
    } catch (error) {
      logger?.warn?.(`flow: 遥控确认回执发送失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: true, verb }
  }

  /** 给 RemoteHub / 飞书卡片直接操作熔断态会话的统一接口。 */
  async function resolveRemoteAction({ sessionId, action, prompt = '' }) {
    const meta = trippedBySession(sessionId)
    if (meta === undefined || meta.agent === undefined) {
      return { ok: false, reason: '该会话当前未处于熔断态或已解锁' }
    }
    if (action === 'retry' || action === '1') {
      retry(meta.agent)
      return { ok: true, action: 'retry', project: meta.project, message: `已清零报错并继续执行「${meta.project}」` }
    }
    if (action === 'escalate' || action === '2') {
      const switched = await escalate(meta.agent, undefined)
      return {
        ok: true,
        action: 'escalate',
        switched,
        project: meta.project,
        message: switched ? `已切到救场强模型诊断「${meta.project}」` : `已解锁并重试「${meta.project}」（未配置救场强模型）`,
      }
    }
    if (action === 'resume' || action === '3') {
      resume(meta.agent)
      const trimmed = String(prompt ?? '').trim()
      if (trimmed !== '') {
        const forwarded = forwardTo(meta, trimmed)
        return {
          ok: true,
          action: 'resume',
          forwarded,
          project: meta.project,
          message: forwarded ? `已解除熔断并转交新指令到「${meta.project}」` : `已解除熔断，但新指令转交失败`,
        }
      }
      return { ok: true, action: 'resume', project: meta.project, message: `已解除「${meta.project}」的熔断暂停` }
    }
    return { ok: false, reason: `未知熔断动作：${action}` }
  }

  async function preStep(payload, next) {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return next()

    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const raw = messages.map(textOfMessage).join('\n').trim()
    const stripped = stripImTags(raw)
    const text = stripped.toLowerCase()
    const token = text.replace(/\s+/g, ' ')

    const state = states.get(keyOf(agent))
    const locked = state?.locked === true
    diag(`preStep session=${sessionIdOf(agent)} agent=${agentLabelOf(agent)} token="${token.slice(0, 40)}" rawLen=${raw.length} locked=${locked} tripped=${trippedSnapshot()}`)

    const cmd = CMD_RE.exec(stripped)
    const code = cmd?.[2]?.trim() ?? ''
    const rest = cmd?.[3]?.trim() ?? ''
    const imKey = state?.key ?? keyOf(agent)

    if (!locked) {
      if (cmd !== null) {
        const command = cmd[1]
        // 非锁定会话中，如果用户发了 `1 某某问题` / `2 某某建议` 且没有任何熔断项匹配，放行；
        // 即便有熔断项，仅当 command === '3' 才允许携带自由正文，1/2 带正文一律不当遥控指令！
        if ((command === '1' || command === '2') && rest !== '') {
          diag(`preStep non-locked 1/2 with body → 放行`)
          return next()
        }
        const meta = code !== '' ? trippedByCode(code) : loneTripped()
        const how = code !== '' ? `code:${code}` : 'lone'
        if (meta === undefined) {
          diag(`preStep match=none(${how}) → 放行`)
        } else if (meta.agent === agent) {
          diag(`preStep match=self(${how}) → 放行`)
        } else if (command === '3') {
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
        const handoff = takeHandoff(imKey)
        if (handoff !== undefined && stripped !== '') {
          const forwarded = forwardTo(handoff, stripped, messages[0])
          void replyTo(`已将新指令转交桌面会话「${handoff.project}」执行${forwarded ? '。' : '，但转交失败，请回电脑端确认。'}`)
          diag(`preStep handoff forward key=${imKey} ok=${forwarded} → reject`)
          return { kind: 'reject' }
        }
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
    // B-10b 修复：桌面端锁定时输入 `3 新指令`，自动剥离前缀 `3 ` 后投递。
    if (cmd !== null && cmd[1] === '3' && rest !== '') {
      diag('preStep 命中本会话 3+指令 → resume + 剥离前缀投递')
      resume(agent)
      const ok = forwardTo({ agent, project: projectOf(agent) }, rest, messages[0])
      return ok ? { kind: 'reject' } : next()
    }

    diag('preStep 普通纠错文本 → unlock + 放行')
    logger?.info?.('flow: 收到普通纠错文本，已解除熔断锁定并放行')
    unlock(agent, 'user-message')
    return next()
  }

  function listTrips() {
    return [...tripped.entries()].map(([key, meta]) => ({
      key,
      sessionId: String(meta?.sessionId ?? ''),
      project: String(meta?.project ?? ''),
      streak: Number(meta?.streak ?? 0),
      errors: Array.isArray(meta?.errors) ? meta.errors : [],
      at: Number(meta?.at ?? 0),
    }))
  }

  /** 清理已释放会话的内存条目（含 settling 与指向该目标会话的 handoffs，P1-9 修复）。 */
  function forget(sessionId) {
    const sid = String(sessionId ?? '')
    const key = `session:${sid}`
    const state = states.get(key)
    try { state?.notifyHandle?.cancel?.() } catch { /* dispose-path: 会话释放时取消延迟告警 */ }
    states.delete(key)
    alerts.delete(key)
    tripped.delete(key)
    pending.delete(key)
    settling.delete(key)
    handoffs.delete(key)
    if (sid !== '') {
      for (const [imKey, entry] of handoffs.entries()) {
        if (String(entry?.targetAgent?.session?.id ?? '') === sid) {
          handoffs.delete(imKey)
        }
      }
    }
  }

  function dispose() {
    disposed = true
    for (const cleanup of [...settleCleanups]) {
      try { cleanup() } catch { /* dispose-path: settle 定时器可能已自动触发 */ }
    }
    settleCleanups.clear()
    for (const state of states.values()) {
      try { state?.notifyHandle?.cancel?.() } catch { /* dispose-path: 插件卸载时取消残留告警句柄 */ }
    }
    states.clear()
    alerts.clear()
    tripped.clear()
    pending.clear()
    settling.clear()
    handoffs.clear()
  }

  return {
    observe,
    preStep,
    retry,
    escalate,
    resume,
    unlock,
    isLocked,
    alertTextOf,
    listTrips,
    resolveRemoteAction,
    forget,
    dispose,
  }
}
