import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

import { createCircuitBreaker } from '../../src/resilience/circuit-breaker.js'
import { createTeamWatcher, isConnectionRefusedError, parseSseFrame } from '../../src/resilience/team-sse.js'
import { buildMimeMessage, sanitizeSmtpAddress, sendMailWithBuiltin } from '../../src/notify/smtp-client.js'
import { createNotifier } from '../../src/notify/dispatcher.js'
import { stripImTags } from '../../src/shared/message.js'

test('stripImTags strips all 4 dsh-im wrapper tags cleanly', () => {
  const wrapped = '<dsh_im_source>{"ch":"wx"}</dsh_im_source><dsh_im_source_guidance>hi</dsh_im_source_guidance><dsh_im_reply_to>m1</dsh_im_reply_to><dsh_im_context>ctx</dsh_im_context>1 同意'
  assert.equal(stripImTags(wrapped), '1 同意')
})

test('B-10: circuit-breaker strict word boundary, desktop 3+cmd stripping, cancel delayed alert on unlock', async () => {
  let cancelledAlert = false
  let brakeEvent = null
  let unlockedEvent = null
  const forwarded = []

  const fakeCtx = {
    on: () => () => {},
    commands: { execute: async () => ({ kind: 'success' }) },
  }
  const breaker = createCircuitBreaker({
    ctx: fakeCtx,
    getConfig: () => ({ circuit: { enabled: true, threshold: 2, idleSeconds: 120 } }),
    notifier: {
      schedule() {
        return {
          cancel() { cancelledAlert = true },
          done: Promise.resolve({}),
        }
      },
    },
    readMode: () => 'build',
    onBrake: (p) => { brakeEvent = p },
    onUnlocked: (p) => { unlockedEvent = p },
  })

  const agentA = {
    id: 'a1',
    session: { id: 's-a', header: { cwd: '/work/projA' } },
    cancel() {},
    settled: () => Promise.resolve(),
    followup(msg) { forwarded.push(msg.content[0].text) },
  }
  const agentB = {
    id: 'a2',
    session: { id: 's-b', header: { cwd: '/work/projB' } },
  }

  // 触发 2 次连续报错进入熔断
  breaker.observe({ agent: agentA, name: 'bash' }, { isError: true, error: { message: 'err1' } })
  breaker.observe({ agent: agentA, name: 'bash' }, { isError: true, error: { message: 'err2' } })
  assert.equal(breaker.isLocked(agentA), true)
  assert.equal(brakeEvent?.project, 'projA')

  // 等 afterSettle 挂上 delayed notify handle
  await new Promise(r => setTimeout(r, 20))

  // B-10a：另一个未锁定会话发 "100个文件" / "3个按钮" / "2. 方案修改" 绝不被劫持！
  for (const natural of ['100个文件需要检查', '3个按钮改蓝色', '2. 方案修改建议', '1 这不是重试']) {
    let nextCalled = false
    const decision = await breaker.preStep(
      { agent: agentB, messages: [{ content: natural }] },
      async () => { nextCalled = true; return { kind: 'continue' } },
    )
    assert.equal(nextCalled, true, `自然语句 "${natural}" 不应被熔断器劫持`)
    assert.equal(decision.kind, 'continue')
  }
  assert.equal(breaker.isLocked(agentA), true)

  // B-10b & B-10c：桌面锁定会话输入 "3 不要读文件直接汇总" → 解锁、取消延迟告警、剥离前缀 "3 " 后投递！
  const res = await breaker.preStep(
    { agent: agentA, messages: [{ id: 'm1', content: '3 不要读文件直接汇总' }] },
    async () => ({ kind: 'continue' }),
  )
  assert.equal(res.kind, 'reject')
  assert.equal(breaker.isLocked(agentA), false)
  assert.equal(cancelledAlert, true)
  assert.equal(unlockedEvent?.project, 'projA')
  assert.deepEqual(forwarded, ['不要读文件直接汇总'])

  breaker.dispose()
})

test('B-09: team-sse tracks all team members until every member reaches terminal state & detects error.cause.code', () => {
  const completed = []
  const alerts = []
  const watcher = createTeamWatcher({
    getConfig: () => ({ team: { enabled: true } }),
    onAlert: p => alerts.push(p),
    onComplete: p => completed.push(p),
  })

  watcher.handleFrame('member.status', JSON.stringify({ type: 'member.status', teamId: 't1', memberId: 'm1', status: 'running' }))
  watcher.handleFrame('member.status', JSON.stringify({ type: 'member.status', teamId: 't1', memberId: 'm2', status: 'running' }))
  watcher.handleFrame('member.status', JSON.stringify({ type: 'member.status', teamId: 't1', memberId: 'm1', status: 'done' }))
  // m2 仍在运行，绝不能误触发全队完成！
  assert.equal(completed.length, 0)

  watcher.handleFrame('member.status', JSON.stringify({ type: 'member.status', teamId: 't1', memberId: 'm2', status: 'done' }))
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0].memberIds.sort(), ['m1', 'm2'])

  // error.cause.code 检测
  const wrappedErr = new TypeError('fetch failed', { cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }) })
  assert.equal(isConnectionRefusedError(wrappedErr), true)

  // CRLF SSE 帧解析含 id
  const frame = parseSseFrame('id: 42\r\nevent: scope.request\r\ndata: {"reason":"need write"}')
  assert.equal(frame.id, '42')
  assert.equal(frame.event, 'scope.request')
})

test('B-08: smtp-client parses multi-line EHLO, falls back to AUTH LOGIN, and prevents CRLF injection', async () => {
  assert.throws(() => sanitizeSmtpAddress('a@b.com\r\nRCPT TO:<evil@x.com>'))
  const mime = buildMimeMessage({
    fromName: 'Flow\r\nBcc: evil@x.com',
    from: 'bot@example.com',
    to: 'user@example.com',
    subject: 'Hi\r\nInjected: yes',
    text: 'hello',
  })
  assert.ok(!mime.includes('\r\nBcc:'))
  assert.ok(!mime.includes('\r\nInjected:'))

  // 本地模拟 SMTP 服务器：多行 250- EHLO + 仅支持 AUTH LOGIN
  const commands = []
  let stage = 'greeting'
  const server = createServer((socket) => {
    socket.write('220 mock.smtp ESMTP\r\n')
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\r\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (stage === 'data') {
          if (line === '.') {
            stage = 'after-data'
            socket.write('250 OK queued\r\n')
          }
          continue
        }
        commands.push(line)
        if (line.startsWith('EHLO')) {
          socket.write('250-mock.smtp\r\n250-SIZE 10485760\r\n250 AUTH LOGIN\r\n')
        } else if (line === 'AUTH LOGIN') {
          stage = 'user'
          socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (stage === 'user') {
          stage = 'pass'
          socket.write('334 UGFzc3dvcmQ6\r\n')
        } else if (stage === 'pass') {
          stage = 'mail'
          socket.write('235 Auth ok\r\n')
        } else if (line.startsWith('MAIL FROM:')) {
          socket.write('250 OK\r\n')
        } else if (line.startsWith('RCPT TO:')) {
          socket.write('250 OK\r\n')
        } else if (line === 'DATA') {
          stage = 'data'
          socket.write('354 End with .\r\n')
        } else if (line === 'QUIT') {
          socket.write('221 Bye\r\n')
          socket.end()
        }
      }
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await sendMailWithBuiltin({
      host: '127.0.0.1',
      port,
      security: 'plain',
      user: 'bot@example.com',
      pass: 'secret123',
      from: 'bot@example.com',
      to: 'user@example.com',
      subject: 'Test',
      text: 'Body',
    })
    assert.equal(result.ok, true)
    assert.ok(commands.includes('AUTH LOGIN'))
    assert.ok(!commands.some(c => c.startsWith('AUTH PLAIN')))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('M-11: notifier re-checks desktop activity when delayed timer fires', async () => {
  let idleMs = 10
  let sentCount = 0
  const notifier = createNotifier({
    getConfig: () => ({ circuit: { idleSeconds: 0.05 }, notify: { gate: 'im-first' } }),
    activity: { idleMsOf: () => idleMs },
    im: { send: async () => { sentCount += 1; return { ok: true, via: 'mock' } } },
    email: { send: async () => ({ ok: true }) },
  })
  const handle = notifier.schedule('gate', { title: 't', project: 'p', markdown: 'm', session: { id: 's1' } })
  // Node 22 的 test runner 在仅剩 unref() 定时器时会提前判定事件循环空闲并中止未决 Promise，因此测试期间持有一个短周期 keepalive。
  const keepAlive = setInterval(() => {}, 25)
  try {
    // 模拟用户一直处于活跃状态（每次触发重查 idleMs 仍 < 50ms），超过 3 轮顺延应抑制不发
    const result = await handle.done
    assert.equal(result.suppressed, 'user-active')
    assert.equal(sentCount, 0)
  } finally {
    clearInterval(keepAlive)
    notifier.dispose()
  }
})
