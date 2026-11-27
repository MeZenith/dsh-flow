/**
 * 桌面活跃度跟踪。
 *
 * v0.6.0：补充 `forget(sessionId)` 供会话释放时回收内存。
 *
 * @module dsh-flow/resilience/activity
 */
export const ACTIVITY_EVENT = 'api-session/activity'

/**
 * 创建活跃度跟踪器。
 * @param {{ ctx: import('@deepseek-ai/cordis').Context }} deps
 */
export function createActivityTracker({ ctx }) {
  const lastActive = new Map()

  const off = ctx.on(ACTIVITY_EVENT, (sessionId, updatedAt) => {
    const key = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
    if (key === '') return
    const stamp = typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : Date.now()
    const previous = lastActive.get(key)
    if (previous === undefined || stamp > previous) lastActive.set(key, stamp)
  })

  function lastActiveAt(session) {
    const key = typeof session?.id === 'string' ? session.id : ''
    return key === '' ? undefined : lastActive.get(key)
  }

  function idleMsOf(session, now = Date.now()) {
    const stamp = lastActiveAt(session)
    if (stamp === undefined) return Number.POSITIVE_INFINITY
    return Math.max(0, now - stamp)
  }

  function touch(session, now = Date.now()) {
    const key = typeof session?.id === 'string' ? session.id : ''
    if (key !== '') lastActive.set(key, now)
  }

  function forget(sessionId) {
    const key = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
    if (key !== '') lastActive.delete(key)
  }

  function dispose() {
    try { off?.() } catch { /* 已卸载 */ }
    lastActive.clear()
  }

  return { lastActiveAt, idleMsOf, touch, forget, dispose }
}
