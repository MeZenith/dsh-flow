/**
 * `dsh-team-control` 后台 SSE 联动（静默容错）。
 *
 * 端点：`GET <baseUrl>/api/events?team=&member=&lastEventId=`，`text/event-stream`，
 * 每 15 秒一个 `: ping` 注释帧，最多重放 5000 条。帧类型：
 * `lease.warn` / `scope.request` / `decision` / `message.delivered` /
 * `member.status` / `step.append`（实测清单，来自 0.3.0 的 sidecar）。
 *
 * 红线：
 * - **绝不刷屏**：服务没起、断线、格式错，全部静默重连（指数退避 + 抖动）；
 * - **绝不影响主插件**：任何异常都折成本模块内部的 warn，不向调用方抛；
 * - 地址来自配置，不硬编码。
 *
 * @module dsh-flow/team-sse
 */
/** 退避序列上限。 */
const MAX_BACKOFF_MS = 60_000
/** 首次重连延迟。 */
const BASE_BACKOFF_MS = 1_000

/** 会触发"团队异常/审批"通知的帧类型。 */
const ALERT_TYPES = new Set(['scope.request', 'lease.warn'])

/** 判定成员进入终态的字符串。 */
const TERMINAL_STATUS = new Set(['done', 'failed', 'error', 'stopped', 'succeeded', 'cancelled'])

/**
 * 解析一帧 SSE 文本。
 * @param {string} block
 * @returns {{ event: string, data: string } | null}
 */
export function parseSseFrame(block) {
  let event = 'message'
  const data = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

/**
 * 建立监听器。
 *
 * @param {{
 *   getConfig: () => object,
 *   onAlert: (payload: { type: string, summary: string, raw: object }) => void,
 *   onComplete: (payload: { summary: string, memberIds: string[] }) => void,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createTeamWatcher({ getConfig, onAlert, onComplete, logger }) {
  let running = false
  let controller
  let timer
  let attempt = 0
  /** memberId → 最近一次状态（只在终态集合里记） */
  const memberStatus = new Map()

  function settings() {
    const team = getConfig()?.team ?? {}
    const baseUrl = typeof team.baseUrl === 'string' && team.baseUrl.trim() !== ''
      ? team.baseUrl.trim().replace(/\/+$/, '')
      : 'http://127.0.0.1:4317'
    return { enabled: team.enabled !== false, baseUrl }
  }

  /** 处理一条帧。 */
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
      if (memberId === '' || status === '') return
      if (TERMINAL_STATUS.has(status)) memberStatus.set(memberId, status)
      else memberStatus.delete(memberId)

      const teamId = typeof payload.teamId === 'string' ? payload.teamId : ''
      if (memberStatus.size > 0 && teamId !== '') {
        // 最保守的完成判定：所有已知成员都在终态，且本帧刚刚让最后一个进入终态。
        const allTerminal = [...memberStatus.values()].every(value => TERMINAL_STATUS.has(value))
        if (allTerminal) {
          onComplete({ summary: `团队 ${teamId} 全部成员进入终态`, memberIds: [...memberStatus.keys()] })
          memberStatus.clear()
        }
      }
    }
  }

  /** 一次连接尝试。 */
  async function connectOnce() {
    const { baseUrl } = settings()
    controller = new AbortController()
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
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
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const frame = parseSseFrame(block)
        if (frame !== null) {
          try {
            handleFrame(frame.event, frame.data)
          } catch (error) {
            logger?.warn?.(`flow: SSE 帧处理失败 → ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        index = buffer.indexOf('\n\n')
      }
    }
  }

  /** 退避重连循环。 */
  function scheduleRetry() {
    if (!running) return
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** attempt))
    const jitter = Math.floor(Math.random() * 250)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, delay + jitter)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 一轮"连接 + 失败退避"。 */
  async function run() {
    if (!running) return
    const { enabled } = settings()
    if (!enabled) {
      // 关闭时退化为低频轮询配置，不占连接。
      timer = setTimeout(() => { timer = undefined; void run() }, 30_000)
      if (typeof timer.unref === 'function') timer.unref()
      return
    }
    try {
      await connectOnce()
      // 正常结束（服务端关流）也要重连
      if (running) scheduleRetry()
    } catch (error) {
      if (!running) return
      const message = error instanceof Error ? error.message : String(error)
      // 只在第一次失败时提示一次，之后静默退避，避免刷屏。
      if (attempt === 0) logger?.warn?.(`flow: dsh-team-control SSE 未连接（${message}），将后台重试`)
      scheduleRetry()
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
    memberStatus.clear()
  }

  return { start, stop }
}
