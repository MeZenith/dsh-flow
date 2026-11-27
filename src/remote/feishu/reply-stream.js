/**
 * 飞书实时流式回复引擎（支持 CardKit 原生流式打字机 + `message.patch` 自动无感降级）。
 *
 * 工作链路：
 * 1. 用户从飞书发消息 → `beginTurn` 立刻发出一张「⏳ 项目名 · 思考中…」动态卡片（带停止按钮）；
 * 2. DSH 广播 `agent/inbox/claimed` → 将本张卡片与真实 `turn` 精准绑定；
 * 3. DSH 广播 `tool/call` → 更新卡片状态提示「🔧 正在执行 read_file…」；
 * 4. DSH 广播 `agent/assistant-stream`（text-delta）→ 节流 ~1s 原地刷新卡片打字机内容；
 * 5. DSH 广播 `assistant/message` → 写入该 step 的权威正文；
 * 6. DSH 广播 `turn/end` → 原地定稿为完整 Markdown 回复卡片 + 底部 `[换项目 / 切模式 / 待办]` 快捷栏；
 *    若回答超长（> 3600 字）自动分片续发，不截断关键内容。
 *
 * 同时支持可选的「同步桌面端对话回复」（默认关闭，仅当用户开启时才为桌面端发起的回合创建飞书流式卡片）。
 *
 * @module dsh-flow/remote/feishu/reply-stream
 */
import { buildFinalReplyCard, buildStreamingReplyCard } from './cards.js'
import { DEFAULT_BOT_NAME } from './presets.js'

const FLUSH_INTERVAL_MS = 1000
const MAX_CARD_TEXT_CHARS = 3600
const STALE_TURN_MS = 30 * 60 * 1000

/** 从 DSH content block 数组提取纯文本。 */
export function extractAssistantText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/** 按段落/换行把超长 Markdown 切分成适合飞书单卡展示的片段。 */
export function splitMarkdownChunks(text, limit = MAX_CARD_TEXT_CHARS) {
  const clean = String(text ?? '').trim()
  if (clean.length <= limit) return clean === '' ? [] : [clean]
  const chunks = []
  let rest = clean
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.45) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.45) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** 单回合助手正文累加器（处理多 step + tool 调用后的正文切分）。 */
export class TurnTextAccumulator {
  constructor() {
    this.steps = new Map()
    this.fallbackText = ''
  }

  clear() {
    this.steps.clear()
    this.fallbackText = ''
  }

  appendDelta(step, index, text) {
    if (typeof text !== 'string' || text === '') return
    const s = Number.isSafeInteger(step) ? step : 0
    const idx = Number.isSafeInteger(index) ? index : 0
    this.fallbackText = ''
    let parts = this.steps.get(s)
    if (!parts) {
      parts = new Map()
      this.steps.set(s, parts)
    }
    parts.set(idx, (parts.get(idx) ?? '') + text)
  }

  setCanonical(step, text) {
    const clean = String(text ?? '').trim()
    if (clean === '') return
    if (!Number.isSafeInteger(step)) {
      this.steps.clear()
      this.fallbackText = clean
      return
    }
    this.fallbackText = ''
    this.steps.set(step, new Map([[0, clean]]))
  }

  get text() {
    if (this.steps.size === 0) return this.fallbackText
    return [...this.steps.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, parts]) => [...parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v)
        .join('')
        .trim())
      .filter(Boolean)
      .join('\n\n')
  }
}

function terminalReasonKind(event) {
  const raw = event?.data?.reason
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.kind === 'string') return raw.kind
  return 'completed'
}

/**
 * 创建飞书流式回复管理器。
 *
 * @param {{
 *   client: object,
 *   getBotAlias: () => string,
 *   getConfig: () => object,
 *   resolveTargetChatId: (sessionId: string) => string,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (msg: string) => void,
 * }} deps
 */
export function createFeishuReplyStreamer({
  client,
  getBotAlias,
  getConfig,
  resolveTargetChatId,
  logger,
  diag = () => {},
}) {
  /** 活跃流式回复任务（按 sessionId 索引当前最新进行中的槽位；同时按 messageId 映射等待 claim 的队列）。 */
  const activeBySession = new Map()
  const pendingByMessageId = new Map()
  const streamMetaBySession = new Map()

  function alias() {
    return getBotAlias?.() || DEFAULT_BOT_NAME
  }

  function clearTimer(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  function cleanup(entry) {
    clearTimer(entry)
    if (entry.inboxMessageId) pendingByMessageId.delete(entry.inboxMessageId)
    if (activeBySession.get(entry.sessionId) === entry) {
      activeBySession.delete(entry.sessionId)
    }
  }

  function previewMarkdown(entry) {
    const live = entry.acc.text
    if (live !== '') {
      const clipped = live.length > MAX_CARD_TEXT_CHARS
        ? `${live.slice(0, MAX_CARD_TEXT_CHARS - 24)}\n\n…（输出较长，完成后将完整呈现）`
        : live
      return entry.toolHint ? `${clipped}\n\n_${entry.toolHint}_` : clipped
    }
    return entry.toolHint || '⏳ 正在思考…'
  }

  /** 将最新预览节流推给飞书（支持 CardKit 流式与 message.patch 两种通道）。 */
  async function flushNow(entry) {
    if (entry.finalized) return
    await entry.readyPromise
    if (entry.finalized) return
    const md = previewMarkdown(entry)
    if (md === entry.lastPushedText) return
    entry.lastPushedText = md

    try {
      if (entry.transport === 'cardkit' && entry.cardId) {
        entry.sequence += 1
        const res = await client.streamCardContent(entry.cardId, md, entry.sequence)
        if (!res.ok) {
          // CardKit 中途更新异常时安全回落 patchCard
          if (entry.messageId) {
            await client.patchCard(entry.messageId, buildStreamingReplyCard({
              project: entry.project,
              mode: entry.mode,
              sessionId: entry.sessionId,
              markdown: md,
              botAlias: alias(),
            }))
          }
        }
      } else if (entry.messageId) {
        await client.patchCard(entry.messageId, buildStreamingReplyCard({
          project: entry.project,
          mode: entry.mode,
          sessionId: entry.sessionId,
          markdown: md,
          botAlias: alias(),
        }))
      }
    } catch (error) {
      logger?.warn?.(`flow: 飞书流式刷新异常 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function scheduleFlush(entry) {
    if (entry.finalized) return
    if (entry.timer !== null) return
    const elapsed = Date.now() - entry.lastFlushAt
    const wait = elapsed >= FLUSH_INTERVAL_MS ? 60 : FLUSH_INTERVAL_MS - elapsed
    entry.timer = setTimeout(() => {
      entry.timer = null
      entry.lastFlushAt = Date.now()
      void flushNow(entry)
    }, wait)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()
  }

  /** 启动一张流式回复卡片（发送初始「思考中」卡片）。 */
  function createEntry({ sessionId, chatId, replyToMessageId, project, mode, inboxMessageId = '', origin = 'feishu' }) {
    // 若同一会话有旧的滞留未结束卡片，先收口释放定时器
    const prev = activeBySession.get(sessionId)
    if (prev && Date.now() - prev.createdAt > STALE_TURN_MS) cleanup(prev)

    const entry = {
      sessionId,
      chatId,
      replyToMessageId,
      project: project || '桌面会话',
      mode: mode || 'off',
      inboxMessageId,
      origin,
      turn: null,
      acc: new TurnTextAccumulator(),
      toolHint: '⏳ 正在思考…',
      transport: 'patch', // 'cardkit' | 'patch'
      cardId: '',
      messageId: '',
      sequence: 0,
      lastPushedText: '',
      lastFlushAt: 0,
      timer: null,
      finalized: false,
      createdAt: Date.now(),
      readyPromise: null,
    }

    const initialCard = buildStreamingReplyCard({
      project: entry.project,
      mode: entry.mode,
      sessionId: entry.sessionId,
      markdown: entry.toolHint,
      botAlias: alias(),
      streaming: true,
    })

    entry.readyPromise = (async () => {
      // 优先尝试飞书官方 CardKit 原生流式卡片，不具备权限时自动降级普通可 patch 卡片
      if (typeof client.createStreamingCard === 'function') {
        const ck = await client.createStreamingCard(chatId, initialCard, { replyToMessageId })
        if (ck.ok && ck.cardId && ck.messageId) {
          entry.transport = 'cardkit'
          entry.cardId = ck.cardId
          entry.messageId = ck.messageId
          entry.lastPushedText = entry.toolHint
          diag(`feishu reply stream started via cardkit session=${sessionId} cardId=${ck.cardId}`)
          return
        }
      }
      const fallbackCard = buildStreamingReplyCard({
        project: entry.project,
        mode: entry.mode,
        sessionId: entry.sessionId,
        markdown: entry.toolHint,
        botAlias: alias(),
        streaming: false,
      })
      const sent = await client.sendCard(chatId, fallbackCard, { replyToMessageId })
      if (sent.ok && sent.messageId) {
        entry.transport = 'patch'
        entry.messageId = sent.messageId
        entry.lastPushedText = entry.toolHint
        diag(`feishu reply stream started via patch session=${sessionId} msg=${sent.messageId}`)
      }
    })().catch((error) => {
      logger?.warn?.(`flow: 飞书创建回复卡片失败 → ${error instanceof Error ? error.message : String(error)}`)
    })

    activeBySession.set(sessionId, entry)
    if (inboxMessageId) pendingByMessageId.set(inboxMessageId, entry)
    return entry
  }

  /** 由飞书路由器在派活成功后立即调用。 */
  function beginTurn({ sessionId, chatId, replyToMessageId, project, mode, inboxMessageId }) {
    if (!sessionId || !chatId || !client.isReady()) return null
    return createEntry({ sessionId, chatId, replyToMessageId, project, mode, inboxMessageId, origin: 'feishu' })
  }

  /** 将流式回复卡片收口为最终定稿卡片（含超长分片续发）。 */
  async function finalizeEntry(entry, reasonKind = 'completed') {
    if (!entry || entry.finalized) return
    entry.finalized = true
    cleanup(entry)
    await entry.readyPromise

    const rawText = entry.acc.text.trim()
    const isAborted = reasonKind === 'cancelled' || reasonKind === 'aborted' || reasonKind === 'abort'
    const isError = reasonKind === 'error' || reasonKind === 'failed'
    const finalText = rawText !== ''
      ? rawText
      : (isAborted ? '⏹ 已停止本次回答。' : isError ? '⚠️ 本轮执行异常中断，请在桌面端查看详情。' : '✅ 本轮执行已完成。')

    const chunks = splitMarkdownChunks(finalText, MAX_CARD_TEXT_CHARS)
    const firstChunk = chunks[0] ?? finalText
    const finalCard = buildFinalReplyCard({
      project: entry.project,
      mode: entry.mode,
      sessionId: entry.sessionId,
      markdown: firstChunk,
      status: isAborted ? 'aborted' : isError ? 'error' : 'completed',
      partInfo: chunks.length > 1 ? `1/${chunks.length}` : '',
      botAlias: alias(),
    })

    try {
      if (entry.transport === 'cardkit' && entry.cardId && typeof client.finishStreamingCard === 'function') {
        entry.sequence += 1
        const done = await client.finishStreamingCard(entry.cardId, finalCard, entry.sequence)
        if (!done.ok && entry.messageId) {
          await client.patchCard(entry.messageId, finalCard)
        }
      } else if (entry.messageId) {
        await client.patchCard(entry.messageId, finalCard)
      } else if (entry.chatId) {
        await client.sendCard(entry.chatId, finalCard, { replyToMessageId: entry.replyToMessageId })
      }

      // 超长回复后续分片
      for (let i = 1; i < chunks.length; i += 1) {
        const contCard = buildFinalReplyCard({
          project: entry.project,
          mode: entry.mode,
          sessionId: entry.sessionId,
          markdown: chunks[i],
          status: 'completed',
          partInfo: `${i + 1}/${chunks.length}`,
          showActions: i === chunks.length - 1,
          botAlias: alias(),
        })
        await client.sendCard(entry.chatId, contCard)
      }
    } catch (error) {
      logger?.warn?.(`flow: 飞书定稿回复卡片失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /* ---- 接收 DSH 宿主事件 ---- */

  function onInboxClaimed({ sessionId, messageId, turn }) {
    if (!sessionId) return
    const entry = (messageId && pendingByMessageId.get(messageId)) || activeBySession.get(sessionId)
    if (!entry) return
    if (messageId) pendingByMessageId.delete(messageId)
    if (Number.isSafeInteger(turn)) entry.turn = turn
  }

  function ensureEntryForDesktopSync({ sessionId, project, mode, turn }) {
    if (getConfig?.()?.feishu?.syncDesktopReplies !== true) return undefined
    if (!client.isReady()) return undefined
    const existing = activeBySession.get(sessionId)
    if (existing) return existing
    const chatId = resolveTargetChatId?.(sessionId) || ''
    if (chatId === '') return undefined
    const created = createEntry({ sessionId, chatId, project, mode, origin: 'desktop' })
    if (Number.isSafeInteger(turn)) created.turn = turn
    return created
  }

  function onAssistantStream({ sessionId, frame, project, mode }) {
    if (!sessionId || !frame || typeof frame !== 'object') return
    if (frame.type === 'start') {
      streamMetaBySession.set(sessionId, { attemptId: frame.attemptId, turn: frame.turn, step: frame.step })
      return
    }
    if (frame.type === 'end') {
      streamMetaBySession.delete(sessionId)
      return
    }
    if (frame.type !== 'chunk') return
    const meta = streamMetaBySession.get(sessionId)
    const turn = meta?.turn ?? frame.turn
    const step = meta?.step ?? frame.step ?? 0

    let entry = activeBySession.get(sessionId)
    if (!entry) {
      entry = ensureEntryForDesktopSync({ sessionId, project, mode, turn })
    }
    if (!entry || entry.finalized) return
    if (entry.turn !== null && Number.isSafeInteger(turn) && entry.turn !== turn) return
    if (entry.turn === null && Number.isSafeInteger(turn)) entry.turn = turn

    const chunk = frame.chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      entry.toolHint = ''
      entry.acc.appendDelta(step, chunk.index, chunk.text)
      scheduleFlush(entry)
    }
  }

  function onSessionEvent({ sessionId, event, project, mode }) {
    if (!sessionId || !event || typeof event !== 'object') return
    const type = event.type
    const turn = event.data?.turn

    if (type === 'turn/start') {
      const existing = activeBySession.get(sessionId)
      if (existing && existing.turn === null && Number.isSafeInteger(turn)) {
        existing.turn = turn
      }
      return
    }

    let entry = activeBySession.get(sessionId)
    if (!entry && (type === 'assistant/message' || type === 'tool/call')) {
      entry = ensureEntryForDesktopSync({ sessionId, project, mode, turn })
    }
    if (!entry || entry.finalized) return
    if (entry.turn !== null && Number.isSafeInteger(turn) && entry.turn !== turn) return
    if (entry.turn === null && Number.isSafeInteger(turn)) entry.turn = turn

    if (type === 'tool/call') {
      const toolName = String(event.data?.name ?? event.data?.toolName ?? '工具').trim()
      // 保留最终答复的干净性：调用工具前的过渡自言自语清掉，换上实时工具进度
      entry.acc.clear()
      entry.toolHint = `🔧 正在执行 \`${toolName}\`…`
      scheduleFlush(entry)
      return
    }

    if (type === 'assistant/message') {
      const content = event.data?.message?.content
      const hasToolCall = Array.isArray(content) && content.some(part => part?.type === 'tool-call')
      const text = extractAssistantText(content)
      if (hasToolCall || text === '') {
        if (hasToolCall) entry.acc.clear()
      } else {
        entry.toolHint = ''
        entry.acc.setCanonical(event.data?.step, text)
        scheduleFlush(entry)
      }
      return
    }

    if (type === 'turn/end') {
      void finalizeEntry(entry, terminalReasonKind(event))
    }
  }

  function forgetSession(sessionId) {
    streamMetaBySession.delete(sessionId)
    const entry = activeBySession.get(sessionId)
    if (entry) cleanup(entry)
  }

  function dispose() {
    for (const entry of [...activeBySession.values()]) clearTimer(entry)
    activeBySession.clear()
    pendingByMessageId.clear()
    streamMetaBySession.clear()
  }

  return {
    beginTurn,
    onInboxClaimed,
    onAssistantStream,
    onSessionEvent,
    forgetSession,
    dispose,
  }
}
