/**
 * P0 + P1 自检（真模块 + 假宿主）。
 *
 * 不依赖 DSH 运行时：`userQuestions` / `notifier` / `im` / `email` 全部用假对象注入，
 * 但被验证的是真实模块逻辑：文档白名单、章节校验、票据状态机、pre-step 遥控、
 * 倒计时竞速、超时严格停手、附件投递、结算器副作用（授权 / 切模式）、跨重启授权恢复。
 *
 * 运行：`node test/p0p1.selftest.mjs`（退出码非 0 表示有用例失败）
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPromptApi } from '../prompt-api.js'
import { migrateLegacyCustom, resolveCustomDir } from '../prompt-store.js'

import {
  attachmentsOf, checkDoc, digestOf, docsNote, ensureDocs, resolveTarget, templateOf, writeDoc,
} from '../flow-docs.js'
import { createGateTickets, formatImGate } from '../gate-tickets.js'
import { createGateSettler } from '../gate-settle.js'
import { createGateRouter } from '../gate-router.js'
import { createFlowTools } from '../tools.js'
import { describeLevel, gateRequiredDocs, levelDef, rememberLevel, shouldDeliverDocs } from '../flow-level.js'
import { collectAttachments } from '../notify-email.js'
import { BASE_RULES, Config, plainConfigOf } from '../config.js'
import { buildLevelBlock, buildModeText } from '../mode-plan.js'
import { createUiSkillProbe, normalizeSkillName } from '../flow-ui-skill.js'
import {
  buildFixPackage, buildQaNotification, buildWhiteboxBrief, createReworkTracker, parseBlackbox, parseWhitebox,
} from '../qa-handoff.js'
import { probeDispatchCapabilities, requiresDeclaration } from '../dispatch-declare.js'
import { isAllowedPath } from '../prompt-updater.js'

/* ------------------------------------------------------------------ *
 * 测试脚手架
 * ------------------------------------------------------------------ */

const results = []
let failures = 0

function test(name, fn) {
  try {
    const value = fn()
    results.push({ name, ok: true, note: typeof value === 'string' ? value : '' })
  } catch (error) {
    failures += 1
    results.push({ name, ok: false, note: error instanceof Error ? error.message : String(error) })
  }
}

async function testAsync(name, fn) {
  try {
    const value = await fn()
    results.push({ name, ok: true, note: typeof value === 'string' ? value : '' })
  } catch (error) {
    failures += 1
    results.push({ name, ok: false, note: error instanceof Error ? error.message : String(error) })
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-flow-selftest-'))
const cwd = join(root, 'proj')
mkdirSync(cwd, { recursive: true })

/** 可变配置：用例之间只改需要的字段。 */
const cfg = {
  docs: { enabled: true, dir: '.flow/docs', level: 'M', enforce: 'strict', writePolicy: 'ask' },
  gate: { timeoutSeconds: 1800, escalate: 'both', imDigestChars: 200, docDigestChars: 800, persist: false },
  behavior: { autoCompactOnGate: false },
  email: { attachLimitBytes: 2 * 1024 * 1024 },
  notify: { gate: 'im-first' },
}
const getConfig = () => cfg

/** 生成一份"有效"文档正文：章节号齐全、长度过线、无占位符。 */
function validDoc(id, sections) {
  const body = [`# ${id} 测试文档`]
  for (let index = 1; index <= sections; index += 1) {
    body.push('', `## ${index}. 第 ${index} 节`, '', `本节内容为自检用正文，重复填充以保证超过最短长度限制。第 ${index} 节说明：`.repeat(2))
  }
  return body.join('\n')
}

function makeTickets(overrides = {}) {
  return createGateTickets({ getConfig, logger: { warn() {}, info() {} }, diag() {}, ...overrides })
}

/**
 * 默认结算器：假 `switchMode` 只记录调用，方便断言"模式是不是真的切了"。
 *
 * @param {object} tickets 票据仓库。
 * @param {{ resolveAgent?: (id: string) => object | undefined, switches?: string[] }} [options]
 */
function makeSettler(tickets, { resolveAgent = () => undefined, switches = [] } = {}) {
  return createGateSettler({
    getConfig,
    switchMode: async (agent, modeId) => {
      switches.push(modeId)
      return { label: modeId, notes: [] }
    },
    bridge: { schedule: () => true },
    notifier: { schedule: () => ({ cancel() {} }) },
    tickets,
    resolveAgent,
    logger: { warn() {}, info() {} },
  })
}

/* ------------------------------------------------------------------ *
 * P0：真实入口导入冒烟（先跑）
 * ------------------------------------------------------------------ */

await testAsync('P0-0 真实入口导入冒烟：index.js / prompt-bridge.js 能无错求值', async () => {
  const bridge = await import('../prompt-bridge.js')
  assert.equal(bridge.DOCS_CONTEXT, 'flow:docs')
  assert.equal(bridge.PROMPT_NAMES.DOCS_CONTEXT, 'flow:docs')
  assert.equal(bridge.PROMPT_NAMES.MODE_CONTEXT, 'flow:mode')
  assert.equal(typeof bridge.attachAgentDocsContext, 'function')

  const entry = await import('../index.js')
  assert.equal(entry.name, 'flow')
  assert.equal(typeof entry.apply, 'function')
  assert.ok(Array.isArray(entry.inject) && entry.inject.includes('systemPrompt'))
  assert.equal(typeof entry.Config, 'function')

  const cfgMod = await import('../config.js')
  const plain = cfgMod.plainConfigOf(cfgMod.Config({}))
  assert.equal(plain.docs.level, 'M')
  assert.equal(plain.docs.dir, '.flow/docs')
  assert.equal(plain.gate.timeoutSeconds, 1800)

  const tools = await import('../tools.js')
  assert.equal(typeof tools.createFlowTools, 'function')
  assert.equal(tools.GATE_TOOL, 'flow_stage_gate')
  assert.equal(tools.DOCS_WRITE_TOOL, 'flow_docs_write')
  return 'index / prompt-bridge / tools / config 四处入口求值成功'
})

/* ------------------------------------------------------------------ *
 * P0：编号文档
 * ------------------------------------------------------------------ */

test('P0-1 模板按需读取：prompts/docs 里有 7 份且可读', () => {
  const ids = ['01', '02', '03', '04', '05', '06', '07']
  for (const id of ids) assert.ok(templateOf(id).length > 200, `模板 ${id} 过短`)
  return `7 份模板，最大 ${Math.max(...ids.map(id => templateOf(id).length))} 字符`
})

test('P0-2 docsNote 不超过 5 行且不含模板正文', () => {
  const note = docsNote({ config: cfg, cwd, level: 'M' })
  const lines = note.split('\n')
  assert.ok(lines.length <= 5, `便利贴 ${lines.length} 行，超过 5 行上限`)
  assert.ok(!note.includes('## 1. 目标与成功画像'), '便利贴里混进了模板正文')
  return `${lines.length} 行 / ${note.length} 字符`
})

test('P0-3 flow_docs_init：等级 M 生成 5 份骨架，已存在的跳过', () => {
  const wanted = ['01', '03', '05', '06', '07']
  const first = ensureDocs({ config: cfg, cwd, ids: wanted })
  assert.equal(first.created.length, 5, `M 级应生成 5 份，实际 ${first.created.join(',')}`)
  const second = ensureDocs({ config: cfg, cwd, ids: wanted })
  assert.equal(second.created.length, 0)
  assert.equal(second.skipped.length, 5)
  return `首次 ${first.created.join(' ')}；再次全部跳过`
})

test('P0-4 骨架不算有效文档（占位符必须被拦住）', () => {
  const report = checkDoc({ config: cfg, cwd, id: '03', level: 'M' })
  assert.equal(report.ok, false)
  assert.ok(report.reasons.some(reason => reason.includes('占位符')), `实际原因：${report.reasons.join('；')}`)
  return report.reasons.join('；')
})

test('P0-5 写入校验：有效正文通过，缺章节被点名', () => {
  const good = writeDoc({ config: cfg, cwd, target: { kind: 'doc', id: '03' }, content: validDoc('03', 7) })
  assert.equal(good.ok, true)
  const okReport = checkDoc({ config: cfg, cwd, id: '03', level: 'M' })
  assert.equal(okReport.ok, true, okReport.reasons.join('；'))

  const bad = writeDoc({ config: cfg, cwd, target: { kind: 'doc', id: '05' }, content: `${validDoc('05', 3)}\n${'填充'.repeat(120)}` })
  assert.equal(bad.ok, true)
  const badReport = checkDoc({ config: cfg, cwd, id: '05', level: 'M' })
  assert.equal(badReport.ok, false)
  assert.deepEqual(badReport.missing, [4, 5, 6, 7])
  return `缺章节被点名：${badReport.missing.map(n => `§${n}`).join(' ')}`
})

test('P0-6 路径白名单：只放行 .flow/docs/** 与 .flow/spec.md', () => {
  const bad = [
    { kind: 'doc', id: '99' },
    { kind: 'preview', name: '../evil' },
    { kind: 'preview', name: 'ok/../x' },
    { kind: 'unknown' },
  ]
  for (const target of bad) {
    assert.equal(resolveTarget({ config: cfg, cwd, target }).ok, false, `本应拒绝：${JSON.stringify(target)}`)
  }
  const doc = resolveTarget({ config: cfg, cwd, target: { kind: 'doc', id: '3' } })
  assert.equal(doc.ok, true)
  assert.equal(doc.display, '.flow/docs/03-tech-and-env.md')
  const spec = resolveTarget({ config: cfg, cwd, target: { kind: 'spec' } })
  assert.equal(spec.ok, true)
  assert.equal(spec.display, '.flow/spec.md')
  return `放行 ${doc.display} 与 ${spec.display}；拒绝 4 个越界目标`
})

test('P0-7 业务代码写到不了：resolveTarget 永远不给 src/*.js', () => {
  for (const id of ['01', '02', '03', '04', '05', '06', '07']) {
    const resolved = resolveTarget({ config: cfg, cwd, target: { kind: 'doc', id } })
    assert.equal(resolved.ok, true)
    assert.ok(resolved.display.startsWith('.flow/docs/'), `${id} 落到了 ${resolved.display}`)
  }
  return '7 个编号全部锁在 .flow/docs/ 下'
})

test('P0-8 文档摘要与附件：正文进附件、摘要进正文', () => {
  const digest = digestOf({ config: cfg, cwd, ids: ['03'], maxChars: 120 })
  assert.ok(digest.text.includes('03'), '摘要缺少编号')
  const { attachments } = attachmentsOf({ config: cfg, cwd, ids: ['03'] })
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0].filename, '03-tech-and-env.md')
  assert.ok(attachments[0].content.length > 200)
  return `摘要 ${digest.text.length} 字符；附件 ${attachments[0].content.length} 字节`
})

test('P0-9 等级矩阵：M 要 01/03/05/06/07，L 要全套，S 不要文档', () => {
  assert.deepEqual(gateRequiredDocs({ level: 'M', kind: 'stage', nextMode: 'build' }), ['01', '03', '05'])
  assert.deepEqual(gateRequiredDocs({ level: 'L', kind: 'stage', nextMode: 'build' }), ['01', '02', '03', '04', '05'])
  assert.deepEqual(gateRequiredDocs({ level: 'M', kind: 'acceptance' }), ['06', '07'])
  assert.deepEqual(gateRequiredDocs({ level: 'S', kind: 'stage', nextMode: 'build' }), [])
  assert.ok(describeLevel('L').includes('01/02/03/04/05/06/07'))
  return '矩阵与 flow-level.js 同源'
})

test('P0-10 投递矩阵：01 单发不投，03/05 要投，permission 不投', () => {
  assert.equal(shouldDeliverDocs({ kind: 'stage', docIds: ['01'] }).deliver, false)
  assert.equal(shouldDeliverDocs({ kind: 'stage', docIds: ['03'] }).deliver, true)
  assert.equal(shouldDeliverDocs({ kind: 'stage', docIds: ['05'] }).deliver, true)
  assert.equal(shouldDeliverDocs({ kind: 'permission', docIds: ['03'] }).deliver, false)
  return '01 不发 / 03·05 发 / permission 不发'
})

/* ------------------------------------------------------------------ *
 * P1：票据与授权
 * ------------------------------------------------------------------ */

test('P1-1 票据状态机：create → decide，状态、动作与 note 落住', () => {
  const tickets = makeTickets()
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'stage', level: 'M', fromStage: 'plan', nextMode: 'build',
    question: 'q', options: [{ label: 'A', action: 'approve' }, { label: 'B', action: 'skip' }], docIds: ['03'], timeoutSeconds: 60,
  })
  assert.equal(tickets.openFor('desk').length, 1)
  const decided = tickets.decide(ticket.id, { action: 'skip', by: 'im', note: '先跳过，明天再看' })
  assert.equal(decided.ok, true)
  assert.equal(decided.ticket.state, 'skipped')
  assert.equal(decided.ticket.action, 'skip', '必须记住动作，否则回头只能读到状态')
  assert.equal(decided.ticket.note, '先跳过，明天再看')
  assert.equal(tickets.openFor('desk').length, 0)
  return `#${ticket.id} → skipped，action/note 都在`
})

test('P1-2 超时：expire 置 hold，releaseHold 才放行', () => {
  const tickets = makeTickets()
  const ticket = tickets.create({ sessionId: 'desk2', project: 'demo', cwd, kind: 'stage', question: 'q', options: [], docIds: [], timeoutSeconds: 1 })
  tickets.expire(ticket.id)
  assert.equal(tickets.holdOf('desk2')?.id, ticket.id)
  assert.equal(tickets.releaseHold('desk2'), 1)
  assert.equal(tickets.holdOf('desk2'), undefined)
  return 'expire → hold → release 后仍待人决定'
})

test('P1-3 写授权：none/once/session-docs/deny/auto 五种口径', () => {
  const tickets = makeTickets()
  assert.equal(tickets.canWrite('s1', { docId: '03' }).ok, false)
  tickets.grant('s1', 'once', { docId: '03' })
  assert.equal(tickets.canWrite('s1', { docId: '03' }).ok, true)
  assert.equal(tickets.canWrite('s1', { docId: '05' }).ok, false, 'once 授权不能串到别的文档')
  tickets.consumeOnce('s1')
  assert.equal(tickets.canWrite('s1', { docId: '03' }).ok, false, 'once 用后必须失效')
  tickets.grant('s1', 'session-docs')
  assert.equal(tickets.canWrite('s1', { docId: '05' }).ok, true)
  tickets.grant('s1', 'deny')
  assert.equal(tickets.canWrite('s1', { docId: '05' }).ok, false)
  assert.equal(tickets.canWrite('s1', { docId: '05', policy: 'auto' }).ok, true)
  return 'once 单篇有效、session-docs 全域、deny 拦住、auto 直通'
})

test('P1-4 IM 摘要：长问题截断但票据号与 1/2/3 指引完好', () => {
  const tickets = makeTickets()
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'stage', fromStage: 'plan', nextMode: 'build',
    question: `这是一段很长的结论${'，包含了很多模块名与文件名'.repeat(40)}`,
    options: [{ label: '同意，切换到 Build', action: 'approve' }, { label: '方案还需调整', action: 'revise' }, { label: '先暂停', action: 'pause' }],
    docIds: ['03', '05'], timeoutSeconds: 0,
  })
  const text = formatImGate(ticket, { digestChars: 60 })
  const lines = text.split('\n')
  assert.ok(lines[0].includes(`#${ticket.id}`))
  assert.ok(lines[1].includes('1=') && lines[1].includes('2=') && lines[1].includes('3='))
  assert.ok(lines[2].includes(`#${ticket.id} 1`))
  assert.ok(text.includes('已发邮箱附件'))
  assert.ok(text.length < 700, `摘要过长：${text.length}`)
  return `首行 ${lines[0]}｜总长 ${text.length}`
})

/* ------------------------------------------------------------------ *
 * P1：pre-step 遥控
 * ------------------------------------------------------------------ */

function imPayload(text, sessionId = 'im-session') {
  return {
    agent: { session: { id: sessionId, header: { origin: 'root', cwd } } },
    messages: [{ content: [{ type: 'text', text: `<dsh_im_source>{"channel":"weixin"}</dsh_im_source>${text}` }] }],
  }
}

/** 桌面主会话的一条普通用户消息（不带 IM 包裹）。 */
function deskPayload(text, sessionId = 'desk') {
  return {
    agent: { session: { id: sessionId, header: { origin: 'root', cwd } } },
    messages: [{ content: [{ type: 'text', text }] }],
  }
}

function makeDeskAgent(sessionId = 'desk') {
  const steers = []
  const followups = []
  return {
    steers,
    followups,
    agent: {
      session: { id: sessionId, header: { origin: 'root', cwd } },
      steer(message) { steers.push(message) },
      followup(message) { followups.push(message) },
    },
  }
}

await testAsync('P1-5 IM 遥控：掐断 IM 推理 + 决定与附带意见原样转给桌面', async () => {
  const tickets = makeTickets()
  const desk = makeDeskAgent()
  const switches = []
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'stage', fromStage: 'plan', nextMode: 'build',
    question: 'q', options: [{ label: '同意', action: 'approve' }, { label: '跳过', action: 'skip' }], docIds: [], timeoutSeconds: 60,
  })
  const acks = []
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async (payload) => { acks.push(payload); return { ok: true, via: 'fake' } } },
    getConfig,
    resolveAgent: id => (id === 'desk' ? desk.agent : undefined),
    settler: makeSettler(tickets, { resolveAgent: id => (id === 'desk' ? desk.agent : undefined), switches }),
  })
  let nextCalled = false
  const decision = await router.preStep(imPayload(`#${ticket.id} 1 同意 文档直接发送到我的邮箱内`), async () => {
    nextCalled = true
    return { kind: 'continue' }
  })
  assert.equal(decision.kind, 'reject')
  assert.equal(nextCalled, false, '不许放行给 IM 会话推理')
  assert.equal(tickets.find(ticket.id, cwd).state, 'answered')
  assert.deepEqual(switches, ['build'], '结算器必须真的切模式')
  assert.equal(desk.steers.length + desk.followups.length, 1, '没有前台等待时必须转交一次')
  const forwarded = (desk.steers[0] ?? desk.followups[0]).content[0].text
  assert.ok(forwarded.includes('同意 文档直接发送到我的邮箱内'))
  assert.equal(acks.length, 1)
  return 'reject ✓｜切模式 ✓｜转交 1 次｜note 原样'
})

await testAsync('P1-6 歧义保护：门禁与熔断同时待决时，裸数字不执行任何动作', async () => {
  const tickets = makeTickets()
  const desk = makeDeskAgent()
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'stage', fromStage: 'plan', nextMode: 'build',
    question: 'q', options: [{ label: '同意', action: 'approve' }, { label: '跳过', action: 'skip' }], docIds: [], timeoutSeconds: 60,
  })
  const acks = []
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [{ key: 'session:desk', project: 'demo', streak: 3, at: Date.now() }] },
    im: { send: async (payload) => { acks.push(payload); return { ok: true } } },
    getConfig,
    resolveAgent: () => desk.agent,
    settler: makeSettler(tickets, { resolveAgent: () => desk.agent }),
  })
  const decision = await router.preStep(imPayload('2'), async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'reject')
  assert.equal(tickets.find(ticket.id, cwd).state, 'open', '歧义时绝不能结算票据')
  assert.equal(desk.steers.length, 0)
  assert.ok(acks[0].markdown.includes('歧义') && acks[0].markdown.includes(`#${ticket.id}`))
  return '裸数字被拦下并要求带票据号，票据仍 open'
})

await testAsync('P1-7 只有熔断没有门禁：裸数字放行给熔断器', async () => {
  const tickets = makeTickets()
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [{ key: 'session:x', project: 'demo', streak: 3, at: Date.now() }] },
    im: { send: async () => ({ ok: true }) },
    getConfig,
    resolveAgent: () => undefined,
    settler: makeSettler(tickets),
  })
  let nextCalled = false
  const decision = await router.preStep(imPayload('3'), async () => {
    nextCalled = true
    return { kind: 'continue' }
  })
  assert.equal(decision.kind, 'continue')
  assert.equal(nextCalled, true)
  return 'next() 交回熔断，保持原 1/2/3 语义'
})

await testAsync('P1-8 子代理会话不参与遥控', async () => {
  const tickets = makeTickets()
  tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'stage', question: 'q', options: [{ label: '同意', action: 'approve' }], docIds: [], timeoutSeconds: 60,
  })
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async () => ({ ok: true }) },
    getConfig,
    resolveAgent: () => undefined,
    settler: makeSettler(tickets),
  })
  const payload = imPayload('1', 'child')
  payload.agent.session.header.origin = 'subagent'
  const decision = await router.preStep(payload, async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'continue')
  return 'origin=subagent 直接放行'
})

await testAsync('P1-9 IM 回 0 拉文档摘要', async () => {
  const tickets = makeTickets()
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'stage', question: 'q',
    options: [{ label: '同意', action: 'approve' }], docIds: ['03'], timeoutSeconds: 60,
  })
  const acks = []
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async (payload) => { acks.push(payload); return { ok: true } } },
    getConfig,
    resolveAgent: () => undefined,
    settler: makeSettler(tickets),
  })
  const decision = await router.preStep(imPayload(`#${ticket.id} 0`), async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'reject')
  assert.ok(acks[0].markdown.includes('03-tech-and-env'))
  assert.equal(tickets.find(ticket.id, cwd).state, 'open')
  return '0/doc 只回摘要，票据保持 open'
})

/* ------------------------------------------------------------------ *
 * P1：门禁工具
 * ------------------------------------------------------------------ */

function makeTools({ tickets, questions, notifier, uiSkills, ctxTools = [], presets = [], agentPresets = [] } = {}) {
  const fakeCtx = {
    get: name => {
      if (name === 'permissionPresets') return { names: presets }
      if (name === 'agentPresets') return { list: async () => agentPresets.map(id => ({ id })) }
      return undefined
    },
    tools: { get: name => (ctxTools.includes(name) ? { name } : undefined) },
  }
  const desk = makeDeskAgent()
  const emails = []
  const ims = []
  const switches = []
  const resolveAgent = id => (String(id) === String(desk.agent.session.id) ? desk.agent : undefined)
  const switchMode = async (agent, modeId) => {
    switches.push(modeId)
    return { label: modeId, notes: [] }
  }
  const settler = createGateSettler({
    getConfig,
    switchMode,
    bridge: { schedule: () => true },
    notifier: notifier ?? { schedule: () => ({ cancel() {} }) },
    tickets,
    resolveAgent,
    logger: { warn() {}, info() {} },
  })
  const toolList = createFlowTools({
    ctx: fakeCtx,
    getConfig,
    switchMode,
    bridge: { schedule: () => true },
    logger: { warn() {}, info() {} },
    getUserQuestions: () => questions,
    notifier: notifier ?? { sendNow: async () => ({ ok: true }) },
    im: { send: async (payload) => { ims.push(payload); return { ok: true } } },
    email: { send: async (payload) => { emails.push(payload); return { ok: true } } },
    tickets,
    settler,
    uiSkills,
  })
  const byName = name => toolList.find(tool => tool.name === name)
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async (payload) => { ims.push(payload); return { ok: true } } },
    getConfig,
    resolveAgent,
    settler,
  })
  const exec = { agent: desk.agent, callId: 'call-1', signal: new AbortController().signal }
  return { desk, emails, ims, switches, byName, exec, settler, tickets, router, resolveAgent }
}

await testAsync('P1-10 文档必达：M 级缺 05 时门禁直接 blocked，不切模式', async () => {
  const tickets = makeTickets()
  const questions = { ask: async () => ({ answers: [{ id: 'flow-gate', selected: ['同意，切换到 Build'] }] }) }
  const { byName, exec, switches } = makeTools({ tickets, questions })
  const result = await byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'build', summary: 's', level: 'M', docIds: ['05'] },
    exec,
  )
  assert.equal(result.outcome, 'blocked')
  assert.equal(switches.length, 0, '缺文档时绝不能切模式')
  assert.ok(result.message.includes('05'))
  return 'blocked ✓｜未切模式｜点名 05'
})

await testAsync('P1-11 非阻塞建票：立刻返回选项块 + 强制停手指令（不碰 ask / askTimed）', async () => {
  const tickets = makeTickets()
  let askedCount = 0
  const questions = { ask: async () => { askedCount += 1; return { answers: [] } } }
  const { byName, exec, switches, emails, ims } = makeTools({ tickets, questions })
  const started = Date.now()
  const result = await byName('flow_stage_gate').execute(
    { fromStage: 'review', nextMode: 'build', summary: '实现完成', level: 'S', docIds: ['03'], timeoutSeconds: 60 },
    exec,
  )
  const elapsed = Date.now() - started
  assert.equal(result.outcome, 'awaiting-user', result.message)
  assert.equal(askedCount, 0, '非阻塞：绝不许再走 ask / askTimed')
  assert.equal(switches.length, 0, '建票不等于批准')
  assert.ok(elapsed < 1000, `必须立刻返回，实际 ${elapsed}ms`)
  assert.ok(result.message.includes('立刻结束本轮对话'), '缺强制停手指令')
  assert.ok(result.message.includes('严禁在用户回复前继续'), '缺禁止推进条款')
  assert.ok(/#t[0-9a-f]{2,12}/.test(result.message), '必须带票据号')
  assert.equal(emails.length, 1, '文档仍要投递')
  assert.equal(ims.length, 1)
  const open = tickets.openFor('desk')
  assert.equal(open.length, 1)
  assert.equal(open[0].hold, true, '建票即 hold')
  return `awaiting-user ✓｜0 次 ask｜${elapsed}ms｜hold ✓｜附件 ${emails[0].attachments[0].filename}`
})

await testAsync('P1-12 超时：单次催办 + 严格 hold，绝不切模式', async () => {
  const tickets = makeTickets()
  const notifies = []
  const notifier = {
    schedule: () => ({ cancel() {} }),
    sendNow: async (event, payload) => { notifies.push({ event, payload }); return { ok: true } },
  }
  const { byName, exec, switches } = makeTools({ tickets, questions: { ask: async () => ({}) }, notifier })
  const result = await byName('flow_stage_gate').execute(
    { fromStage: 'build', nextMode: 'review', summary: '实现完成', level: 'S', timeoutSeconds: 1 },
    exec,
  )
  assert.equal(result.outcome, 'awaiting-user')
  assert.ok(result.message.includes('催办定时器已挂上'))
  const tid = result.message.match(/#(t[0-9a-f]{2,12})/)[1]
  assert.equal(tickets.hasEscalation(tid), true, '建票时必须挂上催办定时器')

  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.equal(notifies.length, 1, '催办只许一次')
  assert.equal(notifies[0].event, 'gate-timeout')
  assert.equal(tickets.find(tid).state, 'expired')
  assert.equal(tickets.find(tid).hold, true)
  assert.deepEqual(switches, [], '超时绝不能切模式')

  const write = await byName('flow_docs_write').execute({ id: '06', content: validDoc('06', 6) }, exec)
  assert.equal(write.outcome, 'blocked', 'hold 期间不许写文档')
  return `催办 ${notifies.length} 次 ✓｜expired+hold ✓｜未切模式 ✓`
})

await testAsync('P1-13 桌面回 `#票据 1 意见`：直接落权继续，且立刻停表', async () => {
  const tickets = makeTickets()
  const desk = makeDeskAgent()
  const switches = []
  const resolveAgent = id => (String(id) === 'desk' ? desk.agent : undefined)
  const settler = createGateSettler({
    getConfig,
    switchMode: async (agent, modeId) => { switches.push(modeId); return { label: modeId, notes: [] } },
    bridge: { schedule: () => true },
    notifier: { schedule: () => ({ cancel() {} }) },
    tickets,
    resolveAgent,
    logger: { warn() {}, info() {} },
  })
  const toolList = createFlowTools({
    ctx: { get: () => undefined },
    getConfig,
    switchMode: async () => ({ label: 'x' }),
    bridge: { schedule: () => true },
    logger: { warn() {}, info() {} },
    getUserQuestions: () => ({ ask: async () => ({ answers: [] }) }),
    notifier: { sendNow: async () => ({ ok: true }), schedule: () => ({ cancel() {} }) },
    im: { send: async () => ({ ok: true }) },
    email: { send: async () => ({ ok: true }) },
    tickets,
    settler,
  })
  const gate = toolList.find(tool => tool.name === 'flow_stage_gate')
  const exec = { agent: desk.agent, callId: 'call-1', signal: new AbortController().signal }
  const opened = await gate.execute(
    { fromStage: 'plan', nextMode: 'build', summary: 's', level: 'S', timeoutSeconds: 30 },
    exec,
  )
  const tid = opened.message.match(/#(t[0-9a-f]{2,12})/)[1]
  assert.equal(tickets.hasEscalation(tid), true)

  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async () => ({ ok: true }) },
    getConfig,
    resolveAgent,
    settler,
  })
  let nextCalled = false
  const decision = await router.preStep(deskPayload(`#${tid} 1 同意 发我邮箱`), async () => {
    nextCalled = true
    return { kind: 'continue' }
  })
  assert.equal(decision.kind, 'reject', '桌面命中票据必须接手，不能把原文丢给模型')
  assert.equal(nextCalled, false)
  assert.deepEqual(switches, ['build'], '必须真的切模式')
  assert.equal(tickets.find(tid).state, 'answered')
  assert.equal(tickets.hasEscalation(tid), false, '用户已回话，必须停表')
  const injected = (desk.steers[0] ?? desk.followups[0]).content[0].text
  assert.ok(injected.includes('发我邮箱'), '附带指令要原样注入')
  return 'answered ✓｜切 build ✓｜停表 ✓｜附带指令原样注入 ✓'
})

await testAsync('P1-14 只读写授权：建票即挂起 → 桌面回 1 落权 → 写入成功 → 再写又要授权', async () => {
  const tickets = makeTickets()
  const { byName, exec, emails, router } = makeTools({ tickets, questions: { ask: async () => ({}) } })
  const denied = await byName('flow_docs_write').execute({ id: '06', content: validDoc('06', 6) }, exec)
  assert.equal(denied.outcome, 'needs-permission')

  const draft = validDoc('06', 6)
  const granted = await byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'off', summary: '申请写 06', kind: 'permission', docId: '06', draftContent: draft },
    exec,
  )
  assert.equal(granted.outcome, 'awaiting-user', `实际返回：${granted.outcome}｜${granted.message}`)
  assert.ok(granted.message.includes('立刻结束本轮对话'))
  assert.equal(emails.length, 1, '带草稿的授权门禁必须发预览邮件')
  assert.equal(emails[0].attachments[0].filename, '06-blackbox-qa.draft.md')
  assert.equal(emails[0].attachments[0].content.toString('utf8'), draft)
  assert.equal(tickets.canWrite('desk', { docId: '06' }).ok, false, '没回 1 之前不许写')

  const tid = granted.message.match(/#(t[0-9a-f]{2,12})/)[1]
  const decision = await router.preStep(deskPayload(`#${tid} 1`), async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'reject')

  const written = await byName('flow_docs_write').execute({ id: '06', content: validDoc('06', 6) }, exec)
  assert.equal(written.outcome, 'ok', written.message)
  assert.ok(existsSync(join(cwd, '.flow/docs/06-blackbox-qa.md')))
  const after = await byName('flow_docs_write').execute({ id: '06', content: validDoc('06', 6) }, exec)
  assert.equal(after.outcome, 'needs-permission', 'once 用后必须再次申请')
  return 'awaiting-user → 桌面 #id 1 → 写入成功 → 再写又要授权'
})

await testAsync('P1-15 按需投递：flow_send_doc 立刻发邮件附件 + IM 摘要', async () => {
  const tickets = makeTickets()
  const { byName, exec, emails, ims } = makeTools({ tickets, questions: { ask: async () => ({}) } })
  const result = await byName('flow_send_doc').execute({ docIds: ['03'], to: 'both', note: '你要的文档' }, exec)
  assert.equal(result.outcome, 'ok')
  assert.equal(emails.length, 1)
  assert.equal(emails[0].attachments[0].filename, '03-tech-and-env.md')
  assert.ok(ims[0].markdown.includes('完整文档已发至邮箱附件'))
  return `邮件附件 ${emails[0].attachments[0].filename}｜IM 标注见邮箱`
})

await testAsync('P1-16 附件白名单：越界附件路径不会被读进邮件', async () => {
  const tickets = makeTickets()
  const { byName, exec, emails } = makeTools({ tickets, questions: { ask: async () => ({}) } })
  writeFileSync(join(root, 'secret.txt'), 'top-secret', 'utf8')
  const result = await byName('flow_send_doc').execute(
    { docIds: ['03'], to: 'email', attachments: ['../secret.txt'] },
    exec,
  )
  assert.equal(result.outcome, 'ok')
  assert.equal(emails[0].attachments.length, 1)
  return '越界附件被丢弃，仅 03 进邮件'
})

/* ------------------------------------------------------------------ *
 * P1：草稿预览闭环（R7）
 * ------------------------------------------------------------------ */

await testAsync('P1-17 无草稿的授权申请被拦下：不弹窗、不发信、不授权', async () => {
  const tickets = makeTickets()
  let asked = false
  const questions = { ask: async () => { asked = true; return { answers: [] } } }
  const { byName, exec, emails, ims } = makeTools({ tickets, questions })
  const result = await byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'off', summary: '申请写 03', kind: 'permission', docId: '03' },
    exec,
  )
  assert.equal(result.outcome, 'blocked')
  assert.ok(result.message.includes('draftContent'))
  assert.equal(asked, false)
  assert.equal(emails.length, 0)
  assert.equal(ims.length, 0)
  assert.equal(tickets.canWrite('desk', { docId: '03' }).ok, false)
  return 'blocked 且零副作用'
})

await testAsync('P1-18 带草稿的授权申请：邮件发 .draft.md，IM 指明草稿未落盘', async () => {
  const tickets = makeTickets()
  const draft = `${validDoc('03', 7)}\n\n## 附：这次为什么这么改\n自检专用草稿正文。`
  const questions = { ask: async () => ({ answers: [] }) }
  const { byName, exec, emails, ims, router } = makeTools({ tickets, questions })
  const result = await byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'off', summary: '申请写 03', kind: 'permission', docId: '03', draftContent: draft },
    exec,
  )
  assert.equal(result.outcome, 'awaiting-user')
  const attachment = emails[0].attachments.find(item => item.filename.endsWith('.draft.md'))
  assert.ok(attachment !== undefined)
  assert.equal(attachment.content.toString('utf8'), draft)
  assert.ok(ims[0].markdown.includes('草稿未落盘'))
  assert.ok(ims[0].markdown.includes('回复 0'))

  // 用户回 3 = 拒绝写入：授权口径必须真的落到 deny，写盘继续被拦。
  const tid = result.message.match(/#(t[0-9a-f]{2,12})/)[1]
  await router.preStep(deskPayload(`#${tid} 3`), async () => ({ kind: 'continue' }))
  assert.equal(tickets.grantOf('desk').scope, 'deny')
  assert.equal(tickets.canWrite('desk', { docId: '03' }).ok, false)
  return `附件 ${attachment.filename}（${attachment.content.length} B）｜IM 含草稿指引｜回 3 → deny`
})

await testAsync('P1-19 IM 回 0：文档未落盘时回退读票据草稿', async () => {
  const tickets = makeTickets()
  const draft = `未落盘草稿标题\n\n这里是用户在手机上应该看到的方案正文。${'补充说明。'.repeat(20)}`
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'permission', level: 'M',
    fromStage: 'plan', nextMode: 'off', question: 'q', options: [{ label: '仅本次', action: 'once' }],
    docIds: [], attachments: [], timeoutSeconds: 0, draftId: '03', draftContent: draft,
  })
  const acks = []
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async (payload) => { acks.push(payload); return { ok: true } } },
    getConfig,
    resolveAgent: () => undefined,
    settler: makeSettler(tickets),
  })
  const decision = await router.preStep(imPayload(`#${ticket.id} 0`), async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'reject')
  const text = acks[0].markdown
  assert.ok(text.includes('未落盘草稿'))
  assert.ok(text.includes('这里是用户在手机上应该看到的方案正文'))
  assert.ok(text.includes('03-tech-and-env.draft.md'))
  return `回退草稿成功（${text.length} 字符）`
})

test('P1-20 草稿不落盘：不进 .flow/docs，也不进状态文件', () => {
  const cwd2 = join(root, 'proj2')
  mkdirSync(cwd2, { recursive: true })
  const persistCfg = { ...cfg, gate: { ...cfg.gate, persist: true } }
  const tickets = createGateTickets({ getConfig: () => persistCfg, logger: { warn() {}, info() {} } })
  const marker = 'DRAFT-MARKER-不落盘-9f2c'
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd: cwd2, kind: 'permission', level: 'M',
    fromStage: 'plan', nextMode: 'off', question: 'q', options: [{ label: '仅本次', action: 'once' }],
    docIds: [], attachments: [], timeoutSeconds: 0, draftId: '07', draftContent: `${marker}\n${validDoc('07', 7)}`,
  })
  assert.equal(ticket.draftContent.includes(marker), true)
  const stateFile = join(cwd2, '.flow/state/gates.json')
  assert.ok(existsSync(stateFile))
  assert.ok(!readFileSync(stateFile, 'utf8').includes(marker), '状态文件里不许出现草稿正文')
  assert.equal(existsSync(join(cwd2, '.flow/docs/07-whitebox-qa.md')), false)
  return '草稿只在内存；状态文件与 .flow/docs 均无草稿正文'
})

await testAsync('P1-21 草稿超限：直接拒绝创建票据并提示精简', async () => {
  const tickets = makeTickets()
  const { byName, exec } = makeTools({ tickets, questions: { ask: async () => ({ answers: [] }) } })
  const result = await byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'off', summary: 's', kind: 'permission', docId: '03', draftContent: 'x'.repeat(130 * 1024) },
    exec,
  )
  assert.equal(result.outcome, 'blocked')
  assert.ok(result.message.includes('120000'), `实际：${result.message}`)
  return '超 120000 字符直接拦下'
})

test('P1-22 邮件附件构造：内存草稿（字符串/ Buffer）都能成附件', () => {
  const out = collectAttachments({
    event: 'gate',
    config: cfg,
    drafts: [
      { filename: '03-tech-and-env.draft.md', content: '# 草稿正文' },
      { filename: 'extra.md', content: Buffer.from('buffer 正文', 'utf8') },
      { filename: 'skip.md', content: '' },
    ],
  })
  assert.equal(out.length, 2)
  assert.equal(out[0].filename, '03-tech-and-env.draft.md')
  assert.equal(out[0].content.toString('utf8'), '# 草稿正文')
  assert.ok(Buffer.isBuffer(out[1].content))
  assert.equal(out[0].contentType, 'text/markdown; charset=UTF-8')
  return '2 条附件，空草稿跳过'
})

await testAsync('P1-23 草稿优先：同号文档已落盘也不抢主角', async () => {
  assert.ok(existsSync(join(cwd, '.flow/docs/03-tech-and-env.md')))
  const tickets = makeTickets()
  const marker = '新草稿标记：这一版才要授权'
  const ticket = tickets.create({
    sessionId: 'desk', project: 'demo', cwd, kind: 'permission', level: 'M',
    fromStage: 'plan', nextMode: 'off', question: 'q', options: [{ label: '仅本次', action: 'once' }],
    docIds: ['03'], attachments: [], timeoutSeconds: 0, draftId: '03', draftContent: `${marker}\n${validDoc('03', 7)}`,
  })
  const acks = []
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async (payload) => { acks.push(payload); return { ok: true } } },
    getConfig,
    resolveAgent: () => undefined,
    settler: makeSettler(tickets),
  })
  const decision = await router.preStep(imPayload(`#${ticket.id} doc`), async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'reject')
  const text = acks[0].markdown
  assert.ok(text.includes(marker))
  assert.ok(text.includes('待授权，优先展示'))
  assert.ok(!text.includes('（已落盘）'))
  return '草稿优先于磁盘旧文'
})

/* ------------------------------------------------------------------ *
 * P1：结算器 / 卡片关闭 / 跨重启授权（本轮新增）
 * ------------------------------------------------------------------ */

await testAsync('P1-24 桌面发普通文字：自动停表 + 保留 hold；重发门禁顶替旧票', async () => {
  const tickets = makeTickets()
  const desk = makeDeskAgent()
  const switches = []
  const resolveAgent = id => (String(id) === 'desk' ? desk.agent : undefined)
  const settler = createGateSettler({
    getConfig,
    switchMode: async (agent, modeId) => { switches.push(modeId); return { label: modeId, notes: [] } },
    bridge: { schedule: () => true },
    notifier: { schedule: () => ({ cancel() {} }) },
    tickets,
    resolveAgent,
    logger: { warn() {}, info() {} },
  })
  const toolList = createFlowTools({
    ctx: { get: () => undefined },
    getConfig,
    switchMode: async () => ({ label: 'x' }),
    bridge: { schedule: () => true },
    logger: { warn() {}, info() {} },
    getUserQuestions: () => ({ ask: async () => ({ answers: [] }) }),
    notifier: { sendNow: async () => ({ ok: true }), schedule: () => ({ cancel() {} }) },
    im: { send: async () => ({ ok: true }) },
    email: { send: async () => ({ ok: true }) },
    tickets,
    settler,
  })
  const gate = toolList.find(tool => tool.name === 'flow_stage_gate')
  const exec = { agent: desk.agent, callId: 'call-1', signal: new AbortController().signal }

  const first = await gate.execute({ fromStage: 'plan', nextMode: 'build', summary: 'v1', level: 'S', timeoutSeconds: 30 }, exec)
  const id1 = first.message.match(/#(t[0-9a-f]{2,12})/)[1]
  assert.equal(tickets.hasEscalation(id1), true)

  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async () => ({ ok: true }) },
    getConfig,
    resolveAgent,
    settler,
  })
  const passthrough = await router.preStep(deskPayload('这个方案再想想，先别切'), async () => ({ kind: 'continue' }))
  assert.equal(passthrough.kind, 'continue', '普通讨论必须放行给模型')
  assert.equal(tickets.hasEscalation(id1), false, '桌面一开口就该停表')
  assert.equal(tickets.find(id1).hold, true, 'hold 不许自动解除')
  assert.deepEqual(switches, [], '停下来讨论 ≠ 批准')

  const second = await gate.execute({ fromStage: 'plan', nextMode: 'build', summary: 'v2 改完草稿重发', level: 'S', timeoutSeconds: 30 }, exec)
  const id2 = second.message.match(/#(t[0-9a-f]{2,12})/)[1]
  assert.notEqual(id1, id2, '重发必须是新票据')
  assert.equal(tickets.find(id1).state, 'superseded', '旧票必须被顶替')
  assert.equal(tickets.find(id2).state, 'open')
  assert.ok(second.message.includes('已顶替旧票'))
  assert.equal(tickets.hasEscalation(id1), false, '旧票的催办要一并撤掉')
  assert.equal(tickets.hasEscalation(id2), true)
  return `放行 ✓｜停表 ✓｜hold 保留 ✓｜#${id1} superseded → #${id2}`
})

await testAsync('P1-25 未回话前 hold 拦住写盘；IM 补授权后真的能写', async () => {
  const tickets = makeTickets()
  const { byName, exec, router } = makeTools({ tickets, questions: { ask: async () => ({}) } })
  const write = byName('flow_docs_write')

  const draft = validDoc('05', 7)
  const opened = await byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'off', summary: '申请写 05', kind: 'permission', docId: '05', draftContent: draft },
    exec,
  )
  assert.equal(opened.outcome, 'awaiting-user')
  assert.ok(opened.message.includes('立刻结束本轮对话'))

  const pending = tickets.openFor('desk')
  assert.equal(pending.length, 1, '建票后必须待决，等着被 IM 救回')

  const before = await write.execute({ id: '05', content: draft }, exec)
  assert.equal(before.outcome, 'blocked', 'hold 期间应先被拦（尚未授权）')

  await router.preStep(imPayload(`#${pending[0].id} 1 同意落盘`), async () => ({ kind: 'continue' }))

  const after = await write.execute({ id: '05', content: draft }, exec)
  assert.equal(after.outcome, 'ok', `IM 授权后必须真能写：${after.message}`)
  assert.ok(existsSync(join(cwd, '.flow/docs/05-dev-spec.md')))
  return '待决 + hold 拦写 → IM 补授权 → 写入成功'
})

await testAsync('P1-26 超时后 IM 批准 stage：模式真实切换', async () => {
  const tickets = makeTickets()
  const desk = makeDeskAgent()
  const switches = []
  const questions = { ask: async () => ({ answers: [] }) }
  const resolveAgent = id => (String(id) === 'desk' ? desk.agent : undefined)
  const settler = createGateSettler({
    getConfig,
    switchMode: async (agent, modeId) => { switches.push(modeId); return { label: modeId, notes: [] } },
    bridge: { schedule: () => true },
    notifier: { schedule: () => ({ cancel() {} }) },
    tickets,
    resolveAgent,
    logger: { warn() {}, info() {} },
  })
  const toolList = createFlowTools({
    ctx: { get: () => undefined },
    getConfig,
    switchMode: async () => ({ label: 'x' }),
    bridge: { schedule: () => true },
    logger: { warn() {}, info() {} },
    getUserQuestions: () => questions,
    notifier: { sendNow: async () => ({ ok: true }), schedule: () => ({ cancel() {} }) },
    im: { send: async () => ({ ok: true }) },
    email: { send: async () => ({ ok: true }) },
    tickets,
    settler,
  })
  const gate = toolList.find(tool => tool.name === 'flow_stage_gate')
  const exec = { agent: desk.agent, callId: 'call-1', signal: new AbortController().signal }
  const timedOut = await gate.execute(
    { fromStage: 'plan', nextMode: 'build', summary: 's', level: 'S', timeoutSeconds: 1 },
    exec,
  )
  assert.equal(timedOut.outcome, 'awaiting-user')
  assert.deepEqual(switches, [], '建票那一刻不许切')

  // 真的等到超时：票据转 expired + hold，催办只发一次，模式仍不许动。
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.equal(tickets.openFor('desk').length, 1, '超时后票据仍待决，可被 IM 救回')
  assert.deepEqual(switches, [], '超时那一刻不许切')

  const pending = tickets.openFor('desk')
  const router = createGateRouter({
    tickets,
    breaker: { listTrips: () => [] },
    im: { send: async () => ({ ok: true }) },
    getConfig,
    resolveAgent,
    settler,
  })
  const decision = await router.preStep(imPayload(`#${pending[0].id} 1`), async () => ({ kind: 'continue' }))
  assert.equal(decision.kind, 'reject')
  assert.deepEqual(switches, ['build'], '迟到批准必须真的切模式')
  assert.equal(tickets.holdOf('desk'), undefined, '决定后必须解除 hold')
  assert.equal(desk.steers.length + desk.followups.length, 1, '卡片已退出，必须 steer 唤醒桌面')
  return 'pending-human → IM 批准 → 切 build + 解除 hold + steer 1 次'
})

test('P1-27 跨重启授权不丢：票据里恢复 once，消费后不再重放', () => {
  const cwd3 = join(root, 'proj3')
  mkdirSync(cwd3, { recursive: true })
  const persistCfg = { ...cfg, gate: { ...cfg.gate, persist: true } }
  const factory = () => createGateTickets({ getConfig: () => persistCfg, logger: { warn() {}, info() {} } })

  const first = factory()
  const ticket = first.create({
    sessionId: 'desk', project: 'demo', cwd: cwd3, kind: 'permission', level: 'M',
    fromStage: 'plan', nextMode: 'off', question: 'q', options: [{ label: '仅本次', action: 'once' }],
    docIds: [], attachments: [], timeoutSeconds: 0, draftId: '05', draftContent: validDoc('05', 7),
  })
  const settlerA = createGateSettler({
    getConfig: () => persistCfg,
    switchMode: async () => ({ label: 'x' }),
    tickets: first,
    resolveAgent: () => undefined,
    logger: { warn() {}, info() {} },
  })
  return settlerA.settle(ticket.id, { action: 'once', by: 'im' }).then(() => {
    // 模拟重启：全新实例，内存 grants 为空，只能从票据恢复。
    const second = factory()
    const restored = second.canWrite('desk', { docId: '05', cwd: cwd3 })
    assert.equal(restored.ok, true, '重启后必须能从票据恢复授权')
    assert.equal(restored.restored, true)
    assert.equal(second.consumeOnce('desk'), true)

    const third = factory()
    const afterConsume = third.canWrite('desk', { docId: '05', cwd: cwd3 })
    assert.equal(afterConsume.ok, false, '消费过的 once 不许重放')
    return '重启恢复 ✓｜消费后拒绝重放 ✓'
  })
})

/* ------------------------------------------------------------------ *
 * P2 / P3：提示词硬规格与 UI Skills 探测
 * ------------------------------------------------------------------ */

const PROMPT_DIR = new URL('../prompts/', import.meta.url)

/** 读提示词原文。 */
function promptText(rel) {
  return readFileSync(new URL(rel, PROMPT_DIR), 'utf8')
}

/** 断言文本里同时包含所有片段。 */
function hasAll(text, needles, label) {
  const missing = needles.filter(needle => !text.includes(needle))
  assert.deepEqual(missing, [], `${label} 缺少：${missing.join(' / ')}`)
}

test('P2-1 base.md 与 config.js 的 BASE_RULES 逐字一致', () => {
  const file = promptText('base.md').replace(/\s+$/, '')
  const inline = BASE_RULES.replace(/\s+$/, '')
  assert.equal(file, inline, 'base.md 与 BASE_RULES 已漂移（会被一键更新覆盖掉手的改）')
  return `${file.length} 字符完全一致`
})

test('P2-2 base.md 第 7/8/9 条与下载阈值同源', () => {
  const text = promptText('base.md')
  hasAll(text, [
    '7. **报错分流', '外部非代码阻断', "flow_stage_gate { kind: 'blocker' }", '连续失败 2 次',
    '8. **下载与安装红绿灯', '20MB', '300MB', '60s', '🟢', '🟡', '🔴',
    '9. **非阻塞门禁铁律', '立刻结束本轮对话', '1/2/3',
    '10. **反脑补与反偷懒简化', '最省事的实现', '手风琴',
    '11. **不可逆与破坏性操作红线', 'git reset --hard', 'git push --force', '回滚',
    '12. **反测试造假与编码卫生', 'skip', 'UTF-8 无 BOM',
    '05-dev-spec.md`（SSOT', '摘要同步在 `.flow/spec.md`',
  ], 'base.md')
  const download = plainConfigOf(Config({})).download
  assert.equal(download.greenMaxMB, 20)
  assert.equal(download.yellowMaxMB, 300)
  assert.equal(download.slowSeconds, 60)
  return `9 条契约齐全，阈值 ${download.greenMaxMB}/${download.yellowMaxMB}/${download.slowSeconds}s 与配置一致`
})

test('P2-3 五份模式提示词各自硬条款命中', () => {
  const plan = promptText('modes/plan.md')
  hasAll(plan, ['S 级反偷懒红线', '点哪里', '5 维追问', '❌', '✅', 'draftContent', '80 行', '覆盖 0X §Y', '1` 批准，进入 Build', 'flow_docs_write'], 'plan.md')

  const ultra = promptText('modes/plan-ultra.md')
  hasAll(ultra, ['架构耦合', '状态机', '安全', 'plan-auditor', 'flow_dispatch_declare', '🔴', '🟡', '🟢', '回写'], 'plan-ultra.md')

  const build = promptText('modes/build.md')
  hasAll(build, ['05-dev-spec.md', '唯一法典', '白名单', '共享入口', '验证回执', '最多 3 轮'], 'build.md')

  const review = promptText('modes/review.md')
  hasAll(review, ['黑盒体验', '白盒定因', '不看源码', '文件:行号', '孤儿模块', '4.1', '4.2', '防污染'], 'review.md')

  const flow = promptText('modes/flow.md')
  hasAll(flow, [
    'flow_dispatch_declare', '[调度声明]', '三层正交拼装', 'qa-blackbox', 'qa-whitebox',
    "kind:'acceptance'", '1/2/3',
    // 本轮补强：内联细则 + 留在 Flow 模式
    'S 级三问', '5 维具体追问', 'R7 草稿先行', "nextMode: 'flow'", '留在 Flow 模式',
    'plan-auditor', '四件套', '共享入口串行',
  ], 'flow.md')
  return '5 份模式提示词全部命中硬条款'
})

test('P2-4 五份子代理提示词都有硬隔离尾注与专属职责', () => {
  const files = {
    'ui-architect.md': ['flow_ui_skill', 'Design Token', '8 态', '44px', '.flow/docs/preview/', '反 AI 味禁令'],
    'plan-auditor.md': ['只读', '裁决表', '反例路径', '最小修改'],
    'build-worker.md': ['白名单', '越界联动上报清单', '真实命令输出'],
    'qa-blackbox.md': ['禁读业务源码', '待人工点验清单', 'BUG-01', '证据'],
    'qa-whitebox.md': ['文件:行号', '触发链', '未定位', '回归点'],
  }
  for (const [file, needles] of Object.entries(files)) {
    const text = promptText(`subagents/${file}`)
    hasAll(text, [...needles, '【子代理硬隔离尾注】', '禁止调用任何 `flow_*` 工具', '禁止再派子代理', '禁止直接向用户提问'], file)
  }
  const roster = promptText('subagents/README.md')
  hasAll(roster, ['plan-auditor.md', 'build-worker.md', 'qa-blackbox.md', 'qa-whitebox.md', 'ui-architect.md'], 'subagents/README.md')
  return '5 份子代理 + README 全部合规'
})

test('P2-5 等级/文档/门禁块与 flow-level.js 同源，且进入注入文本', () => {
  const mBlock = buildLevelBlock(cfg, 'unit-m')
  const expected = levelDef('M').docs.join(' ')
  assert.ok(mBlock.includes(`必做文档：${expected}`), `注入块与矩阵不一致：${mBlock}`)
  assert.ok(mBlock.includes('切 Build 前必须齐备：01 03 05'))
  assert.ok(mBlock.includes('验收门禁必须齐备：06 07'))

  rememberLevel('unit-l', 'L')
  const lBlock = buildLevelBlock(cfg, 'unit-l')
  assert.ok(lBlock.includes(levelDef('L').docs.join(' ')), 'L 级文档清单漂移')

  const text = buildModeText(cfg, 'plan', undefined, { sessionId: 'unit-m' })
  assert.ok(text.includes('[Flow 等级与文档]'), '模式注入文本里没有等级块')
  assert.ok(text.includes('必做文档：01 03 05 06 07'), '注入块内容不对')
  return 'M/L 两档与矩阵一致，且确实拼进了 buildModeText'
})

test('P3-1 UI Skill 探测：已装双 Skill → 分流建议 taste/impeccable', async () => {
  const probe = createUiSkillProbe({
    getSkills: () => ({ list: async () => [{ name: 'design-taste-frontend' }, { name: 'impeccable' }] }),
  })
  const result = await probe.probe(cwd)
  assert.equal(result.ok, true)
  assert.deepEqual(result.installed, { taste: true, impeccable: true })
  assert.ok(result.text.includes('taste'))
  assert.ok(result.text.includes('impeccable'))
  assert.ok(result.text.includes('新页') && result.text.includes('老项目'))
  return '双命中 → 新页 taste / 老页 impeccable'
})

test('P3-2 UI Skill 未装：纯对话三选一，且绝不弹门禁', async () => {
  const probe = createUiSkillProbe({ getSkills: () => ({ list: async () => [] }) })
  const tickets = makeTickets()
  let asked = false
  const questions = { ask: async () => { asked = true; return { answers: [] } } }
  const { byName, exec } = makeTools({ tickets, questions, uiSkills: probe })
  const result = await byName('flow_ui_skill').execute({}, exec)
  assert.equal(result.outcome, 'choose')
  assert.equal(asked, false, 'UI Skill 探测是纯对话，不许弹门禁')
  assert.ok(result.message.includes('https://github.com/Leonxlnx/taste-skill'))
  assert.ok(result.message.includes('https://github.com/pbakaus/impeccable'))
  assert.ok(result.message.includes('暂不安装'))
  assert.ok(result.message.includes('1)') && result.message.includes('2)') && result.message.includes('3)'))
  return '三选一齐全，零门禁调用'
})

test('P3-3 别名归一 + 服务缺失时诚实降级', async () => {
  assert.equal(normalizeSkillName('tasteskill'), 'taste')
  assert.equal(normalizeSkillName('Design-Taste-Frontend'), 'taste')
  assert.equal(normalizeSkillName('impeccable'), 'impeccable')
  assert.equal(normalizeSkillName('unknown-skill'), 'unknown-skill')

  const missing = createUiSkillProbe({ getSkills: () => undefined })
  const result = await missing.probe(cwd)
  assert.equal(result.ok, false)
  assert.equal(result.source, 'unavailable')
  assert.ok(result.text.includes('内置'))

  const tickets = makeTickets()
  const { byName, exec } = makeTools({ tickets, questions: { ask: async () => ({}) }, uiSkills: missing })
  const tool = await byName('flow_ui_skill').execute({}, exec)
  assert.equal(tool.outcome, 'unavailable')
  assert.ok(tool.message.includes('内置'))
  return '别名归一 ✓｜服务缺失降级为内置规范 ✓'
})

/* ------------------------------------------------------------------ *
 * P4：派单声明与门禁拦截（提示词引用的工具必须真实存在）
 * ------------------------------------------------------------------ */

await testAsync('P4-1 派单声明：探测三项能力、拒绝共享入口与白名单重叠、无工具降级', async () => {
  const tickets = makeTickets()
  const questions = { ask: async () => ({ answers: [] }) }
  const { byName, exec } = makeTools({
    tickets,
    questions,
    ctxTools: ['dsh_team_spawn'],
    presets: ['workspace-write'],
    agentPresets: ['standard', 'minimal'],
  })
  const tool = byName('flow_dispatch_declare')

  const ok = await tool.execute({
    assignments: [
      { who: 'build-worker', duty: '施工', files: ['src/a.js'] },
      { who: 'qa-blackbox', duty: '黑盒', files: ['test/'] },
    ],
  }, exec)
  assert.equal(ok.outcome, 'ok', ok.message)
  assert.equal(ok.message.split('\n')[0], '[调度声明] 派单工具=dsh_team_spawn｜只读能力=fallback｜模式×特种兵=2组｜白名单=2段')
  assert.ok(ok.message.includes('standard / minimal'), '必须报出探测到的 agentPreset')
  assert.ok(ok.message.includes('无 read-only preset'), '缺只读能力要给降级结论')

  const shared = await tool.execute({
    assignments: [{ who: 'a', files: ['src/a.js'] }, { who: 'b', files: ['index.js'] }],
  }, exec)
  assert.equal(shared.outcome, 'blocked')
  assert.ok(shared.message.includes('共享入口'), `实际：${shared.message}`)

  const overlap = await tool.execute({
    assignments: [{ who: 'a', files: ['src/'] }, { who: 'b', files: ['src/x.js'] }],
  }, exec)
  assert.equal(overlap.outcome, 'blocked')
  assert.ok(overlap.message.includes('白名单重叠'))

  const glob = await tool.execute({
    assignments: [{ who: 'a', files: ['src/**/*.js'] }, { who: 'b', files: ['src/b.js'] }],
  }, exec)
  assert.equal(glob.outcome, 'blocked', 'glob 与具体路径相交也要拒绝')

  const degraded = makeTools({ tickets: makeTickets(), questions, ctxTools: [], presets: ['read-only'] })
  const d = await degraded.byName('flow_dispatch_declare').execute(
    { assignments: [{ who: 'solo', files: ['src/a.js'] }] },
    degraded.exec,
  )
  assert.equal(d.outcome, 'degraded')
  assert.ok(d.message.includes('派单工具=none'))
  assert.ok(d.message.includes('只读能力=preset'))
  assert.ok(d.message.includes('单线程'))
  return '声明行格式 ✓｜共享入口 ✓｜重叠/glob ✓｜降级 ✓'
})

await testAsync('P4-2 双路径拦截：nextMode=build 与 flow+toStage 都必须先声明', async () => {
  const questions = { ask: async () => ({ answers: [] }) }
  // 先把 01 写成有效文档，确保这段测的是"派单声明"而不是"文档必达"。
  writeDoc({ config: cfg, cwd, target: { kind: 'doc', id: '01' }, content: validDoc('01', 8) })

  const buildTools = makeTools({ tickets: makeTickets(), questions, ctxTools: ['dsh_team_spawn'] })
  const buildBlocked = await buildTools.byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'build', summary: '定稿', level: 'M', docIds: ['01', '03', '05'] },
    buildTools.exec,
  )
  assert.equal(buildBlocked.outcome, 'blocked', buildBlocked.message)
  assert.ok(buildBlocked.message.includes('flow_dispatch_declare'))

  const flowTools = makeTools({ tickets: makeTickets(), questions, ctxTools: ['dsh_team_spawn'] })
  const flowBlocked = await flowTools.byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'flow', toStage: 'build', summary: '定稿', level: 'M', docIds: ['05'] },
    flowTools.exec,
  )
  assert.equal(flowBlocked.outcome, 'blocked', flowBlocked.message)
  assert.ok(flowBlocked.message.includes('toStage=build'), '拦截文案要点明是哪条路径')

  const soloTools = makeTools({ tickets: makeTickets(), questions, ctxTools: ['dsh_team_spawn'] })
  const solo = await soloTools.byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'build', summary: '小改', level: 'S' },
    soloTools.exec,
  )
  assert.equal(solo.outcome, 'awaiting-user', 'S 级单线程施工不拦截')

  await flowTools.byName('flow_dispatch_declare').execute(
    { assignments: [{ who: 'build-worker', files: ['src/a.js'] }] },
    flowTools.exec,
  )
  const armed = await flowTools.byName('flow_stage_gate').execute(
    { fromStage: 'plan', nextMode: 'flow', toStage: 'build', summary: '定稿', level: 'M', docIds: ['05'], timeoutSeconds: 0 },
    flowTools.exec,
  )
  assert.equal(armed.outcome, 'awaiting-user', armed.message)
  const tid = armed.message.match(/#(t[0-9a-f]{2,12})/)[1]
  await flowTools.settler.settle(tid, { action: 'approve', by: 'desktop' })
  assert.deepEqual(flowTools.switches, ['flow'], 'nextMode=flow 时应留在 Flow 模式')
  return 'build 路径 blocked ✓｜flow+toStage blocked ✓｜S 级放行 ✓｜声明后结算切 flow ✓'
})

/* ------------------------------------------------------------------ *
 * P5：双阶验收交接与返工轮次
 * ------------------------------------------------------------------ */

const BLACKBOX_FIXTURE = [
  '# 06 黑盒测试报告',
  '',
  '## 3. 待人工点验清单',
  '',
  '| 编号 | 点哪里 | 期望现象 | 为什么机器测不了 | 用户结论 |',
  '|---|---|---|---|---|',
  '| H-01 | 设置页开关 | 立即生效 | 真机手感 |  |',
  '',
  '## 5. 缺陷表（症状）',
  '',
  '| 编号 | 症状 | 复现步骤 | 影响面 | 严重度 |',
  '|---|---|---|---|---|',
  '| BUG-01 | 点保存无反应 | 连续点两次 | 主流程 | 🔴 Blocker |',
  '| BUG-02 | 空列表无引导 | 清空数据 | 体验 | 🟢 Minor |',
  '',
  '## 6. 结论',
  '',
  '打回：有 Blocker',
].join('\n')

const WHITEBOX_FIXTURE = [
  '# 07 白盒测试报告',
  '',
  '## 2. 根因定位',
  '',
  '| BUG | 文件:行号 | 代码摘录 | 触发链 | 置信度 |',
  '|---|---|---|---|---|',
  '| BUG-01 | src/save.js:42 | `if (saving) return` | 点击 → handler → 早退 | 高 |',
  '',
  '## 3. 安全审计',
  '',
  '路径穿越：无',
  '',
  '## 4. 并发与竞态',
  '',
  '无',
  '',
  '## 5. 孤儿模块与联动遗漏',
  '',
  '无',
  '',
  '## 7. 结论与回归清单',
  '',
  '可修复',
].join('\n')

test('P5-1 解析 06：BUG 症状表与人工点验清单都能读出来', () => {
  const parsed = parseBlackbox(BLACKBOX_FIXTURE)
  assert.equal(parsed.bugs.length, 2)
  assert.equal(parsed.bugs[0].id, 'BUG-01')
  assert.ok(parsed.bugs[0].severity.includes('🔴'))
  assert.equal(parsed.manual.length, 1)
  assert.equal(parsed.manual[0].id, 'H-01')
  assert.ok(parsed.conclusion.includes('打回'))

  const brief = buildWhiteboxBrief({ project: 'demo', bugs: parsed.bugs, manual: parsed.manual })
  assert.ok(brief.includes('BUG-01') && brief.includes('BUG-02'))
  assert.ok(brief.includes('文件:行号'), '简报必须要求交行号证据')
  assert.ok(brief.includes('未定位'), '简报必须要求未定位时给取证手段')
  assert.ok(brief.includes('H-01'), '人工点验项要带进简报')
  return `2 BUG + 1 人工点验 → 简报 ${brief.length} 字符`
})

test('P5-2 合并修复包：未定位与 Blocker 都能点名', () => {
  const blackbox = parseBlackbox(BLACKBOX_FIXTURE)
  const whitebox = parseWhitebox(WHITEBOX_FIXTURE)
  assert.equal(whitebox.roots.length, 1)
  assert.equal(whitebox.roots[0].bug, 'BUG-01')
  assert.ok(whitebox.sections.includes('安全审计'))

  const pack = buildFixPackage({ project: 'demo', bugs: blackbox.bugs, roots: whitebox.roots })
  assert.deepEqual(pack.missing, ['BUG-02'], 'BUG-02 没有根因 → 必须列为未定位')
  assert.deepEqual(pack.blocked, ['BUG-01'])
  assert.ok(pack.markdown.includes('未定位'))
  assert.ok(pack.markdown.includes('src/save.js:42'))
  return '未定位 BUG-02 ✓｜Blocker BUG-01 ✓'
})

test('P5-3 返工轮次：1–3 轮放行，第 4 轮硬拦', () => {
  const tracker = createReworkTracker()
  const round1 = tracker.next('s')
  const round2 = tracker.next('s')
  const round3 = tracker.next('s')
  assert.deepEqual([round1.allowed, round2.allowed, round3.allowed], [true, true, true])
  const round4 = tracker.next('s')
  assert.equal(round4.blocked, true)
  assert.equal(round4.allowed, false)
  const round5 = tracker.next('s')
  assert.equal(round5.blocked, true, '第 5 轮仍然拦，不许绕过')
  tracker.reset('s')
  assert.equal(tracker.next('s').allowed, true, 'reset 后重新计数')
  return '3 轮放行 → 第 4/5 轮 blocked → reset 恢复'
})

test('P5-4 qa 通知：正文置顶阻塞项与人工清单，附件带 06/07', () => {
  const payload = buildQaNotification({ project: 'demo', blackboxText: BLACKBOX_FIXTURE, whiteboxText: WHITEBOX_FIXTURE })
  assert.equal(payload.attachments.length, 2)
  assert.deepEqual(payload.attachments.map(item => item.filename), ['06-blackbox-qa.md', '07-whitebox-qa.md'])
  const head = payload.markdown.slice(0, 400)
  assert.ok(head.includes('🔴'), '正文开头必须先给阻塞项')
  assert.ok(head.includes('BUG-01'), '阻塞项要点名')
  assert.ok(payload.markdown.includes('H-01'), '人工点验清单要在正文里')
  assert.ok(payload.markdown.indexOf('🔴') < payload.markdown.indexOf('待人工点验清单'), '阻塞项必须排在人工清单之前')
  return `附件 ${payload.attachments.map(item => item.filename).join(' + ')}｜正文 ${payload.markdown.length} 字符`
})

await testAsync('P5-5 flow_qa_handoff 工具：brief/package/round/notify 全链路', async () => {
  const tickets = makeTickets()
  const sent = []
  const notifier = {
    schedule: () => ({ cancel() {} }),
    sendNow: async (event, payload) => { sent.push({ event, payload }); return { ok: true, email: { ok: true } } },
  }
  const { byName, exec } = makeTools({ tickets, questions: { ask: async () => ({}) }, notifier })
  writeDoc({ config: cfg, cwd, target: { kind: 'doc', id: '06' }, content: BLACKBOX_FIXTURE })
  writeDoc({ config: cfg, cwd, target: { kind: 'doc', id: '07' }, content: WHITEBOX_FIXTURE })

  const brief = await byName('flow_qa_handoff').execute({ action: 'brief' }, exec)
  assert.equal(brief.outcome, 'ok', brief.message)
  assert.ok(brief.message.includes('BUG-01'))

  const pack = await byName('flow_qa_handoff').execute({ action: 'package' }, exec)
  assert.equal(pack.outcome, 'partial', '有未定位项时返回 partial')
  assert.ok(pack.message.includes('BUG-02'))

  const r1 = await byName('flow_qa_handoff').execute({ action: 'round' }, exec)
  const r2 = await byName('flow_qa_handoff').execute({ action: 'round' }, exec)
  const r3 = await byName('flow_qa_handoff').execute({ action: 'round' }, exec)
  const r4 = await byName('flow_qa_handoff').execute({ action: 'round' }, exec)
  assert.deepEqual([r1.outcome, r2.outcome, r3.outcome], ['ok', 'ok', 'ok'])
  assert.equal(r4.outcome, 'blocked')
  assert.ok(r4.message.includes('硬拦'))

  const notify = await byName('flow_qa_handoff').execute({ action: 'notify' }, exec)
  assert.equal(notify.outcome, 'ok', notify.message)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event, 'qa')
  assert.equal(sent[0].payload.attachments.length, 2)
  assert.equal(sent[0].payload.strategy, 'email-first')
  return 'brief ✓｜package partial ✓｜3 放 1 拦 ✓｜qa 通知双附件 ✓'
})

/* ------------------------------------------------------------------ *
 * P6：发版就绪（manifest × 白名单交叉断言 / 版本 / 双路径收紧）
 * ------------------------------------------------------------------ */

test('P6-1 manifest.json：每条路径都被 ALLOWED 放行，sha256 与磁盘一致', () => {
  const manifest = JSON.parse(readFileSync(new URL('../prompts/manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.5.0')
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 24, `条目 ${manifest.files?.length}`)

  const rejected = manifest.files.filter(item => !isAllowedPath(item.path)).map(item => item.path)
  assert.deepEqual(rejected, [], `一键热更新会被白名单拒掉：${rejected.join(' / ')}`)

  const hash = text => createHash('sha256').update(text).digest('hex')
  const stale = []
  for (const item of manifest.files) {
    const text = readFileSync(new URL(`../prompts/${item.path}`, import.meta.url))
    if (hash(text) !== item.sha256) stale.push(item.path)
  }
  assert.deepEqual(stale, [], `sha256 过期：${stale.join(' / ')}`)

  const paths = manifest.files.map(item => item.path)
  for (const need of ['base.md', 'modes/flow.md', 'subagents/qa-whitebox.md', 'docs/05-dev-spec.md']) {
    assert.ok(paths.includes(need), `manifest 缺 ${need}`)
  }
  return `${manifest.files.length} 条全部放行且哈希一致`
})

test('P6-2 package.json：0.5.1 + 七个新模块与 prompts 都在发布清单，展示素材不进包', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '0.5.1')
  for (const file of ['flow-level.js', 'flow-docs.js', 'gate-tickets.js', 'gate-router.js', 'gate-settle.js', 'dispatch-declare.js', 'qa-handoff.js', 'prompts']) {
    assert.ok(pkg.files.includes(file), `files 缺 ${file}`)
  }
  assert.equal(pkg.files.some(file => file.startsWith('test')), false, 'test/ 不该进发布包')
  assert.equal(pkg.files.some(file => file.startsWith('.flow')), false, '运行时产物不该进发布包')
  // README 用的 Banner / 截图 / 动图只留在 Git 仓库，不进 npm 包（否则包体积 5MB+）。
  assert.equal(pkg.files.includes('docs'), false, 'docs 目录整包会带进 5MB 展示素材')
  assert.equal(pkg.files.some(file => file.startsWith('docs/assets')), false, '展示素材不该进发布包')
  assert.ok(pkg.files.includes('docs/DETAIL.md') && pkg.files.includes('docs/flow-api-research.md'), '技术文档仍应随包分发')
  return `${pkg.files.length} 条 files，版本 ${pkg.version}，展示素材已剔除`
})

test('P6-3 拦截收紧：review 不再强迫重填施工声明，build/toStage 仍然拦', () => {
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'build', nextMode: 'review' }), false)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan-ultra', nextMode: 'review' }), false)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan', nextMode: 'build' }), true)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan', nextMode: 'flow', docIds: ['05'] }), true)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan', nextMode: 'flow', docIds: ['03'] }), false)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan', nextMode: 'flow', toStage: 'build' }), true)
  assert.equal(requiresDeclaration({ level: 'S', kind: 'stage', fromStage: 'plan', nextMode: 'build' }), false)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'acceptance', fromStage: 'build' }), false)
  return 'review 放行 ✓｜build/flow+05/toStage 拦截 ✓｜S 与 acceptance 豁免 ✓'
})

await testAsync('P6-4 agentPresets 探测：按宿主真实形状取 id，过滤 broken，异常形状安全降级', async () => {
  const ok = await probeDispatchCapabilities({
    get: name => (name === 'agentPresets'
      ? { list: async () => [{ id: 'standard', order: 1 }, { id: 'minimal' }, { id: 'broken-one', broken: 'never started' }] }
      : name === 'permissionPresets' ? { names: ['workspace-write', 'read-only'] } : undefined),
    tools: { get: name => (name === 'dsh_team_spawn' ? {} : undefined) },
  })
  assert.deepEqual(ok.tools, ['dsh_team_spawn'])
  assert.equal(ok.readOnly.mode, 'preset')
  assert.deepEqual(ok.agentPresets.names, ['standard', 'minimal'])
  assert.deepEqual(ok.agentPresets.broken, ['broken-one'], '坏预设不能推荐给派单')

  const weird = await probeDispatchCapabilities({
    get: () => ({ list: async () => 'not-an-array' }),
    tools: { get: () => { throw new Error('registry boom') } },
  })
  assert.deepEqual(weird.tools, [], '工具注册表抛错时按不可用处理')
  assert.deepEqual(weird.agentPresets.names, [], '异常形状不抛错，降级为空')

  const empty = await probeDispatchCapabilities({ get: () => undefined, tools: {} })
  assert.deepEqual(empty.agentPresets.names, [])
  assert.equal(empty.agentPresets.source, 'unavailable')
  assert.equal(empty.readOnly.mode, 'none')
  return 'host 形状 ✓｜broken 过滤 ✓｜异常形状不抛错 ✓'
})

await testAsync('P6-5 UI Skill 开关：设置里关掉后直接回内置规范，不扫 skill 目录', async () => {
  let scanned = 0
  const probe = createUiSkillProbe({
    getSkills: () => ({ list: async () => { scanned += 1; return [{ name: 'impeccable' }] } }),
    getConfig: () => ({ ui: { skillProbe: false } }),
  })
  const result = await probe.probe(cwd)
  assert.equal(result.source, 'disabled')
  assert.equal(scanned, 0, '关掉探测后不许再扫 skill 目录')
  assert.ok(result.text.includes('内置'))
  return 'disabled ✓｜零扫描 ✓'
})

/* ------------------------------------------------------------------ *
 * P7：本地接口安全矩阵（五道防线）
 * ------------------------------------------------------------------ */

function fakeApiStore() {
  const writes = []
  return {
    writes,
    display: { root: 'prompts', officialDir: 'prompts/subagents', customDir: '~/.dsh-flow/prompts/custom/subagents' },
    manifestInfo: () => ({ version: '0.5.1', updatedAt: '', fileCount: 0 }),
    base: () => ({ source: 'file', path: 'C:/node_modules/dsh-flow/prompts/base.md', text: 'base' }),
    baseFile: () => 'base',
    mode: () => ({ source: 'file', path: 'C:/node_modules/dsh-flow/prompts/modes/plan.md', text: 'plan' }),
    rosterInfo: () => ({ content: '', source: 'default', hasCustom: false, path: 'C:/node_modules/dsh-flow/prompts/subagents/README.md' }),
    listSubagents: () => [{
      id: 'qa-tester', title: 't', kind: 'official', overridden: false, content: 'c',
      resolvedPath: 'C:/node_modules/dsh-flow/prompts/subagents/qa-tester.md',
    }],
    invalidate() {},
    writeSubagent(id, content) { writes.push({ id, content }); return { ok: true } },
    writeRoster(content) { writes.push({ id: 'roster', content }); return { ok: true } },
    deleteSubagent() { return { ok: true } },
    deleteRoster() { return { ok: true } },
  }
}

function fakeReq({ method = 'GET', url = '/api/dsh-flow/prompts', headers = {}, address = '127.0.0.1', body = '' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(text) { this.body = text ?? '' },
  }
}

function apiHarness() {
  const store = fakeApiStore()
  let updateCalls = 0
  const api = createPromptApi({
    store,
    update: async () => { updateCalls += 1; return { result: { ok: true }, text: 'ok' } },
  })
  return { store, api, updates: () => updateCalls }
}

await testAsync('P7-1 合法同源 GET/HEAD 200，路径字段已脱敏', async () => {
  const { api } = apiHarness()
  const res = fakeRes()
  await api.getOverview(fakeReq({ headers: { host: '127.0.0.1:3080' } }), res)
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body).data
  assert.equal(data.root, 'prompts')
  assert.equal(data.officialDir, 'prompts/subagents')
  assert.ok(!data.base.path.includes('C:'), `base.path 仍是绝对路径：${data.base.path}`)
  assert.ok(!data.subagents[0].resolvedPath.includes('C:'), 'resolvedPath 仍是绝对路径')
  assert.equal(data.customDir, '~/.dsh-flow/prompts/custom/subagents')

  const headRes = fakeRes()
  await api.getOverview(fakeReq({ method: 'HEAD', headers: { host: 'LOCALHOST:3080' } }), headRes)
  assert.equal(headRes.statusCode, 200, 'HEAD 与大小写 LOCALHOST 都应放行')

  const sixRes = fakeRes()
  await api.getOverview(fakeReq({ headers: { host: '[::1]:3080' } }), sixRes)
  assert.equal(sixRes.statusCode, 200, '[::1] 应放行')
  return 'GET/HEAD/LOCALHOST/[::1] ✓｜路径脱敏 ✓'
})

await testAsync('P7-2 伪造 Host 全部 403（含 @ / / / 尾点 / 双端口）', async () => {
  const { api } = apiHarness()
  const bad = ['evil.example', '127.0.0.1@evil.example', '127.0.0.1/evil', 'localhost.', '127.0.0.1:3080:80', '127.0.0.1:99999', '', '::1']
  for (const host of bad) {
    const res = fakeRes()
    await api.getOverview(fakeReq({ headers: { host } }), res)
    assert.equal(res.statusCode, 403, `Host=${JSON.stringify(host)} 应被拒`)
    assert.equal(JSON.parse(res.body).reason, 'bad-host')
  }
  const missing = fakeRes()
  await api.getOverview(fakeReq({ headers: {} }), missing)
  assert.equal(missing.statusCode, 403, '缺少 Host 也要拒')
  return `${bad.length} 个畸形 Host 全部 403`
})

await testAsync('P7-3 跨站 Origin 403，同源 Origin 放行，无 Origin 放行', async () => {
  const { api } = apiHarness()
  const host = '127.0.0.1:3080'

  const cross = fakeRes()
  await api.getOverview(fakeReq({ headers: { host, origin: 'http://evil.example' } }), cross)
  assert.equal(cross.statusCode, 403)
  assert.equal(JSON.parse(cross.body).reason, 'cross-origin')

  const same = fakeRes()
  await api.getOverview(fakeReq({ headers: { host, origin: 'http://127.0.0.1:3080' } }), same)
  assert.equal(same.statusCode, 200, '同源 Origin 必须放行')

  const upper = fakeRes()
  await api.getOverview(fakeReq({ headers: { host, origin: 'HTTP://127.0.0.1:3080' } }), upper)
  assert.equal(upper.statusCode, 200, 'Origin 大小写不敏感')

  const nullOrigin = fakeRes()
  await api.getOverview(fakeReq({ headers: { host, origin: 'null' } }), nullOrigin)
  assert.equal(nullOrigin.statusCode, 403, 'Origin: null 按跨站处理')

  const updated = fakeRes()
  await api.postUpdate(fakeReq({ method: 'POST', url: '/api/dsh-flow/prompts/update', headers: { host, origin: 'https://evil.example', 'content-type': 'text/plain' } }), updated)
  assert.equal(updated.statusCode, 403, 'POST 跨站必须在方法/正文校验之前被拦')
  return '跨站 403 ✓｜同源/无 Origin 放行 ✓｜Origin: null 拒绝 ✓'
})

await testAsync('P7-4 方法白名单：GET /prompts/update 405 + Allow，且零副作用', async () => {
  const { api, updates } = apiHarness()
  const res = fakeRes()
  await api.postUpdate(fakeReq({ method: 'GET', url: '/api/dsh-flow/prompts/update', headers: { host: '127.0.0.1:3080' } }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
  assert.equal(updates(), 0, '405 时绝不能触发更新')

  const put = fakeRes()
  await api.roster(fakeReq({ method: 'POST', url: '/api/dsh-flow/roster', headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' } }), put)
  assert.equal(put.statusCode, 405)
  assert.equal(put.headers.allow, 'PUT, DELETE')

  const getSub = fakeRes()
  await api.subagent(fakeReq({ method: 'GET', url: '/api/dsh-flow/subagents/qa-tester', headers: { host: '127.0.0.1:3080' } }), getSub)
  assert.equal(getSub.statusCode, 405)
  assert.equal(getSub.headers.allow, 'PUT, DELETE')
  return 'GET update 405 ✓｜roster POST 405 ✓｜subagent GET 405 ✓'
})

await testAsync('P7-5 PUT 正文类型：text/plain 415 且不落盘，application/json 放行', async () => {
  const { api, store } = apiHarness()
  const rejected = fakeRes()
  await api.subagent(fakeReq({
    method: 'PUT',
    url: '/api/dsh-flow/subagents/qa-tester',
    headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' },
    body: JSON.stringify({ content: 'x' }),
  }), rejected)
  assert.equal(rejected.statusCode, 415)
  assert.deepEqual(store.writes, [], '415 时绝不能写盘')

  const accepted = fakeRes()
  await api.subagent(fakeReq({
    method: 'PUT',
    url: '/api/dsh-flow/subagents/qa-tester',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ content: 'hello' }),
  }), accepted)
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.deepEqual(store.writes, [{ id: 'qa-tester', content: 'hello' }])
  return 'text/plain 415 零写入 ✓｜JSON 放行 ✓'
})

await testAsync('P7-6 非回环来源 403，本地 curl（无 Origin、无 content-type 的 GET）放行', async () => {
  const { api } = apiHarness()
  const remote = fakeRes()
  await api.getOverview(fakeReq({ address: '192.168.1.9', headers: { host: '127.0.0.1:3080' } }), remote)
  assert.equal(remote.statusCode, 403)
  assert.equal(JSON.parse(remote.body).reason, 'non-loopback')

  const curl = fakeRes()
  await api.getOverview(fakeReq({ headers: { host: '127.0.0.1:3080' } }), curl)
  assert.equal(curl.statusCode, 200)
  return '非回环 403 ✓｜本地 curl 放行 ✓'
})

/* ------------------------------------------------------------------ *
 * P8：私有提示词目录（插件包之外 + 无损迁移）
 * ------------------------------------------------------------------ */

test('P8-1 customDir 解析：配置 > DSH_PROFILE_DIR > 家目录', () => {
  const home = join(tmpdir(), 'fake-home')
  const fromProfile = resolveCustomDir({ env: { DSH_PROFILE_DIR: join(tmpdir(), 'profile') }, home })
  assert.ok(fromProfile.endsWith(join('data', 'dsh-flow', 'prompts', 'custom', 'subagents')), fromProfile)

  const fromHome = resolveCustomDir({ env: {}, home })
  assert.equal(fromHome, join(home, '.dsh-flow', 'prompts', 'custom', 'subagents'))

  const overridden = resolveCustomDir({
    getConfig: () => ({ prompts: { customDir: join(tmpdir(), 'mine') } }),
    env: { DSH_PROFILE_DIR: join(tmpdir(), 'profile') },
    home,
  })
  assert.equal(overridden, join(tmpdir(), 'mine', 'subagents'))
  return '三级回退 ✓'
})

test('P8-2 旧目录无损迁移：同名不覆盖、新文件复制、旧文件保留', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-flow-mig-'))
  const legacy = join(base, 'legacy')
  const target = join(base, 'target')
  mkdirSync(legacy, { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(legacy, 'a.md'), '# a legacy', 'utf8')
  writeFileSync(join(legacy, 'b.md'), '# b legacy', 'utf8')
  writeFileSync(join(target, 'b.md'), '# b new', 'utf8')

  const result = migrateLegacyCustom({ legacyDir: legacy, targetDir: target })
  assert.deepEqual(result.copied, ['a.md'])
  assert.deepEqual(result.skipped, ['b.md'])
  assert.deepEqual(result.errors, [])
  assert.equal(readFileSync(join(target, 'a.md'), 'utf8'), '# a legacy')
  assert.equal(readFileSync(join(target, 'b.md'), 'utf8'), '# b new', '同名文件绝不能被旧内容覆盖')
  assert.equal(readFileSync(join(legacy, 'a.md'), 'utf8'), '# a legacy', '旧目录不许被删')
  assert.equal(readFileSync(join(legacy, 'b.md'), 'utf8'), '# b legacy')

  const again = migrateLegacyCustom({ legacyDir: legacy, targetDir: target })
  assert.deepEqual(again.copied, [], '第二次迁移应是幂等的')
  rmSync(base, { recursive: true, force: true })
  return 'copied a.md ✓｜b.md 保持新版 ✓｜旧目录保留 ✓｜幂等 ✓'
})

/* ------------------------------------------------------------------ *
 * P9：全仓零 Git 冲突标记
 * ------------------------------------------------------------------ */

test('P9-1 全仓（md/js/json/yml）零冲突标记', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const skip = new Set(['node_modules', '.git', '.flow'])
  const hits = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (!/\.(md|js|mjs|json|yml|yaml)$/i.test(entry.name)) continue
      const path = join(dir, entry.name)
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (/^(<<<<<<<|=======$|>>>>>>>)/.test(line)) hits.push(`${relative(root, path)}:${index + 1}`)
      })
    }
  }
  walk(root)
  assert.deepEqual(hits, [], `仍有冲突标记：${hits.join(' / ')}`)
  return '零冲突标记 ✓'
})

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const passed = results.filter(item => item.ok).length
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.note === '' ? '' : `  — ${item.note}`}`)
}
console.log(`\n${passed}/${results.length} 通过，${failures} 失败`)
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
