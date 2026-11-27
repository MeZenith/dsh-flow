import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClientSource } from '../../scripts/build-client.mjs'
import { computeManifestEntries } from '../../scripts/sync-manifest.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('root index.js exports ONLY named exports (Config, apply, inject, name) and no default', async () => {
  const entry = await import('../../index.js')
  const keys = Object.keys(entry).sort()
  assert.deepEqual(keys, ['Config', 'apply', 'inject', 'name'])
  assert.equal('default' in entry, false)
  assert.equal(entry.name, 'flow')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(typeof entry.Config, 'function')
  assert.ok(entry.inject.includes('systemPrompt'))
})

test('Config schema defaults match v0.6.0 decisions (D-01 auto docs write & D-02 Feishu config)', async () => {
  const { Config, plainConfigOf, BASE_RULES } = await import('../../src/config/schema.js')
  const plain = plainConfigOf(Config({}))
  assert.equal(plain.docs.level, 'M')
  assert.equal(plain.docs.dir, '.flow/docs')
  assert.equal(plain.docs.writePolicy, 'auto')
  assert.equal(plain.gate.timeoutSeconds, 1800)
  assert.equal(plain.feishu.enabled, false)
  assert.equal(plain.feishu.domain, 'feishu')
  assert.equal(plain.feishu.botName, 'Flow 指挥官')
  assert.equal(plain.feishu.sendDocFiles, true)

  const diskBase = readFileSync(join(ROOT, 'prompts', 'base.md'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(BASE_RULES.replace(/\r\n/g, '\n'), diskBase)
})

test('prompts/manifest.json matches package.json version and all 24 official prompt sha256s', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(ROOT, 'prompts', 'manifest.json'), 'utf8'))
  const computed = computeManifestEntries()
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.files.length, computed.length)
  assert.ok(computed.length >= 24)
  for (let i = 0; i < computed.length; i += 1) {
    assert.deepEqual(manifest.files[i], computed[i])
  }
})

test('client.js is in sync with src/client/* and boots inside __ModuleLoader__', () => {
  const built = buildClientSource()
  const disk = readFileSync(join(ROOT, 'client.js'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(disk, built)

  let registered = null
  const mockWindow = { __ModuleLoader__: { load(spec) { registered = spec } } }
  const runner = new Function('window', disk)
  runner(mockWindow)

  assert.ok(registered !== null)
  assert.equal(registered.id, 'dsh-flow')

  const mockReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useCallback: fn => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: fn => fn(),
    useRef: v => ({ current: v }),
    useState: v => [typeof v === 'function' ? v() : v, () => {}],
  }
  const mockDom = { createPortal: x => x }
  const mod = registered.factory(id => (id === 'react' ? mockReact : id === 'react-dom' ? mockDom : null))
  assert.equal(mod.name, 'flow-client')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'))
})

test('prompt-bridge exports DOCS_CONTEXT and PROMPT_NAMES without TDZ error', async () => {
  const bridge = await import('../../src/prompts/bridge.js')
  assert.equal(bridge.DOCS_CONTEXT, 'flow:docs')
  assert.equal(bridge.PROMPT_NAMES.DOCS_CONTEXT, 'flow:docs')
  assert.equal(bridge.PROMPT_NAMES.MODE_CONTEXT, 'flow:mode')
})
