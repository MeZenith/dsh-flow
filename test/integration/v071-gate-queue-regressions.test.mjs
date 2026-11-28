import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../../src/plugin.js'
import { createCompactBridge, detectExternalCompactor } from '../../src/modes/compact-bridge.js'
import { createGateTickets } from '../../src/gates/tickets.js'
import { createGateSettler } from '../../src/gates/settler.js'
import { createGateRouter } from '../../src/gates/router.js'
import { createGateTool, inferCustomOptionAction } from '../../src/tools/gate.js'

function validDoc(id, sections = 4) {
  const body = [`# ${id} 方案`]
  for (let i = 1; i <= sections; i += 1) {
    body.push('', `## ${i}. 第 ${i} 节`, '', `详细内容与具体决策说明第 ${i} 节。`.repeat(4))
  }
  return body.join('\n')
}

/**
 * 忠实模拟 DSH `packages/core/agent-loop/src/agent.ts` 的运行态队列/阶段状态机：
 * - `running` 态下调用 `followup()` 不会设置 `wakeRequested`；
 * - `preStep` 返回 `reject` 时，`turn()` 直接退出进入 `idle`（不会消费 `next-turn` 队列！）；
 * - 只有 `idle` 态调用 `followup()` 才会拉起新一轮，或 `whenIdle()` 在进入 `idle` 后兑现。
 */
function createDshAgentLoopHarness({ sessionId, cwd }) {
  const inboxNextTurn = []
  const listeners = new Map()
  const executedTurns = []
  let status = 'idle'
  let compactCount = 0
  let busyErrors = 0
  let idleResolvers = []
  let gateRouter = null

  const emitStatus = (next) => {
    if (status === next) return
    status = next
    for (const fn of listeners.get('agent/status') ?? []) fn({ agent, status: next })
    if (next === 'idle') {
      const pending = idleResolvers
      idleResolvers = []
      for (const resolve of pending) resolve()
    }
  }

  const agent = {
    id: `ag-${sessionId}`,
    get status() { return status },
    session: { id: sessionId, header: { cwd } },
    inboxNextTurn,
    whenIdle() {
      if (status === 'idle') return Promise.resolve()
      return new Promise(resolve => { idleResolvers.push(resolve) })
    },
    followup(msg) {
      inboxNextTurn.push(msg)
      // 还原真实 DSH agent.ts#wakeDriver：running 态不会自唤醒；仅 idle 态才会启动新 turn
      if (status === 'idle') {
        void Promise.resolve().then(() => runTurnLoop())
      }
    },
    steer(msg) {
      inboxNextTurn.push(msg)
    },
    get compactCount() { return compactCount },
    get busyErrors() { return busyErrors },
    get executedTurns() { return executedTurns },
  }

  const compaction = {
    async compactNow() {
      if (status === 'running') {
        busyErrors += 1
        const err = new Error('busy')
        err.name = 'ManualCompactionError'
        err.code = 'busy'
        throw err
      }
      await new Promise(r => setTimeout(r, 15))
      compactCount += 1
      return { compacted: true }
    },
  }

  async function runTurnLoop() {
    while (inboxNextTurn.length > 0) {
      const msg = inboxNextTurn.shift()
      emitStatus('running')
      const decision = await gateRouter.preStep(
        { agent, messages: [msg] },
        async () => ({ kind: 'enter', messages: [msg] }),
      )
      if (decision?.kind === 'reject') {
        // 还原 agent.ts#L354-L356: return false → kick finally 设置 idle 并停止消费队列
        emitStatus('idle')
        return
      }
      executedTurns.push(msg)
      emitStatus('idle')
    }
  }

  return {
    agent,
    compaction,
    onStatus(fn) {
      let set = listeners.get('agent/status')
      if (!set) { set = new Set(); listeners.set('agent/status', set) }
      set.add(fn)
    },
    bindRouter(router) { gateRouter = router },
    async sendUserMessage(msg) {
      inboxNextTurn.push(msg)
      if (status === 'idle') await runTurnLoop()
    },
  }
}

test('G-01: desktop preStep defers followup until agent is idle & compaction finishes (autoCompactOnGate true/false & bare 0)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-g01-'))
  try {
    mkdirSync(root, { recursive: true })
    for (const autoCompactOnGate of [true, false]) {
      const cfg = {
        gate: { persist: false },
        behavior: { autoCompactOnGate },
        modes: { build: { label: 'Build' }, plan: { label: 'Plan' } },
      }
      const harness = createDshAgentLoopHarness({ sessionId: `sess-g01-${String(autoCompactOnGate)}`, cwd: root })
      const tickets = createGateTickets({ getConfig: () => cfg })
      const bridge = createCompactBridge({
        ctx: { get: (k) => (k === 'compaction' ? harness.compaction : undefined) },
        getHostCompaction: () => harness.compaction,
      })
      harness.onStatus(payload => bridge.onStatus(payload))

      const settler = createGateSettler({
        getConfig: () => cfg,
        switchMode: async () => ({ label: 'Build', notes: [] }),
        bridge,
        tickets,
        resolveAgent: () => harness.agent,
      })
      const router = createGateRouter({
        tickets,
        bridge,
        getConfig: () => cfg,
        resolveAgent: () => harness.agent,
        settler,
      })
      harness.bindRouter(router)

      const t1 = tickets.create({
        sessionId: harness.agent.session.id,
        project: 'demo',
        cwd: root,
        kind: 'stage',
        fromStage: 'plan',
        nextMode: 'build',
        docIds: ['03'],
        summary: 'done',
        options: [
          { label: '批准', action: 'approve' },
          { label: '修改', action: 'revise' },
        ],
        hold: true,
      })

      // 先测试桌面发 bare `0`：也必须延迟到 idle 后注入并唤醒展示摘要
      await harness.sendUserMessage({ id: 'u0', enqueuedAt: Date.now() + 10, content: '0' })
      await new Promise(r => setTimeout(r, 60))
      assert.equal(harness.agent.inboxNextTurn.length, 0)
      assert.equal(harness.agent.executedTurns.length, 1)
      assert.ok(harness.agent.executedTurns[0].content[0].text.includes(`[Flow 文档 #${t1.id}`))
      assert.equal(tickets.find(t1.id).state, 'open')

      // 再发桌面 bare `1 同意\n加毛玻璃`
      await harness.sendUserMessage({ id: 'u1', enqueuedAt: Date.now() + 20, content: '1 同意\n加毛玻璃' })
      await new Promise(r => setTimeout(r, 80))

      assert.equal(tickets.find(t1.id).state, 'answered')
      assert.equal(harness.agent.inboxNextTurn.length, 0)
      assert.equal(harness.agent.busyErrors, 0)
      assert.equal(harness.agent.compactCount, autoCompactOnGate ? 1 : 0)
      assert.equal(harness.agent.executedTurns.length, 2)
      const delivered = harness.agent.executedTurns[1].content[0].text
      assert.ok(delivered.includes(`[Flow 门禁决定·你已在桌面确认]`))
      assert.ok(delivered.includes(`票据 #${t1.id}`))
      assert.ok(delivered.includes('加毛玻璃'))

      router.dispose()
      bridge.dispose()
      tickets.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('G-01 fallback: waitForIdle via plugin agent/status wakes running mock without whenIdle()', async () => {
  const statusHandlers = []
  let registeredRouterProbe
  const fakeAgent = {
    id: 'ag-wait',
    status: 'running',
    session: { id: 'sess-wait', header: { cwd: process.cwd() } },
    ctx: {
      systemPrompt: { context: () => () => {} },
      on: (event, fn) => {
        if (event === 'agent/pre-step') registeredRouterProbe = fn
        return () => {}
      },
      effect: (fn) => { const d = fn(); return () => d?.() },
    },
    followups: [],
    followup(msg) { this.followups.push(msg) },
  }
  const scoped = {
    logger: { info() {}, warn() {}, error() {} },
    sessionProjections: { register: async () => ({ dispose: async () => {}, get: () => 'off' }) },
    systemPrompt: { getSectionOrder: () => 0, section: () => () => {} },
    agents: { list: () => [fakeAgent], get: (id) => (id === 'sess-wait' ? fakeAgent : undefined) },
    tools: { register: () => () => {}, get: () => undefined },
    commands: { register: () => () => {}, execute: async () => ({ result: { kind: 'success', text: 'ok' } }) },
    effect: (fn) => { const d = fn(); return () => d?.() },
    on(event, fn) {
      if (event === 'agent/status') statusHandlers.push(fn)
      return () => {}
    },
    get: () => undefined,
    inject: () => undefined,
  }
  apply({ logger: { info() {}, warn() {}, error() {} }, inject: (_d, cb) => cb(scoped) }, {
    feishu: { enabled: false },
    team: { enabled: false },
  })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(typeof registeredRouterProbe, 'function')
  // 触发状态转为 idle
  fakeAgent.status = 'idle'
  for (const fn of statusHandlers) fn({ agent: fakeAgent, status: 'idle' })
})

test('G-02: stale queued bare reply before ticket creation cannot auto-approve a new gate, while fresh reply and explicit #id work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-g02-'))
  try {
    mkdirSync(root, { recursive: true })
    const cfg = { gate: { persist: false }, behavior: { autoCompactOnGate: false }, modes: { build: { label: 'Build' } } }
    const tickets = createGateTickets({ getConfig: () => cfg })
    const followups = []
    const agent = {
      id: 'ag-g02',
      status: 'idle',
      session: { id: 'sess-g02', header: { cwd: root } },
      followup(msg) { followups.push(msg.content[0].text) },
    }
    const settler = createGateSettler({
      getConfig: () => cfg,
      switchMode: async () => ({ label: 'Build', notes: [] }),
      tickets,
      resolveAgent: () => agent,
    })
    const router = createGateRouter({
      tickets,
      getConfig: () => cfg,
      resolveAgent: () => agent,
      settler,
    })

    // 先把一条旧消息入队（模拟在上一关重复发送、滞留在 next-turn[1] 的消息）
    const oldTime = Date.now() - 10_000
    router.observeInboxSpliced({
      sessionId: 'sess-g02',
      event: {
        type: 'agent/inbox/spliced',
        time: oldTime,
        data: { inserted: [{ id: 'msg-stale-1', content: [{ type: 'text', text: '1 同意旧方案' }] }] },
      },
    })

    // 之后创建新门禁票据 tNew（createdAt 晚于 oldTime）
    const tNew = tickets.create({
      sessionId: 'sess-g02',
      project: 'demo',
      cwd: root,
      kind: 'stage',
      fromStage: 'plan',
      nextMode: 'build',
      summary: 'wait',
      options: [
        { label: '批准', action: 'approve' },
        { label: '暂停', action: 'pause' },
        { label: '打回修改', action: 'revise' },
      ],
      hold: true,
    })

    // 滞留旧消息被取出执行 preStep：绝不能自动批准 tNew，应直接放行给模型处理
    let passedToModel = false
    const staleRes = await router.preStep(
      { agent, messages: [{ id: 'msg-stale-1', content: [{ type: 'text', text: '1 同意旧方案' }] }] },
      async () => { passedToModel = true; return { kind: 'enter' } },
    )
    assert.equal(passedToModel, true)
    assert.equal(staleRes.kind, 'enter')
    assert.equal(tickets.find(tNew.id).state, 'open')
    assert.equal(followups.length, 0)

    // 显式带票据号（即使原消息入队时间早）仍可显式结算；先测一次新入队的裸回复 `3 框架使用Vite+Vue3`
    router.observeInboxSpliced({
      sessionId: 'sess-g02',
      event: {
        type: 'agent/inbox/spliced',
        time: tNew.createdAt + 50,
        data: { inserted: [{ id: 'msg-fresh-3', content: [{ type: 'text', text: '3 框架使用Vite+Vue3' }] }] },
      },
    })
    const freshRes = await router.preStep(
      { agent, messages: [{ id: 'msg-fresh-3', content: [{ type: 'text', text: '3 框架使用Vite+Vue3' }] }] },
      async () => ({ kind: 'enter' }),
    )
    assert.equal(freshRes.kind, 'reject')
    assert.equal(tickets.find(tNew.id).state, 'answered')
    assert.equal(tickets.find(tNew.id).action, 'revise')
    assert.equal(tickets.find(tNew.id).note, '框架使用Vite+Vue3')
    assert.equal(followups.length, 1)
    assert.ok(followups[0].includes('框架使用Vite+Vue3'))

    // 再开一票验证显式 `#ticketId 1` 不受旧消息时间限制
    const tExplicit = tickets.create({
      sessionId: 'sess-g02',
      project: 'demo',
      cwd: root,
      kind: 'stage',
      fromStage: 'plan',
      nextMode: 'build',
      summary: 'explicit',
      options: [{ label: '批准', action: 'approve' }],
      hold: true,
    })
    router.observeInboxSpliced({
      sessionId: 'sess-g02',
      event: {
        type: 'agent/inbox/spliced',
        time: oldTime,
        data: { inserted: [{ id: 'msg-exp', content: [{ type: 'text', text: `#${tExplicit.id} 1` }] }] },
      },
    })
    const expRes = await router.preStep(
      { agent, messages: [{ id: 'msg-exp', content: [{ type: 'text', text: `#${tExplicit.id} 1` }] }] },
      async () => ({ kind: 'enter' }),
    )
    assert.equal(expRes.kind, 'reject')
    assert.equal(tickets.find(tExplicit.id).state, 'answered')

    router.forgetSession('sess-g02')
    router.dispose()
    tickets.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('G-03 & G-04: gate markdown separates list from bullet metadata and custom options infer semantic actions', async () => {
  assert.equal(inferCustomOptionAction('批准，进入 Build 施工', 0), 'approve')
  assert.equal(inferCustomOptionAction('开启 Plan Ultra 深度审计', 1), 'revise')
  assert.equal(inferCustomOptionAction('打回修改，我要改方案', 2), 'revise')
  assert.equal(inferCustomOptionAction('先跳过这项', 1), 'skip')
  assert.equal(inferCustomOptionAction('暂停，由我手动接管', 2), 'pause')
  assert.equal(inferCustomOptionAction('拒绝写入', 2), 'deny')

  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-g03-'))
  try {
    mkdirSync(join(root, '.flow', 'docs'), { recursive: true })
    const cfg = {
      docs: { enabled: true, dir: '.flow/docs', level: 'S', enforce: 'warn', writePolicy: 'ask' },
      gate: { timeoutSeconds: 0, persist: false },
      notify: { gate: 'off' },
      modes: { build: { label: 'Build' }, plan: { label: 'Plan' } },
    }
    const tickets = createGateTickets({ getConfig: () => cfg })
    const gateTool = createGateTool({ getConfig: () => cfg, tickets })
    const agent = { session: { id: 'sess-g03', header: { cwd: root } } }

    // 1. 阶段门禁：验证自定义 options 语义动作与 Markdown 格式（不再有 `\n0. `）
    const stageRes = await gateTool.execute({
      fromStage: 'plan',
      nextMode: 'build',
      level: 'S',
      summary: '请审阅',
      options: ['批准，进入 Build 施工', '开启 Plan Ultra 深度审计', '打回修改，我要改方案'],
    }, { agent })
    assert.equal(stageRes.outcome, 'awaiting-user')
    assert.equal(stageRes.message.includes('\n0. '), false)
    assert.ok(stageRes.message.includes('\n\n- `0` 查看文档 / 草稿摘要\n- 回复：'))

    const stageTicket = tickets.openFor('sess-g03')[0]
    assert.deepEqual(stageTicket.options.map(o => o.action), ['approve', 'revise', 'revise'])

    // 2. 授权门禁：同样不出现 `\n0. ` 并用空行隔离列表与说明
    const permRes = await gateTool.execute({
      fromStage: 'plan',
      nextMode: 'off',
      kind: 'permission',
      docId: '05',
      draftContent: validDoc('05', 4),
      summary: 'perm',
    }, { agent })
    assert.equal(permRes.outcome, 'awaiting-user')
    assert.equal(permRes.message.includes('\n0. '), false)
    assert.ok(permRes.message.includes('\n\n- `0` 查看草稿摘要\n- 回复：'))
    tickets.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('G-05: compact-bridge and settler automatically detect billion-context and yield auto-compaction', async () => {
  const prevProxy = process.env.BILLION_CONTEXT_PROXY
  try {
    delete process.env.BILLION_CONTEXT_PROXY

    // 1. 通过 loader.entries() 检测到 bili-native
    assert.equal(detectExternalCompactor({
      get: (k) => (k === 'loader' ? { entries: () => [{ name: 'bili-native', disabled: false }] } : undefined),
    }).detected, true)

    // 2. 已禁用的 entry 不算检测到
    assert.equal(detectExternalCompactor({
      get: (k) => (k === 'loader' ? { entries: () => [{ name: 'bili-native', disabled: true }] } : undefined),
    }).detected, false)

    // 3. 通过 commands(acp + acp-cache) 检测，并在 settler 中自动让权、不触发警告与原生 compactNow
    let nativeCalled = 0
    const warns = []
    const infos = []
    const ctx = {
      get(k) {
        if (k === 'commands') return { get: (n) => (n === 'acp' || n === 'acp-cache' ? { name: n } : undefined) }
        return undefined
      },
    }
    const bridge = createCompactBridge({
      ctx,
      getHostCompaction: () => ({ compactNow: async () => { nativeCalled += 1; return {} } }),
      logger: { warn: m => warns.push(m), info: m => infos.push(m) },
    })
    assert.equal(bridge.externalCompactor().detected, true)
    assert.equal(bridge.schedule({ id: 'ag' }), false)

    const cfg = {
      gate: { persist: false },
      behavior: { autoCompactOnGate: true },
      modes: { build: { label: 'Build' } },
    }
    const tickets = createGateTickets({ getConfig: () => cfg })
    const agent = { id: 'ag-g05', status: 'idle', session: { id: 'sess-g05', header: { cwd: '/tmp' } } }
    const ticket = tickets.create({
      sessionId: 'sess-g05',
      project: 'demo',
      cwd: '/tmp',
      kind: 'stage',
      fromStage: 'plan',
      nextMode: 'build',
      summary: 'ok',
      options: [{ label: '批准', action: 'approve' }],
      hold: true,
    })
    const settler = createGateSettler({
      getConfig: () => cfg,
      switchMode: async () => ({ label: 'Build', notes: [] }),
      bridge,
      tickets,
      resolveAgent: () => agent,
      logger: { warn: m => warns.push(m), info: m => infos.push(m) },
    })
    const res = await settler.settle(ticket.id, { action: 'approve', by: 'desktop' })
    assert.equal(res.ok, true)
    assert.equal(res.effects.compactDelegated, 'billion-context')
    assert.equal(res.effects.compactScheduled, true)
    assert.equal(res.effects.compacted, undefined)
    assert.equal(nativeCalled, 0)
    assert.equal(warns.length, 0)

    // 4. 通过 BILLION_CONTEXT_PROXY 环境变量检测
    process.env.BILLION_CONTEXT_PROXY = 'http://127.0.0.1:4100'
    assert.equal(detectExternalCompactor({}).detected, true)

    bridge.dispose()
    tickets.dispose()
  } finally {
    if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY
    else process.env.BILLION_CONTEXT_PROXY = prevProxy
  }
})
