import assert from 'node:assert/strict'
import test from 'node:test'
import { createFeishuRouter, parseFeishuMessageText } from '../../src/remote/feishu/router.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'

function flushAsync() {
  return new Promise(r => setTimeout(r, 15))
}

function makeHarness({ allowed = ['ou_ok'], sessions = [], workspaces = [], gates = [], trips = [], streamer = null } = {}) {
  const sentTexts = []
  const sentCards = []
  const patchedCards = []
  const trackedTickets = new Map()
  const trackedBrakes = new Map()
  const discovered = []
  const hubCalls = []

  const client = {
    async sendText(chatId, text, opts) {
      sentTexts.push({ chatId, text, opts })
      return { ok: true, messageId: `m_${sentTexts.length}` }
    },
    async sendCard(chatId, card, opts) {
      sentCards.push({ chatId, card, opts })
      return { ok: true, messageId: `c_${sentCards.length}` }
    },
    async patchCard(messageId, card) {
      patchedCards.push({ messageId, card })
      return { ok: true }
    },
    trackTicketCard(id, v) { trackedTickets.set(id, v) },
    getTicketCard(id) { return trackedTickets.get(id) },
    clearTicketCard(id) { trackedTickets.delete(id) },
    trackBrakeCard(id, v) { trackedBrakes.set(id, v) },
    getBrakeCard(id) { return trackedBrakes.get(id) },
    clearBrakeCard(id) { trackedBrakes.delete(id) },
  }

  let currentSessions = [...sessions]
  let failSendPrompt = false
  let failSwitchMode = false
  let failSettle = false
  let failResolveBrake = false

  const hub = {
    listSessions() { return currentSessions },
    async listWorkspaces() { return workspaces },
    listPending() { return { gates, trips } },
    getGateDigest(id) {
      if (id === 'missing') return { ok: false, reason: 'not found' }
      return { ok: true, text: `digest:${id}`, ticket: { id, project: 'Alpha' } }
    },
    async settleGate(arg) {
      hubCalls.push(['settleGate', arg])
      if (failSettle) return { ok: false, reason: 'already settled' }
      return {
        ok: true,
        ticket: { id: arg.ticketId, project: 'Alpha', stageName: 'Plan' },
        action: arg.action ?? 'pass',
        label: '通过',
        effectSummary: 'mode->build',
        effects: ['mode->build'],
        forwarded: true,
      }
    },
    async switchMode(arg) {
      hubCalls.push(['switchMode', arg])
      if (failSwitchMode) return { ok: false, reason: 'bad mode' }
      return { ok: true, label: arg.mode }
    },
    abortSession(sid) {
      hubCalls.push(['abortSession', sid])
      if (sid === 'none') return { ok: false, reason: 'no session' }
      return { ok: true, session: { project: 'Alpha' } }
    },
    async sendPrompt(arg) {
      hubCalls.push(['sendPrompt', arg])
      if (failSendPrompt) return { ok: false, reason: 'offline' }
      const sid = arg.text === 'rebind' ? 's2' : (arg.sessionId || 's_new')
      return {
        ok: true,
        messageId: 'inbox_1',
        session: { sessionId: sid, cwd: arg.cwd || '/repo/a', project: 'Alpha', mode: 'flow' },
      }
    },
    async resolveBrake(arg) {
      hubCalls.push(['resolveBrake', arg])
      if (failResolveBrake) return { ok: false, reason: 'not tripped' }
      return { ok: true, project: 'Alpha', action: arg.action, message: 'brake ok' }
    },
  }

  const stateStore = createFlowStateStore({ persist: false })
  const approvals = []
  const router = createFeishuRouter({
    hub,
    client,
    stateStore,
    getConfig: () => ({ feishu: { allowedOpenIds: allowed, botName: 'FlowBot' }, circuit: { threshold: 4 } }),
    replyStreamer: streamer,
    resolveApproval: arg => {
      approvals.push(arg)
      return arg.approvalId === 'bad' ? { ok: false, reason: 'expired' } : { ok: true }
    },
    onChatDiscovered: (c, u, t) => discovered.push({ c, u, t }),
  })

  return {
    router, sentTexts, sentCards, patchedCards, trackedTickets, trackedBrakes, discovered, hubCalls, approvals,
    gates, trips,
    setSessions(next) { currentSessions = next },
    setFlags(f) {
      if ('failSendPrompt' in f) failSendPrompt = f.failSendPrompt
      if ('failSwitchMode' in f) failSwitchMode = f.failSwitchMode
      if ('failSettle' in f) failSettle = f.failSettle
      if ('failResolveBrake' in f) failResolveBrake = f.failResolveBrake
    },
  }
}

function msg(text, { openId = 'ou_ok', chatId = 'oc_1', chatType = 'p2p', rootId = '', messageType = 'text' } = {}) {
  return {
    sender: { sender_id: { open_id: openId } },
    message: {
      chat_id: chatId,
      chat_type: chatType,
      root_id: rootId,
      message_id: 'om_1',
      message_type: messageType,
      content: messageType === 'text' && !text.startsWith('{raw:') ? JSON.stringify({ text }) : text,
    },
  }
}

test('parseFeishuMessageText handles non-text, invalid JSON, and @mentions', () => {
  assert.equal(parseFeishuMessageText({ message_type: 'image', content: '{}' }), '')
  assert.equal(parseFeishuMessageText({ message_type: 'text', content: '{raw:broken' }), '{raw:broken')
  assert.equal(parseFeishuMessageText({ message_type: 'text', content: JSON.stringify({ text: '@_user_1 /m @_user_2' }) }), '/m')
})

test('Feishu router handles /id, allowlist denials, help, /m, /p, /mode, /stop, /new, @project, brake/gate shortcuts, and default routing', async () => {
  const emptyAllow = makeHarness({ allowed: [] })
  await emptyAllow.router.handleMessage(msg('/whoami', { openId: 'ou_stranger' }))
  assert.match(emptyAllow.sentTexts[0].text, /open_id：ou_stranger/)
  await emptyAllow.router.handleMessage(msg('hello', { openId: 'ou_stranger' }))
  assert.match(emptyAllow.sentTexts[1].text, /白名单尚未配置/)

  const closedDeny = await emptyAllow.router.handleCardAction({ operator: { open_id: 'ou_stranger' }, action: { value: {} } })
  assert.equal(closedDeny.toast.type, 'error')

  const streamerTurns = []
  const h = makeHarness({
    sessions: [
      { sessionId: 's1', cwd: '/repo/alpha', project: 'Alpha', mode: 'flow' },
      { sessionId: 's2', cwd: '/repo/beta', project: 'Beta', mode: 'build' },
    ],
    workspaces: [{ workspaceId: 'w1', name: 'Gamma', cwd: '/repo/gamma', sessions: [] }],
    gates: [{ id: 't10', project: 'Alpha', stageName: 'Plan', docId: '02', summary: 'ok' }],
    trips: [{ sessionId: 's1', project: 'Alpha', count: 3 }],
    streamer: { beginTurn: t => streamerTurns.push(t) },
  })

  await h.router.handleMessage(msg('/id', { openId: 'ou_other' }))
  await h.router.handleMessage(msg('hi', { openId: 'ou_other' }))
  assert.match(h.sentTexts.at(-1).text, /未在白名单/)

  // Help / Menu / Pending
  await h.router.handleMessage(msg('/help'))
  await h.router.handleMessage(msg('/m'))
  await h.router.handleMessage(msg('/p'))
  assert.ok(h.sentCards.length >= 4)
  assert.ok(h.trackedTickets.has('t10'))
  assert.ok(h.trackedBrakes.has('s1'))

  // #ticket commands
  await h.router.handleMessage(msg('#t10 0'))
  assert.match(h.sentTexts.at(-1).text, /digest:t10/)
  await h.router.handleMessage(msg('#t10 1 looks good'))
  assert.match(h.sentTexts.at(-1).text, /已结算/)

  // /mode picker + direct /mode + /stop
  await h.router.handleMessage(msg('/mode'))
  await h.router.handleMessage(msg('/mode build'))
  assert.match(h.sentTexts.at(-1).text, /切换为 \*\*build\*\*/)
  await h.router.handleMessage(msg('/stop'))
  assert.match(h.sentTexts.at(-1).text, /已中止/)

  // Multiple sessions without focus -> shows workspace card
  await h.router.handleMessage(msg('帮我看一下这个报错'))
  assert.equal(h.sentCards.at(-1).card.header.template, 'wathet')

  // @project fuzzy match & missing project
  await h.router.handleMessage(msg('@NoSuchProj hi'))
  assert.match(h.sentTexts.at(-1).text, /没找到/)
  await h.router.handleMessage(msg('@Gamma 检查目录'))
  assert.equal(streamerTurns.at(-1).project, 'Alpha')

  // /new command
  await h.router.handleMessage(msg('/new alpha 新建任务'))
  assert.equal(streamerTurns.at(-1).project, 'Alpha')

  // Default prompt delivery with session rebind
  await h.router.handleMessage(msg('rebind'))
  assert.equal(streamerTurns.at(-1).sessionId, 's2')

  // Single trip vs single gate quick reply
  h.gates.length = 0
  await h.router.handleMessage(msg('3 continue now'))
  assert.match(h.sentTexts.at(-1).text, /brake ok/)

  h.trips.length = 0
  h.gates.push({ id: 't11', project: 'Alpha', stageName: 'Review' })
  await h.router.handleMessage(msg('2 need fix'))
  assert.match(h.sentTexts.at(-1).text, /门禁 #t11 已结算/)
})

test('Feishu router handles all interactive card action branches cleanly', async () => {
  const h = makeHarness({
    sessions: [{ sessionId: 's1', cwd: '/repo/alpha', project: 'Alpha', mode: 'flow' }],
    workspaces: [{ workspaceId: 'w1', name: 'Alpha', cwd: '/repo/alpha', sessions: [] }],
    gates: [{ id: 't20', project: 'Alpha', stageName: 'Plan' }],
    trips: [{ sessionId: 's1', project: 'Alpha', count: 3 }],
  })

  const act = (value, openMessageId = 'om_card_1') =>
    h.router.handleCardAction({
      operator: { open_id: 'ou_ok' },
      context: { open_chat_id: 'oc_1', open_message_id: openMessageId },
      action: { value },
    })

  assert.equal((await act({ kind: 'ui:ping' })).toast.type, 'success')
  assert.equal((await act({ kind: 'ui:open-workspaces' })).toast.type, 'info')
  assert.equal((await act({ kind: 'ui:open-modes', sessionId: 's1' })).toast.type, 'info')
  assert.equal((await act({ kind: 'ui:open-pending' })).toast.type, 'info')
  assert.equal((await act({ kind: 'ui:open-help' })).toast.type, 'info')
  assert.equal((await act({ kind: 'mode:switch', sessionId: 's1', mode: 'build', project: 'Alpha' })).toast.type, 'info')
  assert.equal((await act({ kind: 'turn:abort', sessionId: 's1' })).toast.type, 'info')
  assert.equal((await act({ kind: 'turn:abort', sessionId: 'none' })).toast.type, 'error')
  assert.equal((await act({ kind: 'approval:decide', approvalId: 'ap1', decision: 'allowed-once' })).toast.type, 'success')
  assert.equal((await act({ kind: 'approval:decide', approvalId: 'bad', decision: 'allowed-once' })).toast.type, 'error')
  assert.equal((await act({ kind: 'focus:workspace', bindKey: 'group:oc_1:r1', isGroup: true, workspaceId: 'w1', cwd: '/repo/alpha', project: 'Alpha' })).toast.type, 'success')
  assert.equal((await act({ kind: 'gate:digest', ticketId: 't20' })).toast.type, 'info')
  assert.equal((await act({ kind: 'gate:decide', ticketId: 't20', token: '1', action: 'pass', label: '通过' }, 'om_g1')).toast.type, 'info')
  assert.equal((await act({ kind: 'brake:action', sessionId: 's1', action: 'escalate', project: 'Alpha' }, 'om_b1')).toast.type, 'info')
  assert.equal((await act({ kind: 'unknown:kind' })).toast.content, '已收到操作')

  await flushAsync()
  assert.ok(h.patchedCards.length >= 2)
  assert.ok(h.sentCards.some(c => c.card.header?.template === 'indigo'))
  assert.ok(h.discovered.some(d => d.u === 'ou_ok'))

  // Empty pending & no sessions paths + error feedback paths
  h.gates.length = 0
  h.trips.length = 0
  h.setSessions([])
  await act({ kind: 'ui:open-pending' })
  await act({ kind: 'ui:open-modes' })
  await act({ kind: 'mode:switch', mode: 'build' })
  h.setFlags({ failSendPrompt: true, failSwitchMode: true, failSettle: true, failResolveBrake: true })
  await act({ kind: 'gate:decide', ticketId: 't21', token: '1', action: 'pass', label: '通过' })
  await act({ kind: 'brake:action', sessionId: 's1', action: 'retry', project: 'Alpha' })
  await h.router.handleMessage(msg('/p'))
  await h.router.handleMessage(msg('/mode build'))
  await h.router.handleMessage(msg('/stop'))
  await h.router.handleMessage(msg('#t21 1'))
  await h.router.handleMessage(msg('/new alpha retry'))
  await flushAsync()
  assert.ok(h.sentTexts.some(t => t.text.includes('没有待审批门禁')))
  assert.ok(h.sentTexts.some(t => t.text.includes('没有在线桌面会话')))
  assert.ok(h.sentTexts.some(t => t.text.includes('门禁结算未完成')))
  assert.ok(h.sentTexts.some(t => t.text.includes('新建/唤起会话失败')))
})
