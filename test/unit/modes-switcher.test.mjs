import test from 'node:test'
import assert from 'node:assert/strict'
import { applyModeSwitch, applyPermission, resolveModelTarget } from '../../src/modes/switcher.js'
import { COMPACT_MESSAGES, createCompactBridge } from '../../src/modes/compact-bridge.js'

function fakeAgent(id = 'sess-m1') {
  const appended = []
  const selected = []
  return {
    id: `ag-${id}`,
    session: {
      id,
      header: { cwd: '/work/demo' },
      append: (type, data) => appended.push({ type, data }),
    },
    model: {
      select: spec => selected.push(spec),
    },
    appended,
    selected,
  }
}

test('switcher resolveModelTarget handles invalid key, missing llm, reject, and valid model', async () => {
  assert.equal((await resolveModelTarget(undefined, 'bad-key')).ok, false)
  assert.equal((await resolveModelTarget({ get: () => undefined }, 'deepseek::chat')).ok, false)

  const failCtx = { get: () => ({ resolveModelInfo: async () => { throw new Error('unknown model') } }) }
  const errRes = await resolveModelTarget(failCtx, 'deepseek::missing')
  assert.equal(errRes.ok, false)
  assert.ok(errRes.reason.includes('unknown model'))

  const okCtx = { get: () => ({ resolveModelInfo: async () => ({ id: 'chat' }) }) }
  const okRes = await resolveModelTarget(okCtx, 'deepseek::chat')
  assert.deepEqual(okRes, { ok: true, provider: 'deepseek', model: 'chat' })
})

test('switcher applyPermission handles keep, permissionPresets, and fallback session events', () => {
  const ag = fakeAgent()
  assert.deepEqual(applyPermission(undefined, ag, 'keep'), { via: 'skipped' })

  const presetCalls = []
  const presetCtx = {
    get: name => (name === 'permissionPresets'
      ? { names: ['read-only'], set: (s, p) => presetCalls.push([s.id, p]) }
      : undefined),
  }
  assert.deepEqual(applyPermission(presetCtx, ag, 'read-only'), { via: 'preset' })
  assert.deepEqual(presetCalls, [['sess-m1', 'read-only']])

  assert.deepEqual(applyPermission(presetCtx, ag, 'workspace-write'), { via: 'fallback' })
  assert.equal(ag.appended[0].type, 'sandbox/mode')
  assert.equal(ag.appended[1].type, 'approval/policy')
})

test('switcher applyModeSwitch switches model & permission cleanly and tolerates model/permission errors', async () => {
  const agOff = fakeAgent()
  const offRes = await applyModeSwitch({ config: {}, agent: agOff, modeId: 'off' })
  assert.equal(offRes.modeId, 'off')
  assert.equal(offRes.permissionVia, 'skipped')

  const agOk = fakeAgent()
  const okCtx = {
    get: name => (name === 'llm'
      ? { resolveModelInfo: async () => ({}) }
      : name === 'permissionPresets'
        ? { names: ['read-only'], set() {} }
        : undefined),
  }
  const okRes = await applyModeSwitch({
    ctx: okCtx,
    config: { modes: { plan: { label: 'Plan', permission: 'read-only', model: 'ds::reasoner' } } },
    agent: agOk,
    modeId: 'plan',
  })
  assert.equal(okRes.modelChanged, true)
  assert.equal(okRes.permissionVia, 'preset')
  assert.deepEqual(agOk.selected, [{ provider: 'ds', model: 'reasoner' }])

  const warnings = []
  const brokenAgent = {
    session: { id: 's-bad', append() { throw new Error('disk readonly') } },
    model: { select() { throw new Error('model locked') } },
  }
  const badRes = await applyModeSwitch({
    ctx: { get: name => (name === 'llm' ? { resolveModelInfo: async () => ({}) } : undefined) },
    config: { modes: { build: { label: 'Build', permission: 'workspace-write', model: 'ds::coder' } } },
    agent: brokenAgent,
    modeId: 'build',
    logger: { warn: msg => warnings.push(msg) },
  })
  assert.equal(badRes.modelChanged, false)
  assert.ok(badRes.notes.some(n => n.includes('模型切换失败')))
  assert.ok(badRes.notes.some(n => n.includes('权限切换失败')))
  assert.equal(warnings.length, 1)
})

test('compact-bridge runNow covers unavailable, null, success, cancelled, ManualCompactionError & unknown error', async () => {
  const ag = fakeAgent()
  const noneBridge = createCompactBridge({ ctx: { get: () => undefined } })
  const unavail = await noneBridge.runNow(ag)
  assert.equal(unavail.ok, false)
  assert.equal(unavail.code, 'unavailable')
  assert.equal(noneBridge.available(ag), false)

  let mode = 'ok'
  const compService = {
    compactNow: async () => {
      if (mode === 'null') return null
      if (mode === 'busy') {
        const err = new Error('busy')
        err.name = 'ManualCompactionError'
        err.code = 'busy'
        throw err
      }
      if (mode === 'boom') throw new Error('unexpected boom')
      return { shadowedSeqs: [1, 2], shadowedTokenCount: 500, summarySeq: 9 }
    },
  }
  const bridge = createCompactBridge({
    ctx: { get: name => (name === 'compaction' ? compService : undefined) },
  })
  assert.equal(bridge.available(ag), true)
  assert.equal((await bridge.runNow(ag)).code, 'compacted')

  mode = 'null'
  assert.equal((await bridge.runNow(ag)).code, 'empty')

  mode = 'busy'
  const busyRes = await bridge.runNow(ag)
  assert.equal(busyRes.ok, false)
  assert.equal(busyRes.text, COMPACT_MESSAGES.busy)

  mode = 'boom'
  const ac = new AbortController()
  ac.abort()
  assert.equal((await bridge.runNow(ag, ac.signal)).code, 'cancelled')
  assert.equal((await bridge.runNow(ag)).code, 'unknown')
  bridge.dispose()
})

test('compact-bridge schedule, onStatus, locked deferral, forget, and dispose work cleanly', async () => {
  const ag = fakeAgent()
  let locked = true
  let calls = 0
  const bridge = createCompactBridge({
    ctx: { get: () => undefined },
    getHostCompaction: () => ({ compactNow: async () => { calls += 1; return { shadowedSeqs: [], shadowedTokenCount: 0 } } }),
    isLocked: () => locked,
    logger: { info() {}, warn() {} },
  })

  assert.equal(bridge.schedule(ag), true)
  assert.equal(bridge.schedule(ag), false)
  assert.equal(bridge.isScheduled(ag), true)

  bridge.onStatus({ agent: ag, status: 'running' })
  bridge.onStatus({ agent: ag, status: 'idle' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls, 0, '熔断锁定时绝不自动压缩')

  locked = false
  bridge.onStatus({ agent: ag, status: 'idle' })
  await new Promise(r => setTimeout(r, 25))
  assert.equal(calls, 1)

  bridge.schedule(ag)
  bridge.forget(ag)
  assert.equal(bridge.isScheduled(ag), false)
  bridge.dispose()
})
