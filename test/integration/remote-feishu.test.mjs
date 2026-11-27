import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAppPreset, resolveAvatarUrls } from '../../src/remote/feishu/presets.js'
import { ensureNoProxyForFeishu, setFeishuSdkOverride } from '../../src/remote/feishu/sdk-loader.js'
import { encodeQrDataUrl, encodeQrMatrix } from '../../src/remote/feishu/qr-svg.js'
import { FEISHU_SECRET_CRED_REF, formatOnboardingError, registrationHostOf } from '../../src/remote/feishu/onboarding.js'
import { FLOW_SLASH_COMMANDS, syncFeishuSlashCommands } from '../../src/remote/feishu/slash-commands.js'
import { splitMarkdownChunks } from '../../src/remote/feishu/reply-stream.js'
import { createHarnessBridge } from '../../src/remote/harness-bridge.js'
import { createRemoteHub } from '../../src/remote/hub.js'
import { createFeishuCommander } from '../../src/remote/feishu/index.js'
import { createGateTickets } from '../../src/gates/tickets.js'
import { createGateSettler } from '../../src/gates/settler.js'
import { createGateRouter } from '../../src/gates/router.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'

test('Feishu presets, QR SVG encoder, NO_PROXY & error diagnostics', () => {
  const okPreset = buildAppPreset({ name: '我的研发官', description: '自定义简介', avatarUrl: 'cat' })
  assert.equal(okPreset.ok, true)
  assert.equal(okPreset.appPreset.name, '我的研发官')
  assert.equal(okPreset.appPreset.desc, '自定义简介')
  assert.ok(okPreset.appPreset.avatar[0].startsWith('https://'))

  const okCustomUrl = buildAppPreset({ name: 'Bot', avatarUrl: 'https://cdn.example.com/icon.png' })
  assert.equal(okCustomUrl.ok, true)
  assert.deepEqual(okCustomUrl.appPreset.avatar, ['https://cdn.example.com/icon.png'])

  assert.equal(resolveAvatarUrls('http://127.0.0.1:3080/a.png').ok, false)
  assert.equal(resolveAvatarUrls('C:\\Users\\a.png').ok, false)
  assert.equal(resolveAvatarUrls('data:image/png;base64,AAAA').ok, false)

  // registerApp 裸主机名（不可使用 lark.Domain 数字枚举 0/1）
  assert.equal(registrationHostOf('feishu'), 'accounts.feishu.cn')
  assert.equal(registrationHostOf('lark'), 'accounts.larksuite.com')

  // NO_PROXY 同时覆盖 open.* 与 accounts.*
  const prevNoProxy = process.env.NO_PROXY
  try {
    process.env.NO_PROXY = 'localhost'
    ensureNoProxyForFeishu('feishu')
    assert.ok(process.env.NO_PROXY.includes('open.feishu.cn'))
    assert.ok(process.env.NO_PROXY.includes('accounts.feishu.cn'))
  } finally {
    if (prevNoProxy === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = prevNoProxy
  }

  // 零依赖 QR SVG 编码器（短 URL + 长飞书 OAuth URL）
  const longUrl = `https://open.feishu.cn/page/launcher?user_code=TEST-1234&addons=${'A'.repeat(420)}`
  const qr = encodeQrMatrix(longUrl)
  assert.ok(qr.version >= 14 && qr.size === qr.version * 4 + 17)
  const dataUrl = encodeQrDataUrl(longUrl)
  assert.ok(dataUrl.startsWith('data:image/svg+xml;charset=utf-8,'))

  // 证书与过期错误提示友好化
  assert.ok(formatOnboardingError({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }).includes('TLS 证书'))
  assert.ok(formatOnboardingError({ code: 'expired_token' }).includes('二维码已过期'))
  assert.ok(formatOnboardingError({ code: 'access_denied' }).includes('取消授权'))
})

test('Feishu Commander end-to-end: QR onboarding, allowlist, multi-project @routing, card click ACK+patch, file upload, dedupe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-feishu-'))
  const sentMessages = []
  const patchedMessages = []
  const uploadedFiles = []
  let registeredHandlers = null
  let registerAppArgs = null

  const mockSdk = {
    // 复刻真实 @larksuiteoapi/node-sdk 1.77.0 的数字枚举（Feishu=0, Lark=1），防止 registerApp 误传枚举导致 https://0
    Domain: { 0: 'Feishu', 1: 'Lark', Feishu: 0, Lark: 1 },
    LoggerLevel: { warn: 3 },
    async registerApp(opts) {
      registerAppArgs = opts
      opts.onQRCodeReady?.({ url: 'https://open.feishu.cn/page/launcher?user_code=TEST-0001', expireIn: 300 })
      opts.onStatusChange?.({ status: 'scanned', message: '已扫码' })
      return { client_id: 'cli_test_123', client_secret: 'sec_test_456', user_info: { open_id: 'ou_owner_1' } }
    },
    Client: class MockClient {
      async request(req) {
        if (req.url === '/open-apis/bot/v3/info') {
          return { code: 0, bot: { app_name: '我的研发管家', avatar_url: 'https://cdn.example.com/bot.png', open_id: 'ou_bot' } }
        }
        return { code: 0 }
      }
      im = {
        v1: {
          message: {
            create: async (args) => {
              const id = `om_${sentMessages.length + 1}`
              sentMessages.push({ kind: 'create', id, ...args })
              return { code: 0, data: { message_id: id } }
            },
            reply: async (args) => {
              const id = `om_${sentMessages.length + 1}`
              sentMessages.push({ kind: 'reply', id, ...args })
              return { code: 0, data: { message_id: id } }
            },
            patch: async (args) => {
              patchedMessages.push(args)
              return { code: 0 }
            },
          },
          file: {
            create: async (args) => {
              uploadedFiles.push(args.data.file_name)
              return { file_key: `file_key_${uploadedFiles.length}` }
            },
          },
        },
      }
    },
    EventDispatcher: class MockDispatcher {
      register(handlers) {
        registeredHandlers = handlers
        return this
      }
    },
    WSClient: class MockWS {
      async start() { return true }
      async close() { return true }
    },
  }

  setFeishuSdkOverride(mockSdk)
  try {
    const cfg = {
      docs: { enabled: true, dir: '.flow/docs', level: 'M', writePolicy: 'auto' },
      gate: { persist: false, docDigestChars: 800 },
      circuit: { threshold: 3 },
      feishu: {
        enabled: true,
        domain: 'feishu',
        botName: '我的研发管家',
        botDescription: '测试描述',
        botAvatarUrl: 'https://cdn.example.com/custom.png',
        allowedOpenIds: ['ou_owner_1'],
        defaultChatId: 'oc_default_chat',
        pushOnGate: true,
        pushOnBrake: true,
        pushOnComplete: true,
        sendDocFiles: true,
      },
    }
    const getConfig = () => cfg
    const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })
    const savedCreds = new Map()
    const inboxA = []
    const inboxB = []
    const switchedModes = []

    const agentA = { id: 'agA', session: { id: 'sess-A', header: { cwd: '/work/alpha' } }, followup: m => inboxA.push(m.content[0].text), cancel() {} }
    const agentB = { id: 'agB', session: { id: 'sess-B', header: { cwd: '/work/beta' } }, followup: m => inboxB.push(m.content[0].text), cancel() {} }
    const agents = [agentA, agentB]
    const resolveAgent = sid => agents.find(a => a.session.id === sid)

    const tickets = createGateTickets({ getConfig })
    const settler = createGateSettler({
      getConfig,
      switchMode: async (_a, m) => { switchedModes.push(m); return { label: m, notes: [] } },
      tickets,
      resolveAgent,
      onSettled: ({ ticket, action, by, note, effects }) => {
        hub.emit('gate:settled', { ticket, action, label: action, by, note, effects })
      },
    })
    const gateRouter = createGateRouter({ tickets, getConfig, resolveAgent, settler })
    const breakerMock = {
      isLocked: () => false,
      listTrips: () => [],
      resolveRemoteAction: async ({ sessionId, action }) => ({ ok: true, action, project: sessionId === 'sess-A' ? 'alpha' : 'beta', message: `已处理 ${action}` }),
    }

    const bridge = createHarnessBridge({
      ctx: { agents: { list: () => agents } },
      readMode: () => 'plan',
      resolveAgent,
      switchMode: async (_a, m) => { switchedModes.push(m); return { label: m, notes: [] } },
      tickets,
      breaker: breakerMock,
      stateStore,
    })

    const hub = createRemoteHub({ bridge, tickets, settler, gateRouter, breaker: breakerMock, getConfig })
    const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
    assert.match(FEISHU_SECRET_CRED_REF, REF_RE)
    const commander = createFeishuCommander({
      hub,
      getConfig,
      getCredentials: () => ({
        resolve: async (k) => {
          if (!REF_RE.test(k)) throw new TypeError(`invalid ref ${k}`)
          const v = savedCreds.get(k)
          return v ? { value: v, source: 'file' } : undefined
        },
        set: async (k, v) => {
          if (!REF_RE.test(k)) throw new TypeError(`invalid ref ${k}`)
          savedCreds.set(k, v)
        },
        unset: async (k) => { savedCreds.delete(k) },
      }),
      stateStore,
    })

    // 1. 扫码建应用：校验自定义名称与头像透传给 appPreset，且完成后自动保存凭据并连接 WS
    const onboardRes = await commander.startOnboarding({
      domain: 'feishu',
      botName: '我的研发管家',
      botDescription: '测试描述',
      botAvatarUrl: 'https://cdn.example.com/custom.png',
    })
    assert.equal(onboardRes.ok, true)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(registerAppArgs.domain, 'accounts.feishu.cn')
    assert.equal(registerAppArgs.appPreset.name, '我的研发管家')
    assert.equal(registerAppArgs.appPreset.desc, '测试描述')
    assert.deepEqual(registerAppArgs.appPreset.avatar, ['https://cdn.example.com/custom.png'])
    assert.deepEqual(registerAppArgs.addons.events.items.tenant, ['im.message.receive_v1'])
    assert.deepEqual(registerAppArgs.addons.callbacks.items, ['card.action.trigger'])
    const finalOnboard = commander.onboardingStatus()
    assert.equal(finalOnboard.ownerOpenId, 'ou_owner_1')
    assert.ok(finalOnboard.qrSvgDataUrl.startsWith('data:image/svg+xml;charset=utf-8,'))
    assert.equal(savedCreds.get(FEISHU_SECRET_CRED_REF), 'sec_test_456')
    assert.equal(commander.isReady(), true)

    // 2. 非白名单用户被拒绝；但 `/id` 可查自己的 open_id
    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-stranger-1',
      sender: { sender_id: { open_id: 'ou_stranger' } },
      message: { message_id: 'm0', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '帮我删库' }) },
    })
    assert.equal(inboxA.length, 0)
    assert.equal(inboxB.length, 0)
    assert.ok(sentMessages[sentMessages.length - 1].data.content.includes('白名单'))

    // 3. 白名单用户发 `/m` → 推送项目指挥台卡片
    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-menu',
      sender: { sender_id: { open_id: 'ou_owner_1' } },
      message: { message_id: 'm1', chat_id: 'oc_default_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/m' }) },
    })
    const menuMsg = sentMessages[sentMessages.length - 1]
    assert.equal(menuMsg.data.msg_type, 'interactive')
    assert.ok(menuMsg.data.content.includes('alpha'))
    assert.ok(menuMsg.data.content.includes('beta'))

    // 4. `@beta 帮我写单测` → 自动切焦点到 beta 并派活；后续直接发消息也直达 beta
    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-at-beta',
      sender: { sender_id: { open_id: 'ou_owner_1' } },
      message: { message_id: 'm2', chat_id: 'oc_default_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '@beta 帮我写单测' }) },
    })
    assert.deepEqual(inboxB, ['帮我写单测'])

    // 重复 event_id 必须去重
    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-at-beta',
      sender: { sender_id: { open_id: 'ou_owner_1' } },
      message: { message_id: 'm2', chat_id: 'oc_default_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '@beta 帮我写单测' }) },
    })
    assert.equal(inboxB.length, 1)

    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-plain-beta',
      sender: { sender_id: { open_id: 'ou_owner_1' } },
      message: { message_id: 'm3', chat_id: 'oc_default_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '再补一个边界用例' }) },
    })
    assert.deepEqual(inboxB, ['帮我写单测', '再补一个边界用例'])

    // 5. 门禁创建 → 自动发飞书门禁卡片 + 直接上传 .md 文件
    const ticket = tickets.create({
      sessionId: 'sess-A',
      project: 'alpha',
      cwd: '/work/alpha',
      kind: 'stage',
      fromStage: 'plan',
      nextMode: 'build',
      summary: '完整架构方案已定稿',
      options: [{ label: '同意进入 Build', action: 'approve' }, { label: '打回', action: 'revise' }],
      docIds: ['05'],
      hold: true,
    })
    hub.emit('gate:created', {
      ticket,
      attachments: [{ filename: '05-dev-spec.md', content: Buffer.from('# Spec\n', 'utf8') }],
      summary: ticket.summary,
    })
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(uploadedFiles, ['05-dev-spec.md'])
    const cardMsg = sentMessages.find(m => m.data?.msg_type === 'interactive' && m.data.content.includes(ticket.id))
    assert.ok(cardMsg !== undefined)

    // 6. 点击飞书门禁卡片按钮 → 秒回 toast，后台结算并原地 patch 卡片 + 唤醒 alpha！
    const ack = await registeredHandlers['card.action.trigger']({
      event_id: 'ev-card-1',
      operator: { open_id: 'ou_owner_1' },
      context: { open_chat_id: 'oc_default_chat', open_message_id: cardMsg.id },
      action: { value: { kind: 'gate:decide', ticketId: ticket.id, token: '1', action: 'approve', label: '同意进入 Build' } },
    })
    assert.equal(ack.toast.type, 'success')
    await new Promise(r => setTimeout(r, 30))
    assert.equal(tickets.find(ticket.id).state, 'answered')
    assert.deepEqual(switchedModes, ['build'])
    assert.ok(inboxA[0].includes('来自飞书卡片'))
    assert.ok(patchedMessages.some(p => p.path.message_id === cardMsg.id && p.data.content.includes('门禁已结算')))

    // 7. 熔断事件 → 推红色抢救卡片 → 点按钮后原地 patch 为已解除
    hub.emit('brake:tripped', { sessionId: 'sess-A', project: 'alpha', mode: 'build', streak: 3, threshold: 3, errors: ['boom'] })
    await new Promise(r => setTimeout(r, 20))
    const brakeMsg = sentMessages.find(m => m.data?.msg_type === 'interactive' && m.data.content.includes('熔断急刹'))
    assert.ok(brakeMsg !== undefined)
    const brakeAck = await registeredHandlers['card.action.trigger']({
      event_id: 'ev-card-brake',
      operator: { open_id: 'ou_owner_1' },
      context: { open_chat_id: 'oc_default_chat', open_message_id: brakeMsg.id },
      action: { value: { kind: 'brake:action', sessionId: 'sess-A', action: 'escalate', project: 'alpha' } },
    })
    assert.equal(brakeAck.toast.type, 'success')
    await new Promise(r => setTimeout(r, 20))
    assert.ok(patchedMessages.some(p => p.path.message_id === brakeMsg.id && p.data.content.includes('熔断已解除')))

    await commander.dispose()
    tickets.dispose()
  } finally {
    setFeishuSdkOverride(undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('Feishu v0.6.1: streaming reply cards, desktop sync isolation, welcome & mode cards, slash sync, and competitive DSH tool approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-feishu-v061-'))
  const sentMessages = []
  const patchedMessages = []
  const streamUpdates = []
  const cardkitFinished = []
  const slashCalls = []
  let registeredHandlers = null
  let lastRegisterArgs = null

  const mockSdk = {
    Domain: { 0: 'Feishu', 1: 'Lark', Feishu: 0, Lark: 1 },
    LoggerLevel: { warn: 3 },
    async registerApp(opts) {
      lastRegisterArgs = opts
      opts.onQRCodeReady?.({ url: 'https://open.feishu.cn/page/launcher?user_code=UPG-1', expireIn: 300 })
      return { client_id: opts.appId || 'cli_v061', client_secret: 'sec_v061', user_info: { open_id: 'ou_me' } }
    },
    Client: class MockClient {
      async request(req) {
        if (req.url === '/open-apis/bot/v3/info') {
          return { code: 0, bot: { app_name: 'Flow 指挥官', avatar_url: '', open_id: 'ou_bot' } }
        }
        if (req.url === '/open-apis/application/v7/app_slash_commands') {
          slashCalls.push(req)
          if (req.method === 'GET') return { code: 0, data: { items: [{ command: 'm' }] } }
          return { code: 0, data: { command_id: `cmd_${slashCalls.length}` } }
        }
        return { code: 0 }
      }
      cardkit = {
        v1: {
          card: {
            create: async () => ({ code: 0, data: { card_id: `ck_${sentMessages.length + 1}` } }),
            update: async (args) => { cardkitFinished.push(args); return { code: 0 } },
            settings: async () => ({ code: 0 }),
          },
          cardElement: {
            content: async (args) => { streamUpdates.push(args); return { code: 0 } },
          },
        },
      }
      im = {
        v1: {
          message: {
            create: async (args) => {
              const id = `om_${sentMessages.length + 1}`
              sentMessages.push({ kind: 'create', id, ...args })
              return { code: 0, data: { message_id: id } }
            },
            reply: async (args) => {
              const id = `om_${sentMessages.length + 1}`
              sentMessages.push({ kind: 'reply', id, ...args })
              return { code: 0, data: { message_id: id } }
            },
            patch: async (args) => {
              patchedMessages.push(args)
              return { code: 0 }
            },
          },
          file: { create: async () => ({ file_key: 'fk_1' }) },
        },
      }
    },
    EventDispatcher: class { register(h) { registeredHandlers = h; return this } },
    WSClient: class { async start() { return true } async close() { return true } },
  }

  setFeishuSdkOverride(mockSdk)
  try {
    const cfg = {
      docs: { enabled: true, dir: '.flow/docs', level: 'M', writePolicy: 'auto' },
      gate: { persist: false },
      circuit: { threshold: 3 },
      feishu: {
        enabled: true,
        domain: 'feishu',
        appId: 'cli_v061',
        appSecret: 'sec_v061',
        botName: 'Flow 指挥官',
        allowedOpenIds: ['ou_me'],
        defaultChatId: 'oc_me',
        pushOnGate: true,
        pushOnBrake: true,
        pushOnApproval: true,
        syncDesktopReplies: false,
        pushOnComplete: true,
        sendDocFiles: true,
      },
    }
    const getConfig = () => cfg
    const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })
    const inbox = []
    let currentMode = 'flow'
    let aborted = false
    const agent = {
      id: 'ag1',
      session: { id: 'sess-1', header: { cwd: '/work/demo' } },
      followup: (m) => inbox.push(m),
      cancel: () => { aborted = true },
    }
    const resolveAgent = sid => (sid === 'sess-1' ? agent : undefined)
    const tickets = createGateTickets({ getConfig })
    const settler = createGateSettler({
      getConfig,
      switchMode: async (_a, m) => { currentMode = m; return { label: m, notes: [] } },
      tickets,
      resolveAgent,
    })
    const gateRouter = createGateRouter({ tickets, getConfig, resolveAgent, settler })
    const breaker = { isLocked: () => false, listTrips: () => [], resolveRemoteAction: async () => ({ ok: true }) }
    const bridge = createHarnessBridge({
      ctx: { agents: { list: () => [agent] } },
      readMode: () => currentMode,
      resolveAgent,
      switchMode: async (_a, m) => { currentMode = m; return { label: m, notes: [] } },
      tickets,
      breaker,
      stateStore,
    })
    const hub = createRemoteHub({ bridge, tickets, settler, gateRouter, breaker, getConfig })
    const commander = createFeishuCommander({ hub, getConfig, stateStore })

    const conn = await commander.connect()
    assert.equal(conn.ok, true)

    // 1. Slash command sync (0ms delay unit check + missing permission check)
    const missingPermRes = await syncFeishuSlashCommands({
      apiClient: { request: async () => ({ code: 99991672, msg: 'no permission' }) },
      delayMs: 0,
    })
    assert.equal(missingPermRes.ok, false)
    assert.equal(missingPermRes.status, 'missing_permission')

    const createdCmds = []
    const syncedRes = await syncFeishuSlashCommands({
      apiClient: {
        request: async (req) => {
          if (req.method === 'GET') return { code: 0, data: { items: [{ command: 'm' }] } }
          createdCmds.push(req.data.command)
          return { code: 0, data: { command_id: 'c1' } }
        },
      },
      delayMs: 0,
    })
    assert.equal(syncedRes.ok, true)
    assert.equal(syncedRes.status, 'synced')
    assert.equal(syncedRes.created, FLOW_SLASH_COMMANDS.length - 1)
    assert.equal(createdCmds[createdCmds.length - 1], 'mode')

    // 2. 欢迎引导卡 & 图形模式切换卡（点按钮切模式并原地 patch）
    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-hi',
      sender: { sender_id: { open_id: 'ou_me' } },
      message: { message_id: 'm-hi', chat_id: 'oc_me', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好' }) },
    })
    assert.ok(sentMessages.some(m => m.data.content.includes('3 秒上手') && m.data.content.includes('ui:open-modes')))

    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-mode',
      sender: { sender_id: { open_id: 'ou_me' } },
      message: { message_id: 'm-mode', chat_id: 'oc_me', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/mode' }) },
    })
    const modeCardMsg = sentMessages[sentMessages.length - 1]
    assert.ok(modeCardMsg.data.content.includes('切换模式'))

    const modeAck = await registeredHandlers['card.action.trigger']({
      event_id: 'ev-mode-click',
      operator: { open_id: 'ou_me' },
      context: { open_chat_id: 'oc_me', open_message_id: modeCardMsg.id },
      action: { value: { kind: 'mode:switch', sessionId: 'sess-1', project: 'demo', mode: 'build' } },
    })
    assert.equal(modeAck.toast.type, 'success')
    await new Promise(r => setTimeout(r, 30))
    assert.equal(currentMode, 'build')
    assert.ok(patchedMessages.some(p => p.path.message_id === modeCardMsg.id && p.data.content.includes('当前：build')))

    // 3. 飞书发问题 → 立刻出流式卡片 → 接收 stream delta & tool/call & turn/end → 定稿卡片回推！
    await registeredHandlers['im.message.receive_v1']({
      event_id: 'ev-ask',
      sender: { sender_id: { open_id: 'ou_me' } },
      message: { message_id: 'm-ask', chat_id: 'oc_me', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '怎么启动项目？' }) },
    })
    assert.equal(inbox.length, 1)
    commander.onInboxClaimed({ sessionId: 'sess-1', messageId: inbox[0].id, turn: 7 })
    commander.onSessionEvent({ sessionId: 'sess-1', event: { type: 'tool/call', data: { turn: 7, name: 'read_file' } }, project: 'demo', mode: 'build' })
    commander.onAssistantStream({ sessionId: 'sess-1', frame: { type: 'start', attemptId: 'a1', turn: 7, step: 1 }, project: 'demo', mode: 'build' })
    commander.onAssistantStream({ sessionId: 'sess-1', frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', index: 0, text: '运行 npm test 即可。' } }, project: 'demo', mode: 'build' })
    commander.onSessionEvent({
      sessionId: 'sess-1',
      event: { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '运行 `npm test` 即可。' }] } } },
      project: 'demo',
      mode: 'build',
    })
    commander.onSessionEvent({ sessionId: 'sess-1', event: { type: 'turn/end', data: { turn: 7, reason: 'completed' } }, project: 'demo', mode: 'build' })
    await new Promise(r => setTimeout(r, 60))
    assert.ok(cardkitFinished.some(u => u.data.card.data.includes('运行 `npm test` 即可')))
    assert.ok(cardkitFinished.some(u => u.data.card.data.includes('ui:open-workspaces')))

    // 4. 桌面端日常对话防打扰隔离：syncDesktopReplies=false 不推，true 才推
    const beforeCount = sentMessages.length
    commander.onSessionEvent({
      sessionId: 'sess-1',
      event: { type: 'assistant/message', data: { turn: 8, step: 0, message: { content: [{ type: 'text', text: '桌面端悄悄话' }] } } },
      project: 'demo',
      mode: 'build',
    })
    commander.onSessionEvent({ sessionId: 'sess-1', event: { type: 'turn/end', data: { turn: 8, reason: 'completed' } }, project: 'demo', mode: 'build' })
    await new Promise(r => setTimeout(r, 40))
    assert.equal(sentMessages.length, beforeCount)

    cfg.feishu.syncDesktopReplies = true
    commander.onSessionEvent({
      sessionId: 'sess-1',
      event: { type: 'assistant/message', data: { turn: 9, step: 0, message: { content: [{ type: 'text', text: '桌面镜像同步内容' }] } } },
      project: 'demo',
      mode: 'build',
    })
    commander.onSessionEvent({ sessionId: 'sess-1', event: { type: 'turn/end', data: { turn: 9, reason: 'completed' } }, project: 'demo', mode: 'build' })
    await new Promise(r => setTimeout(r, 60))
    assert.ok(sentMessages.length > beforeCount)
    assert.ok(cardkitFinished.some(u => u.data.card.data.includes('桌面镜像同步内容')))

    // 5. 竞争式 DSH 工具审批：飞书先点允许 → 立刻 resolve 并 abort 桌面弹窗 + patch 卡片
    let desktopAborted = false
    const apprReq = {
      agent,
      toolName: 'bash',
      reason: '执行测试命令',
      input: { command: 'npm test' },
      signal: new AbortController().signal,
    }
    const apprPromise = commander.handleApprovalRequest(apprReq, () => new Promise((resolve) => {
      apprReq.signal.addEventListener('abort', () => { desktopAborted = true; resolve('cancelled') }, { once: true })
    }))
    await new Promise(r => setTimeout(r, 30))
    const apprCard = sentMessages.find(m => m.data.content.includes('工具执行审批'))
    assert.ok(apprCard !== undefined)
    const parsedAppr = JSON.parse(apprCard.data.content)
    const allowBtn = parsedAppr.body.elements.find(el => el.tag === 'column_set').columns[0].elements[0]
    const apprId = allowBtn.behaviors[0].value.approvalId

    const apprAck = await registeredHandlers['card.action.trigger']({
      event_id: 'ev-appr-ok',
      operator: { open_id: 'ou_me' },
      context: { open_chat_id: 'oc_me', open_message_id: apprCard.id },
      action: { value: { kind: 'approval:decide', approvalId: apprId, decision: 'allowed-once' } },
    })
    assert.equal(apprAck.toast.type, 'success')
    assert.equal(await apprPromise, 'allowed-once')
    assert.equal(desktopAborted, true)
    assert.ok(patchedMessages.some(p => p.path.message_id === apprCard.id && p.data.content.includes('已允许执行')))

    // 6. 停止按钮 & 定向补权 QR
    await registeredHandlers['card.action.trigger']({
      event_id: 'ev-abort',
      operator: { open_id: 'ou_me' },
      context: { open_chat_id: 'oc_me', open_message_id: 'om_x' },
      action: { value: { kind: 'turn:abort', sessionId: 'sess-1' } },
    })
    assert.equal(aborted, true)

    const upg = await commander.startPermissionUpgrade()
    assert.equal(upg.ok, true)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(lastRegisterArgs.appId, 'cli_v061')

    // 7. 长回复自动分片
    const longChunks = splitMarkdownChunks(`${'段落内容。'.repeat(400)}\n\n${'后半段内容。'.repeat(400)}`, 1000)
    assert.ok(longChunks.length >= 4)

    await commander.dispose()
    tickets.dispose()
  } finally {
    setFeishuSdkOverride(undefined)
    rmSync(root, { recursive: true, force: true })
  }
})
