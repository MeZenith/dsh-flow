/**
 * 飞书 WebSocket 长连接客户端与消息/卡片收发封装。
 *
 * 核心特性：
 * - 出站 WSS 长连接（零公网 IP、零服务器、穿透公司/家庭 NAT）；
 * - 有界 `event_id` 去重集合（500 条 LRU），避免飞书重推造成重复执行；
 * - 卡片点击 `card.action.trigger` 严格满足 3 秒 ACK 窗口：立即返回 toast，
 *   真正结算与 `im.v1.message.patch` 原地刷卡片异步完成；
 * - 维护 `ticketCards` / `brakeCards` 映射，确保桌面端操作后也能自动把飞书旧卡片刷成已处理态。
 *
 * @module dsh-flow/remote/feishu/client
 */
import { ensureNoProxyForFeishu, loadFeishuSdk } from './sdk-loader.js'
import { sendFeishuFiles } from './files.js'

const MAX_SEEN_EVENTS = 500
const MAX_TRACKED_CARDS = 200

/**
 * 创建飞书长连接客户端。
 *
 * @param {{
 *   onMessage: (event: object) => Promise<void> | void,
 *   onCardAction: (event: object) => Promise<{ toast?: { type: string, content: string }, card?: object } | void> | { toast?: object, card?: object } | void,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createFeishuClient({ onMessage, onCardAction, onDisconnected, logger, diag = () => {} }) {
  let apiClient = null
  let wsClient = null
  let connectionState = 'disconnected' // disconnected | connecting | connected | error
  let lastError = ''
  let connectedAt = 0
  let currentAppId = ''
  let currentDomain = 'feishu'
  /** 连接代数令牌（P1-5 修复：防止并发 connect 产生僵尸双 WebSocket）。 */
  let connectSeq = 0
  /** 本连接周期内若明确缺少 cardkit:card:write 权限，跳过重复失败请求。 */
  let cardkitDenied = false

  /** 有界事件去重表 */
  const seenEvents = new Set()
  /** ticketId → { messageId, chatId } */
  const ticketCards = new Map()
  /** brakeKey/sessionId → { messageId, chatId } */
  const brakeCards = new Map()

  async function closeWsInstance(instance) {
    if (!instance) return
    try {
      if (typeof instance.close === 'function') await instance.close({ force: true })
      else if (typeof instance.stop === 'function') await instance.stop()
    } catch { /* 忽略关闭异常 */ }
  }

  function effectiveState() {
    if (wsClient !== null && typeof wsClient.getConnectionStatus === 'function') {
      try {
        const raw = String(wsClient.getConnectionStatus() ?? '').toLowerCase()
        if (raw === 'connected' || raw === 'open' || raw === 'ready') return 'connected'
        if (raw === 'connecting' || raw === 'reconnecting') return 'connecting'
        if (raw === 'error' || raw === 'failed') return 'error'
        if (raw === 'disconnected' || raw === 'closed') return 'disconnected'
      } catch { /* 回落内部状态 */ }
    }
    return connectionState
  }

  function markEventSeen(eventId) {
    if (typeof eventId !== 'string' || eventId === '') return false
    if (seenEvents.has(eventId)) return true
    seenEvents.add(eventId)
    if (seenEvents.size > MAX_SEEN_EVENTS) {
      const oldest = seenEvents.values().next().value
      seenEvents.delete(oldest)
    }
    return false
  }

  function rememberCard(map, key, value) {
    if (typeof key !== 'string' || key === '' || !value?.messageId) return
    map.delete(key)
    map.set(key, value)
    if (map.size > MAX_TRACKED_CARDS) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  async function connect({ appId, appSecret, domain = 'feishu' }) {
    const cleanId = String(appId ?? '').trim()
    const cleanSecret = String(appSecret ?? '').trim()
    if (cleanId === '' || cleanSecret === '') {
      connectionState = 'error'
      lastError = '缺少 App ID 或 App Secret'
      return { ok: false, reason: lastError }
    }

    const seq = ++connectSeq
    cardkitDenied = false

    if (wsClient !== null) {
      const prevWs = wsClient
      wsClient = null
      apiClient = null
      connectedAt = 0
      await closeWsInstance(prevWs)
      if (seq !== connectSeq) return { ok: false, reason: '连接请求已被更新的连接替代' }
    }

    const loaded = await loadFeishuSdk()
    if (seq !== connectSeq) return { ok: false, reason: '连接请求已被更新的连接替代' }
    if (!loaded.ok) {
      connectionState = 'error'
      lastError = loaded.reason
      return { ok: false, reason: loaded.reason }
    }

    const { lark } = loaded
    currentAppId = cleanId
    currentDomain = domain === 'lark' ? 'lark' : 'feishu'
    ensureNoProxyForFeishu(currentDomain)

    const sdkDomain = currentDomain === 'lark'
      ? (lark.Domain?.Lark ?? 'https://open.larksuite.com')
      : (lark.Domain?.Feishu ?? 'https://open.feishu.cn')

    connectionState = 'connecting'
    lastError = ''

    let localWs = null
    try {
      const localApi = new lark.Client({
        appId: cleanId,
        appSecret: cleanSecret,
        domain: sdkDomain,
      })

      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          const eventId = data?.event_id ?? data?.header?.event_id ?? data?.message?.message_id ?? ''
          if (markEventSeen(String(eventId))) return
          try {
            await onMessage?.(data)
          } catch (error) {
            logger?.warn?.(`flow: 飞书入站消息处理异常 → ${error instanceof Error ? error.message : String(error)}`)
          }
        },
        'card.action.trigger': async (data) => {
          const eventId = data?.event_id ?? data?.header?.event_id ?? data?.token ?? ''
          if (eventId !== '' && markEventSeen(`card:${eventId}`)) {
            return { toast: { type: 'info', content: '已收到，请勿重复点击' } }
          }
          try {
            const response = await onCardAction?.(data)
            if (response !== undefined && response !== null) return response
            return { toast: { type: 'success', content: '已受理' } }
          } catch (error) {
            logger?.warn?.(`flow: 飞书卡片回调异常 → ${error instanceof Error ? error.message : String(error)}`)
            return { toast: { type: 'error', content: `处理失败：${error instanceof Error ? error.message : String(error)}` } }
          }
        },
      })

      // P1-5 修复：显式开启 pingTimeout 看门狗与生命周期回调，修复休眠唤醒/闪断后的假在线问题。
      localWs = new lark.WSClient({
        appId: cleanId,
        appSecret: cleanSecret,
        domain: sdkDomain,
        loggerLevel: lark.LoggerLevel?.warn ?? 3,
        handshakeTimeoutMs: 15_000,
        wsConfig: { pingTimeout: 10 },
        onReady: () => {
          if (seq !== connectSeq) return
          connectionState = 'connected'
          connectedAt = Date.now()
          lastError = ''
        },
        onReconnecting: () => {
          if (seq !== connectSeq) return
          connectionState = 'connecting'
          diag(`feishu ws reconnecting appId=${cleanId}`)
        },
        onReconnected: () => {
          if (seq !== connectSeq) return
          connectionState = 'connected'
          lastError = ''
          diag(`feishu ws reconnected appId=${cleanId}`)
          logger?.info?.(`flow: 飞书 WebSocket 长连接已自动恢复（${cleanId}）`)
        },
        onError: (err) => {
          if (seq !== connectSeq) return
          connectionState = 'error'
          lastError = err instanceof Error ? err.message : String(err ?? 'WebSocket 异常')
          diag(`feishu ws error=${lastError}`)
          logger?.warn?.(`flow: 飞书 WebSocket 长连接异常断开 → ${lastError}`)
          try { onDisconnected?.(lastError) } catch { /* 忽略 */ }
        },
      })

      await localWs.start({ eventDispatcher: dispatcher })
      if (seq !== connectSeq) {
        await closeWsInstance(localWs)
        return { ok: false, reason: '连接请求已被更新的连接替代' }
      }

      wsClient = localWs
      apiClient = localApi
      connectionState = 'connected'
      connectedAt = Date.now()
      lastError = ''
      diag(`feishu ws connected appId=${cleanId} domain=${currentDomain}`)
      logger?.info?.(`flow: 飞书直连 WebSocket 长连接已建立（${cleanId}）`)
      return { ok: true, appId: cleanId, domain: currentDomain }
    } catch (error) {
      await closeWsInstance(localWs)
      if (seq !== connectSeq) return { ok: false, reason: '连接请求已被更新的连接替代' }
      connectionState = 'error'
      lastError = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`flow: 飞书长连接启动失败 → ${lastError}`)
      wsClient = null
      apiClient = null
      connectedAt = 0
      return { ok: false, reason: lastError }
    }
  }

  async function disconnect() {
    connectSeq += 1
    cardkitDenied = false
    const prevWs = wsClient
    wsClient = null
    apiClient = null
    connectionState = 'disconnected'
    connectedAt = 0
    await closeWsInstance(prevWs)
  }

  /** 发送文本消息到 chat_id。 */
  async function sendText(chatId, text, { replyToMessageId } = {}) {
    if (apiClient === null) return { ok: false, reason: '飞书未连接' }
    const content = JSON.stringify({ text: String(text ?? '') })
    try {
      const res = replyToMessageId
        ? await apiClient.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'text', content },
        })
        : await apiClient.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content },
        })
      if (res?.code !== undefined && res.code !== 0) {
        return { ok: false, reason: `code=${res.code} ${res.msg ?? ''}` }
      }
      return { ok: true, messageId: res?.data?.message_id ?? res?.message_id ?? '' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 发送互动卡片到 chat_id（支持直接回复某条消息）。 */
  async function sendCard(chatId, card, { replyToMessageId, receiveIdType = 'chat_id' } = {}) {
    if (apiClient === null) return { ok: false, reason: '飞书未连接' }
    const content = JSON.stringify(card)
    try {
      const res = replyToMessageId
        ? await apiClient.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content },
        })
        : await apiClient.im.v1.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        })
      if (res?.code !== undefined && res.code !== 0) {
        return { ok: false, reason: `code=${res.code} ${res.msg ?? ''}` }
      }
      return { ok: true, messageId: res?.data?.message_id ?? res?.message_id ?? '' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 原地更新已发出的互动卡片（门禁已结算、熔断已解除或流式刷新时调用）。 */
  async function patchCard(messageId, card) {
    if (apiClient === null || typeof messageId !== 'string' || messageId === '') {
      return { ok: false, reason: '缺少客户端或 messageId' }
    }
    try {
      const res = await apiClient.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      if (res?.code !== undefined && res.code !== 0) {
        return { ok: false, reason: `code=${res.code} ${res.msg ?? ''}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 创建并发送飞书 CardKit 原生流式卡片（无权限或 SDK 不支持时返回 ok: false 由上层平滑降级）。 */
  async function createStreamingCard(chatId, card, { replyToMessageId, receiveIdType = 'chat_id' } = {}) {
    if (cardkitDenied || apiClient === null || typeof apiClient?.cardkit?.v1?.card?.create !== 'function') {
      return { ok: false, reason: cardkitDenied ? 'cardkit-permission-denied' : 'cardkit-unavailable' }
    }
    try {
      const created = await apiClient.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(card),
        },
      })
      if (created?.code !== undefined && created.code !== 0) {
        if (created.code === 99991672 || created.code === 99991640) {
          cardkitDenied = true
          diag(`feishu cardkit permission missing (code=${created.code}); fallback to patchCard for current session`)
        }
        return { ok: false, reason: `code=${created.code} ${created.msg ?? ''}` }
      }
      const cardId = String(created?.data?.card_id ?? '').trim()
      if (cardId === '') return { ok: false, reason: 'missing-card-id' }

      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
      const sent = replyToMessageId
        ? await apiClient.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content },
        })
        : await apiClient.im.v1.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        })
      if (sent?.code !== undefined && sent.code !== 0) {
        return { ok: false, reason: `code=${sent.code} ${sent.msg ?? ''}` }
      }
      return {
        ok: true,
        cardId,
        messageId: String(sent?.data?.message_id ?? sent?.message_id ?? ''),
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (/99991672|99991640/.test(msg)) {
        cardkitDenied = true
        diag(`feishu cardkit permission missing (${msg}); fallback to patchCard for current session`)
      }
      return { ok: false, reason: msg }
    }
  }

  /** CardKit 流式原地刷新 markdown 元素正文（飞书官方打字机动画）。 */
  async function streamCardContent(cardId, markdown, sequence, elementId = 'stream_md') {
    if (apiClient === null || !cardId || typeof apiClient?.cardkit?.v1?.cardElement?.content !== 'function') {
      return { ok: false, reason: 'cardkit-unavailable' }
    }
    try {
      const res = await apiClient.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: {
          content: String(markdown ?? ''),
          sequence,
          uuid: `s_${cardId}_${sequence}`,
        },
      })
      if (res?.code !== undefined && res.code !== 0) {
        return { ok: false, reason: `code=${res.code} ${res.msg ?? ''}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** CardKit 流式收口：关闭 streaming_mode 并用定稿卡片整体更新（含底部快捷按钮）。 */
  async function finishStreamingCard(cardId, finalCard, sequence) {
    if (apiClient === null || !cardId) return { ok: false, reason: 'cardkit-unavailable' }
    try {
      if (typeof apiClient?.cardkit?.v1?.card?.update === 'function') {
        const res = await apiClient.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: {
            card: { type: 'card_json', data: JSON.stringify(finalCard) },
            sequence,
            uuid: `u_${cardId}_${sequence}`,
          },
        })
        if (res?.code === undefined || res.code === 0) return { ok: true }
      }
      if (typeof apiClient?.cardkit?.v1?.card?.settings === 'function') {
        const res = await apiClient.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({ config: { streaming_mode: false } }),
            sequence,
            uuid: `f_${cardId}_${sequence}`,
          },
        })
        if (res?.code === undefined || res.code === 0) return { ok: true }
      }
      return { ok: false, reason: 'cardkit-finish-failed' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 直接上传并发送一批文件到飞书聊天窗口。 */
  async function sendFiles(chatId, attachments, { replyToMessageId } = {}) {
    if (apiClient === null) return []
    return sendFeishuFiles({ client: apiClient, chatId, replyToMessageId, attachments })
  }

  return {
    connect,
    disconnect,
    sendText,
    sendCard,
    patchCard,
    createStreamingCard,
    streamCardContent,
    finishStreamingCard,
    sendFiles,
    getApiClient: () => apiClient,
    trackTicketCard: (ticketId, info) => rememberCard(ticketCards, String(ticketId), info),
    getTicketCard: (ticketId) => ticketCards.get(String(ticketId)),
    clearTicketCard: (ticketId) => ticketCards.delete(String(ticketId)),
    trackBrakeCard: (sessionId, info) => rememberCard(brakeCards, String(sessionId), info),
    getBrakeCard: (sessionId) => brakeCards.get(String(sessionId)),
    clearBrakeCard: (sessionId) => brakeCards.delete(String(sessionId)),
    isReady: () => effectiveState() === 'connected' && apiClient !== null,
    status: () => {
      const state = effectiveState()
      return {
        state,
        connected: state === 'connected',
        appId: currentAppId,
        domain: currentDomain,
        connectedAt,
        lastError,
      }
    },
  }
}
