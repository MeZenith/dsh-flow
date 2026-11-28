import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPromptStore } from '../../src/prompts/store.js'
import { createPromptApi } from '../../src/prompts/api.js'
import { attachAgentModeContext } from '../../src/prompts/bridge.js'
import { rememberLevel } from '../../src/workflow/level.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'
import { DEFAULT_SOURCE_URL, MIRROR_SOURCES, PLUGIN_VERSION, checkPluginCompatibility, updatePrompts } from '../../src/prompts/updater.js'
import { createHash } from 'node:crypto'

function fakeReq({ method = 'GET', url = '/api/dsh-flow/prompts', host = '127.0.0.1:3080', origin, contentType, remoteAddress = '127.0.0.1', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks)
  stream.method = method
  stream.url = url
  stream.socket = { remoteAddress }
  stream.headers = { host }
  if (origin !== undefined) stream.headers.origin = origin
  if (contentType !== undefined) stream.headers['content-type'] = contentType
  return stream
}

function fakeRes() {
  const headers = {}
  return {
    statusCode: 200,
    headers,
    body: '',
    ended: false,
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.ended = true
    },
  }
}

test('B-01 & M-09: promptStore.info() works and customDir reacts dynamically to config changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-store-'))
  try {
    const dirA = join(root, 'customA')
    const dirB = join(root, 'customB')
    const cfg = { prompts: { customDir: dirA } }
    const store = createPromptStore({ getConfig: () => cfg })

    const info = store.info()
    assert.ok(info.version !== '')
    assert.equal(info.modes.length, 5)
    assert.ok(info.official.length >= 9)

    assert.equal(store.writeSubagent('my-bot', '# my-bot | A').ok, true)
    assert.equal(store.subagent('my-bot').text, '# my-bot | A')

    // 动态修改 prompts.customDir，无需重启立即切到 dirB
    cfg.prompts.customDir = dirB
    assert.equal(store.subagent('my-bot').text, '')
    assert.equal(store.writeSubagent('my-bot-b', '# my-bot-b | B').ok, true)
    assert.equal(store.subagent('my-bot-b').text, '# my-bot-b | B')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-04: attachAgentModeContext propagates sessionId level and flowAutonomy into mode text', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-bridge-'))
  try {
    const stateStore = createFlowStateStore({ filePath: join(root, 'state.json'), persist: false })
    rememberLevel('sess-L', 'L', stateStore)
    let capturedTextFn
    const fakeAgentCtx = {
      systemPrompt: {
        context(spec) {
          capturedTextFn = spec.text
          return () => {}
        },
      },
    }
    const cfg = {
      docs: { enabled: true, level: 'M', writePolicy: 'auto' },
      behavior: { flowAutonomy: 'step-by-step' },
      modes: { flow: { label: 'Flow', prompt: 'FLOW BODY' } },
      promptSets: [],
    }
    attachAgentModeContext(fakeAgentCtx, {
      agent: { session: { id: 'sess-L' } },
      getConfig: () => cfg,
      getMode: () => 'flow',
      store: null,
      stateStore,
    })
    const rendered = capturedTextFn()
    assert.ok(rendered.includes('等级 L'))
    assert.ok(rendered.includes('分阶段确认'))
    assert.ok(rendered.includes('直接落盘'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-12: prompt-api 5-layer guard, URIError 400, empty HEAD body, sanitized PUT path, feishu routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-api-'))
  try {
    const cfg = { prompts: { customDir: join(root, 'custom') } }
    const store = createPromptStore({ getConfig: () => cfg })
    const api = createPromptApi({
      store,
      update: async () => ({ result: { ok: true }, text: 'ok' }),
      feishu: {
        status: async () => ({ state: 'disconnected', connected: false }),
        presets: () => ({ avatars: [{ id: 'commander', url: 'https://example.com/a.png' }] }),
      },
    })

    // Non-loopback → 403
    const res1 = fakeRes()
    await api.getOverview(fakeReq({ remoteAddress: '10.0.0.5' }), res1)
    assert.equal(res1.statusCode, 403)

    // DNS rebinding Host → 403
    const res2 = fakeRes()
    await api.getOverview(fakeReq({ host: 'evil.example' }), res2)
    assert.equal(res2.statusCode, 403)

    // Cross-origin → 403
    const res3 = fakeRes()
    await api.getOverview(fakeReq({ origin: 'http://evil.example' }), res3)
    assert.equal(res3.statusCode, 403)

    // HEAD writes NO body
    const resHead = fakeRes()
    await api.getOverview(fakeReq({ method: 'HEAD' }), resHead)
    assert.equal(resHead.statusCode, 200)
    assert.equal(resHead.body, '')

    // Malformed percent encoding → 400 (no uncaught URIError)
    const resBadUri = fakeRes()
    await api.subagent(fakeReq({ method: 'PUT', url: '/api/dsh-flow/subagents/%E0%A4%A', contentType: 'application/json', body: { content: 'hi' } }), resBadUri)
    assert.equal(resBadUri.statusCode, 400)

    // PUT sanitizes path in response (never leaks full temp dir)
    const resPut = fakeRes()
    await api.subagent(fakeReq({ method: 'PUT', url: '/api/dsh-flow/subagents/valid-agent', contentType: 'application/json', body: { content: '# valid-agent' } }), resPut)
    assert.equal(resPut.statusCode, 200)
    const putPayload = JSON.parse(resPut.body)
    assert.equal(putPayload.ok, true)
    assert.ok(!String(putPayload.path ?? '').includes(root))

    // Feishu presets endpoint
    const resPresets = fakeRes()
    await api.feishuPresets(fakeReq({ url: '/api/dsh-flow/feishu/presets' }), resPresets)
    assert.equal(resPresets.statusCode, 200)
    assert.equal(JSON.parse(resPresets.body).data.avatars[0].id, 'commander')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M-08: prompt-updater allows plugin installed under path containing "custom"', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-flow-custom-path-'))
  const promptsRoot = join(baseDir, 'custom', 'prompts')
  mkdirSync(promptsRoot, { recursive: true })
  const origFetch = globalThis.fetch
  const fileText = '# base updated\n'
  const hash = createHash('sha256').update(fileText, 'utf8').digest('hex')
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/manifest.json')) {
      return new Response(JSON.stringify({ version: '0.6.99', minPluginVersion: '0.6.0', maxPluginVersion: '0.6.99', updatedAt: '2099-01-01T00:00:00.000Z', files: [{ path: 'base.md', sha256: hash }] }), { status: 200 })
    }
    if (String(url).endsWith('/base.md')) {
      return new Response(fileText, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  try {
    const res = await updatePrompts({ sourceUrl: 'https://example.test/prompts', root: promptsRoot, allowMirrorFallback: false })
    assert.equal(res.ok, true)
    assert.deepEqual(res.updated, ['base.md'])
  } finally {
    globalThis.fetch = origFetch
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('prompt-updater pins default sources to release tag and enforces plugin compatibility bounds', async () => {
  assert.ok(DEFAULT_SOURCE_URL.endsWith(`/v${PLUGIN_VERSION}/prompts`), `DEFAULT_SOURCE_URL must pin v${PLUGIN_VERSION}`)
  assert.ok(!DEFAULT_SOURCE_URL.includes('/main/'))
  assert.ok(MIRROR_SOURCES.every(url => url.includes(`v${PLUGIN_VERSION}`)))

  assert.equal(checkPluginCompatibility({ version: '0.6.5', minPluginVersion: '0.6.0', maxPluginVersion: '0.6.99' }, '0.6.1').ok, true)
  assert.equal(checkPluginCompatibility({ version: '0.6.5', minPluginVersion: '0.7.0' }, '0.6.1').ok, false)
  assert.equal(checkPluginCompatibility({ version: '0.6.5', maxPluginVersion: '0.6.0' }, '0.6.1').ok, false)
  assert.equal(checkPluginCompatibility({ version: '0.7.0' }, '0.6.1').ok, false)

  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-flow-compat-'))
  const origFetch = globalThis.fetch
  const body = '# new rules\n'
  const digest = createHash('sha256').update(body, 'utf8').digest('hex')
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/manifest.json')) {
        return new Response(JSON.stringify({
          version: '0.7.0',
          minPluginVersion: '0.7.0',
          updatedAt: '2099-01-01T00:00:00.000Z',
          files: [{ path: 'base.md', sha256: digest }],
        }), { status: 200 })
      }
      return new Response(body, { status: 200 })
    }
    const rejected = await updatePrompts({
      sourceUrl: 'https://example.test/prompts',
      root: baseDir,
      allowMirrorFallback: false,
      pluginVersion: '0.6.1',
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.incompatible, true)
    assert.ok(String(rejected.reason ?? '').includes('0.7.0'))
  } finally {
    globalThis.fetch = origFetch
    rmSync(baseDir, { recursive: true, force: true })
  }
})
