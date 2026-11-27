/**
 * 直连飞书指挥官主入口（作为 RemoteHub 的首个一级通道适配器）。
 *
 * 职责：
 * 1. 管理飞书凭证、扫码建应用（自定义名称/简介/头像）、手动校验与 WebSocket 长连接；
 * 2. 订阅 RemoteHub 事件：
 *    - `gate:created` → 立即推送门禁互动卡片 + 直传 `.md` / `.html` 文件；
 *    - `gate:settled` → 自动原地 patch 飞书门禁卡片为「已结算」灰/绿态；
 *    - `brake:tripped` → 立即推送红色熔断抢救卡片；
 *    - `brake:unlocked` → 自动原地 patch 飞书熔断卡片为「已解除」态；
 *    - `docs:ready` → 直传文档文件到飞书；
 *    - `session:completed` → 推送阶段汇总卡片；
 * 3. 提供给设置页本地 API 和 `/flow feishu` 命令的控制接口。
 *
 * @module dsh-flow/remote/feishu
 */
import { randomUUID } from 'node:crypto'
import { createFeishuClient } from './client.js'
import { createFeishuOnboarding, createFeishuSecretStore, verifyFeishuCredentials } from './onboarding.js'
import { createFeishuRouter } from './router.js'
import { createFeishuReplyStreamer } from './reply-stream.js'
import { syncFeishuSlashCommands } from './slash-commands.js'
import {
  buildBrakeCard,
  buildBrakeResolvedCard,
  buildGateCard,
  buildGateResolvedCard,
  buildSummaryCard,
  buildTestCard,
  buildToolApprovalCard,
  buildToolApprovalResolvedCard,
  buildWelcomeCard,
} from './cards.js'
import { AVATAR_PRESETS, DEFAULT_BOT_DESCRIPTION, DEFAULT_BOT_NAME, openPlatformAppUrl } from './presets.js'
import { projectNameOfCwd } from '../../shared/message.js'

/**
 * 创建直连飞书指挥官适配器。
 *
 * @param {{
 *   hub: ReturnType<typeof import('../hub.js').createRemoteHub>,
 *   getConfig: () => object,
 *   getCredentials?: () => object | undefined,
 *   stateStore?: object,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createFeishuCommander({ hub, getConfig, getCredentials, stateStore, logger, diag = () => {} }) {
  const secretStore = createFeishuSecretStore({ getCredentials, getConfig })
  let discoveredChatId = ''
  let botProfile = { name: '', avatarUrl: '', openId: '' }
  let runtimeAppId = ''
  let runtimeDomain = 'feishu'
  let slashMenuState = { status: 'unknown', reason: '' }
  /** 待决 DSH 工具审批映射：approvalId -> { settle, project, toolName, messageId } */
  const pendingApprovals = new Map()

  function settings() {
    const cfg = getConfig()?.feishu ?? {}
    return {
      enabled: cfg.enabled === true,
      domain: cfg.domain === 'lark' ? 'lark' : 'feishu',
      appId: String(cfg.appId ?? '').trim() || runtimeAppId,
      appSecret: String(cfg.appSecret ?? '').trim(),
      botName: String(cfg.botName ?? '').trim() || DEFAULT_BOT_NAME,
      botDescription: String(cfg.botDescription ?? '').trim() || DEFAULT_BOT_DESCRIPTION,
      botAvatarUrl: String(cfg.botAvatarUrl ?? '').trim(),
      localAlias: String(cfg.localAlias ?? '').trim(),
      localAvatar: String(cfg.localAvatar ?? '').trim(),
      allowedOpenIds: Array.isArray(cfg.allowedOpenIds) ? cfg.allowedOpenIds : [],
      defaultChatId: String(cfg.defaultChatId ?? '').trim() || discoveredChatId,
      pushOnGate: cfg.pushOnGate !== false,
      pushOnBrake: cfg.pushOnBrake !== false,
      pushOnComplete: cfg.pushOnComplete !== false,
      pushOnApproval: cfg.pushOnApproval !== false,
      syncDesktopReplies: cfg.syncDesktopReplies === true,
      sendDocFiles: cfg.sendDocFiles !== false,
    }
  }

  function displayAlias() {
    const s = settings()
    return s.localAlias || botProfile.name || s.botName || DEFAULT_BOT_NAME
  }

  /** 按会话寻找最合适的飞书推送目标（优先已绑定该会话的群/私聊，其次 defaultChatId）。 */
  function resolveTargetChatId(sessionId) {
    const s = settings()
    const key = String(sessionId ?? '')
    if (key !== '' && stateStore !== undefined) {
      const threads = stateStore.getAllFeishuThreads?.() ?? {}
      for (const binding of Object.values(threads)) {
        if (binding?.sessionId === key && binding?.chatId) return binding.chatId
      }
      const focuses = stateStore.getAllFeishuFocuses?.() ?? {}
      for (const binding of Object.values(focuses)) {
        if (binding?.sessionId === key && binding?.chatId) return binding.chatId
      }
    }
    return s.defaultChatId
  }

  let router
  const client = createFeishuClient({
    onMessage: (data) => router.handleMessage(data),
    onCardAction: (data) => router.handleCardAction(data),
    logger,
    diag,
  })

  const replyStreamer = createFeishuReplyStreamer({
    client,
    getBotAlias: displayAlias,
    getConfig,
    resolveTargetChatId,
    logger,
    diag,
  })

  /** 结算一条挂起的 DSH 工具审批（由飞书卡片按钮触发）。 */
  function resolveApproval({ approvalId, decision, by = 'feishu' }) {
    const entry = pendingApprovals.get(approvalId)
    if (!entry) return { ok: false, reason: '该审批已被处理或已过期' }
    const settled = entry.settle(decision, by)
    return settled ? { ok: true } : { ok: false, reason: '该审批已被处理' }
  }

  router = createFeishuRouter({
    hub,
    client,
    stateStore,
    getConfig,
    replyStreamer,
    resolveApproval,
    onChatDiscovered: (chatId) => {
      if (chatId !== '' && discoveredChatId === '') discoveredChatId = chatId
    },
    logger,
    diag,
  })

  /** 同步飞书原生 `/` 指令面板。 */
  async function syncSlashCommands() {
    const apiClient = client.getApiClient?.()
    if (!apiClient) {
      slashMenuState = { status: 'disconnected', reason: '请先连接飞书机器人' }
      return { ok: false, ...slashMenuState }
    }
    const res = await syncFeishuSlashCommands({ apiClient, logger })
    slashMenuState = {
      status: res.status || (res.ok ? 'synced' : 'error'),
      reason: res.reason || '',
    }
    return res
  }

  /** 向用户推送开箱欢迎与使用指南卡片。 */
  async function sendWelcomeCard(override = {}) {
    if (!client.isReady()) return { ok: false, reason: '飞书未连接' }
    const s = settings()
    const targetChatId = String(override.chatId ?? s.defaultChatId).trim()
    const targetOpenId = String(override.openId ?? s.allowedOpenIds?.[0] ?? '').trim()
    const card = buildWelcomeCard({
      botAlias: displayAlias(),
      sessions: hub.listSessions(),
    })
    if (targetChatId !== '') {
      const res = await client.sendCard(targetChatId, card, { receiveIdType: 'chat_id' })
      return res.ok ? { ok: true, detail: `已发送使用指南卡片至会话 ${targetChatId}` } : { ok: false, reason: res.reason }
    }
    if (targetOpenId !== '') {
      const res = await client.sendCard(targetOpenId, card, { receiveIdType: 'open_id' })
      return res.ok ? { ok: true, detail: `已发送使用指南卡片至你的飞书私聊` } : { ok: false, reason: res.reason }
    }
    return { ok: false, reason: '尚未确定推送目标：请先在飞书给机器人发任意消息（如「你好」），或填写白名单 open_id。' }
  }

  const onboarding = createFeishuOnboarding({
    secretStore,
    logger,
    onCompleted: async ({ appId, appSecret, domain, ownerOpenId, botName, botAvatarUrl, isUpgrade }) => {
      runtimeAppId = appId
      runtimeDomain = domain
      if (botName || botAvatarUrl) {
        botProfile = {
          name: botName || botProfile.name,
          avatarUrl: botAvatarUrl || botProfile.avatarUrl,
          openId: botProfile.openId,
        }
      }
      const connected = await client.connect({ appId, appSecret, domain })
      if (connected.ok) {
        void syncSlashCommands()
        if (ownerOpenId) {
          void sendWelcomeCard({ openId: ownerOpenId })
        } else if (isUpgrade && settings().defaultChatId) {
          void sendWelcomeCard({ chatId: settings().defaultChatId })
        }
      }
    },
  })

  /** 订阅 RemoteHub 全量事件。 */
  const offHub = hub.onEvent(async (type, payload) => {
    if (!client.isReady()) return
    const s = settings()

    if (type === 'gate:created' && s.pushOnGate) {
      const ticket = payload?.ticket
      if (ticket === undefined) return
      const chatId = resolveTargetChatId(ticket.sessionId)
      if (chatId === '') return
      const sent = await client.sendCard(chatId, buildGateCard({ ticket, botAlias: displayAlias() }))
      if (sent.ok && sent.messageId) {
        client.trackTicketCard(ticket.id, { messageId: sent.messageId, chatId })
      }
      if (s.sendDocFiles && Array.isArray(payload?.attachments) && payload.attachments.length > 0) {
        await client.sendFiles(chatId, payload.attachments, { replyToMessageId: sent.messageId })
      }
      return
    }

    if (type === 'gate:settled') {
      const ticket = payload?.ticket
      if (ticket === undefined) return
      const tracked = client.getTicketCard(ticket.id)
      if (tracked?.messageId) {
        await client.patchCard(tracked.messageId, buildGateResolvedCard({
          ticket,
          action: payload.action,
          label: payload.label ?? payload.action,
          by: payload.by ?? 'desktop',
          note: payload.note ?? '',
          effects: payload.effects,
          botAlias: displayAlias(),
        }))
      }
      return
    }

    if (type === 'brake:tripped' && s.pushOnBrake) {
      const chatId = resolveTargetChatId(payload?.sessionId)
      if (chatId === '') return
      const sent = await client.sendCard(chatId, buildBrakeCard({ brake: payload, botAlias: displayAlias() }))
      if (sent.ok && sent.messageId && payload?.sessionId) {
        client.trackBrakeCard(payload.sessionId, { messageId: sent.messageId, chatId })
      }
      return
    }

    if (type === 'brake:unlocked') {
      const tracked = client.getBrakeCard(payload?.sessionId)
      if (tracked?.messageId) {
        await client.patchCard(tracked.messageId, buildBrakeResolvedCard({
          project: payload?.project ?? '桌面会话',
          reason: payload?.reason ?? 'manual',
          botAlias: displayAlias(),
        }))
      }
      return
    }

    if (type === 'docs:ready' && s.sendDocFiles) {
      const chatId = resolveTargetChatId(payload?.sessionId)
      if (chatId === '' || !Array.isArray(payload?.attachments) || payload.attachments.length === 0) return
      await client.sendFiles(chatId, payload.attachments)
      return
    }

    if (type === 'session:completed' && s.pushOnComplete) {
      const chatId = resolveTargetChatId(payload?.sessionId)
      if (chatId === '') return
      await client.sendCard(chatId, buildSummaryCard({
        title: payload?.title ?? 'Flow 阶段进展',
        project: payload?.project ?? '',
        markdown: payload?.markdown ?? '',
        template: 'green',
        botAlias: displayAlias(),
      }))
    }
  })

  /** 启动或按最新凭证重新建立飞书长连接。 */
  async function connect(override = {}) {
    const s = settings()
    const appId = String(override.appId ?? s.appId).trim()
    const domain = override.domain === 'lark' ? 'lark' : (override.domain === 'feishu' ? 'feishu' : (s.domain || runtimeDomain))
    const secret = await secretStore.load(override.appSecret)
    if (override.appSecret) await secretStore.save(override.appSecret)
    if (appId === '' || secret === '') {
      return { ok: false, reason: '请先扫码创建飞书应用，或填写完整的 App ID 与 App Secret' }
    }
    runtimeAppId = appId
    runtimeDomain = domain
    const verified = await verifyFeishuCredentials({ appId, appSecret: secret, domain })
    if (verified.ok) {
      botProfile = { name: verified.botName, avatarUrl: verified.botAvatarUrl, openId: verified.botOpenId }
    }
    const res = await client.connect({ appId, appSecret: secret, domain })
    if (res.ok) {
      void syncSlashCommands()
    }
    return res
  }

  /**
   * 竞争式拦截 DSH 原生工具审批（`approval/request`）：
   * 桌面端弹窗与手机飞书按钮卡片同时弹出，任意一端先决策即刻生效并同步另一端状态。
   */
  function handleApprovalRequest(request, next) {
    const s = settings()
    if (!client.isReady() || !s.pushOnApproval) return next()
    const session = request?.agent?.session
    const sessionId = String(session?.id ?? request?.agent?.id ?? '')
    const chatId = resolveTargetChatId(sessionId)
    const fallbackOpenId = chatId === '' ? String(s.allowedOpenIds?.[0] ?? '').trim() : ''
    if (chatId === '' && fallbackOpenId === '') return next()

    const origSignal = request?.signal
    if (origSignal?.aborted) return Promise.resolve('cancelled')

    const approvalId = `appr-${randomUUID().slice(0, 10)}`
    const project = projectNameOfCwd(String(session?.header?.cwd ?? ''))
    const toolName = String(request?.toolName ?? request?.name ?? '工具调用')
    const reason = String(request?.reason ?? '')
    let summary = ''
    try {
      const rawInput = request?.input ?? request?.args ?? request?.params
      if (rawInput !== undefined && rawInput !== null) {
        summary = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2)
      }
    } catch { /* 忽略序列化异常 */ }

    const localAc = new AbortController()
    if (request && typeof request === 'object') request.signal = localAc.signal

    let desktopPending = true
    let feishuAvailable = true
    let done = false
    let settledDecision = 'cancelled'
    let settledBy = 'desktop'
    let cardMessageId = ''
    let resolvePromise
    const promise = new Promise((resolve) => { resolvePromise = resolve })

    const settle = (decision, by = 'desktop') => {
      if (done) return false
      done = true
      settledDecision = decision
      settledBy = by
      pendingApprovals.delete(approvalId)
      origSignal?.removeEventListener?.('abort', onOrigAbort)
      if (request && request.signal === localAc.signal) request.signal = origSignal
      if (!localAc.signal.aborted) {
        try { localAc.abort(new Error('approval settled')) } catch { /* 忽略 */ }
      }
      resolvePromise(decision)
      if (cardMessageId !== '') {
        void client.patchCard(cardMessageId, buildToolApprovalResolvedCard({
          project,
          toolName,
          decision,
          by,
          botAlias: displayAlias(),
        }))
      }
      return true
    }

    const onOrigAbort = () => { settle('cancelled', 'system') }
    origSignal?.addEventListener?.('abort', onOrigAbort, { once: true })

    pendingApprovals.set(approvalId, { settle, project, toolName })

    // 1. 竞争拉起桌面原生审批
    Promise.resolve()
      .then(() => (localAc.signal.aborted ? 'cancelled' : next()))
      .then((desktopDecision) => {
        if (desktopDecision === 'allowed-once' || desktopDecision === 'rejected') {
          settle(desktopDecision, 'desktop')
        } else {
          desktopPending = false
          if (!feishuAvailable) settle('unavailable', 'system')
        }
      }, () => {
        desktopPending = false
        if (!feishuAvailable) settle('unavailable', 'system')
      })

    // 2. 同步发送飞书审批互动卡片
    const card = buildToolApprovalCard({
      approvalId,
      project,
      toolName,
      reason,
      summary,
      botAlias: displayAlias(),
    })
    const target = chatId !== '' ? chatId : fallbackOpenId
    const receiveIdType = chatId !== '' ? 'chat_id' : 'open_id'
    void client.sendCard(target, card, { receiveIdType }).then((sent) => {
      if (sent.ok && sent.messageId) {
        cardMessageId = sent.messageId
        if (done) {
          // 发送期间已被桌面端抢先处理，立即按真实决策回写灰态
          void client.patchCard(cardMessageId, buildToolApprovalResolvedCard({
            project,
            toolName,
            decision: settledDecision,
            by: settledBy,
            botAlias: displayAlias(),
          }))
        }
      } else {
        feishuAvailable = false
        if (!desktopPending) settle('unavailable', 'system')
      }
    }).catch(() => {
      feishuAvailable = false
      if (!desktopPending) settle('unavailable', 'system')
    })

    return promise
  }

  /** 启动现有应用的扫码一键补权（开通 / 指令菜单、文件上传、卡片回调）。 */
  function startPermissionUpgrade(input = {}) {
    const s = settings()
    const targetAppId = String(input?.appId ?? s.appId).trim()
    if (targetAppId === '') {
      return { ok: false, reason: '请先绑定或创建飞书应用后再执行补权。' }
    }
    return onboarding.start({
      domain: input?.domain ?? s.domain,
      upgradeAppId: targetAppId,
      botName: s.botName,
    })
  }

  /** 启动阶段按配置自动拉起（不阻塞插件主初始化）。 */
  function autoStart() {
    const s = settings()
    if (!s.enabled || s.appId === '') return
    void connect().catch((error) => {
      logger?.warn?.(`flow: 飞书自动连接失败 → ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** 通用通知发送（供 `src/notify/im.js` 优先调用）。 */
  async function sendNotification({ title, markdown, sessionId, attachments }) {
    if (!client.isReady()) return { ok: false, reason: '飞书长连接未就绪' }
    const chatId = resolveTargetChatId(sessionId)
    if (chatId === '') {
      return { ok: false, reason: '尚未确定飞书推送目标（请先给机器人发任意消息，或在设置页填 defaultChatId）' }
    }
    const cardRes = await client.sendCard(chatId, buildSummaryCard({
      title: title || 'Flow 通知',
      markdown,
      botAlias: displayAlias(),
    }))
    if (cardRes.ok && Array.isArray(attachments) && attachments.length > 0 && settings().sendDocFiles) {
      await client.sendFiles(chatId, attachments, { replyToMessageId: cardRes.messageId })
    }
    return cardRes
  }

  /** 发送一张互动测试卡片验证链路。 */
  async function sendTestCard(override = {}) {
    if (!client.isReady()) {
      const connected = await connect(override)
      if (!connected.ok) return { ok: false, reason: connected.reason }
    }
    const s = settings()
    const targetChatId = String(override.chatId ?? s.defaultChatId).trim()
    const targetOpenId = String(override.openId ?? s.allowedOpenIds?.[0] ?? '').trim()
    const card = buildTestCard({ botAlias: displayAlias(), domain: s.domain, appId: s.appId })

    if (targetChatId !== '') {
      const res = await client.sendCard(targetChatId, card, { receiveIdType: 'chat_id' })
      return res.ok
        ? { ok: true, detail: `已发送飞书测试卡片至会话 ${targetChatId}` }
        : { ok: false, reason: res.reason }
    }
    if (targetOpenId !== '') {
      const res = await client.sendCard(targetOpenId, card, { receiveIdType: 'open_id' })
      return res.ok
        ? { ok: true, detail: `已发送飞书测试卡片至用户 ${targetOpenId}` }
        : { ok: false, reason: res.reason }
    }
    return {
      ok: false,
      reason: '连接已在线，但还没拿到推送目标：请先在飞书里给机器人发一条消息（如 `/m`），或在设置页填好允许用户的 open_id / defaultChatId。',
    }
  }

  async function status() {
    const s = settings()
    const ws = client.status()
    const hasSecret = (await secretStore.load()) !== ''
    return {
      ...ws,
      enabled: s.enabled,
      appId: s.appId || ws.appId,
      hasSecret,
      domain: s.domain,
      botName: botProfile.name || s.botName,
      botAvatarUrl: botProfile.avatarUrl || s.botAvatarUrl,
      localAlias: s.localAlias,
      localAvatar: s.localAvatar,
      defaultChatId: s.defaultChatId,
      allowedCount: s.allowedOpenIds.length,
      openPlatformUrl: openPlatformAppUrl(s.appId || ws.appId, s.domain),
      slashMenu: { ...slashMenuState },
      onboarding: onboarding.status(),
    }
  }

  function presets() {
    return {
      defaultName: DEFAULT_BOT_NAME,
      defaultDescription: DEFAULT_BOT_DESCRIPTION,
      avatars: AVATAR_PRESETS,
    }
  }

  async function verifyCredentials(input) {
    const s = settings()
    const secret = await secretStore.load(input?.appSecret)
    const result = await verifyFeishuCredentials({
      appId: input?.appId ?? s.appId,
      appSecret: secret,
      domain: input?.domain ?? s.domain,
    })
    if (result.ok) {
      botProfile = { name: result.botName, avatarUrl: result.botAvatarUrl, openId: result.botOpenId }
      if (input?.appSecret) await secretStore.save(input.appSecret)
    }
    return result
  }

  async function dispose() {
    offHub()
    onboarding.cancel()
    replyStreamer.dispose()
    for (const entry of [...pendingApprovals.values()]) {
      try { entry.settle('cancelled', 'system') } catch { /* 忽略 */ }
    }
    pendingApprovals.clear()
    await client.disconnect()
  }

  return {
    autoStart,
    connect,
    disconnect: () => client.disconnect(),
    status,
    presets,
    verifyCredentials,
    startOnboarding: (input) => onboarding.start(input),
    startPermissionUpgrade,
    onboardingStatus: () => onboarding.status(),
    cancelOnboarding: () => onboarding.cancel(),
    syncSlashCommands,
    sendWelcomeCard,
    sendTestCard,
    sendNotification,
    handleApprovalRequest,
    onInboxClaimed: (payload) => replyStreamer.onInboxClaimed(payload),
    onAssistantStream: (payload) => replyStreamer.onAssistantStream(payload),
    onSessionEvent: (payload) => replyStreamer.onSessionEvent(payload),
    forgetSession: (sessionId) => replyStreamer.forgetSession(sessionId),
    isReady: () => client.isReady(),
    dispose,
  }
}
