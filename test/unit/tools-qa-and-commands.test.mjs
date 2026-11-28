import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQaHandoffTool } from '../../src/tools/qa.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'
import { handleBreakerCommand, handleCompactCommand, handleFeishuCommand, handleHelpCommand, handleNotifyTestCommand } from '../../src/commands/ops.js'
import { handleDocsCommand, handleSpecCommand } from '../../src/commands/docs.js'

test('flow_qa_handoff handles subagent guard, round cap/reset, brief, package, notify, and errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-qa-tool-'))
  const docsDir = join(root, '.flow', 'docs')
  mkdirSync(docsDir, { recursive: true })
  const getConfig = () => ({ docs: { enabled: true, dir: '.flow/docs' }, notify: { qa: 'both' } })
  const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })
  const emitted = []
  const sentNotifications = []
  let throwNotify = false
  let notifyOk = true

  const tool = createQaHandoffTool({
    getConfig,
    stateStore,
    remoteHub: { emit: (type, payload) => emitted.push({ type, payload }) },
    notifier: {
      sendNow: async (kind, payload) => {
        if (throwNotify) throw new Error('smtp timeout')
        sentNotifications.push({ kind, payload })
        return { email: { ok: notifyOk }, im: { ok: notifyOk } }
      },
    },
  })

  const rootAgent = { id: 'ag1', session: { id: 'sess-qa', header: { cwd: root, origin: 'root' } } }
  const subAgent = { id: 'ag2', session: { id: 'sess-sub', header: { cwd: root, origin: 'subagent' } } }

  try {
    const subRes = await tool.execute({ action: 'round' }, { agent: subAgent })
    assert.equal(subRes.outcome, 'unavailable')

    assert.equal((await tool.execute({ action: 'round' }, { agent: rootAgent })).outcome, 'ok')
    assert.equal((await tool.execute({ action: 'round' }, { agent: rootAgent })).outcome, 'ok')
    assert.equal((await tool.execute({ action: 'round' }, { agent: rootAgent })).outcome, 'ok')
    const r4 = await tool.execute({ action: 'round' }, { agent: rootAgent })
    assert.equal(r4.outcome, 'blocked')

    assert.equal((await tool.execute({ action: 'reset' }, { agent: rootAgent })).outcome, 'ok')
    assert.equal((await tool.execute({ action: 'brief' }, { agent: rootAgent })).outcome, 'blocked')

    writeFileSync(join(docsDir, '06-blackbox-qa.md'), [
      '# 06 黑盒测试报告',
      '',
      '| 编号 | 现象/症状 | 复现步骤 | 影响范围 | 严重程度 |',
      '| --- | --- | --- | --- | --- |',
      '| BUG-1 | 提交按钮点击无反应 | 点击保存按钮 | 表单页 | Blocker |',
      '',
      '| 编号 | 点哪里/位置 | 期望结果 | 为什么测 |',
      '| --- | --- | --- | --- |',
      '| M-1 | 登录页面 | 跳转首页 | 验证主链路 |',
      '',
      '## 6 结论',
      '存在阻塞缺陷需修复',
    ].join('\n'), 'utf8')
    const briefRes = await tool.execute({ action: 'brief' }, { agent: rootAgent })
    assert.equal(briefRes.outcome, 'ok')
    assert.ok(briefRes.message.includes('BUG-1'))

    assert.equal((await tool.execute({ action: 'package' }, { agent: rootAgent })).outcome, 'blocked')
    writeFileSync(join(docsDir, '07-whitebox-qa.md'), [
      '# 07 白盒测试报告',
      '',
      '| BUG | 文件:行号 | 触发链 | 最小修复 | 回归点 |',
      '| --- | --- | --- | --- | --- |',
      '| BUG-1 | `src/app.js:12` | onClick 未绑定 | 绑定 handler | 保存流程 |',
      '',
      '安全审计 / 并发 / 孤儿模块 / 联动遗漏：已检查无异常。',
    ].join('\n'), 'utf8')
    const packRes = await tool.execute({ action: 'package', project: 'demo' }, { agent: rootAgent })
    assert.ok(packRes.outcome === 'ok' || packRes.outcome === 'partial')

    const notifyRes = await tool.execute({ action: 'notify', project: 'demo' }, { agent: rootAgent })
    assert.equal(notifyRes.outcome, 'ok')
    assert.equal(emitted.length, 1)
    assert.equal(sentNotifications[0].kind, 'qa')

    notifyOk = false
    assert.equal((await tool.execute({ action: 'notify' }, { agent: rootAgent })).outcome, 'error')

    throwNotify = true
    const throwRes = await tool.execute({ action: 'notify' }, { agent: rootAgent })
    assert.equal(throwRes.outcome, 'error')
    assert.ok(throwRes.message.includes('smtp timeout'))

    assert.equal((await tool.execute({ action: 'bogus' }, { agent: rootAgent })).outcome, 'unavailable')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('commands/ops handles compact, breaker, notify-test, feishu, and help subcommands', async () => {
  const ag = { id: 'ag', session: { id: 's-ops', header: { cwd: '/work/ops' } } }

  assert.equal((await handleCompactCommand({ agent: ag, bridge: undefined })).kind, 'error')
  assert.equal((await handleCompactCommand({ agent: ag, bridge: { runNow: async () => ({ ok: true, result: null }) } })).kind, 'success')
  const compOk = await handleCompactCommand({
    agent: ag,
    bridge: { runNow: async () => ({ ok: true, result: { shadowedSeqs: [1, 2], shadowedTokenCount: 120, summarySeq: 5 } }) },
  })
  assert.equal(compOk.sourceEventSeq, 5)
  assert.equal((await handleCompactCommand({ agent: ag, bridge: { runNow: async () => ({ ok: false, text: 'busy' }) } })).kind, 'error')

  assert.equal((await handleBreakerCommand({ head: 'retry', agent: ag, breaker: undefined })).kind, 'error')
  const calls = []
  const fakeBreaker = {
    retry: () => calls.push('retry'),
    escalate: async () => true,
    resume: () => calls.push('resume'),
  }
  assert.equal((await handleBreakerCommand({ head: 'retry', agent: ag, breaker: fakeBreaker })).kind, 'success')
  assert.equal((await handleBreakerCommand({ head: 'escalate', agent: ag, breaker: fakeBreaker })).kind, 'success')
  assert.equal((await handleBreakerCommand({ head: 'resume', agent: ag, breaker: fakeBreaker })).kind, 'success')
  assert.deepEqual(calls, ['retry', 'resume'])

  assert.equal((await handleNotifyTestCommand({ im: undefined, email: undefined })).kind, 'error')
  const ntOk = await handleNotifyTestCommand({
    im: { test: async () => ({ ok: true, detail: 'im ok' }) },
    email: { test: async () => ({ ok: false, detail: 'smtp fail' }) },
    feishu: {
      status: async () => ({ connected: true }),
      sendTestCard: async () => ({ ok: true, detail: 'card ok' }),
    },
  })
  assert.ok(ntOk.text.includes('card ok') && ntOk.text.includes('im ok') && ntOk.text.includes('smtp fail'))

  assert.equal((await handleFeishuCommand({ rawArg: 'feishu status', feishu: undefined })).kind, 'error')
  const fakeFeishu = {
    connect: async () => ({ ok: true, appId: 'cli_1', domain: 'feishu' }),
    disconnect: async () => {},
    sendTestCard: async () => ({ ok: false, reason: 'no target' }),
    status: async () => ({ connected: false, state: 'disconnected', allowedCount: 0, domain: 'feishu', lastError: 'timeout' }),
  }
  assert.equal((await handleFeishuCommand({ rawArg: 'feishu connect', feishu: fakeFeishu })).kind, 'success')
  assert.equal((await handleFeishuCommand({ rawArg: 'feishu disconnect', feishu: fakeFeishu })).kind, 'success')
  assert.equal((await handleFeishuCommand({ rawArg: 'feishu test', feishu: fakeFeishu })).kind, 'error')
  assert.ok((await handleFeishuCommand({ rawArg: 'feishu status', feishu: fakeFeishu })).text.includes('timeout'))

  assert.ok(handleHelpCommand().text.includes('/flow'))
})

test('commands/docs handles init, check, S-level, and /flow spec variants', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-cmd-docs-'))
  const config = { docs: { enabled: true, dir: '.flow/docs', level: 'M' }, spec: { enabled: true, path: '.flow/spec.md', maxChars: 600 } }
  const agent = { id: 'ag', session: { id: 's-docs', header: { cwd: root } } }
  const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })

  try {
    const missing = handleDocsCommand({ agent, rawArg: 'docs list', config, stateStore })
    assert.equal(missing.kind, 'error')

    const init = handleDocsCommand({ agent, rawArg: 'docs init', config, stateStore })
    assert.equal(init.kind, 'success')

    writeFileSync(
      join(root, '.flow', 'docs', '05-dev-spec.md'),
      [
        '<!-- flow:doc id="05" status="complete" -->',
        '# 05 Dev Spec',
        ...[1, 2, 3, 4, 5, 6, 7].map(
          n => `## ${n}. 模块设计说明\n本节完整定义分层状态机、严格边界校验、熔断恢复与飞书双向指令同步机制，覆盖边界输入与错误码约束。\n`,
        ),
      ].join('\n'),
      'utf8',
    )
    const single = handleDocsCommand({ agent, rawArg: 'docs 05', config, stateStore })
    assert.equal(single.kind, 'success')

    const sLevel = handleDocsCommand({ agent, rawArg: 'docs list', config: { docs: { level: 'S', dir: '.flow/docs' } }, stateStore })
    assert.equal(sLevel.kind, 'success')

    assert.ok(handleSpecCommand({ agent, config: { spec: { enabled: false, path: '.flow/spec.md' } } }).text.includes('已关闭'))
    assert.ok(handleSpecCommand({ agent, config }).text.includes('尚未创建'))
    writeFileSync(join(root, '.flow', 'spec.md'), '<!-- flow:summary -->\n# Summary\nGoal X\n<!-- /flow:summary -->\n', 'utf8')
    const specHit = handleSpecCommand({ agent, config })
    assert.ok(specHit.text.includes('Goal X'))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('createDocsTools covers init, check, writePolicy/hold/once, preview & deliver branches', async () => {
  const { createDocsTools } = await import('../../src/tools/docs.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-tools-docs-'))
  let writePolicy = 'auto'
  let hold = null
  let canWriteRes = { ok: true, scope: 'auto' }
  let consumed = 0
  const deliveries = []
  const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })

  const tools = createDocsTools({
    getConfig: () => ({ docs: { enabled: true, dir: '.flow/docs', level: 'M', writePolicy }, spec: { path: '.flow/spec.md' } }),
    tickets: {
      holdOf: () => hold,
      canWrite: () => canWriteRes,
      consumeOnce: () => { consumed += 1 },
    },
    email: { enabled: true, send: async (arg) => { deliveries.push(['email', arg]); return { ok: true } } },
    im: { enabled: true, send: async (arg) => { deliveries.push(['im', arg]); return { ok: true } } },
    remoteHub: {
      emit: (ev, arg) => { deliveries.push([ev, arg]); return true },
      pushFile: async (arg) => { deliveries.push(['feishu', arg]); return { ok: true } },
    },
    stateStore,
  })
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))
  const exec = { id: 'sub_0', agent: { id: 'ag', session: { id: 's-td', header: { cwd: root } } } }

  try {
    assert.equal((await byName.flow_docs_init.execute({ level: 'S' }, exec)).outcome, 'skipped')
    assert.equal((await byName.flow_docs_check.execute({ level: 'S' }, exec)).outcome, 'skipped')
    assert.equal((await byName.flow_docs_init.execute({ ids: ['05'] }, exec)).outcome, 'ok')
    assert.equal((await byName.flow_docs_init.execute({ ids: ['05'] }, exec)).outcome, 'ok')
    assert.equal((await byName.flow_docs_check.execute({ ids: ['05'] }, exec)).outcome, 'blocked')

    assert.equal((await byName.flow_docs_write.execute({ target: 'doc', content: 'x' }, exec)).outcome, 'unavailable')
    hold = { id: 't99' }
    assert.equal((await byName.flow_docs_write.execute({ id: '05', content: 'x' }, exec)).outcome, 'blocked')
    hold = null

    writePolicy = 'ask'
    canWriteRes = { ok: false, reason: 'need approval' }
    assert.equal((await byName.flow_docs_write.execute({ id: '05', content: 'x' }, exec)).outcome, 'needs-permission')

    writePolicy = 'auto'
    canWriteRes = { ok: true, scope: 'once' }
    const docBody = [1, 2, 3, 4, 5, 6, 7].map(n => `## ${n}. 章节\n内容详情覆盖边界与异常处理机制，确保测试稳定通过。\n`).join('\n')
    const wDoc = await byName.flow_docs_write.execute({ id: '05', content: docBody, deliver: 'both' }, exec)
    assert.equal(wDoc.outcome, 'ok')
    assert.equal(consumed, 1)
    assert.ok(deliveries.some(d => d[0] === 'email'))

    assert.equal((await byName.flow_docs_check.execute({ ids: ['05'] }, exec)).outcome, 'ok')
    const wPreview = await byName.flow_docs_write.execute({ target: 'preview', name: 'demo', content: '<h1>hi</h1>', deliver: 'both' }, exec)
    assert.equal(wPreview.outcome, 'ok')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
