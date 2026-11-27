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

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/

function parseFenceOpen(line) {
  const m = FENCE_OPEN_RE.exec(line)
  if (!m) return null
  const marker = m[1]
  const rest = m[2] ?? ''
  if (marker[0] === '`' && rest.includes('`')) return null
  return { char: marker[0], len: marker.length, header: line }
}

function isFenceClose(line, fence) {
  if (!fence) return false
  const trimmed = line.trim()
  if (trimmed.length < fence.len) return false
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fence.char) return false
  }
  return true
}

function unclosedFenceOf(markdown) {
  let fence = null
  for (const line of String(markdown ?? '').split('\n')) {
    if (!fence) {
      const opened = parseFenceOpen(line)
      if (opened) fence = opened
    } else if (isFenceClose(line, fence)) {
      fence = null
    }
  }
  return fence
}

/**
 * 状态感知 Markdown 分片器（P1-2 修复）：
 * - 切分跨越围栏代码块（``` / ~~~）时，自动在上片闭合围栏、下片按原语言重开围栏；
 * - 切分跨越 Markdown 表格时，自动在下一分片开头复写表头与分隔线；
 * - 超长单行仍按字符上限安全切分。
 */
export function splitMarkdownChunks(text, limit = MAX_CARD_TEXT_CHARS) {
  const clean = String(text ?? '').trim()
  if (clean === '') return []
  const maxLen = Math.max(120, Number(limit) || MAX_CARD_TEXT_CHARS)
  if (clean.length <= maxLen) return [clean]

  const lines = clean.split('\n')
  const chunks = []
  let buf = []
  let bufLen = 0
  let fence = null
  let tableHeader = null // [headerLine, sepLine]

  const closingReserve = () => (fence ? fence.len + 1 : 0)

  const flushChunk = ({ reopenFence = true, reopenTable = false } = {}) => {
    if (buf.length === 0) return
    const outLines = [...buf]
    if (fence && reopenFence) {
      outLines.push(fence.char.repeat(fence.len))
    }
    const piece = outLines.join('\n').trim()
    if (piece !== '') chunks.push(piece)
    buf = []
    bufLen = 0
    if (fence && reopenFence) {
      buf.push(fence.header)
      bufLen = fence.header.length
    } else if (reopenTable && tableHeader) {
      buf.push(tableHeader[0], tableHeader[1])
      bufLen = tableHeader[0].length + 1 + tableHeader[1].length
    }
  }

  const pushLine = (line) => {
    if (buf.length === 0) {
      buf.push(line)
      bufLen = line.length
    } else {
      buf.push(line)
      bufLen += 1 + line.length
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    // 表格起止识别（仅在代码块外生效）
    if (!fence) {
      if (!tableHeader && TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const headerBlockLen = line.length + 1 + lines[i + 1].length
        if (buf.length > 0 && bufLen + 1 + headerBlockLen > maxLen) {
          flushChunk({ reopenFence: false, reopenTable: false })
        }
        tableHeader = [line, lines[i + 1]]
        pushLine(line)
        pushLine(lines[i + 1])
        i += 1
        continue
      }
      if (tableHeader && !TABLE_ROW_RE.test(line)) {
        tableHeader = null
      }
    }

    const nextFenceState = (() => {
      if (!fence) {
        const opened = parseFenceOpen(line)
        return opened ? { kind: 'open', fence: opened } : { kind: 'none' }
      }
      return isFenceClose(line, fence) ? { kind: 'close' } : { kind: 'inside' }
    })()

    const extraClose = nextFenceState.kind === 'close' ? 0 : closingReserve()
    const projected = buf.length === 0 ? line.length : bufLen + 1 + line.length

    if (projected + extraClose > maxLen) {
      if (buf.length > 0) {
        // 如果当前块里仅有表格表头而无数据行，先不拆分表头
        const onlyTableHeader = !fence && tableHeader && buf.length <= 2
        if (!onlyTableHeader) {
          flushChunk({ reopenFence: fence !== null, reopenTable: !fence && tableHeader !== null })
        }
      }

      // 单行本身超过上限时按字符安全切分
      const safeCap = Math.max(40, maxLen - (buf.length > 0 ? bufLen + 1 : 0) - closingReserve())
      if (line.length > safeCap && nextFenceState.kind !== 'open' && nextFenceState.kind !== 'close') {
        let rest = line
        while (rest.length > 0) {
          const cap = Math.max(40, maxLen - (buf.length > 0 ? bufLen + 1 : 0) - closingReserve())
          const part = rest.slice(0, cap)
          rest = rest.slice(cap)
          pushLine(part)
          if (rest.length > 0) {
            flushChunk({ reopenFence: fence !== null, reopenTable: !fence && tableHeader !== null })
          }
        }
        continue
      }
    }

    pushLine(line)
    if (nextFenceState.kind === 'open') {
      fence = nextFenceState.fence
      tableHeader = null
    } else if (nextFenceState.kind === 'close') {
      fence = null
    }
  }

  flushChunk({ reopenFence: fence !== null, reopenTable: false })
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
  /**
   * 多回合并发索引（修复 P0-3 单槽覆盖 + 真实 DSH 同步 claim 竞态）：
   * - `entriesByTurn`: `${sessionId}:${turn}` → 已绑定具体 turn 的活跃流式卡片；
   * - `pendingByMessageId`: `inboxMessageId` → 等待 DSH `agent/inbox/claimed` 认领的卡片；
   * - `claimedTurnsByMessageId`: `inboxMessageId` → 真实 DSH 空闲会话下 `agent.followup()` 会在
   *   `beginTurn()` 之前同步触发 `agent/inbox/claimed`，此处暂存认领结果供 `beginTurn()` 即刻绑定；
   * - `unclaimedBySession`: `sessionId` → 未携带 inboxMessageId 的 FIFO 兜底队列；
   * - `allEntries`: 全部存活卡片，便于超时回收与会话卸载清理。
   */
  const entriesByTurn = new Map()
  const pendingByMessageId = new Map()
  const claimedTurnsByMessageId = new Map()
  const unclaimedBySession = new Map()
  const allEntries = new Set()
  const streamMetaBySession = new Map()
  const CLAIMED_STASH_TTL_MS = 60_000
  const MAX_CLAIMED_STASH = 200

  function stashClaimedTurn(messageId, sessionId, turn) {
    if (!messageId || !sessionId || !Number.isSafeInteger(turn)) return
    const now = Date.now()
    for (const [k, v] of claimedTurnsByMessageId) {
      if (now - v.at > CLAIMED_STASH_TTL_MS) claimedTurnsByMessageId.delete(k)
    }
    claimedTurnsByMessageId.delete(messageId)
    claimedTurnsByMessageId.set(messageId, { sessionId, turn, at: now })
    if (claimedTurnsByMessageId.size > MAX_CLAIMED_STASH) {
      const oldest = claimedTurnsByMessageId.keys().next().value
      claimedTurnsByMessageId.delete(oldest)
    }
  }

  function turnKey(sessionId, turn) {
    return `${sessionId}:${turn}`
  }

  function alias() {
    return getBotAlias?.() || DEFAULT_BOT_NAME
  }

  function clearTimer(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  function removeUnclaimed(entry) {
    const queue = unclaimedBySession.get(entry.sessionId)
    if (!queue) return
    const idx = queue.indexOf(entry)
    if (idx !== -1) queue.splice(idx, 1)
    if (queue.length === 0) unclaimedBySession.delete(entry.sessionId)
  }

  function cleanup(entry) {
    clearTimer(entry)
    allEntries.delete(entry)
    if (entry.inboxMessageId && pendingByMessageId.get(entry.inboxMessageId) === entry) {
      pendingByMessageId.delete(entry.inboxMessageId)
    }
    removeUnclaimed(entry)
    if (entry.turn !== null) {
      const k = turnKey(entry.sessionId, entry.turn)
      if (entriesByTurn.get(k) === entry) entriesByTurn.delete(k)
    }
  }

  function bindTurn(entry, turn) {
    if (!entry || entry.finalized || !Number.isSafeInteger(turn)) return
    if (entry.turn === turn) return
    if (entry.turn !== null) {
      const oldKey = turnKey(entry.sessionId, entry.turn)
      if (entriesByTurn.get(oldKey) === entry) entriesByTurn.delete(oldKey)
    }
    if (entry.inboxMessageId && pendingByMessageId.get(entry.inboxMessageId) === entry) {
      pendingByMessageId.delete(entry.inboxMessageId)
    }
    removeUnclaimed(entry)
    entry.turn = turn
    entriesByTurn.set(turnKey(entry.sessionId, turn), entry)
  }

  function shiftUnclaimed(sessionId) {
    const queue = unclaimedBySession.get(sessionId)
    if (!queue || queue.length === 0) return undefined
    while (queue.length > 0) {
      const head = queue.shift()
      if (queue.length === 0) unclaimedBySession.delete(sessionId)
      if (head && !head.finalized) return head
    }
    return undefined
  }

  function findActiveForSession(sessionId, turn) {
    if (Number.isSafeInteger(turn)) {
      const exact = entriesByTurn.get(turnKey(sessionId, turn))
      if (exact && !exact.finalized) return exact
      // 仅对未指定 inboxMessageId 的兜底条目绑定 turn，绝不抢绑正在排队等待 onInboxClaimed 的飞书卡片！
      const unclaimed = shiftUnclaimed(sessionId)
      if (unclaimed) {
        bindTurn(unclaimed, turn)
        return unclaimed
      }
      return undefined
    }
    // 未提供 turn 时，仅在当前会话恰好只有 1 个已绑定条目时命中
    let sole
    for (const entry of entriesByTurn.values()) {
      if (entry.sessionId !== sessionId || entry.finalized) continue
      if (sole !== undefined) return undefined
      sole = entry
    }
    if (sole !== undefined) return sole
    const queue = unclaimedBySession.get(sessionId)
    return queue?.find(e => !e.finalized)
  }

  function syncEntryMode(entry, mode) {
    if (typeof mode === 'string' && mode !== '' && entry.mode !== mode) {
      entry.mode = mode
    }
  }

  function previewMarkdown(entry) {
    const live = entry.acc.text
    if (live !== '') {
      let clipped = live
      if (live.length > MAX_CARD_TEXT_CHARS) {
        const head = live.slice(0, MAX_CARD_TEXT_CHARS - 36)
        const openFence = unclosedFenceOf(head)
        const closeLine = openFence ? `\n${openFence.char.repeat(openFence.len)}` : ''
        clipped = `${head}${closeLine}\n\n…（输出较长，完成后将完整呈现）`
      }
      return entry.toolHint ? `${clipped}\n\n_${entry.toolHint}_` : clipped
    }
    return entry.toolHint || '⏳ 正在思考…'
  }

  /** 按卡片严格串行化更新任务，确保 CardKit `sequence` 单调递增且终态绝不被旧刷新倒灌覆盖（P1-1 修复）。 */
  function enqueue(entry, task) {
    const next = entry.queue.then(task, task)
    entry.queue = next.catch(() => {})
    return next
  }

  /** 将最新预览节流推给飞书（支持 CardKit 流式与 message.patch 两种通道）。 */
  function flushNow(entry) {
    if (entry.finalized) return Promise.resolve()
    return enqueue(entry, async () => {
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
          if (entry.finalized) return
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
    })
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
  function createEntry({ sessionId, chatId, replyToMessageId, project, mode, inboxMessageId = '', origin = 'feishu', turn = null }) {
    // 清理同一会话超龄滞留的死卡片，不影响正在并发运行的其他回合
    const now = Date.now()
    for (const prev of [...allEntries]) {
      if (prev.sessionId === sessionId && now - prev.createdAt > STALE_TURN_MS) {
        cleanup(prev)
      }
    }

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
      createdAt: now,
      queue: Promise.resolve(),
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

    allEntries.add(entry)
    if (Number.isSafeInteger(turn)) {
      bindTurn(entry, turn)
    } else if (inboxMessageId) {
      const earlyClaim = claimedTurnsByMessageId.get(inboxMessageId)
      if (earlyClaim && earlyClaim.sessionId === sessionId && Number.isSafeInteger(earlyClaim.turn)) {
        claimedTurnsByMessageId.delete(inboxMessageId)
        bindTurn(entry, earlyClaim.turn)
      } else {
        pendingByMessageId.set(inboxMessageId, entry)
      }
    } else {
      const queue = unclaimedBySession.get(sessionId) ?? []
      queue.push(entry)
      unclaimedBySession.set(sessionId, queue)
    }
    return entry
  }

  /** 由飞书路由器在派活成功后立即调用。 */
  function beginTurn({ sessionId, chatId, replyToMessageId, project, mode, inboxMessageId }) {
    if (!sessionId || !chatId || !client.isReady()) return null
    return createEntry({ sessionId, chatId, replyToMessageId, project, mode, inboxMessageId, origin: 'feishu' })
  }

  /** 将流式回复卡片收口为最终定稿卡片（串行排在所有在途 flush 之后，含超长分片续发）。 */
  function finalizeEntry(entry, reasonKind = 'completed') {
    if (!entry || entry.finalized) return Promise.resolve()
    entry.finalized = true
    cleanup(entry)

    return enqueue(entry, async () => {
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
    })
  }

  /* ---- 接收 DSH 宿主事件 ---- */

  function onInboxClaimed({ sessionId, messageId, turn }) {
    if (!sessionId) return
    const cleanMsgId = String(messageId ?? '').trim()
    let entry
    if (cleanMsgId !== '') {
      entry = pendingByMessageId.get(cleanMsgId)
      if (!entry) {
        // 真实 DSH 空闲会话会在 agent.followup() 内同步触发 agent/inbox/claimed，
        // 此时 router.js 尚未调用 beginTurn()，先暂存 (messageId -> turn) 供 beginTurn() 即刻绑定。
        if (Number.isSafeInteger(turn)) stashClaimedTurn(cleanMsgId, sessionId, turn)
        return
      }
    } else {
      entry = shiftUnclaimed(sessionId)
      if (!entry) return
    }
    if (entry.finalized) return
    if (Number.isSafeInteger(turn)) bindTurn(entry, turn)
  }

  function ensureEntryForDesktopSync({ sessionId, project, mode, turn }) {
    if (getConfig?.()?.feishu?.syncDesktopReplies !== true) return undefined
    if (!client.isReady()) return undefined
    const existing = findActiveForSession(sessionId, turn)
    if (existing) return existing
    const chatId = resolveTargetChatId?.(sessionId) || ''
    if (chatId === '') return undefined
    return createEntry({
      sessionId,
      chatId,
      project,
      mode,
      origin: 'desktop',
      turn: Number.isSafeInteger(turn) ? turn : null,
    })
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

    let entry = findActiveForSession(sessionId, turn)
    if (!entry) {
      entry = ensureEntryForDesktopSync({ sessionId, project, mode, turn })
    }
    if (!entry || entry.finalized) return
    if (entry.turn !== null && Number.isSafeInteger(turn) && entry.turn !== turn) return
    if (entry.turn === null && Number.isSafeInteger(turn)) bindTurn(entry, turn)
    syncEntryMode(entry, mode)

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
      if (Number.isSafeInteger(turn) && !entriesByTurn.has(turnKey(sessionId, turn))) {
        const unclaimed = shiftUnclaimed(sessionId)
        if (unclaimed) {
          bindTurn(unclaimed, turn)
          syncEntryMode(unclaimed, mode)
        }
      }
      return
    }

    let entry = findActiveForSession(sessionId, turn)
    if (!entry && (type === 'assistant/message' || type === 'tool/call')) {
      entry = ensureEntryForDesktopSync({ sessionId, project, mode, turn })
    }
    if (!entry || entry.finalized) return
    if (entry.turn !== null && Number.isSafeInteger(turn) && entry.turn !== turn) return
    if (entry.turn === null && Number.isSafeInteger(turn)) bindTurn(entry, turn)
    syncEntryMode(entry, mode)

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
    for (const entry of [...allEntries]) {
      if (entry.sessionId === sessionId) cleanup(entry)
    }
    for (const [k, v] of claimedTurnsByMessageId) {
      if (v.sessionId === sessionId) claimedTurnsByMessageId.delete(k)
    }
    unclaimedBySession.delete(sessionId)
  }

  function dispose() {
    for (const entry of [...allEntries]) clearTimer(entry)
    allEntries.clear()
    entriesByTurn.clear()
    pendingByMessageId.clear()
    claimedTurnsByMessageId.clear()
    unclaimedBySession.clear()
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
