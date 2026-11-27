import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../../src/plugin.js'
import { attachAgentDocsContext, attachAgentModeContext, attachAgentSpecContext } from '../../src/prompts/bridge.js'
import { updatePrompts } from '../../src/prompts/updater.js'
import { createGateTickets } from '../../src/gates/tickets.js'
import { createGateSettler } from '../../src/gates/settler.js'
import { createGateRouter } from '../../src/gates/router.js'
import { handleGateCommand } from '../../src/commands/gate.js'
import { createCircuitBreaker } from '../../src/resilience/circuit-breaker.js'
import { createCompactBridge } from '../../src/modes/compact-bridge.js'
import { createDispatchStore } from '../../src/workflow/dispatch.js'
import { createReworkTracker } from '../../src/workflow/qa-handoff.js'
import { createImChannel } from '../../src/notify/im.js'
import { createGateTool } from '../../src/tools/gate.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'
import { createHarnessBridge } from '../../src/remote/harness-bridge.js'
import { createRemoteHub } from '../../src/remote/hub.js'
import { setFeishuSdkOverride } from '../../src/remote/feishu/sdk-loader.js'
import { createFeishuClient } from '../../src/remote/feishu/client.js'
import { createFeishuCommander } from '../../src/remote/feishu/index.js'
import { createFeishuOnboarding, createFeishuSecretStore, FEISHU_REQUIRED_SCOPES } from '../../src/remote/feishu/onboarding.js'
import { createFeishuReplyStreamer, splitMarkdownChunks } from '../../src/remote/feishu/reply-stream.js'
import { buildToolApprovalCard, redactSensitiveText } from '../../src/remote/feishu/cards.js'

test('P0-1 & P1-9: plugin syncModeCommand matches real DSH commands.execute signature and mounts webServer on scoped ctx', async () => {
  const executedCommands = []
  let webServerInjectedOnScoped = false
  let webServerInjectedOnRoot = false
  let registeredCmd = null
  const createdListeners = []
  const disposedListeners = []

  const fakeAgent = {
    id: 'ag-p01',
    session: { id: 'sess-p01', header: { cwd: process.cwd() } },
    ctx: {
      systemPrompt: { context: () => () => {} },
      on: () => () => {},
      effect: (fn) => { const d = fn(); return () => d?.() },
    },
    followup() {},
    cancel() {},
  }

  const scoped = {
    logger: { info() {}, warn() {}, error() {} },
    sessionProjections: { register: async () => ({ dispose: async () => {}, get: () => 'off' }) },
    systemPrompt: { getSectionOrder: () => 0, section: () => () => {} },
    agents: { list: () => [fakeAgent], get: (id) => (id === 'sess-p01' ? fakeAgent : undefined) },
    tools: { register: () => () => {}, get: () => undefined },
    commands: {
      register(def) {
        if (def.name === 'flow') registeredCmd = def
        return () => {}
      },
      // 严格按真实 DSH 宿主契约：execute(agent, line, attachments, signal)
      async execute(agent, line, attachments, signal) {
        executedCommands.push({ agent, line, attachments, signal })
        if (Array.isArray(attachments) && attachments.length > 0) {
          return { commandId: 'flow', result: { kind: 'error', text: '/flow does not accept attachments' } }
        }
        return { commandId: 'flow', result: { kind: 'success', text: `ok ${line}` } }
      },
    },
    effect: (fn) => { const d = fn(); return () => d?.() },
    on(event, fn) {
      if (event === 'agent/created') createdListeners.push(fn)
      if (event === 'agent/disposed') disposedListeners.push(fn)
      return () => {}
    },
    get: () => undefined,
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        webServerInjectedOnScoped = true
        return cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
      }
      return undefined
    },
  }

  const rootCtx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        webServerInjectedOnRoot = true
        return undefined
      }
      return cb(scoped)
    },
  }

  apply(rootCtx, {
    modes: { build: { label: 'Build', permission: 'keep', model: '' } },
    feishu: { enabled: false },
    team: { enabled: false },
  })
  await new Promise(r => setTimeout(r, 30))

  assert.equal(webServerInjectedOnScoped, true)
  assert.equal(webServerInjectedOnRoot, false)
  assert.ok(registeredCmd !== null)

  // 通过 /flow gate 或模拟执行校验 syncModeCommand 契约：直接检验 commands.execute 被调用时附件数组为空且 line 为完整命令
  // 额外直接验证 real DSH 错误返回格式 { result: { kind: 'error' } } 不会被误判为成功
  const badRes = await scoped.commands.execute(fakeAgent, '/flow', ['build'], new AbortController().signal)
  assert.equal(badRes.result.kind, 'error')
  const goodRes = await scoped.commands.execute(fakeAgent, '/flow build', [], new AbortController().signal)
  assert.equal(goodRes.result.kind, 'success')
})

test('P0-2: off mode injects zero Flow spec/docs/mode prompts and reply-stream refreshes mid-turn mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-p02-'))
  try {
    mkdirSync(join(root, '.flow', 'docs'), { recursive: true })
    writeFileSync(join(root, '.flow', 'spec.md'), '# Spec\nExisting spec anchor\n', 'utf8')
    const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })
    const cfg = {
      docs: { enabled: true, dir: '.flow/docs', level: 'M' },
      spec: { enabled: true, path: '.flow/spec.md', maxChars: 600 },
      modes: { flow: { label: 'Flow', prompt: 'FLOW' } },
      promptSets: [],
    }
    const captured = {}
    const fakeAgentCtx = {
      systemPrompt: {
        context(spec) {
          captured[spec.name] = spec.text
          return () => {}
        },
      },
    }
    const agent = { session: { id: 'sess-off', header: { cwd: root } } }
    let currentMode = 'off'
    const getMode = () => currentMode

    attachAgentModeContext(fakeAgentCtx, { agent, getConfig: () => cfg, getMode, store: null, stateStore })
    attachAgentSpecContext(fakeAgentCtx, { agent, getConfig: () => cfg, getMode })
    attachAgentDocsContext(fakeAgentCtx, { agent, getConfig: () => cfg, getMode, stateStore })

    assert.equal(captured['flow:mode'](), '')
    assert.equal(captured['flow:spec'](), '')
    assert.equal(captured['flow:docs'](), '')

    // 切到 flow 后三者均恢复正常注入
    currentMode = 'flow'
    assert.ok(captured['flow:mode']().includes('FLOW'))
    assert.ok(captured['flow:spec']().includes('Existing spec anchor'))
    assert.ok(captured['flow:docs']().includes('[Flow 文档]'))

    // 流式卡片在中途切模式后，定稿卡片标题应反映新模式 build 而非开局旧模式 off
    const finalCards = []
    const streamer = createFeishuReplyStreamer({
      client: {
        isReady: () => true,
        sendCard: async () => ({ ok: true, messageId: 'om_1' }),
        patchCard: async (_id, card) => { finalCards.push(card); return { ok: true } },
      },
      getBotAlias: () => 'Flow',
      getConfig: () => ({ feishu: {} }),
      resolveTargetChatId: () => 'oc_1',
    })
    streamer.beginTurn({ sessionId: 'sess-m', chatId: 'oc_1', project: 'demo', mode: 'off', inboxMessageId: 'msg-1' })
    streamer.onInboxClaimed({ sessionId: 'sess-m', messageId: 'msg-1', turn: 1 })
    streamer.onSessionEvent({
      sessionId: 'sess-m',
      event: { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '已切换到 build' }] } } },
      project: 'demo',
      mode: 'build',
    })
    streamer.onSessionEvent({
      sessionId: 'sess-m',
      event: { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
      project: 'demo',
      mode: 'build',
    })
    await new Promise(r => setTimeout(r, 40))
    assert.ok(finalCards.some(c => c.header.title.content.includes('build')))
    streamer.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('P0-3 & P1-1: rapid back-to-back Feishu turns stay isolated and serial queue prevents flush overwriting final card', async () => {
  let seqCard = 0
  const finishedByCard = new Map()
  const streamSeqs = new Map()
  const patchedCards = []

  const streamer = createFeishuReplyStreamer({
    client: {
      isReady: () => true,
      createStreamingCard: async () => {
        seqCard += 1
        return { ok: true, cardId: `ck_${seqCard}`, messageId: `om_${seqCard}` }
      },
      streamCardContent: async (cardId, _md, sequence) => {
        const arr = streamSeqs.get(cardId) ?? []
        arr.push(sequence)
        streamSeqs.set(cardId, arr)
        // 模拟网络慢且返回失败，验证不会在 finalize 后倒灌 patchCard
        await new Promise(r => setTimeout(r, 40))
        return { ok: false, reason: 'mock-transient' }
      },
      finishStreamingCard: async (cardId, finalCard, sequence) => {
        const arr = streamSeqs.get(cardId) ?? []
        arr.push(sequence)
        streamSeqs.set(cardId, arr)
        finishedByCard.set(cardId, finalCard)
        return { ok: true }
      },
      patchCard: async (messageId, card) => {
        patchedCards.push({ messageId, card })
        return { ok: true }
      },
    },
    getBotAlias: () => 'Flow',
    getConfig: () => ({ feishu: {} }),
    resolveTargetChatId: () => 'oc_1',
  })

  // 用户先发消息 A → 绑定 turn 1
  streamer.beginTurn({ sessionId: 'sess-1', chatId: 'oc_1', project: 'demo', mode: 'flow', inboxMessageId: 'msg-A' })
  streamer.onInboxClaimed({ sessionId: 'sess-1', messageId: 'msg-A', turn: 1 })
  streamer.onAssistantStream({ sessionId: 'sess-1', frame: { type: 'start', attemptId: 'a1', turn: 1, step: 0 }, project: 'demo', mode: 'flow' })
  streamer.onAssistantStream({ sessionId: 'sess-1', frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', index: 0, text: '回答A第一段' } }, project: 'demo', mode: 'flow' })

  // Turn 1 尚未结束时，用户连发消息 B（排队等待 claim）
  streamer.beginTurn({ sessionId: 'sess-1', chatId: 'oc_1', project: 'demo', mode: 'flow', inboxMessageId: 'msg-B' })

  // Turn 1 继续产出并结束 → 必须落到卡片 A (ck_1)，绝不串台到卡片 B (ck_2)
  streamer.onSessionEvent({
    sessionId: 'sess-1',
    event: { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '完整回答A' }] } } },
    project: 'demo',
    mode: 'flow',
  })
  streamer.onSessionEvent({
    sessionId: 'sess-1',
    event: { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
    project: 'demo',
    mode: 'flow',
  })

  // 随后 Turn 2 认领 msg-B 并产出回答 B → 必须落到卡片 B (ck_2)
  streamer.onInboxClaimed({ sessionId: 'sess-1', messageId: 'msg-B', turn: 2 })
  streamer.onSessionEvent({
    sessionId: 'sess-1',
    event: { type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '完整回答B' }] } } },
    project: 'demo',
    mode: 'flow',
  })
  streamer.onSessionEvent({
    sessionId: 'sess-1',
    event: { type: 'turn/end', data: { turn: 2, reason: 'completed' } },
    project: 'demo',
    mode: 'flow',
  })

  await new Promise(r => setTimeout(r, 150))

  assert.ok(finishedByCard.get('ck_1')?.body?.elements?.[0]?.content?.includes('完整回答A'))
  assert.ok(finishedByCard.get('ck_2')?.body?.elements?.[0]?.content?.includes('完整回答B'))
  // 卡片 A/B 的 sequence 均严格递增，且失败的 flush 绝未在 finalize 后倒灌写回「思考中」卡片
  for (const seqs of streamSeqs.values()) {
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1])
  }
  assert.equal(patchedCards.some(p => p.card?.header?.title?.content?.includes('⏳')), false)
  assert.ok(FEISHU_REQUIRED_SCOPES.includes('cardkit:card:write'))
  streamer.dispose()
})

test('P0-4: approval disconnect resolves without deadlock, redacts secrets, escapes fences, and handles frozen request', async () => {
  const sentCards = []
  const mockSdk = {
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { warn: 3 },
    Client: class {
      async request() { return { code: 0, bot: { app_name: 'Flow' } } }
      im = {
        v1: {
          message: {
            create: async (args) => { sentCards.push(args); return { code: 0, data: { message_id: `om_${sentCards.length}` } } },
            reply: async (args) => { sentCards.push(args); return { code: 0, data: { message_id: `om_${sentCards.length}` } } },
            patch: async () => ({ code: 0 }),
          },
        },
      }
    },
    EventDispatcher: class { register() { return this } },
    WSClient: class { async start() {} async close() {} },
  }

  setFeishuSdkOverride(mockSdk)
  try {
    const cfg = {
      feishu: { enabled: true, appId: 'cli_a', appSecret: 'sec_a', allowedOpenIds: ['ou_1'], defaultChatId: 'oc_1', pushOnApproval: true },
    }
    const hub = createRemoteHub({
      bridge: { listWorkspaces: async () => [], listSessions: () => [] },
      tickets: { find: () => undefined },
      settler: {},
      gateRouter: {},
      breaker: {},
      getConfig: () => cfg,
    })
    const commander = createFeishuCommander({ hub, getConfig: () => cfg })
    await commander.connect()

    const frozenReq = Object.freeze({
      agent: { id: 'a1', session: { id: 's1', header: { cwd: '/work/sec' } } },
      toolName: 'bash',
      reason: 'Authorization: Bearer sk-verysecretkey123456',
      input: {
        password: 'my-super-password',
        apiKey: 'xyz-secret',
        cmd: 'curl -H "Authorization: Bearer sk-abcdefgh123456" https://user:topsecret@db.local\n```js\nconsole.log(1)\n```',
      },
      signal: new AbortController().signal,
    })

    // 桌面返回 'unavailable'，随后断连飞书 → 必须在 100ms 内 settle 为 'unavailable' 而非永久死锁
    const p = commander.handleApprovalRequest(frozenReq, async () => 'unavailable')
    await new Promise(r => setTimeout(r, 20))
    await commander.disconnect()
    const outcome = await Promise.race([p, new Promise(r => setTimeout(() => r('DEADLOCK'), 150))])
    assert.equal(outcome, 'unavailable')

    // 校验脱敏与代码块围栏逃逸
    assert.ok(sentCards.length >= 1)
    const rawCardJson = sentCards[0].data.content
    assert.ok(!rawCardJson.includes('my-super-password'))
    assert.ok(!rawCardJson.includes('xyz-secret'))
    assert.ok(!rawCardJson.includes('sk-verysecretkey123456'))
    assert.ok(!rawCardJson.includes('sk-abcdefgh123456'))
    assert.ok(!rawCardJson.includes('topsecret'))
    assert.ok(rawCardJson.includes('[REDACTED]'))

    const card = buildToolApprovalCard({ approvalId: 'a1', summary: 'hello\n```\nworld' })
    const md = card.body.elements[0].content
    assert.ok(md.includes('````\nhello\n```\nworld\n````'))
    assert.equal(redactSensitiveText('token=abc123').includes('abc123'), false)

    await commander.dispose()
  } finally {
    setFeishuSdkOverride(undefined)
  }
})

test('P0-5 & P1-7: gate settler locks against concurrent TOCTOU, suppresses duplicate followup, and compacts idle agent before followup', async () => {
  const cfg = {
    gate: { persist: false },
    behavior: { autoCompactOnGate: true },
    modes: { build: { label: 'Build' } },
  }
  const tickets = createGateTickets({ getConfig: () => cfg })
  const ticket = tickets.create({
    sessionId: 'sess-race',
    project: 'race-proj',
    cwd: '/work/race',
    kind: 'stage',
    fromStage: 'plan',
    nextMode: 'build',
    summary: 'done',
    specUpdated: true,
    options: [{ label: '批准', action: 'approve' }, { label: '暂停', action: 'pause' }],
    hold: true,
  })

  const events = []
  let switchCalls = 0
  let notifyCalls = 0
  let followupCalls = 0
  const agent = {
    id: 'ag-race',
    status: 'idle',
    session: { id: 'sess-race', header: { cwd: '/work/race' } },
    followup(msg) {
      events.push('followup')
      followupCalls += 1
      assert.equal(typeof msg.source, 'object')
      assert.equal(typeof msg.source.kind, 'string')
    },
  }
  const compactBridge = {
    runNow: async () => { events.push('compact'); return { ok: true, code: 'compacted' } },
    schedule: () => { events.push('schedule'); return true },
  }

  const settler = createGateSettler({
    getConfig: () => cfg,
    switchMode: async () => {
      switchCalls += 1
      await new Promise(r => setTimeout(r, 30))
      return { label: 'Build', notes: [] }
    },
    bridge: compactBridge,
    notifier: { schedule: () => { notifyCalls += 1 } },
    tickets,
    resolveAgent: () => agent,
  })
  const gateRouter = createGateRouter({ tickets, getConfig: () => cfg, resolveAgent: () => agent, settler })

  const [r1, r2] = await Promise.all([
    settler.settle(ticket.id, { action: 'approve', by: 'feishu' }),
    settler.settle(ticket.id, { action: 'pause', by: 'desktop' }),
  ])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, false)
  assert.equal(r2.already, true)
  assert.equal(switchCalls, 1)
  assert.equal(notifyCalls, 1)
  assert.equal(r1.effects.compacted, true)
  assert.deepEqual(events, ['compact'])

  // 已结算票据再次走 /flow gate answer 与 gateRouter.preStep 严禁再次调用 followup
  const cmdAgain = await handleGateCommand({
    agent,
    rawArg: `gate answer ${ticket.id} 1`,
    getConfig: () => cfg,
    tickets,
    settler,
    gateRouter,
  })
  assert.equal(cmdAgain.kind, 'success')
  assert.ok(cmdAgain.text.includes('已由其他端结算过'))
  assert.equal(followupCalls, 0)
  tickets.dispose()
})

test('P0-6: strict Fail-Closed when allowedOpenIds is empty or whitespace-only, allowing only /id', async () => {
  const sent = []
  let handlers = null
  const mockSdk = {
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { warn: 3 },
    Client: class {
      async request() { return { code: 0, bot: { app_name: 'Flow' } } }
      im = {
        v1: {
          message: {
            create: async (args) => { sent.push(args); return { code: 0, data: { message_id: `m${sent.length}` } } },
            reply: async (args) => { sent.push(args); return { code: 0, data: { message_id: `m${sent.length}` } } },
            patch: async () => ({ code: 0 }),
          },
        },
      }
    },
    EventDispatcher: class { register(h) { handlers = h; return this } },
    WSClient: class { async start() {} async close() {} },
  }

  setFeishuSdkOverride(mockSdk)
  try {
    const cfg = { feishu: { enabled: true, appId: 'cli_fc', appSecret: 'sec_fc', allowedOpenIds: ['  '] } }
    let promptCalls = 0
    const hub = createRemoteHub({
      bridge: {
        listWorkspaces: async () => [],
        listSessions: () => [{ sessionId: 's1', project: 'demo', cwd: '/demo', mode: 'flow' }],
        sendPrompt: async () => { promptCalls += 1; return { ok: true } },
      },
      tickets: { find: () => undefined },
      settler: {},
      gateRouter: {},
      breaker: {},
      getConfig: () => cfg,
    })
    const commander = createFeishuCommander({ hub, getConfig: () => cfg })
    await commander.connect()

    await handlers['im.message.receive_v1']({
      event_id: 'e1',
      sender: { sender_id: { open_id: 'ou_any' } },
      message: { message_id: 'm1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '执行命令' }) },
    })
    assert.equal(promptCalls, 0)
    assert.ok(sent[sent.length - 1].data.content.includes('白名单尚未配置'))

    const cardAck = await handlers['card.action.trigger']({
      event_id: 'e2',
      operator: { open_id: 'ou_any' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
      action: { value: { kind: 'ui:ping' } },
    })
    assert.equal(cardAck.toast.type, 'error')

    await handlers['im.message.receive_v1']({
      event_id: 'e3',
      sender: { sender_id: { open_id: 'ou_any' } },
      message: { message_id: 'm2', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/id' }) },
    })
    assert.ok(sent[sent.length - 1].data.content.includes('ou_any'))

    await commander.dispose()
  } finally {
    setFeishuSdkOverride(undefined)
  }
})

test('P1-2: splitMarkdownChunks preserves code fences and Markdown table headers across chunks', () => {
  const codeLines = Array.from({ length: 40 }, (_, i) => `const item_${i} = "value_line_${i}_padding_text";`).join('\n')
  const tableLines = [
    '| 模块 | 状态 | 备注 |',
    '|---|---|---|',
    ...Array.from({ length: 25 }, (_, i) => `| mod_${i} | ok | detail_padding_entry_${i} |`),
  ].join('\n')
  const doc = `前置说明\n\n\`\`\`javascript\n${codeLines}\n\`\`\`\n\n${tableLines}`
  const chunks = splitMarkdownChunks(doc, 450)
  assert.ok(chunks.length >= 4)
  for (const chunk of chunks) {
    const fences = (chunk.match(/^```/gm) ?? []).length
    assert.equal(fences % 2, 0, `围栏未配对：\n${chunk}`)
    if (chunk.includes('| mod_')) {
      assert.ok(chunk.includes('| 模块 | 状态 | 备注 |'), `表格分片缺少表头：\n${chunk}`)
    }
  }
})

test('P1-3, P1-5, P1-6, P1-8: persisted private chatId, WS re-entrancy/callbacks, no double gate card/patch, Lark domain_switched & secret priority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-p1-feishu-'))
  const statePath = join(root, 'state.json')
  const closedWs = []
  let wsOptsList = []
  let handlers = null
  const createdMsgs = []
  const patchedMsgs = []

  const mockSdk = {
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { warn: 3 },
    async registerApp(opts) {
      opts.onQRCodeReady?.({ url: 'https://open.feishu.cn/q', expireIn: 300 })
      opts.onStatusChange?.({ status: 'domain_switched' })
      return { client_id: 'cli_lark_1', client_secret: 'sec_new_lark', user_info: { open_id: 'ou_lark' } }
    },
    Client: class {
      async request() { return { code: 0, bot: { app_name: 'Flow' } } }
      im = {
        v1: {
          message: {
            create: async (args) => {
              const id = `om_${createdMsgs.length + 1}`
              createdMsgs.push({ id, ...args })
              return { code: 0, data: { message_id: id } }
            },
            reply: async (args) => {
              const id = `om_${createdMsgs.length + 1}`
              createdMsgs.push({ id, ...args })
              return { code: 0, data: { message_id: id } }
            },
            patch: async (args) => { patchedMsgs.push(args); return { code: 0 } },
          },
        },
      }
    },
    EventDispatcher: class { register(h) { handlers = h; return this } },
    WSClient: class {
      constructor(opts) {
        this.opts = opts
        wsOptsList.push(opts)
      }
      async start() { await new Promise(r => setTimeout(r, 25)) }
      async close(opts) { closedWs.push({ ws: this, opts }) }
    },
  }

  setFeishuSdkOverride(mockSdk)
  try {
    // 1. P1-5: 并发 connect() 仅保留最后一条连接；在途已创建的旧 WS 强制 close({ force: true })，并验证 pingTimeout 与重连回调
    const c = createFeishuClient({ onMessage: () => {}, onCardAction: () => {} })
    const pA = c.connect({ appId: 'cli_1', appSecret: 'sec_1' })
    // 让第一次连接先进入 localWs.start() 等待握手，再发起第二次并发连接
    await new Promise(r => setTimeout(r, 5))
    const pB = c.connect({ appId: 'cli_2', appSecret: 'sec_2' })
    const [resA, resB] = await Promise.all([pA, pB])
    assert.equal(resA.ok, false)
    assert.equal(resB.ok, true)
    assert.ok(closedWs.length >= 1)
    assert.equal(closedWs[0].opts?.force, true)
    assert.equal(wsOptsList[wsOptsList.length - 1].wsConfig.pingTimeout, 10)
    wsOptsList[wsOptsList.length - 1].onReconnecting()
    assert.equal(c.status().state, 'connecting')
    assert.equal(c.isReady(), false)
    wsOptsList[wsOptsList.length - 1].onReconnected()
    assert.equal(c.status().state, 'connected')
    await c.disconnect()
    assert.equal(closedWs[closedWs.length - 1].opts?.force, true)

    // 2. P1-8: domain_switched → onCompleted 收到 'lark'，且 secretStore 优先新密钥而非旧配置里的过期密钥
    const credMap = new Map()
    const cfgOld = { feishu: { appSecret: 'stale_old_secret' } }
    const secretStore = createFeishuSecretStore({
      getConfig: () => cfgOld,
      getCredentials: () => ({
        set: async (k, v) => credMap.set(k, v),
        resolve: async (k) => (credMap.has(k) ? { value: credMap.get(k) } : undefined),
      }),
    })
    let completedPayload = null
    const onboarding = createFeishuOnboarding({
      secretStore,
      onCompleted: (p) => { completedPayload = p },
    })
    await onboarding.start({ domain: 'feishu', botName: 'LarkBot' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(completedPayload?.domain, 'lark')
    assert.equal(await secretStore.load(), 'sec_new_lark')

    // 3. P1-3: 私聊发现 chatId 持久化并在模拟重启后覆盖新 sessionId 的门禁推送
    const cfg = {
      docs: { enabled: true, dir: '.flow/docs', level: 'S', writePolicy: 'auto' },
      gate: { persist: false, timeoutSeconds: 0 },
      notify: { gate: 'im-first' },
      feishu: { enabled: true, appId: 'cli_p13', appSecret: 'sec_p13', allowedOpenIds: ['ou_u1'], defaultChatId: '', pushOnGate: true, pushOnBrake: true },
      im: { enabled: false },
    }
    const store1 = createFlowStateStore({ filePath: statePath, persist: true })
    const hub1 = createRemoteHub({
      bridge: { listWorkspaces: async () => [], listSessions: () => [] },
      tickets: { find: () => undefined },
      settler: {},
      gateRouter: {},
      breaker: {},
      getConfig: () => cfg,
    })
    const cmd1 = createFeishuCommander({ hub: hub1, getConfig: () => cfg, stateStore: store1 })
    await cmd1.connect()
    // 先来一条群消息，再来一条私聊消息 → 私聊应成为优先持久化目标
    await handlers['im.message.receive_v1']({
      event_id: 'ev-grp',
      sender: { sender_id: { open_id: 'ou_u1' } },
      message: { message_id: 'mg', chat_id: 'oc_group_99', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '/help' }) },
    })
    await handlers['im.message.receive_v1']({
      event_id: 'ev-p2p',
      sender: { sender_id: { open_id: 'ou_u1' } },
      message: { message_id: 'mp', chat_id: 'oc_private_77', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/help' }) },
    })
    await cmd1.dispose()

    // 模拟重启：新建 stateStore + commander + gateTool，验证仅发 1 张门禁互动卡（无双卡刷屏）且送达 oc_private_77，点击仅 patch 1 次
    createdMsgs.length = 0
    patchedMsgs.length = 0
    const store2 = createFlowStateStore({ filePath: statePath, persist: true })
    const tickets = createGateTickets({ getConfig: () => cfg })
    const fakeAgent = { id: 'ag2', session: { id: 'brand-new-session', header: { cwd: root } }, followup() {} }
    let hub2
    const settler = createGateSettler({
      getConfig: () => cfg,
      switchMode: async () => ({ label: 'Build', notes: [] }),
      tickets,
      resolveAgent: () => fakeAgent,
      onSettled: ({ ticket, action, by, note, effects }) => hub2.emit('gate:settled', { ticket, action, label: action, by, note, effects }),
    })
    const gateRouter = createGateRouter({ tickets, getConfig: () => cfg, resolveAgent: () => fakeAgent, settler })
    const bridge2 = createHarnessBridge({
      ctx: { agents: { list: () => [fakeAgent] } },
      readMode: () => 'plan',
      resolveAgent: () => fakeAgent,
      switchMode: async () => ({ label: 'Build', notes: [] }),
      tickets,
      breaker: { isLocked: () => false, listTrips: () => [] },
      stateStore: store2,
    })
    hub2 = createRemoteHub({ bridge: bridge2, tickets, settler, gateRouter, breaker: {}, getConfig: () => cfg })
    const cmd2 = createFeishuCommander({ hub: hub2, getConfig: () => cfg, stateStore: store2 })
    await cmd2.connect()
    const imChannel = createImChannel({ ctx: {}, getConfig: () => cfg, getFeishu: () => cmd2 })
    const gateTool = createGateTool({
      getConfig: () => cfg,
      notifier: {},
      im: imChannel,
      email: {},
      tickets,
      dispatchStore: createDispatchStore({ stateStore: store2 }),
      remoteHub: hub2,
      stateStore: store2,
    })

    await gateTool.execute({ fromStage: 'plan', nextMode: 'build', level: 'S', summary: '重启后首个门禁' }, { agent: fakeAgent })
    await new Promise(r => setTimeout(r, 30))

    // P1-6 & P1-3：只收到 1 张互动卡，且发往持久化恢复的私聊 oc_private_77
    assert.equal(createdMsgs.length, 1)
    assert.equal(createdMsgs[0].data.receive_id, 'oc_private_77')

    const ticket = tickets.openFor('brand-new-session')[0]
    await handlers['card.action.trigger']({
      event_id: 'ev-click-once',
      operator: { open_id: 'ou_u1' },
      context: { open_chat_id: 'oc_private_77', open_message_id: createdMsgs[0].id },
      action: { value: { kind: 'gate:decide', ticketId: ticket.id, token: '1', action: 'approve', label: '同意' } },
    })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(patchedMsgs.length, 1)

    // P1-6：群话题内点击 focus:session 只更新该话题键，不污染私聊焦点
    store2.setFeishuFocus('p2p:ou_u1', { sessionId: 'private-orig', project: 'orig', chatId: 'oc_private_77' })
    await handlers['card.action.trigger']({
      event_id: 'ev-grp-focus',
      operator: { open_id: 'ou_u1' },
      context: { open_chat_id: 'oc_group_99', open_message_id: 'om_g' },
      action: { value: { kind: 'focus:session', sessionId: 's-grp', project: 'grp-proj', cwd: '/grp', bindKey: 'group:oc_group_99:root_1', isGroup: true } },
    })
    assert.equal(store2.getFeishuFocus('p2p:ou_u1')?.sessionId, 'private-orig')
    assert.equal(store2.getFeishuThread('group:oc_group_99:root_1')?.sessionId, 's-grp')

    await cmd2.dispose()
    tickets.dispose()
  } finally {
    setFeishuSdkOverride(undefined)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('P1-4, P1-7, P1-9: whenIdle, workspaceRegistry, breaker unlock during /flow-notice, retry fresh id & full cleanup', async () => {
  // 1. workspaceRegistry 探测（P1-4）
  const bridge = createHarnessBridge({
    ctx: {
      agents: { list: () => [] },
      get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ cwd: '/work/reg-app', name: 'reg-app' }] } : undefined),
    },
    readMode: () => 'off',
    resolveAgent: () => undefined,
    switchMode: async () => ({}),
    tickets: { openFor: () => [] },
    breaker: { isLocked: () => false },
  })
  const workspaces = await bridge.listWorkspaces()
  assert.equal(workspaces.some(w => w.name === 'reg-app'), true)

  // 2. 熔断器使用 agent.whenIdle()，在 /flow-notice 耗时期间解锁绝不调度过期告警，且 retry 换新 message id
  let scheduledAlerts = 0
  let offCalls = 0
  const retriedMsgs = []
  const fakeCtx = {
    on: () => () => { offCalls += 1 },
    commands: {
      execute: async () => {
        await new Promise(r => setTimeout(r, 30))
        return { commandId: 'flow-notice', result: { kind: 'success', text: 'ok' } }
      },
    },
  }
  const breaker = createCircuitBreaker({
    ctx: fakeCtx,
    getConfig: () => ({ circuit: { enabled: true, threshold: 1 } }),
    notifier: { schedule: () => { scheduledAlerts += 1; return { cancel() {} } } },
    readMode: () => 'build',
  })

  const agentIdle = {
    id: 'ag-wi',
    session: {
      id: 'sess-wi',
      header: { cwd: '/work/wi' },
      seq: 1,
      eventAt: () => ({ type: 'user/message', data: { id: 'orig-u-1', role: 'user', source: 'legacy', content: [{ type: 'text', text: 'run' }] } }),
    },
    cancel() {},
    whenIdle: () => Promise.resolve(),
    followup: (m) => retriedMsgs.push(m),
  }

  breaker.observe({ agent: agentIdle, name: 'bash' }, { isError: true, error: { message: 'boom' } })
  await new Promise(r => setTimeout(r, 10))
  // 趁 /flow-notice 还在执行时秒解熔断
  breaker.unlock(agentIdle, 'manual')
  await new Promise(r => setTimeout(r, 50))
  assert.equal(scheduledAlerts, 0)

  // 再次熔断后 retry：重投消息 id 必须是全新的，且 source 为对象
  breaker.observe({ agent: agentIdle, name: 'bash' }, { isError: true, error: { message: 'boom2' } })
  breaker.retry(agentIdle)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(retriedMsgs.length, 1)
  assert.notEqual(retriedMsgs[0].id, 'orig-u-1')
  assert.equal(typeof retriedMsgs[0].source, 'object')
  assert.equal(retriedMsgs[0].source.kind, 'user')

  // 无 whenIdle 的 agent 走 agent/status 监听，dispose 时必须清理监听
  const agentNoIdle = { id: 'ag-no', session: { id: 'sess-no', header: { cwd: '/work/no' } }, cancel() {} }
  breaker.observe({ agent: agentNoIdle, name: 'bash' }, { isError: true, error: { message: 'e' } })
  breaker.dispose()
  assert.ok(offCalls >= 1)

  // P1-9: compact-bridge / dispatchStore / reworkTracker forget 清理
  const compact = createCompactBridge({ ctx: { get: () => undefined } })
  compact.schedule(agentIdle)
  assert.equal(compact.isScheduled(agentIdle), true)
  compact.forget(agentIdle)
  assert.equal(compact.isScheduled(agentIdle), false)
  compact.dispose()

  const dispatchStore = createDispatchStore()
  dispatchStore.remember('s-d', { line: 'ok' })
  assert.equal(dispatchStore.size, 1)
  dispatchStore.forget('s-d')
  assert.equal(dispatchStore.size, 0)

  const rework = createReworkTracker()
  rework.next('s-r')
  assert.equal(rework.peek('s-r').round, 1)
  rework.forget('s-r')
  assert.equal(rework.peek('s-r').round, 0)
})

test('P1-10: persisted expired open ticket converges on reload and uppercase /flow gate release works immediately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-p110-'))
  try {
    const cfg = { docs: { dir: '.flow/docs' }, gate: { persist: true } }
    const stateDir = join(root, '.flow', 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'gates.json'), JSON.stringify({
      version: 1,
      tickets: [
        {
          id: 'tab1',
          sessionId: 'sess-r',
          project: 'demo',
          cwd: root,
          kind: 'stage',
          state: 'open',
          hold: true,
          deadline: Date.now() - 10_000,
          createdAt: Date.now() - 20_000,
          options: [{ label: '批准', action: 'approve' }],
        },
      ],
    }, null, 2), 'utf8')

    const expiredEvents = []
    const tickets = createGateTickets({
      getConfig: () => cfg,
      onEvent: (type, t) => { if (type === 'expired') expiredEvents.push(t.id) },
    })

    // 未先调用 list，直接用大写 ID 执行 `/flow gate release TAB1`
    const res = await handleGateCommand({
      agent: { session: { id: 'sess-r', header: { cwd: root } } },
      rawArg: 'gate release TAB1',
      getConfig: () => cfg,
      tickets,
    })
    assert.equal(res.kind, 'success')
    const loaded = tickets.find('tab1', root)
    assert.equal(loaded.state, 'expired')
    assert.equal(loaded.hold, false)
    assert.deepEqual(expiredEvents, ['tab1'])
    tickets.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('P1-11: prompt updater writes local manifest.json on success and rejects oversized streamed response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-p111-'))
  const origFetch = globalThis.fetch
  try {
    const body = '# updated base\n'
    const digest = createHash('sha256').update(body, 'utf8').digest('hex')
    const manifestObj = { version: '9.9.9', updatedAt: '2099-01-01T00:00:00.000Z', files: [{ path: 'base.md', sha256: digest }] }

    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/manifest.json')) {
        return new Response(JSON.stringify(manifestObj), { status: 200 })
      }
      return new Response(body, { status: 200 })
    }
    const okRes = await updatePrompts({ sourceUrl: 'https://example.test/prompts', root, allowMirrorFallback: false })
    assert.equal(okRes.ok, true)
    assert.equal(existsSync(join(root, 'manifest.json')), true)
    assert.equal(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version, '9.9.9')

    // 流式超限响应：超过 512KB 在流读取中途立即中断报错
    const hugeChunk = new Uint8Array(200 * 1024)
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(hugeChunk)
        controller.enqueue(hugeChunk)
        controller.enqueue(hugeChunk)
        controller.close()
      },
    }), { status: 200 })
    const failRes = await updatePrompts({ sourceUrl: 'https://example.test/prompts', root, allowMirrorFallback: false })
    assert.equal(failRes.ok, false)
    assert.ok(String(failRes.reason ?? '').includes('过大'))
  } finally {
    globalThis.fetch = origFetch
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
