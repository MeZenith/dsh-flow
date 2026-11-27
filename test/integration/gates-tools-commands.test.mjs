import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGateTickets } from '../../src/gates/tickets.js'
import { createGateSettler } from '../../src/gates/settler.js'
import { createGateRouter } from '../../src/gates/router.js'
import { createFlowTools } from '../../src/tools/index.js'
import { createFlowCommand } from '../../src/commands/index.js'
import { createPromptStore } from '../../src/prompts/store.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'
import { parseLevelOverride } from '../../src/tools/route.js'

function validDoc(id, sections = 4) {
  const body = [`# ${id} 方案`]
  for (let i = 1; i <= sections; i += 1) {
    body.push('', `## ${i}. 第 ${i} 节`, '', `详细内容与具体决策说明第 ${i} 节。`.repeat(4))
  }
  return body.join('\n')
}

test('D-01, B-03, B-05, B-06, M-05, M-06, M-07: end-to-end gate, docs writePolicy, desktop bare 1, and commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-int-'))
  const cwd = join(root, 'demo-app')
  mkdirSync(cwd, { recursive: true })

  try {
    const cfg = {
      docs: { enabled: true, dir: '.flow/docs', level: 'M', enforce: 'block', writePolicy: 'auto' },
      gate: { timeoutSeconds: 0, escalate: 'both', imDigestChars: 200, docDigestChars: 800, persist: true },
      behavior: { autoCompactOnGate: false, flowAutonomy: 'one-gate' },
      email: { attachLimitBytes: 2 * 1024 * 1024 },
      notify: { gate: 'im-first', qa: 'email-first' },
      modes: { build: { label: 'Build' }, plan: { label: 'Plan' }, flow: { label: 'Flow' } },
      prompts: { customDir: join(root, 'custom') },
    }
    const getConfig = () => cfg
    const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: true })
    const tickets = createGateTickets({ getConfig })

    const followups = []
    const syncedModes = []
    const remoteEvents = []
    const agent = {
      id: 'ag-1',
      session: { id: 'sess-1', header: { cwd } },
      followup(msg) { followups.push(msg.content[0].text) },
      steer(msg) { followups.push(msg.content[0].text) },
    }
    const resolveAgent = (sid) => (sid === 'sess-1' ? agent : undefined)

    const settler = createGateSettler({
      getConfig,
      switchMode: async () => ({ label: 'direct', notes: [] }),
      syncModeCommand: async (_ag, modeId) => {
        syncedModes.push(modeId)
        return { ok: true, label: modeId, notes: [] }
      },
      tickets,
      resolveAgent,
    })

    const gateRouter = createGateRouter({
      tickets,
      getConfig,
      resolveAgent,
      settler,
    })

    const tools = createFlowTools({
      ctx: { tools: { get: () => undefined }, get: () => undefined },
      getConfig,
      switchMode: async (_ag, modeId) => ({ label: modeId, notes: [] }),
      getUserQuestions: () => ({
        ask: async () => ({ answers: [{ id: 'flow-route', selected: '【推荐】Plan', custom: '升到 L' }] }),
      }),
      tickets,
      remoteHub: { emit: (type, payload) => remoteEvents.push({ type, payload }) },
      stateStore,
    })
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))

    // M-07: 开局自定义升降级生效
    assert.equal(parseLevelOverride('升到 L'), 'L')
    assert.equal(parseLevelOverride('降到 S'), 'S')
    const routeRes = await byName.flow_choose_route.execute(
      { recommended: 'plan', level: 'M', reason: '先出方案', taskSummary: '重构' },
      { agent },
    )
    assert.equal(routeRes.outcome, 'switched')
    assert.ok(routeRes.message.includes('等级 L'))
    assert.equal(stateStore.getLevel('sess-1'), 'L')

    // D-01: 默认 writePolicy=auto 直接写文档无需授权门禁（03 需 7 节）
    const write03 = await byName.flow_docs_write.execute({ id: '03', content: validDoc('03', 7) }, { agent })
    assert.equal(write03.outcome, 'ok')
    assert.ok(write03.message.includes('授权 auto'))

    // D-01: writePolicy=auto 时调 kind=permission 直接放行，不建阻断票
    const permAuto = await byName.flow_stage_gate.execute(
      { fromStage: 'plan', nextMode: 'off', summary: 'write', kind: 'permission', docId: '03' },
      { agent },
    )
    assert.equal(permAuto.outcome, 'approved')

    // 建一张正常阶段门禁票（03 已就绪）
    const gate1 = await byName.flow_stage_gate.execute(
      { fromStage: 'plan', nextMode: 'plan', level: 'M', docIds: ['03'], summary: '03 方案已落盘' },
      { agent },
    )
    assert.equal(gate1.outcome, 'awaiting-user')
    const t1 = tickets.openFor('sess-1')[0]
    assert.ok(t1 !== undefined)
    // RemoteHub 立即收到 gate:created
    assert.equal(remoteEvents.some(e => e.type === 'gate:created' && e.payload.ticket.id === t1.id), true)

    // B-06: 再发一个缺文档的 05 门禁（会被 blocked），绝不能把 t1 作废！
    const blockedGate = await byName.flow_stage_gate.execute(
      { fromStage: 'plan', nextMode: 'build', level: 'M', docIds: ['05'], summary: '缺 05' },
      { agent },
    )
    assert.equal(blockedGate.outcome, 'blocked')
    assert.equal(tickets.find(t1.id).state, 'open')

    // B-05: 桌面发自然语言 "1个小问题" 不被误吞
    let passedThrough = false
    await gateRouter.preStep(
      { agent, messages: [{ content: '1个小问题想确认' }] },
      async () => { passedThrough = true; return { kind: 'continue' } },
    )
    assert.equal(passedThrough, true)
    assert.equal(tickets.find(t1.id).state, 'open')

    // B-05 & B-03: 桌面直接回裸 "1 同意\n顺便优化日志" → 结算、保留多行意见、经 syncModeCommand 切模式并唤醒！
    const settledRes = await gateRouter.preStep(
      { agent, messages: [{ id: 'u1', content: '1 同意\n顺便优化日志' }] },
      async () => ({ kind: 'continue' }),
    )
    assert.equal(settledRes.kind, 'reject')
    assert.equal(tickets.find(t1.id).state, 'answered')
    assert.equal(tickets.find(t1.id).note, '同意\n顺便优化日志')
    assert.deepEqual(syncedModes, ['plan'])
    assert.ok(followups[followups.length - 1].includes('顺便优化日志'))

    // M-05: 测试 writePolicy='ask' 下 permission 票据持久化 draftId & open hold 恢复
    cfg.docs.writePolicy = 'ask'
    const permAsk = await byName.flow_stage_gate.execute(
      { fromStage: 'plan', nextMode: 'off', kind: 'permission', docId: '05', draftContent: '# draft 05', summary: 'perm' },
      { agent },
    )
    assert.equal(permAsk.outcome, 'awaiting-user')
    const pTicket = tickets.openFor('sess-1')[0]
    assert.equal(pTicket.draftId, '05')

    // 重新建票据仓库从磁盘加载，验证 draftId 与 hold 保留
    const ticketsReloaded = createGateTickets({ getConfig })
    const loadedTicket = ticketsReloaded.find(pTicket.id, cwd)
    assert.equal(loadedTicket.draftId, '05')
    assert.equal(loadedTicket.hold, true)

    // Commands: /flow prompts list (B-01), /flow gate doc, /flow gate release <id>, /flow gate answer 保留大小写与唤醒
    const promptStore = createPromptStore({ getConfig })
    const cmd = createFlowCommand({
      ctx: {},
      getConfig,
      readMode: () => 'plan',
      tickets,
      settler,
      gateRouter,
      stateStore,
      prompts: { store: promptStore },
    })

    const pList = await cmd.handler({ agent, rawInput: 'prompts list' })
    assert.equal(pList.kind, 'success')
    assert.ok(pList.text.includes('五大模式来源'))

    const docCmd = await cmd.handler({ agent, rawInput: `gate doc ${pTicket.id}` })
    assert.equal(docCmd.kind, 'success')
    assert.ok(docCmd.text.includes('# draft 05'))

    const answerCmd = await cmd.handler({ agent, rawInput: `gate answer ${pTicket.id} 1 KeepExactCase` })
    assert.equal(answerCmd.kind, 'success')
    assert.equal(tickets.find(pTicket.id).note, 'KeepExactCase')
    assert.ok(followups[followups.length - 1].includes('KeepExactCase'))

    tickets.dispose()
    ticketsReloaded.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
