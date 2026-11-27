/**
 * 兼容 IM 通知渠道（直连飞书 > dshIm 服务 > dsh-im 本地 HTTP > 自定义 Webhook）。
 *
 * v0.6.0 改进：
 * - 若已启用直连飞书并在线，优先作为 IM 通道发送，免去 `dsh-im` 限制；
 * - 对 `dshIm` 服务采用 `getDshIm` 优先，再尝试本地 HTTP 投递；
 * - 所有外部 HTTP / Webhook 请求均加 `AbortSignal.timeout(10_000)`，防止请求永久挂起。
 *
 * @module dsh-flow/notify/im
 */

const MAX_TEXT = 8_000
const FETCH_TIMEOUT_MS = 10_000
const DELIVERY_PATH = '/api/dsh-im/delivery/messages'

/** 仅指旧 dsh-im 文本投递不带附件；直连飞书支持直接发送文件与卡片。 */
export const IM_SUPPORTS_ATTACHMENTS = false

export function webBaseCandidates() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  const list = []
  if (typeof env.DSH_WEB_URL === 'string' && env.DSH_WEB_URL.trim() !== '') {
    list.push(env.DSH_WEB_URL.trim().replace(/\/+$/, ''))
  }
  if (typeof env.DSH_PORT === 'string' && env.DSH_PORT.trim() !== '') {
    list.push(`http://127.0.0.1:${env.DSH_PORT.trim()}`)
  }
  if (typeof env.DSH_WEB_PORT === 'string' && env.DSH_WEB_PORT.trim() !== '') {
    list.push(`http://127.0.0.1:${env.DSH_WEB_PORT.trim()}`)
  }
  list.push('http://127.0.0.1:3080')
  return [...new Set(list)]
}

function timeoutSignal(ms = FETCH_TIMEOUT_MS) {
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

/**
 * 创建 IM 渠道。
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getConfig: () => object,
 *   getDshIm?: () => object | undefined,
 *   getFeishu?: () => object | undefined,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createImChannel({ ctx, getConfig, getDshIm, getFeishu, logger }) {
  function serviceOf() {
    try {
      const held = typeof getDshIm === 'function' ? getDshIm() : undefined
      if (held !== undefined) return held
      return ctx?.get?.('dshIm')
    } catch {
      return undefined
    }
  }

  function settings() {
    const config = getConfig()
    const im = config?.im ?? {}
    return {
      enabled: im.enabled !== false,
      botId: typeof im.botId === 'string' ? im.botId.trim() : '',
      targetId: typeof im.targetId === 'string' ? im.targetId.trim() : '',
      webhook: {
        enabled: im.webhook?.enabled === true,
        url: typeof im.webhook?.url === 'string' ? im.webhook.url.trim() : '',
        kind: typeof im.webhook?.kind === 'string' ? im.webhook.kind : 'feishu',
      },
    }
  }

  async function listBots() {
    const service = serviceOf()
    if (service === undefined || typeof service.listBots !== 'function') return []
    try {
      const bots = await service.listBots()
      return Array.isArray(bots) ? bots : []
    } catch {
      return []
    }
  }

  async function listTargets(botId) {
    const service = serviceOf()
    if (service === undefined || typeof service.listTargets !== 'function') return []
    try {
      const targets = await service.listTargets(botId)
      return Array.isArray(targets) ? targets : []
    } catch {
      return []
    }
  }

  async function sendViaHttp(text, im) {
    for (const base of webBaseCandidates()) {
      const url = `${base}${DELIVERY_PATH}`
      let alive = false
      try {
        const probe = await fetch(url, { method: 'GET', signal: timeoutSignal(3_000) })
        alive = probe.status === 405
      } catch {
        alive = false
      }
      if (!alive) continue
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: timeoutSignal(FETCH_TIMEOUT_MS),
          body: JSON.stringify({
            botId: im.botId,
            targetId: im.targetId,
            text,
            format: 'markdown',
          }),
        })
        const payload = await response.json().catch(() => null)
        if (response.ok && payload?.sent === true) return { ok: true, via: 'http', base }
        const code = payload?.error?.code ?? `HTTP ${response.status}`
        return { ok: false, via: 'http', base, reason: String(code) }
      } catch (error) {
        return {
          ok: false,
          via: 'http',
          base,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return { ok: false, via: 'http', reason: `未找到投递路由 ${DELIVERY_PATH}` }
  }

  function webhookPayload(kind, text, title) {
    switch (kind) {
      case 'dingtalk':
        return { msgtype: 'markdown', markdown: { title, text } }
      case 'wecom':
        return { msgtype: 'markdown', markdown: { content: text } }
      case 'bark':
        return { title, body: text }
      case 'pushplus':
        return { title, content: text, template: 'markdown' }
      case 'custom':
        return { title, text, markdown: text }
      case 'feishu':
      default:
        return { msg_type: 'text', content: { text: `${title}\n\n${text}` } }
    }
  }

  async function sendWebhook(text, title) {
    const { webhook } = settings()
    if (!webhook.enabled || webhook.url === '') {
      return { ok: false, via: 'webhook', reason: 'webhook 未启用或地址为空' }
    }
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
        body: JSON.stringify(webhookPayload(webhook.kind, text, title)),
      })
      if (!response.ok) return { ok: false, via: 'webhook', reason: `HTTP ${response.status}` }
      return { ok: true, via: 'webhook' }
    } catch (error) {
      return { ok: false, via: 'webhook', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function send({ title, markdown, sessionId, skipFeishu = false }) {
    const text = markdown.length > MAX_TEXT ? `${markdown.slice(0, MAX_TEXT - 1)}…` : markdown
    const reasons = []

    // 1. 直连飞书优先（在线且启用且调用方未已通过 RemoteHub 发互动卡片时）
    const feishu = skipFeishu ? undefined : (typeof getFeishu === 'function' ? getFeishu() : undefined)
    if (feishu !== undefined && typeof feishu.sendNotification === 'function' && feishu.isReady?.() === true) {
      try {
        const res = await feishu.sendNotification({ title, markdown: text, sessionId })
        if (res?.ok === true) return { ok: true, via: 'feishu' }
        reasons.push(`feishu:${res?.reason ?? '发送失败'}`)
      } catch (error) {
        reasons.push(`feishu:${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const im = settings()
    if (!im.enabled) {
      if (reasons.length > 0) return { ok: false, via: 'im', reason: reasons.join('；') }
      return { ok: false, via: 'im', reason: 'IM 渠道已在设置中关闭' }
    }

    if (im.botId !== '' && im.targetId !== '') {
      // 2. 优先 dshIm 服务（进程内直接调用），其次本地 HTTP 投递
      const service = serviceOf()
      if (service !== undefined && typeof service.send === 'function') {
        try {
          const result = await service.send(im.botId, im.targetId, text, { format: 'markdown' })
          if (result?.sent === true) return { ok: true, via: 'dshIm' }
          reasons.push('dshIm:未返回 sent:true')
        } catch (error) {
          const code = error !== null && typeof error === 'object' ? String(error.code ?? '') : ''
          reasons.push(`dshIm:${code === '' ? (error instanceof Error ? error.message : String(error)) : code}`)
        }
      }

      const viaHttp = await sendViaHttp(text, im)
      if (viaHttp.ok) return viaHttp
      reasons.push(`HTTP(${viaHttp.base ?? '默认端口'}):${viaHttp.reason}`)
    } else {
      reasons.push('未配置 botId / targetId')
    }

    // 3. 自定义 Webhook
    const webhook = await sendWebhook(text, title)
    if (webhook.ok) return webhook
    reasons.push(`webhook:${webhook.reason}`)

    logger?.warn?.(`flow: IM 投递全部失败（${reasons.join('；')}）`)
    return { ok: false, via: 'im', reason: reasons.join('；') }
  }

  async function test() {
    const im = settings()
    const bots = await listBots()
    const botLine = bots.length === 0
      ? '服务侧拿不到机器人列表（可用「IM机器人」设置页核对）'
      : `可用机器人：${bots.map(bot => `${bot.botId}${bot.channel ? `/${bot.channel}` : ''}`).join('、')}`

    const result = await send({
      title: 'dsh-flow 测试消息',
      markdown: [
        '**dsh-flow 测试消息**',
        '',
        `- 时间：${new Date().toISOString()}`,
        `- 目标：${im.botId || '未配置'} / ${im.targetId || '未配置'}`,
        `- ${botLine}`,
        '',
        '收到这条说明 IM 通知链路可用。',
      ].join('\n'),
    })

    const where = result.base ? `（${result.base}）` : ''
    return {
      ok: result.ok,
      via: result.via,
      detail: result.ok
        ? `已通过 ${result.via}${where} 发送`
        : `发送失败：${result.reason ?? '未知原因'}`,
    }
  }

  return { send, test, listBots, listTargets, settings, supportsAttachments: IM_SUPPORTS_ATTACHMENTS }
}
