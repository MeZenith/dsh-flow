/**
 * 桌面活跃度跟踪。
 *
 * 官方信号：`'api-session/activity'(sessionId, updatedAt)` —— 由
 * `api/session-controller/src/index.ts:245` 在**用户撰写的持久消息**落地时 emit
 * （`types.ts:705` 的声明）。第三方插件没有 focus/blur/键鼠心跳通道，
 * 要那类数据得走 Typert Remote 构建期 codegen，S1 已排除。
 *
 * 因此这里的"桌面空闲"语义是**距用户最后一次真正介入该会话的时间**。
 * 对"别在我正跟这个 agent 对话时打扰我"这个真实诉求，它比窗口焦点更准。
 *
 * @module dsh-flow/activity
 */
export const ACTIVITY_EVENT = 'api-session/activity'

/**
 * 创建活跃度跟踪器。
 * @param {{ ctx: import('@deepseek-ai/cordis').Context }} deps
 */
export function createActivityTracker({ ctx }) {
  /** sessionId → 最后活跃时间戳 */
  const lastActive = new Map()

  const dispose = ctx.on(ACTIVITY_EVENT, (sessionId, updatedAt) => {
    const key = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
    if (key === '') return
    const stamp = typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : Date.now()
    const previous = lastActive.get(key)
    if (previous === undefined || stamp > previous) lastActive.set(key, stamp)
  })

  /**
   * 该会话最后一次用户介入的时间戳；从未观察到则 undefined。
   * @param {{ id?: string } | undefined} session
   */
  function lastActiveAt(session) {
    const key = typeof session?.id === 'string' ? session.id : ''
    return key === '' ? undefined : lastActive.get(key)
  }

  /**
   * 距最后一次介入的毫秒数。
   *
   * 从未观察到活跃时返回 `Infinity`：视为"早就空闲"，允许立刻通知
   * （宁可早提醒，也不要因为没数据而永远不发）。
   *
   * @param {{ id?: string } | undefined} session
   * @param {number} now
   * @returns {number}
   */
  function idleMsOf(session, now = Date.now()) {
    const stamp = lastActiveAt(session)
    if (stamp === undefined) return Number.POSITIVE_INFINITY
    return Math.max(0, now - stamp)
  }

  /** 记一次手动触碰（例如用户刚点了门禁选项）。 */
  function touch(session, now = Date.now()) {
    const key = typeof session?.id === 'string' ? session.id : ''
    if (key !== '') lastActive.set(key, now)
  }

  return { lastActiveAt, idleMsOf, touch, dispose }
}
