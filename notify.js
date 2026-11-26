/**
 * 通知分流器：策略表 + 空闲门控 + 自动回退 + 定时器清理。
 *
 * 四类事件（`brake` / `gate` / `team` / `archive`）各自配置策略：
 * `im-first`（IM 失败回退邮箱）、`email-first`（邮箱失败回退 IM）、
 * `both`、`off`。**两路都失败只 `logger.warn`**，绝不向调用方抛。
 *
 * 空闲门控：除 `archive` 外，事件会等到"距用户最后一次介入 ≥ idleSeconds"才发；
 * 不足则按剩余时间排定时器。任何一次提前作答都通过 `cancel(handle)` 清掉定时器，
 * 避免发出过期提醒。
 *
 * @module dsh-flow/notify
 */
import { collectAttachments } from './notify-email.js'

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
  /** 在飞的定时器，卸载时统一清理。 */
  const timers = new Set()
  let disposed = false

  /**
   * 读策略。
   *
   * `payload.strategy` 优先于配置：门禁超时催办要在「此刻」用 `gate.escalate` 指定的通道，
   * 而不是被 `notify.<event>` 的全局策略覆盖（两处语义不同，别混）。
   */
  function strategyOf(event, payload) {
    const override = payload?.strategy
    if (['im-first', 'email-first', 'both', 'off'].includes(override)) return override
    const value = getConfig()?.notify?.[event]
    return ['im-first', 'email-first', 'both', 'off'].includes(value) ? value : 'im-first'
  }

  /**
   * 读空闲门限（毫秒）。
   *
   * `archive` 默认**也**尊重空闲门控（避免用户正在用电脑时被归档邮件打断）；
   * 设置里打开 `email.forceArchive` 后改为无视活跃状态立刻归档。
   */
  function idleThresholdOf(event) {
    const config = getConfig()
    if (event === 'archive' && config?.email?.forceArchive === true) return 0
    const seconds = Number(config?.circuit?.idleSeconds)
    const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 120
    return Math.max(0, safe * 1000)
  }

  /**
   * 真正投递一次（已越过空闲门控）。
   *
   * @param {string} event
   * @param {{ title: string, markdown: string, project: string, agent?: object, session?: object, errorContext?: string, teamReport?: string }}
   *   payload
   * @returns {Promise<{ im?: object, email?: object }>}
   */
  async function deliver(event, payload) {
    const strategy = strategyOf(event, payload)
    if (strategy === 'off') return {}

    const config = getConfig()
    // 显式附件优先（门禁的 03/04/05/06/07 文档由 flow-docs 读成 Buffer 后直接传进来）；
    // 没传时回落到原来的按事件挑选逻辑，保持既有行为不变。
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
    const runIm = async () => {
      report.im = await im.send({ title: payload.title, markdown: payload.markdown })
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
      // 渠道实现本应自行吞错；这里是最后一道保险。
      logger?.warn?.(`flow: ${event} 通知异常 → ${error instanceof Error ? error.message : String(error)}`)
    }

    if (report.im?.ok !== true && report.email?.ok !== true) {
      logger?.warn?.(`flow: ${event} 通知全部失败（策略 ${strategy}）`)
    }
    return report
  }

  /**
   * 排定一次通知；返回句柄，`cancel()` 可取消尚未发出的定时器。
   *
   * @param {string} event
   * @param {object} payload 见 {@link deliver}
   * @param {{ immediate?: boolean }} [options]
   * @returns {{ cancel: () => void, done: Promise<object> }}
   */
  function schedule(event, payload, options = {}) {
    let cancelled = false
    let timer

    const settle = async () => {
      if (cancelled || disposed) return {}
      return deliver(event, payload)
    }

    if (strategyOf(event, payload) === 'off') {
      return { cancel() {}, done: Promise.resolve({}) }
    }

    const session = payload.session ?? payload.agent?.session
    const threshold = idleThresholdOf(event)
    // `once` 用于「超时催办」：deadline 已经到了，不该再等桌面空闲，也不重试。
    const idle = options.immediate === true || options.once === true || threshold === 0
      ? Number.POSITIVE_INFINITY
      : activity.idleMsOf(session)
    const remaining = Math.max(0, threshold - idle)

    const done = new Promise((resolve) => {
      if (remaining <= 0) {
        void Promise.resolve().then(settle).then(resolve)
        return
      }
      timer = setTimeout(() => {
        timers.delete(timer)
        void settle().then(resolve)
      }, remaining)
      if (typeof timer.unref === 'function') timer.unref()
      timers.add(timer)
    })

    return {
      cancel() {
        cancelled = true
        if (timer !== undefined) {
          clearTimeout(timer)
          timers.delete(timer)
          timer = undefined
        }
      },
      done,
    }
  }

  /** 直接投递（不排期），供 `/flow notify-test` 与需要即时验证的场合。 */
  function sendNow(event, payload) {
    return deliver(event, payload)
  }

  /** 卸载：清掉所有未发出的定时器。 */
  function dispose() {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  return { schedule, sendNow, strategyOf, dispose }
}
