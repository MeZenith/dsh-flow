/**
 * 飞书双向指挥路由器：处理所有入站文本消息与互动卡片回调。
 *
 * 核心体验（直击痛点）：
 * - **任意工作区随时指挥**：输入 `/m` 弹工作区/会话选择卡片，点一下即切目标；或直接 `@项目名 帮我修复登录bug`；
 * - **群聊话题隔离**：在群聊里不同话题（`root_id`）自动绑定不同项目，互不串线；
 * - **私聊多项目焦点**：自动记住上次聚焦项目，随手发消息即直达该桌面会话；
 * - **门禁 & 熔断卡片一键拍板**：按钮点击 3 秒内秒回 toast，异步结算并原地把卡片置灰防误点；
 * - **严格白名单守门**：配置了 `allowedOpenIds` 后，非白名单用户一律拒绝执行任何操作。
 *
 * @module dsh-flow/remote/feishu/router
 */
import {
  buildBrakeCard,
  buildBrakeResolvedCard,
  buildGateCard,
  buildGateResolvedCard,
  buildModeCard,
  buildSummaryCard,
  buildWelcomeCard,
  buildWorkspaceCard,
} from './cards.js'
import { DEFAULT_BOT_NAME } from './presets.js'

/** 从飞书 `im.message.receive_v1` 内容 JSON 提取纯文本并去除 @机器人 占位符。 */
export function parseFeishuMessageText(message) {
  if (message?.message_type !== 'text') return ''
  let text = ''
  try {
    const parsed = JSON.parse(String(message.content ?? '{}'))
    text = String(parsed?.text ?? '')
  } catch {
    text = String(message?.content ?? '')
  }
  // 去掉飞书群聊里的 `@_user_1` 占位符
  return text.replace(/@_user_\d+/g, '').trim()
}

/** 构造会话绑定键（群聊按 chatId+rootId 话题隔离，私聊按 openId）。 */
function bindingKeyOf({ chatType, chatId, rootId, senderOpenId }) {
  if (chatType === 'group') {
    return rootId ? `group:${chatId}:${rootId}` : `group:${chatId}`
  }
  return `p2p:${senderOpenId || chatId}`
}

/**
 * 创建飞书双向指挥路由器。
 *
 * @param {{
 *   hub: ReturnType<typeof import('../hub.js').createRemoteHub>,
 *   client: ReturnType<typeof import('./client.js').createFeishuClient>,
 *   stateStore?: object,
 *   getConfig: () => object,
 *   onChatDiscovered?: (chatId: string, senderOpenId: string) => void,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createFeishuRouter({
  hub,
  client,
  stateStore,
  getConfig,
  replyStreamer,
  resolveApproval,
  onChatDiscovered,
  logger,
  diag = () => {},
}) {
  function botAlias() {
    const cfg = getConfig()?.feishu ?? {}
    return String(cfg.localAlias || cfg.botName || DEFAULT_BOT_NAME).trim() || DEFAULT_BOT_NAME
  }

  /** 严格白名单校验。 */
  function isAllowedUser(openId) {
    const list = getConfig()?.feishu?.allowedOpenIds
    if (!Array.isArray(list) || list.length === 0) return true
    const clean = String(openId ?? '').trim()
    if (clean === '') return false
    return list.some(item => String(item ?? '').trim() === clean)
  }

  function getBinding(key, isGroup) {
    if (isGroup) return stateStore?.getFeishuThread?.(key)
    return stateStore?.getFeishuFocus?.(key)
  }

  function setBinding(key, isGroup, binding) {
    if (isGroup) stateStore?.setFeishuThread?.(key, binding)
    else stateStore?.setFeishuFocus?.(key, binding)
  }

  /** 尝试把项目名/路径匹配到在线会话或工作区。 */
  async function matchProjectOrSession(query) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (needle === '') return undefined
    const sessions = hub.listSessions()
    const exactSession = sessions.find(s => s.project.toLowerCase() === needle || s.sessionId.toLowerCase() === needle)
    if (exactSession) return { sessionId: exactSession.sessionId, cwd: exactSession.cwd, project: exactSession.project }
    const fuzzySession = sessions.find(s => s.project.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle))
    if (fuzzySession) return { sessionId: fuzzySession.sessionId, cwd: fuzzySession.cwd, project: fuzzySession.project }
    const workspaces = await hub.listWorkspaces()
    const ws = workspaces.find(w => w.name.toLowerCase() === needle || w.name.toLowerCase().includes(needle) || w.cwd.toLowerCase() === needle)
    if (ws) return { sessionId: ws.sessions?.[0]?.sessionId ?? '', cwd: ws.cwd, project: ws.name }
    return undefined
  }

  /** 处理入站文本消息（`im.message.receive_v1`）。 */
  async function handleMessage(data) {
    const message = data?.message ?? {}
    const senderOpenId = String(data?.sender?.sender_id?.open_id ?? '')
    const chatId = String(message.chat_id ?? '')
    const chatType = String(message.chat_type ?? 'p2p')
    const messageId = String(message.message_id ?? '')
    const rootId = String(message.root_id ?? '')
    if (chatId === '') return

    const text = parseFeishuMessageText(message)
    if (text === '') return

    // `/id` 与 `/whoami` 允许未进白名单前查询自己的 open_id，方便自助配置白名单。
    if (/^\/?(?:id|whoami)$/i.test(text)) {
      await client.sendText(
        chatId,
        `你的飞书 open_id：${senderOpenId || '(未知)'}\n当前会话 chat_id：${chatId}\n可将 open_id 填入 DSH 设置页「飞书允许用户白名单」。`,
        { replyToMessageId: messageId },
      )
      return
    }

    if (!isAllowedUser(senderOpenId)) {
      diag(`feishu deny sender=${senderOpenId}`)
      await client.sendText(
        chatId,
        `当前账号未在白名单内，已拒绝操作。\n如需授权，请将你的 open_id（${senderOpenId || '未知'}）添加到 DSH「远程指挥（飞书）」白名单中。`,
        { replyToMessageId: messageId },
      )
      return
    }

    onChatDiscovered?.(chatId, senderOpenId)

    const isGroup = chatType === 'group'
    const bindKey = bindingKeyOf({ chatType, chatId, rootId, senderOpenId })
    const lower = text.toLowerCase()

    /** 向指定聊天发送「模式选择」图形卡片。 */
    async function sendModePicker(targetChatId, { focusOverride, replyTo } = {}) {
      const sessions = hub.listSessions()
      const focus = focusOverride ?? getBinding(bindKey, isGroup)
      const matched = (focus?.sessionId ? sessions.find(s => s.sessionId === focus.sessionId) : undefined) ?? sessions[0]
      if (!matched) {
        await client.sendText(targetChatId, '当前没有在线桌面会话，请先在电脑端打开 DSH 会话，再发 `/m` 选择项目。', { replyToMessageId: replyTo })
        return
      }
      await client.sendCard(
        targetChatId,
        buildModeCard({
          project: matched.project,
          sessionId: matched.sessionId,
          currentMode: matched.mode,
          botAlias: botAlias(),
        }),
        { replyToMessageId: replyTo },
      )
    }

    // 1. 欢迎与使用指南卡片（/help /start 帮助 菜单 指南 你好 ?）
    if (/^\/?(?:help|start|guide)$/i.test(lower) || /^(?:帮助|菜单|指南|使用指南|使用说明|你好|hello|hi|\?|？)$/i.test(text)) {
      const sessions = hub.listSessions()
      const activeFocus = getBinding(bindKey, isGroup)
      await client.sendCard(
        chatId,
        buildWelcomeCard({ botAlias: botAlias(), sessions, activeFocus }),
        { replyToMessageId: messageId },
      )
      return
    }

    // 2. 项目指挥台（/m /menu /projects /项目）
    if (/^\/(?:m|menu|projects|ws|workspaces)$/i.test(lower) || text === '项目' || text === '切换项目') {
      const [workspaces, sessions] = await Promise.all([hub.listWorkspaces(), Promise.resolve(hub.listSessions())])
      const activeFocus = getBinding(bindKey, isGroup)
      await client.sendCard(
        chatId,
        buildWorkspaceCard({ workspaces, sessions, activeFocus, botAlias: botAlias() }),
        { replyToMessageId: messageId },
      )
      return
    }

    // 3. 待决门禁 & 熔断总览（/p /pending /待办）
    if (/^\/(?:p|pending|gates)$/i.test(lower) || text === '待办') {
      const { gates, trips } = hub.listPending()
      if (gates.length === 0 && trips.length === 0) {
        await client.sendText(chatId, '当前没有待决门禁，也没有触发熔断的会话。', { replyToMessageId: messageId })
        return
      }
      for (const ticket of gates.slice(0, 5)) {
        const sent = await client.sendCard(chatId, buildGateCard({ ticket, botAlias: botAlias() }))
        if (sent.ok && sent.messageId) client.trackTicketCard(ticket.id, { messageId: sent.messageId, chatId })
      }
      for (const trip of trips.slice(0, 3)) {
        const sent = await client.sendCard(chatId, buildBrakeCard({
          brake: { ...trip, threshold: Number(getConfig()?.circuit?.threshold) || 3 },
          botAlias: botAlias(),
        }))
        if (sent.ok && sent.messageId) client.trackBrakeCard(trip.sessionId, { messageId: sent.messageId, chatId })
      }
      return
    }

    // 4. 显式门禁回复：`#t3f9 1 [意见]` 或 `#t3f9 0`
    const gateMatch = /^#([a-z0-9]{2,12})\s+(1|2|3|0|doc)(?:\s+([\s\S]*))?$/i.exec(text)
    if (gateMatch !== null) {
      const ticketId = gateMatch[1]
      const token = gateMatch[2].toLowerCase()
      const note = String(gateMatch[3] ?? '').trim()
      if (token === '0' || token === 'doc') {
        const digest = hub.getGateDigest(ticketId)
        await client.sendText(chatId, digest.ok ? digest.text : digest.reason, { replyToMessageId: messageId })
        return
      }
      const res = await hub.settleGate({ ticketId, token, note, by: 'feishu' })
      if (!res.ok) {
        await client.sendText(chatId, `门禁结算未完成：${res.reason}`, { replyToMessageId: messageId })
        return
      }
      await client.sendText(
        chatId,
        `✅ 门禁 #${res.ticket.id} 已结算：${res.label}${res.effectSummary ? `（${res.effectSummary}）` : ''}${res.forwarded ? '，已唤醒桌面会话。' : '，但桌面会话当前不在线。'}`,
        { replyToMessageId: messageId },
      )
      return
    }

    // 5a. 弹出图形化模式选择卡片：`/mode` 或 `模式` / `切换模式`
    if (/^\/mode$/i.test(lower) || text === '模式' || text === '切换模式') {
      await sendModePicker(chatId, { replyTo: messageId })
      return
    }

    // 5b. 直接切模式：`/mode <mode>`
    const modeMatch = /^\/mode\s+([a-z-]+)$/i.exec(text)
    if (modeMatch !== null) {
      const focus = getBinding(bindKey, isGroup)
      const sessionId = focus?.sessionId || hub.listSessions()[0]?.sessionId || ''
      if (sessionId === '') {
        await client.sendText(chatId, '尚未聚焦任何在线会话，请先发 `/m` 选择一个项目。', { replyToMessageId: messageId })
        return
      }
      const res = await hub.switchMode({ sessionId, mode: modeMatch[1] })
      await client.sendText(
        chatId,
        res.ok ? `✅ 已将「${focus?.project || sessionId}」切换为 **${res.label}**。` : `切换失败：${res.reason}`,
        { replyToMessageId: messageId },
      )
      return
    }

    // 6. 中止当前回合：`/stop` 或 `/cancel`
    if (/^\/(?:stop|cancel)$/i.test(lower) || text === '停止') {
      const focus = getBinding(bindKey, isGroup)
      const sessionId = focus?.sessionId || hub.listSessions()[0]?.sessionId || ''
      if (sessionId === '') {
        await client.sendText(chatId, '当前没有聚焦的在线会话可中止。', { replyToMessageId: messageId })
        return
      }
      const res = hub.abortSession(sessionId)
      await client.sendText(
        chatId,
        res.ok ? `⏹ 已中止「${res.session?.project || sessionId}」当前回合。` : `中止失败：${res.reason}`,
        { replyToMessageId: messageId },
      )
      return
    }

    // 7. 新建或指定目录开活：`/new <project|path> [prompt]`
    const newMatch = /^\/new\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(text)
    if (newMatch !== null) {
      const targetQuery = newMatch[1]
      const initialPrompt = String(newMatch[2] ?? '').trim()
      const matched = await matchProjectOrSession(targetQuery)
      const cwd = matched?.cwd || targetQuery
      const res = await hub.sendPrompt({
        cwd,
        text: initialPrompt || '你好，请汇报当前工作区状态并等待进一步指示。',
        createIfMissing: true,
        source: 'feishu',
      })
      if (!res.ok) {
        await client.sendText(chatId, `新建/唤起会话失败：${res.reason}`, { replyToMessageId: messageId })
        return
      }
      const binding = { sessionId: res.session.sessionId, cwd: res.session.cwd, project: res.session.project, chatId }
      setBinding(bindKey, isGroup, binding)
      if (replyStreamer) {
        replyStreamer.beginTurn({
          sessionId: res.session.sessionId,
          chatId,
          replyToMessageId: messageId,
          project: res.session.project,
          mode: res.session.mode,
          inboxMessageId: res.messageId,
        })
      } else {
        await client.sendText(
          chatId,
          `🚀 已切入项目「${binding.project}」并下达指令（模式：${res.session.mode}）。`,
          { replyToMessageId: messageId },
        )
      }
      return
    }

    // 8. `@项目名 你的指令`：一步切换聚焦并直发指令（流式卡片承接回复）
    const atMatch = /^@([^\s]+)\s+([\s\S]+)$/.exec(text)
    if (atMatch !== null) {
      const target = await matchProjectOrSession(atMatch[1])
      const prompt = atMatch[2].trim()
      if (target === undefined) {
        await client.sendText(chatId, `没找到名为「${atMatch[1]}」的项目或在线会话，发送 \`/m\` 可查看全部项目。`, { replyToMessageId: messageId })
        return
      }
      const sent = await hub.sendPrompt({ sessionId: target.sessionId, cwd: target.cwd, text: prompt, source: 'feishu' })
      if (!sent.ok) {
        await client.sendText(chatId, `投递到「${target.project}」失败：${sent.reason}`, { replyToMessageId: messageId })
        return
      }
      setBinding(bindKey, isGroup, {
        sessionId: sent.session.sessionId,
        cwd: sent.session.cwd,
        project: sent.session.project,
        chatId,
      })
      if (replyStreamer) {
        replyStreamer.beginTurn({
          sessionId: sent.session.sessionId,
          chatId,
          replyToMessageId: messageId,
          project: sent.session.project,
          mode: sent.session.mode,
          inboxMessageId: sent.messageId,
        })
      } else {
        await client.sendText(chatId, `📨 已转交「${sent.session.project}」执行。`, { replyToMessageId: messageId })
      }
      return
    }

    // 9. 熔断快速回复 `3 你的新指令`（当且仅当有唯一熔断会话时）
    const brakeMatch = /^([123])(?:\s+([\s\S]*))?$/.exec(text)
    if (brakeMatch !== null) {
      const { gates, trips } = hub.listPending()
      if (trips.length === 1 && gates.length === 0) {
        const res = await hub.resolveBrake({
          sessionId: trips[0].sessionId,
          action: brakeMatch[1],
          prompt: brakeMatch[2] ?? '',
        })
        await client.sendText(chatId, res.ok ? `✅ ${res.message}` : `处理失败：${res.reason}`, { replyToMessageId: messageId })
        return
      }
      if (gates.length === 1 && trips.length === 0 && (brakeMatch[1] === '1' || brakeMatch[1] === '2' || brakeMatch[1] === '3')) {
        const res = await hub.settleGate({
          ticketId: gates[0].id,
          token: brakeMatch[1],
          note: String(brakeMatch[2] ?? '').trim(),
          by: 'feishu',
        })
        await client.sendText(
          chatId,
          res.ok ? `✅ 门禁 #${res.ticket.id} 已结算：${res.label}` : `结算失败：${res.reason}`,
          { replyToMessageId: messageId },
        )
        return
      }
    }

    // 10. 默认：向当前聚焦的会话派发自然语言指令，并用实时流式卡片回传 AI 回答！
    let focus = getBinding(bindKey, isGroup)
    const sessions = hub.listSessions()
    if (focus === undefined && sessions.length === 1) {
      focus = { sessionId: sessions[0].sessionId, cwd: sessions[0].cwd, project: sessions[0].project, chatId }
      setBinding(bindKey, isGroup, focus)
    }

    if (focus === undefined) {
      const workspaces = await hub.listWorkspaces()
      await client.sendCard(
        chatId,
        buildWorkspaceCard({ workspaces, sessions, activeFocus: undefined, botAlias: botAlias() }),
        { replyToMessageId: messageId },
      )
      return
    }

    const delivered = await hub.sendPrompt({
      sessionId: focus.sessionId,
      cwd: focus.cwd,
      text,
      source: 'feishu',
    })
    if (!delivered.ok) {
      await client.sendText(
        chatId,
        `目标会话「${focus.project}」投递失败：${delivered.reason}\n发送 \`/m\` 可重新选择在线项目。`,
        { replyToMessageId: messageId },
      )
      return
    }
    if (delivered.session.sessionId !== focus.sessionId) {
      setBinding(bindKey, isGroup, {
        sessionId: delivered.session.sessionId,
        cwd: delivered.session.cwd,
        project: delivered.session.project,
        chatId,
      })
    }
    if (replyStreamer) {
      replyStreamer.beginTurn({
        sessionId: delivered.session.sessionId,
        chatId,
        replyToMessageId: messageId,
        project: delivered.session.project,
        mode: delivered.session.mode,
        inboxMessageId: delivered.messageId,
      })
    } else {
      await client.sendText(chatId, `📨 已送达「${delivered.session.project}」（${delivered.session.mode}）。`, { replyToMessageId: messageId })
    }
  }

  /**
   * 处理飞书互动卡片点击（`card.action.trigger`）。
   *
   * 必须 3 秒内返回 ACK toast；耗时操作放后台并原地 patch 卡片。
   */
  async function handleCardAction(data) {
    const senderOpenId = String(data?.operator?.open_id ?? '')
    const chatId = String(data?.context?.open_chat_id ?? '')
    const messageId = String(data?.context?.open_message_id ?? '')
    const value = data?.action?.value ?? {}
    const kind = String(value?.kind ?? '')

    if (!isAllowedUser(senderOpenId)) {
      return { toast: { type: 'error', content: '当前账号不在白名单内，操作被拒绝' } }
    }
    if (chatId !== '') onChatDiscovered?.(chatId, senderOpenId)

    if (kind === 'ui:ping') {
      return { toast: { type: 'success', content: '✅ 飞书互动卡片回调畅通！' } }
    }

    if (kind === 'ui:open-workspaces') {
      void (async () => {
        const [workspaces, sessions] = await Promise.all([hub.listWorkspaces(), Promise.resolve(hub.listSessions())])
        if (chatId !== '') {
          await client.sendCard(chatId, buildWorkspaceCard({ workspaces, sessions, botAlias: botAlias() }))
        }
      })()
      return { toast: { type: 'info', content: '正在打开项目指挥台…' } }
    }

    if (kind === 'ui:open-modes') {
      void (async () => {
        const sessions = hub.listSessions()
        const focus = getBinding(`p2p:${senderOpenId || chatId}`, false)
        const preferredId = String(value.sessionId || focus?.sessionId || '')
        const matched = (preferredId ? sessions.find(s => s.sessionId === preferredId) : undefined) ?? sessions[0]
        if (chatId === '') return
        if (!matched) {
          await client.sendText(chatId, '当前没有在线桌面会话，请先在电脑端打开项目。')
          return
        }
        await client.sendCard(chatId, buildModeCard({
          project: matched.project,
          sessionId: matched.sessionId,
          currentMode: matched.mode,
          botAlias: botAlias(),
        }))
      })()
      return { toast: { type: 'info', content: '正在打开模式选择卡片…' } }
    }

    if (kind === 'ui:open-pending') {
      void (async () => {
        if (chatId === '') return
        const { gates, trips } = hub.listPending()
        if (gates.length === 0 && trips.length === 0) {
          await client.sendText(chatId, '当前没有待审批门禁，也没有触发熔断的会话。')
          return
        }
        for (const ticket of gates.slice(0, 5)) {
          const sent = await client.sendCard(chatId, buildGateCard({ ticket, botAlias: botAlias() }))
          if (sent.ok && sent.messageId) client.trackTicketCard(ticket.id, { messageId: sent.messageId, chatId })
        }
        for (const trip of trips.slice(0, 3)) {
          const sent = await client.sendCard(chatId, buildBrakeCard({
            brake: { ...trip, threshold: Number(getConfig()?.circuit?.threshold) || 3 },
            botAlias: botAlias(),
          }))
          if (sent.ok && sent.messageId) client.trackBrakeCard(trip.sessionId, { messageId: sent.messageId, chatId })
        }
      })()
      return { toast: { type: 'info', content: '正在拉取待办…' } }
    }

    if (kind === 'ui:open-help') {
      void (async () => {
        if (chatId === '') return
        const sessions = hub.listSessions()
        const focus = getBinding(`p2p:${senderOpenId || chatId}`, false)
        await client.sendCard(chatId, buildWelcomeCard({ botAlias: botAlias(), sessions, activeFocus: focus }))
      })()
      return { toast: { type: 'info', content: '已发送使用指南卡片' } }
    }

    if (kind === 'mode:switch') {
      const targetSessionId = String(value.sessionId ?? '')
      const targetMode = String(value.mode ?? '')
      const project = String(value.project ?? '当前项目')
      void (async () => {
        const sid = targetSessionId || hub.listSessions()[0]?.sessionId || ''
        if (sid === '') return
        const res = await hub.switchMode({ sessionId: sid, mode: targetMode })
        if (res.ok && messageId !== '') {
          await client.patchCard(messageId, buildModeCard({
            project,
            sessionId: sid,
            currentMode: targetMode,
            botAlias: botAlias(),
          }))
        } else if (!res.ok && chatId !== '') {
          await client.sendText(chatId, `切换模式失败：${res.reason}`)
        }
      })()
      return { toast: { type: 'success', content: `已切换为 ${targetMode}` } }
    }

    if (kind === 'turn:abort') {
      const targetSessionId = String(value.sessionId ?? '')
      const res = hub.abortSession(targetSessionId)
      return {
        toast: res.ok
          ? { type: 'info', content: '⏹ 已发送停止指令' }
          : { type: 'error', content: res.reason || '停止失败' },
      }
    }

    if (kind === 'approval:decide') {
      const approvalId = String(value.approvalId ?? '')
      const decision = value.decision === 'allowed-once' ? 'allowed-once' : 'rejected'
      const outcome = resolveApproval?.({ approvalId, decision, by: 'feishu' })
      if (outcome?.ok) {
        return {
          toast: {
            type: decision === 'allowed-once' ? 'success' : 'info',
            content: decision === 'allowed-once' ? '✅ 已允许本次执行' : '❌ 已拒绝本次执行',
          },
        }
      }
      return { toast: { type: 'info', content: outcome?.reason || '该审批已被处理或已过期' } }
    }

    if (kind === 'focus:session' || kind === 'focus:workspace') {
      const bindKey = `p2p:${senderOpenId || chatId}`
      const binding = {
        sessionId: String(value.sessionId ?? ''),
        cwd: String(value.cwd ?? ''),
        project: String(value.project ?? '未命名工作区'),
        chatId,
      }
      setBinding(bindKey, false, binding)
      if (chatId !== '') {
        // 同时按 group 维度兜底（若在群里点击）
        setBinding(`group:${chatId}`, true, binding)
      }
      void (async () => {
        if (chatId !== '') {
          await client.sendText(chatId, `🎯 已切换指挥目标至「${binding.project}」，现在直接发消息即可给它派活。`)
        }
      })()
      return { toast: { type: 'success', content: `已切换到「${binding.project}」` } }
    }

    if (kind === 'gate:digest') {
      const ticketId = String(value.ticketId ?? '')
      void (async () => {
        const digest = hub.getGateDigest(ticketId)
        if (chatId !== '') {
          await client.sendCard(chatId, buildSummaryCard({
            title: `文档摘要 · #${ticketId}`,
            project: digest.ticket?.project ?? '',
            markdown: digest.ok ? digest.text : digest.reason,
            template: 'indigo',
            botAlias: botAlias(),
          }))
        }
      })()
      return { toast: { type: 'info', content: '正在拉取文档摘要…' } }
    }

    if (kind === 'gate:decide') {
      const ticketId = String(value.ticketId ?? '')
      const token = String(value.token ?? '')
      const action = String(value.action ?? '')
      const label = String(value.label ?? action)
      if (messageId !== '' && ticketId !== '') {
        client.trackTicketCard(ticketId, { messageId, chatId })
      }
      void (async () => {
        const res = await hub.settleGate({ ticketId, token, action, by: 'feishu' })
        if (res.ok && messageId !== '') {
          await client.patchCard(messageId, buildGateResolvedCard({
            ticket: res.ticket,
            action: res.action,
            label: res.label,
            by: 'feishu',
            effects: res.effects,
            botAlias: botAlias(),
          }))
        } else if (!res.ok && chatId !== '') {
          await client.sendText(chatId, `门禁 #${ticketId} 处理结果：${res.reason}`)
        }
      })()
      return { toast: { type: 'success', content: `已选择：${label}` } }
    }

    if (kind === 'brake:action') {
      const sessionId = String(value.sessionId ?? '')
      const action = String(value.action ?? 'retry')
      const project = String(value.project ?? '桌面会话')
      if (messageId !== '' && sessionId !== '') {
        client.trackBrakeCard(sessionId, { messageId, chatId })
      }
      void (async () => {
        const res = await hub.resolveBrake({ sessionId, action })
        if (res.ok && messageId !== '') {
          await client.patchCard(messageId, buildBrakeResolvedCard({
            project: res.project ?? project,
            reason: res.action ?? action,
            detail: res.message,
            botAlias: botAlias(),
          }))
        } else if (!res.ok && chatId !== '') {
          await client.sendText(chatId, `熔断处理提示：${res.reason}`)
        }
      })()
      const label = action === 'retry' ? '原模型重试' : action === 'escalate' ? '切救场强模型' : '解除熔断'
      return { toast: { type: 'success', content: `已执行：${label}` } }
    }

    return { toast: { type: 'info', content: '已收到操作' } }
  }

  return { handleMessage, handleCardAction, isAllowedUser }
}
