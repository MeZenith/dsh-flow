import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelTarget } from '../../src/modes/switcher.js'
import { createCircuitBreaker } from '../../src/resilience/circuit-breaker.js'

function makeBreakerEnv({ threshold = 3, rescueModel = '' } = {}) {
  const scheduled = []
  const cancelled = []
  const logs = []
  const imSent = []
  const brakeEvents = []
  const unlockEvents = []
  let executedNotice = 0

  const breaker = createCircuitBreaker({
    ctx: {
      on: (_ev, _cb) => () => {},
      commands: {
        execute: async (_ag, line) => {
          if (line === '/flow-notice') executedNotice += 1
          return { kind: 'success' }
        },
      },
      get: name => (name === 'llm'
        ? { resolveModelInfo: async (p, m) => (m === 'bad' ? Promise.reject(new Error('nope')) : { p, m }) }
        : undefined),
    },
    getConfig: () => ({ circuit: { enabled: true, threshold, rescueModel, idleSeconds: 120 } }),
    notifier: {
      schedule: (event, payload) => {
        const handle = { id: scheduled.length + 1, event, payload, cancel: () => cancelled.push(event) }
        scheduled.push(handle)
        return handle
      },
    },
    logger: { info: m => logs.push(m), warn: m => logs.push(m) },
    readMode: () => 'build',
    im: {
      send: async (msg) => {
        imSent.push(msg)
        return { ok: true, via: 'feishu' }
      },
    },
    onBrake: payload => brakeEvents.push(payload),
    onUnlocked: payload => unlockEvents.push(payload),
  })

  function makeAgent(sessionId, project = 'alpha') {
    const sentFollowups = []
    const selects = []
    const agent = {
      id: `ag-${sessionId}`,
      status: 'idle',
      whenIdle: () => Promise.resolve(),
      session: {
        id: sessionId,
        header: { cwd: `/work/${project}` },
        seq: 1,
        eventAt: () => ({ type: 'user/message', data: { id: 'u-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do work' }] } }),
      },
      cancel: () => {},
      followup: msg => sentFollowups.push(msg),
      model: { select: spec => selects.push(spec) },
      sentFollowups,
      selects,
    }
    return agent
  }

  return { breaker, makeAgent, scheduled, cancelled, imSent, brakeEvents, unlockEvents, getNoticeCount: () => executedNotice }
}

test('circuit-breaker state transitions: threshold N-1 / N / N+1, success reset, and resolveRemoteAction 1/2/3', async () => {
  const env = makeBreakerEnv({ threshold: 3, rescueModel: 'ds::strong' })
  const ag = env.makeAgent('s-cb-1', 'alpha')

  // N-1 stays unlocked
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: 'e1' } })
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: 'e2' } })
  assert.equal(env.breaker.isLocked(ag), false)

  // Success resets streak
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: false })
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: 'e3' } })
  assert.equal(env.breaker.isLocked(ag), false)

  // Reach threshold N=3 -> locks
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: 'e4' } })
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: 'e5' } })
  assert.equal(env.breaker.isLocked(ag), true)
  assert.equal(env.brakeEvents.length, 1)

  // N+1 while already locked does not double-trip
  env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: 'e6' } })
  assert.equal(env.brakeEvents.length, 1)

  await new Promise(r => setTimeout(r, 25))
  assert.ok(env.getNoticeCount() >= 1)

  // Escalate via resolveRemoteAction ('2') switches model & unlocks & follows up
  const escRes = await env.breaker.resolveRemoteAction({ sessionId: 's-cb-1', action: '2' })
  assert.equal(escRes.ok, true)
  assert.equal(escRes.switched, true)
  assert.equal(env.breaker.isLocked(ag), false)
  assert.deepEqual(ag.selects, [{ provider: 'ds', model: 'strong' }])
  await new Promise(r => setTimeout(r, 70))
  assert.equal(ag.sentFollowups.length, 1)

  // Trip again and test '3' with prompt
  for (let i = 0; i < 3; i += 1) env.breaker.observe({ agent: ag, name: 'bash' }, { isError: true, error: { message: `x${i}` } })
  const res3 = await env.breaker.resolveRemoteAction({ sessionId: 's-cb-1', action: 'resume', prompt: '换个思路重试' })
  assert.equal(res3.ok, true)
  assert.equal(res3.forwarded, true)
  assert.equal(ag.sentFollowups[1].content[0].text, '换个思路重试')
  assert.equal((await env.breaker.resolveRemoteAction({ sessionId: 'missing', action: '1' })).ok, false)

  env.breaker.dispose()
})

test('circuit-breaker preStep handles desktop 1/2/3, 3+prompt, ordinary text unlock, and cross-session handoff', async () => {
  const env = makeBreakerEnv({ threshold: 2, rescueModel: '' })
  const agA = env.makeAgent('s-a', 'projA')
  const agB = env.makeAgent('s-b', 'projB')

  for (let i = 0; i < 2; i += 1) env.breaker.observe({ agent: agA, name: 'bash' }, { isError: true, error: { message: 'boom' } })
  assert.equal(env.breaker.listTrips().length, 1)

  // Ordinary non-command text unlocks agA and calls next()
  let passedNext = false
  await env.breaker.preStep({ agent: agA, messages: [{ content: [{ type: 'text', text: '我改好了继续吧' }] }] }, () => { passedNext = true; return { kind: 'enter' } })
  assert.equal(passedNext, true)
  assert.equal(env.breaker.isLocked(agA), false)

  // Re-trip agA and steer it from another idle session agB via `3 #projA 新任务`
  for (let i = 0; i < 2; i += 1) env.breaker.observe({ agent: agA, name: 'bash' }, { isError: true, error: { message: 'boom2' } })
  const crossRes = await env.breaker.preStep(
    { agent: agB, messages: [{ content: [{ type: 'text', text: '3 #projA 先跑单测' }] }] },
    () => ({ kind: 'enter' }),
  )
  assert.equal(crossRes.kind, 'reject')
  assert.equal(env.breaker.isLocked(agA), false)
  assert.equal(agA.sentFollowups[agA.sentFollowups.length - 1].content[0].text, '先跑单测')

  // Unknown rescue model fallback stays graceful
  assert.equal((await resolveModelTarget(env.breaker, 'ds::bad')).ok, false)
  env.breaker.forget('s-a')
  env.breaker.dispose()
})
