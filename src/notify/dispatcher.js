/**
 * 通知分流器：策略表 + 空闲门控 + 自动回退 + 定时器清理。
 *
 * v0.6.0 修复：
 * - M-11：延迟定时器到点时重新核对 `activity.idleMsOf(session)`，若用户在等待期间重新活跃，
 *   按剩余时间顺延（最多顺延 3 次后取消），避免用户正盯着电脑操作时弹出过时提醒。
 *
 * @module dsh-flow/notify/dispatcher
 */
import { collectAttachments } from './email.js'

const MAX_DEFER_ROUNDS = 3

/**
 * 创建分流器。
 *
 * @param {{
 *   getConfig: () => object,
 *   activity: { idleMsOf: (session: object, now?: number) => number },
 *   im: { send: Function },
 *   email: { send: Function },
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createNotifier({ getConfig, activity, im, email, logger }) {
  const timers = new Set()
  let disposed = false

  function strategyOf(event, payload) {
    const override = payload?.strategy
    if (['im-first', 'email-first', 'both', 'off'].includes(override)) return override
    const value = getConfig()?.notify?.[event]
    return ['im-first', 'email-first', 'both', 'off'].includes(value) ? value : 'im-first'
  }

  function idleThresholdOf(event) {
    const config = getConfig()
    if (event === 'archive' && config?.email?.forceArchive === true) return 0
    const seconds = Number(config?.circuit?.idleSeconds)
    const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 120
    return Math.max(0, safe * 1000)
  }

  async function deliver(event, payload) {
    const strategy = strategyOf(event, payload)
    if (strategy === 'off') return {}

    const config = getConfig()
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments
      : collectAttachments({
        event,
        config,
        agent: payload.agent,
        errorContext: payload.errorContext,
        teamReport: payload.teamReport,
        drafts: payload.drafts,
      })

    const report = {}
    const sessionId = payload.session?.id ?? payload.agent?.session?.id
    const runIm = async () => {
      report.im = await im.send({ title: payload.title, markdown: payload.markdown, sessionId })
      return report.im.ok === true
    }
    const runEmail = async () => {
      report.email = await email.send({
        event,
        project: payload.project,
        text: payload.markdown,
        attachments,
      })
      return report.email.ok === true
    }

    try {
      if (strategy === 'im-first') {
        if (!(await runIm())) await runEmail()
      } else if (strategy === 'email-first') {
        if (!(await runEmail())) await runIm()
      } else {
        const [imOk, emailOk] = await Promise.all([runIm(), runEmail()])
        if (!imOk && !emailOk) {
          logger?.warn?.(`flow: ${event} 双渠道均投递失败`)
        }
      }
    } catch (error) {
      logger?.warn?.(`flow: ${event} 通知异常 → ${error instanceof Error ? error.message : String(error)}`)
    }

    if (report.im?.ok !== true && report.email?.ok !== true) {
      logger?.warn?.(`flow: ${event} 通知全部失败（策略 ${strategy}）`)
    }
    return report
  }

  function schedule(event, payload, options = {}) {
    let cancelled = false
    let activeTimer

    if (strategyOf(event, payload) === 'off') {
      return { cancel() {}, done: Promise.resolve({}) }
    }

    const session = payload.session ?? payload.agent?.session
    const immediate = options.immediate === true || options.once === true

    const done = new Promise((resolve) => {
      let deferCount = 0

      const attempt = () => {
        if (cancelled || disposed) {
          resolve({})
          return
        }
        const threshold = idleThresholdOf(event)
        const idle = immediate || threshold === 0
          ? Number.POSITIVE_INFINITY
          : activity.idleMsOf(session)
        const remaining = Math.max(0, threshold - idle)

        if (remaining <= 0) {
          void Promise.resolve().then(() => (cancelled || disposed ? {} : deliver(event, payload))).then(resolve)
          return
        }

        if (deferCount >= MAX_DEFER_ROUNDS) {
          // 用户在多轮等待期间持续活跃，说明人就在电脑前，放弃发送迟到通知。
          resolve({ suppressed: 'user-active' })
          return
        }
        deferCount += 1

        activeTimer = setTimeout(() => {
          timers.delete(activeTimer)
          activeTimer = undefined
          attempt()
        }, remaining)
        if (typeof activeTimer.unref === 'function') activeTimer.unref()
        timers.add(activeTimer)
      }

      attempt()
    })

    return {
      cancel() {
        cancelled = true
        if (activeTimer !== undefined) {
          clearTimeout(activeTimer)
          timers.delete(activeTimer)
          activeTimer = undefined
        }
      },
      done,
    }
  }

  function sendNow(event, payload) {
    return deliver(event, payload)
  }

  function dispose() {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  return { schedule, sendNow, strategyOf, dispose }
}
