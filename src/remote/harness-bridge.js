/**
 * DSH 宿主桥接层：把工作区、会话列表、消息注入、模式切换和中断能力封装成统一接口。
 *
 * 供 `RemoteHub` 使用，屏蔽 DSH 可选服务（`sessionController` / `workspaceController`）的差异。
 *
 * @module dsh-flow/remote/harness-bridge
 */
import { basename } from 'node:path'
import { projectNameOfCwd } from '../shared/message.js'
import { MODE_OFF } from '../config/constants.js'

/**
 * 创建宿主桥接器。
 *
 * @param {{
 *   ctx: object,
 *   readMode: (session: object) => string,
 *   resolveAgent: (sessionId: string) => object | undefined,
 *   switchMode: (agent: object, modeId: string) => Promise<object>,
 *   syncModeCommand?: (agent: object, modeId: string) => Promise<object>,
 *   tickets: object,
 *   breaker: object,
 *   stateStore?: object,
 *   getSessionController?: () => object | undefined,
 *   getWorkspaceController?: () => object | undefined,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createHarnessBridge({
  ctx,
  readMode,
  resolveAgent,
  switchMode,
  syncModeCommand,
  tickets,
  breaker,
  stateStore,
  getSessionController,
  getWorkspaceController,
  logger,
}) {
  function activeAgents() {
    try {
      const list = ctx?.agents?.list?.()
      if (!Array.isArray(list)) return []
      return list.filter(agent => agent !== null && agent !== undefined && agent.session?.header?.origin !== 'subagent')
    } catch {
      return []
    }
  }

  /** 构建单个在线会话的摘要快照。 */
  function describeAgent(agent) {
    const session = agent?.session
    const sessionId = String(session?.id ?? '')
    const cwd = String(session?.header?.cwd ?? '')
    const project = projectNameOfCwd(cwd)
    const mode = session ? readMode(session) : MODE_OFF
    const openGates = sessionId ? tickets.openFor(sessionId) : []
    const isTripped = breaker?.isLocked?.(agent) === true
    const status = typeof agent?.status === 'string'
      ? agent.status
      : (isTripped ? 'tripped' : openGates.length > 0 ? 'awaiting-gate' : 'idle')
    return {
      sessionId,
      agentId: String(agent?.id ?? ''),
      project,
      cwd,
      mode,
      status,
      online: true,
      pendingGateIds: openGates.map(item => item.id),
      isTripped,
      title: String(session?.header?.title ?? project),
    }
  }

  /** 列出全部在线会话（可按 cwd 或项目名过滤）。 */
  function listSessions({ cwd, project } = {}) {
    const wantedCwd = typeof cwd === 'string' ? cwd.trim().toLowerCase() : ''
    const wantedProject = typeof project === 'string' ? project.trim().toLowerCase() : ''
    return activeAgents()
      .map(describeAgent)
      .filter(item => {
        if (wantedCwd !== '' && item.cwd.toLowerCase() !== wantedCwd) return false
        if (wantedProject !== '' && !item.project.toLowerCase().includes(wantedProject)) return false
        return true
      })
  }

  /** 列出工作区（聚合在线会话 + 宿主 workspaceController + 历史最近工作区）。 */
  async function listWorkspaces() {
    const byCwd = new Map()

    const upsert = (cwd, name) => {
      const clean = String(cwd ?? '').trim()
      if (clean === '') return
      const key = clean.toLowerCase()
      let entry = byCwd.get(key)
      if (entry === undefined) {
        entry = {
          cwd: clean,
          name: String(name || basename(clean.replace(/[\\/]+$/, '')) || clean),
          sessions: [],
          onlineCount: 0,
        }
        byCwd.set(key, entry)
      }
      return entry
    }

    for (const session of listSessions()) {
      const entry = upsert(session.cwd, session.project)
      if (entry !== undefined) {
        entry.sessions.push(session)
        entry.onlineCount += 1
      }
    }

    try {
      const wc = typeof getWorkspaceController === 'function' ? getWorkspaceController() : ctx?.get?.('workspaceController')
      const listed = typeof wc?.list === 'function' ? await wc.list() : []
      for (const ws of Array.isArray(listed) ? listed : []) {
        const path = typeof ws === 'string' ? ws : (ws?.cwd ?? ws?.path ?? ws?.root ?? '')
        const name = typeof ws === 'object' ? (ws?.name ?? ws?.label) : undefined
        upsert(path, name)
      }
    } catch { /* 宿主未提供 workspaceController */ }

    const recents = stateStore?.getRecentWorkspaces?.() ?? []
    for (const item of recents) {
      upsert(item.cwd, item.name)
    }

    return [...byCwd.values()].sort((a, b) => b.onlineCount - a.onlineCount || a.name.localeCompare(b.name))
  }

  /** 尝试通过宿主 sessionController 为指定工作区拉起新会话。 */
  async function createSessionForCwd(cwd) {
    try {
      const sc = typeof getSessionController === 'function' ? getSessionController() : ctx?.get?.('sessionController')
      if (sc === undefined) return { ok: false, reason: '宿主未开放 sessionController，请先在 DSH 桌面端打开该目录' }
      const fn = typeof sc.create === 'function'
        ? sc.create.bind(sc)
        : typeof sc.createSession === 'function'
          ? sc.createSession.bind(sc)
          : undefined
      if (fn === undefined) return { ok: false, reason: '宿主不支持远程新建会话，请先在 DSH 桌面端打开该目录' }
      const created = await fn({ cwd })
      const sessionId = String(created?.id ?? created?.sessionId ?? created?.session?.id ?? '')
      if (sessionId === '') return { ok: false, reason: '新建会话未返回有效 sessionId' }
      stateStore?.rememberWorkspace?.(cwd, projectNameOfCwd(cwd))
      return { ok: true, sessionId }
    } catch (error) {
      logger?.warn?.(`flow: 远程新建会话失败 → ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 向目标会话或目标工作区派发一条用户消息。 */
  async function sendPrompt({ sessionId, cwd, text, createIfMissing = false, source = 'feishu' }) {
    const cleanText = String(text ?? '').trim()
    if (cleanText === '') return { ok: false, reason: '消息内容不能为空' }

    let targetSessionId = String(sessionId ?? '').trim()
    let agent = targetSessionId !== '' ? resolveAgent(targetSessionId) : undefined

    if (agent === undefined && typeof cwd === 'string' && cwd.trim() !== '') {
      const cleanCwd = cwd.trim()
      if (!createIfMissing) {
        const match = listSessions({ cwd: cleanCwd })[0]
        if (match !== undefined) {
          targetSessionId = match.sessionId
          agent = resolveAgent(targetSessionId)
        }
      }
      if (agent === undefined) {
        const created = await createSessionForCwd(cleanCwd)
        if (!created.ok) return created
        targetSessionId = created.sessionId
        agent = resolveAgent(targetSessionId)
      }
    }

    if (agent === undefined || agent === null) {
      return { ok: false, reason: `未找到在线会话（${targetSessionId || cwd || '未指定'}），请先在 DSH 桌面端打开该项目` }
    }

    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? `remote-${globalThis.crypto.randomUUID()}`
      : `remote-${Date.now().toString(36)}`
    const message = {
      id,
      role: 'user',
      source,
      content: [{ type: 'text', text: cleanText }],
    }

    try {
      if (typeof agent.followup === 'function') {
        agent.followup(message)
      } else if (typeof agent.steer === 'function') {
        agent.steer(message)
      } else {
        return { ok: false, reason: '目标会话不支持接收消息' }
      }
      const info = describeAgent(agent)
      if (info.cwd !== '') stateStore?.rememberWorkspace?.(info.cwd, info.project)
      return { ok: true, session: info, messageId: id }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 切换目标会话的 Flow 模式。 */
  async function switchSessionMode(sessionId, modeId) {
    const agent = resolveAgent(sessionId)
    if (agent === undefined || agent === null) {
      return { ok: false, reason: `会话 ${sessionId} 不在线` }
    }
    try {
      if (typeof syncModeCommand === 'function') {
        const synced = await syncModeCommand(agent, modeId)
        if (synced?.ok === true) {
          return { ok: true, mode: modeId, label: synced.label ?? modeId, notes: synced.notes ?? [] }
        }
      }
      const applied = await switchMode(agent, modeId)
      return { ok: true, mode: modeId, label: applied?.label ?? modeId, notes: applied?.notes ?? [] }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 中止目标会话当前回合。 */
  function abortSession(sessionId) {
    const agent = resolveAgent(sessionId)
    if (agent === undefined || agent === null) {
      return { ok: false, reason: `会话 ${sessionId} 不在线` }
    }
    try {
      agent.cancel?.({ kind: 'user', reason: '来自远程指挥官的中止指令' }, { keepInbox: false })
      return { ok: true, session: describeAgent(agent) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    listWorkspaces,
    listSessions,
    describeAgent,
    sendPrompt,
    switchSessionMode,
    abortSession,
  }
}
