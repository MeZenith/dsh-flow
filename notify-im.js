/**
 * IM 通知渠道。
 *
 * === 三条通路，按可靠性排序 ===
 *
 * 1. **本地投递 HTTP 接口**（首选）：`POST http://127.0.0.1:<port>/api/dsh-im/delivery/messages`
 *    这是 dsh-im 文档里对外承诺的稳定接口，只依赖 WebServer，不需要能看见 Cordis 服务。
 *    本 profile 实测：`GET` 该路由返回 `405`（= 路由存在），假 botId 返回 `404`（= unknown-bot）。
 * 2. **`ctx.dshIm` 服务**：文档推荐用法，但 dsh-im 的 `provide` 发生在
 *    `ctx.inject(['sessionController','workspaceController'], …)` 的子 fiber 内，
 *    本 profile 里 `dsh-im` 的 Config 状态是 `absent`，服务对内不可见 —— 只作兜底。
 * 3. **自定义 Webhook**：飞书 / 钉钉 / 企微 / Bark / PushPlus / 自定义 JSON。
 *
 * 三条都失败时返回结构化原因（含每条通路各自的错误），永不向调用方抛。
 *
 * 能力边界：本接口只发**非空文本 / Markdown**，不支持图片、文件、卡片
 * （`PROACTIVE_DELIVERY.md` 明写）。后台告警因此只推文本摘要，附件统一走 SMTP。
 *
 * @module dsh-flow/notify-im
 */

/** 单条消息长度上限，超出截断（各平台自身也有分段限制）。 */
const MAX_TEXT = 8_000

/**
 * IM 是否能携带文件附件。
 *
 * 实查结论（`@xmanrui/dsh-im` v5.10.0 `PROACTIVE_DELIVERY.md:355`）：
 * 「当前主动投递只发送非空文字，不支持在该接口中发送图片、文件、卡片或富文本。」
 * 所以门禁/文档投递在 IM 侧**只能发控长摘要**，附件一律走 SMTP。这个常量是给
 * 上层做能力判断用的，别让未来的实现悄悄改成 true 而调用方还在按纯文本处理。
 */
export const IM_SUPPORTS_ATTACHMENTS = false

/** dsh-im 投递路由。 */
const DELIVERY_PATH = '/api/dsh-im/delivery/messages'

/**
 * 候选 WebServer 基地址：优先显式环境变量，最后回落到 web profile 默认端口。
 * @returns {string[]}
 */
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

/**
 * 创建 IM 渠道。
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getConfig: () => object,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createImChannel({ ctx, getConfig, logger }) {
  /** 安全取可选服务。 */
  function serviceOf() {
    try {
      return ctx.get('dshIm')
    } catch {
      return undefined
    }
  }

  /** 当前 IM 配置。 */
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

  /** 列出机器人（仅在服务可见时可用）。 */
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

  /** 列出某机器人下已配置的目标。 */
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

  /**
   * 走本地投递 HTTP 接口。
   *
   * 先用 `GET` 探路由（405 = 该方法不允许，即 POST 路由存在），
   * 避免把"路由不存在"误判成"机器人不存在"而给出误导性原因。
   *
   * @returns {Promise<{ ok: boolean, via: string, base?: string, reason?: string }>}
   */
  async function sendViaHttp(text, im) {
    for (const base of webBaseCandidates()) {
      const url = `${base}${DELIVERY_PATH}`
      let alive = false
      try {
        const probe = await fetch(url, { method: 'GET' })
        alive = probe.status === 405
      } catch {
        alive = false
      }
      if (!alive) continue
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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

  /** 按 webhook kind 组装 payload。 */
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

  /** 走 Webhook 发送。 */
  async function sendWebhook(text, title) {
    const { webhook } = settings()
    if (!webhook.enabled || webhook.url === '') {
      return { ok: false, via: 'webhook', reason: 'webhook 未启用或地址为空' }
    }
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(webhookPayload(webhook.kind, text, title)),
      })
      if (!response.ok) return { ok: false, via: 'webhook', reason: `HTTP ${response.status}` }
      return { ok: true, via: 'webhook' }
    } catch (error) {
      return { ok: false, via: 'webhook', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 发送一条 Markdown 文本：HTTP → dshIm 服务 → Webhook。
   *
   * @param {{ title: string, markdown: string }} message
   * @returns {Promise<{ ok: boolean, via: string, base?: string, reason?: string }>}
   */
  async function send({ title, markdown }) {
    const im = settings()
    if (!im.enabled) return { ok: false, via: 'im', reason: 'IM 渠道已在设置中关闭' }

    const text = markdown.length > MAX_TEXT ? `${markdown.slice(0, MAX_TEXT - 1)}…` : markdown
    const reasons = []

    if (im.botId !== '' && im.targetId !== '') {
      const viaHttp = await sendViaHttp(text, im)
      if (viaHttp.ok) return viaHttp
      reasons.push(`HTTP(${viaHttp.base ?? '默认端口'}):${viaHttp.reason}`)

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
      } else {
        reasons.push('dshIm:服务不可见')
      }
    } else {
      reasons.push('未配置 botId / targetId')
    }

    const webhook = await sendWebhook(text, title)
    if (webhook.ok) return webhook
    reasons.push(`webhook:${webhook.reason}`)

    logger?.warn?.(`flow: IM 投递全部失败（${reasons.join('；')}）`)
    return { ok: false, via: 'im', reason: reasons.join('；') }
  }

  /**
   * 设置页 / `/flow notify-test` 的自检：不依赖任何活跃会话。
   * @returns {Promise<{ ok: boolean, via: string, detail: string }>}
   */
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
