import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildGateCard, buildModeCard, buildWorkspaceCard } from '../../src/remote/feishu/cards.js'
import { createPromptStore } from '../../src/prompts/store.js'
import { createPromptApi } from '../../src/prompts/api.js'
import { checkDoc, ensureDocs, writeDoc } from '../../src/workflow/docs.js'
import { createDocsTools } from '../../src/tools/docs.js'
import { createModeProjection } from '../../src/modes/projection.js'

function fakeReq({ method = 'POST', url = '/api/dsh-flow/feishu/connect', host = '127.0.0.1:3080', contentType, body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks)
  stream.method = method
  stream.url = url
  stream.socket = { remoteAddress: '127.0.0.1' }
  stream.headers = { host }
  if (contentType !== undefined) stream.headers['content-type'] = contentType
  return stream
}

function fakeRes() {
  const headers = {}
  return {
    statusCode: 200,
    headers,
    body: '',
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
  }
}

test('P2-1: workspace card strips session- prefix, wraps dense button rows to <=3 per row, and clips long labels', () => {
  const sessions = Array.from({ length: 7 }, (_, i) => ({
    sessionId: `session-a1b2c3d4000${i}`,
    project: `super-long-project-name-for-testing-${i}`,
    cwd: `/work/p${i}`,
    mode: 'flow',
  }))
  const wsCard = buildWorkspaceCard({
    workspaces: [],
    sessions,
    activeFocus: { project: 'demo', sessionId: 'session-a1b2c3d4e5f6' },
  })
  const focusMd = wsCard.body.elements[0].content
  assert.ok(focusMd.includes('a1b2c3d4'))
  assert.equal(focusMd.includes('`session-`'), false)

  const colSets = wsCard.body.elements.filter(el => el.tag === 'column_set')
  assert.ok(colSets.length >= 3)
  for (const row of colSets) {
    assert.ok(row.columns.length <= 3)
    for (const col of row.columns) {
      assert.ok(col.elements[0].text.content.length <= 28)
    }
  }

  const modeCard = buildModeCard({ project: 'demo', sessionId: 's1', currentMode: 'flow' })
  const modeRows = modeCard.body.elements.filter(el => el.tag === 'column_set')
  assert.equal(modeRows.length, 2)
  assert.equal(modeRows[0].columns.length, 3)
  assert.equal(modeRows[1].columns.length, 3)

  const gateCard = buildGateCard({
    ticket: {
      id: 't1234',
      project: 'demo',
      kind: 'stage',
      fromStage: 'plan',
      nextMode: 'build',
      summary: 'ok',
      options: Array.from({ length: 5 }, (_, i) => ({ label: `超长自定义选项文案测试${i}一二三四五六七八九十`, action: 'approve' })),
    },
  })
  const gateRows = gateCard.body.elements.filter(el => el.tag === 'column_set')
  assert.equal(gateRows.length, 2)
  for (const row of gateRows) assert.ok(row.columns.length <= 3)
})

test('P2-2: prompt API distinguishes 400/413/415, ensureDocs invalidates checkDoc cache, and flow_send_doc defaults to both', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-p22-'))
  try {
    const cfg = { docs: { enabled: true, dir: '.flow/docs', level: 'M' }, prompts: { customDir: join(root, 'custom') }, email: {} }
    const store = createPromptStore({ getConfig: () => cfg })
    const api = createPromptApi({
      store,
      update: async () => ({ result: { ok: true }, text: 'ok' }),
      feishu: { connect: async () => ({ ok: true }) },
    })

    // 1. 畸形 JSON → 400
    const resBadJson = fakeRes()
    await api.feishuConnect(fakeReq({ contentType: 'application/json', body: '{bad json' }), resBadJson)
    assert.equal(resBadJson.statusCode, 400)

    // 2. 非对象 JSON（如数组/null）→ 400
    const resArray = fakeRes()
    await api.feishuConnect(fakeReq({ contentType: 'application/json', body: '[1,2,3]' }), resArray)
    assert.equal(resArray.statusCode, 400)

    // 3. 超大请求体 (>1MB) → 413
    const resHuge = fakeRes()
    await api.feishuConnect(fakeReq({ contentType: 'application/json', body: Buffer.alloc(1024 * 1024 + 64, 'a') }), resHuge)
    assert.equal(resHuge.statusCode, 413)

    // 4. 非 JSON Content-Type → 415
    const resBadCt = fakeRes()
    await api.feishuConnect(fakeReq({ contentType: 'text/plain', body: 'hi' }), resBadCt)
    assert.equal(resBadCt.statusCode, 415)

    // 5. 空请求体无 Content-Type → 200
    const resEmpty = fakeRes()
    await api.feishuConnect(fakeReq({}), resEmpty)
    assert.equal(resEmpty.statusCode, 200)

    // 6. ensureDocs({ overwrite: true }) 后立即 checkDoc，缓存必须正确失效
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })
    const full03 = ['# 03 技术与环境', ...Array.from({ length: 7 }, (_, i) => `\n## ${i + 1}. 节 ${i + 1}\n\n${'实质内容描述。'.repeat(12)}`)].join('\n')
    assert.equal(writeDoc({ config: cfg, cwd, target: { kind: 'doc', id: '03' }, content: full03 }).ok, true)
    assert.equal(checkDoc({ config: cfg, cwd, id: '03', level: 'M' }).ok, true)
    // 覆盖为空白模板骨架后，checkDoc 必须立刻反映为失败（不能命中旧缓存）
    assert.equal(ensureDocs({ config: cfg, cwd, ids: ['03'], overwrite: true }).created.includes('03'), true)
    assert.equal(checkDoc({ config: cfg, cwd, id: '03', level: 'M' }).ok, false)

    // 7. flow_send_doc 未传 to 时默认走 both（同时触发 email 与 im/feishu）
    let emailCalled = false
    let imCalled = false
    let hubDocsCalled = false
    const tools = createDocsTools({
      getConfig: () => cfg,
      tickets: { holdOf: () => undefined, canWrite: () => ({ ok: true, scope: 'auto' }) },
      email: { send: async () => { emailCalled = true; return { ok: true } } },
      im: { send: async () => { imCalled = true; return { ok: true } } },
      remoteHub: { emit: (type) => { if (type === 'docs:ready') hubDocsCalled = true } },
    })
    const sendDoc = tools.find(t => t.name === 'flow_send_doc')
    const out = await sendDoc.execute(
      { docIds: ['03'] },
      { agent: { id: 'a1', session: { id: 's1', header: { cwd } } } },
    )
    assert.equal(out.outcome, 'ok')
    assert.equal(emailCalled, true)
    assert.equal(imCalled, true)
    assert.equal(hubDocsCalled, true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('P2-3 & P2-4: built client.js ships UI contrast/race/validation guards & mode projection folds real command/run', () => {
  const clientCode = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
  assert.ok(clientCode.includes('rgba(128, 128, 128, 0.38)'), '关闭态开关高对比度轨道样式应已编入 client.js')
  assert.ok(clientCode.includes('seqByKeyRef'), '乐观更新请求序号防回弹守卫应已编入 client.js')
  assert.ok(clientCode.includes('rosterDirty'), '花名册草稿隔离标记应已编入 client.js')
  assert.ok(clientCode.includes('appSecretDraft'), '手动凭证草稿直传应已编入 client.js')
  assert.ok(clientCode.includes('commitInt'), '严格数字边界校验应已编入 client.js')

  // 严格 DSH 投影契约校验：command/run { name: 'flow', args: 'build' } → { mode: 'build' }，缺参数则保持旧模式
  const proj = createModeProjection()
  let state = proj.init()
  assert.equal(state.mode, 'off')
  state = proj.apply(state, { type: 'command/run', data: { name: 'flow', args: '' } })
  assert.equal(state.mode, 'off')
  state = proj.apply(state, { type: 'command/run', data: { name: 'flow', args: 'build' } })
  assert.equal(state.mode, 'build')
  state = proj.apply(state, { type: 'command/run', data: { name: 'flow', args: 'off' } })
  assert.equal(state.mode, 'off')
})
