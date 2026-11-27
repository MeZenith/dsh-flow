/**
 * `dsh-team-control` 后台 SSE 联动（静默容错）。
 *
 * v0.6.0 修复（B-09）：
 * - 按 `teamId` 分桶跟踪所有成员状态（含运行中/等待态），不再删除非终态成员，
 *   彻底修复「第一个成员结束就误判全队完成」的 bug；
 * - 检测 `error.cause?.code` 以正确识别 Node 原生 fetch 抛出的 `ECONNREFUSED` 退避；
 * - 兼容 `\r\n\r\n` 与 `\n\n` 两种 SSE 帧分隔符，并支持 `id:` / `Last-Event-ID` 断点续传。
 *
 * @module dsh-flow/resilience/team-sse
 */

const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 1_000
const REFUSED_BASE_MS = 30_000
const CONNECT_TIMEOUT_MS = 15_000
const MAX_SSE_BUFFER_CHARS = 1024 * 1024
const MAX_TRACKED_TEAMS = 200
const ALERT_TYPES = new Set(['scope.request', 'lease.warn'])
const TERMINAL_STATUS = new Set(['done', 'failed', 'error', 'stopped', 'succeeded', 'cancelled'])

/**
 * 解析一帧 SSE 文本。
 * @param {string} block
 * @returns {{ id?: string, event: string, data: string } | null}
 */
export function parseSseFrame(block) {
  let event = 'message'
  let id
  const data = []
  for (const rawLine of String(block ?? '').split(/\r?\n/)) {
    if (rawLine.startsWith(':')) continue
    if (rawLine.startsWith('id:')) id = rawLine.slice(3).trim()
    else if (rawLine.startsWith('event:')) event = rawLine.slice(6).trim()
    else if (rawLine.startsWith('data:')) data.push(rawLine.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return { id, event, data: data.join('\n') }
}

/** 识别连接被拒 / 网络不可达错误（递归检查 `error.cause`）。 */
export function isConnectionRefusedError(error) {
  let current = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const code = typeof current.code === 'string' ? current.code : ''
    const message = typeof current.message === 'string' ? current.message : String(current)
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EADDRNOTAVAIL/i.test(`${code} ${message}`)) return true
    current = current.cause
  }
  return false
}

/**
 * 建立监听器。
 *
 * @param {{
 *   getConfig: () => object,
 *   onAlert: (payload: { type: string, summary: string, raw: object }) => void,
 *   onComplete: (payload: { teamId: string, summary: string, memberIds: string[] }) => void,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createTeamWatcher({ getConfig, onAlert, onComplete, logger }) {
  let running = false
  let controller
  let timer
  let attempt = 0
  let lastEventId = ''

  /** teamId → Map<memberId, status>（保留全部成员状态，绝不删除运行中成员）。 */
  const teamMembers = new Map()

  function settings() {
    const team = getConfig()?.team ?? {}
    const baseUrl = typeof team.baseUrl === 'string' && team.baseUrl.trim() !== ''
      ? team.baseUrl.trim().replace(/\/+$/, '')
      : 'http://127.0.0.1:4317'
    return { enabled: team.enabled !== false, baseUrl }
  }

  /** 处理一条帧（对外导出给单测直接调用）。 */
  function handleFrame(event, raw) {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (payload === null || typeof payload !== 'object') return

    const type = typeof payload.type === 'string' ? payload.type : event

    if (ALERT_TYPES.has(type)) {
      const summary = typeof payload.reason === 'string' ? payload.reason
        : typeof payload.message === 'string' ? payload.message
          : JSON.stringify(payload).slice(0, 400)
      onAlert({ type, summary, raw: payload })
      return
    }

    if (type === 'decision') {
      const outcome = typeof payload.outcome === 'string' ? payload.outcome : ''
      if (outcome !== '' && outcome !== 'approved' && outcome !== 'allowed') {
        onAlert({ type, summary: `决策结果：${outcome}`, raw: payload })
      }
      return
    }

    if (type === 'member.status') {
      const memberId = typeof payload.memberId === 'string' ? payload.memberId
        : typeof payload.member === 'string' ? payload.member : ''
      const status = typeof payload.status === 'string' ? payload.status : ''
      const teamId = typeof payload.teamId === 'string' ? payload.teamId : ''
      if (memberId === '' || status === '' || teamId === '') return

      let members = teamMembers.get(teamId)
      if (members === undefined) {
        members = new Map()
        teamMembers.set(teamId, members)
        while (teamMembers.size > MAX_TRACKED_TEAMS) {
          const oldest = teamMembers.keys().next().value
          if (oldest === undefined) break
          teamMembers.delete(oldest)
        }
      }
      const prevStatus = members.get(memberId)
      members.set(memberId, status)

      // 只有当本帧让某成员刚进入终态，且该 team 的所有已知成员均已进入终态时才触发完结。
      if (TERMINAL_STATUS.has(status) && !TERMINAL_STATUS.has(prevStatus)) {
        const allTerminal = members.size > 0 && [...members.values()].every(value => TERMINAL_STATUS.has(value))
        if (allTerminal) {
          const memberIds = [...members.keys()]
          teamMembers.delete(teamId)
          onComplete({ teamId, summary: `团队 ${teamId} 全部成员（${memberIds.length} 人）进入终态`, memberIds })
        }
      }
    }
  }

  async function connectOnce() {
    const { baseUrl } = settings()
    controller = new AbortController()
    const query = lastEventId === '' ? '' : `?lastEventId=${encodeURIComponent(lastEventId)}`
    const headers = { accept: 'text/event-stream' }
    if (lastEventId !== '') headers['last-event-id'] = lastEventId

    const connectTimer = setTimeout(() => {
      try { controller?.abort() } catch { /* 忽略 */ }
    }, CONNECT_TIMEOUT_MS)
    if (typeof connectTimer.unref === 'function') connectTimer.unref()
    let response
    try {
      response = await fetch(`${baseUrl}/api/events${query}`, {
        headers,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(connectTimer)
    }
    if (!response.ok || response.body === null) {
      throw new Error(`SSE HTTP ${response.status}`)
    }
    attempt = 0
    logger?.info?.(`flow: 已连接 dsh-team-control SSE（${baseUrl}）`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (running) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        try { await reader.cancel() } catch { /* 忽略 */ }
        throw new Error('SSE 帧缓冲超过 1MB 上限，已主动断流重连')
      }
      // 兼容 \r\n\r\n 与 \n\n 两种 SSE 帧分隔符。
      let match = /\r?\n\r?\n/.exec(buffer)
      while (match !== null) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const frame = parseSseFrame(block)
        if (frame !== null) {
          if (typeof frame.id === 'string' && frame.id !== '') lastEventId = frame.id
          try {
            handleFrame(frame.event, frame.data)
          } catch (error) {
            logger?.warn?.(`flow: SSE 帧处理失败 → ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        match = /\r?\n\r?\n/.exec(buffer)
      }
    }
  }

  function scheduleRetry(refused = false) {
    if (!running) return
    const base = refused ? REFUSED_BASE_MS : BASE_BACKOFF_MS
    const delay = Math.min(MAX_BACKOFF_MS, base * (2 ** attempt))
    const jitter = Math.floor(Math.random() * 250)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, delay + jitter)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function run() {
    if (!running) return
    const { enabled } = settings()
    if (!enabled) {
      timer = setTimeout(() => { timer = undefined; void run() }, 30_000)
      if (typeof timer.unref === 'function') timer.unref()
      return
    }
    try {
      await connectOnce()
      if (running) scheduleRetry()
    } catch (error) {
      if (!running) return
      const message = error instanceof Error ? error.message : String(error)
      const refused = isConnectionRefusedError(error)
      if (attempt === 0) {
        logger?.warn?.(refused
          ? `flow: 未检测到 dsh-team-control（${message}），已静默退避，不刷屏`
          : `flow: dsh-team-control SSE 未连接（${message}），将后台重试`)
      }
      scheduleRetry(refused)
    }
  }

  function start() {
    if (running) return
    running = true
    void run()
  }

  function stop() {
    running = false
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    try { controller?.abort() } catch { /* 已结束 */ }
    controller = undefined
    teamMembers.clear()
  }

  return { start, stop, handleFrame }
}
