import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectAttachments, createEmailChannel, enforceLimit } from '../../src/notify/email.js'
import { neteaseHostOf, normalizeProvider, presetVisibility, resolveSmtp } from '../../src/notify/smtp-presets.js'
import { createImChannel, webBaseCandidates } from '../../src/notify/im.js'

test('smtp-presets resolves qq, netease domains, gmail, custom ports, and visibility flags', () => {
  assert.equal(normalizeProvider('gmail'), 'gmail')
  assert.equal(normalizeProvider('bogus'), 'qq')

  assert.equal(neteaseHostOf('user@126.com'), 'smtp.126.com')
  assert.equal(neteaseHostOf('user@yeah.net'), 'smtp.yeah.net')
  assert.equal(neteaseHostOf('user@163.com'), 'smtp.163.com')

  assert.deepEqual(resolveSmtp({ provider: 'qq', account: 'a@qq.com' }), { host: 'smtp.qq.com', port: 465, security: 'ssl', provider: 'qq' })
  assert.deepEqual(resolveSmtp({ provider: 'netease', account: 'a@126.com' }), { host: 'smtp.126.com', port: 465, security: 'ssl', provider: 'netease' })
  assert.equal(resolveSmtp({ provider: 'custom', host: '' }), null)
  assert.deepEqual(resolveSmtp({ provider: 'custom', host: 'mail.example.com', port: 587, security: 'starttls' }), {
    host: 'mail.example.com',
    port: 587,
    security: 'starttls',
    provider: 'custom',
  })

  assert.equal(presetVisibility('qq').custom, undefined)
  assert.equal(presetVisibility('custom').host, true)
  assert.equal(presetVisibility('gmail').host, false)
})

test('email enforceLimit & collectAttachments respect size caps and collect expected artifacts', () => {
  const res = enforceLimit([
    { filename: 'small.md', content: Buffer.from('ok'), contentType: 'text/markdown' },
    { filename: 'big.md', content: Buffer.alloc(2048, 65), contentType: 'text/markdown' },
  ], 1024)
  assert.equal(res.accepted.length, 2)
  assert.equal(res.accepted[0].filename, 'small.md')
  assert.equal(res.accepted[1].filename, 'big.md.truncated.txt')
  assert.equal(res.notes.length, 1)

  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-mail-att-'))
  try {
    writeFileSync(join(root, 'spec.md'), '# Spec Anchor\n', 'utf8')
    const atts = collectAttachments({
      event: 'brake',
      config: { spec: { enabled: true, path: 'spec.md' } },
      agent: { session: { header: { cwd: root } } },
      errorContext: 'stack trace',
      teamReport: '# Team',
      drafts: [{ filename: '01-req.md', content: 'draft text' }, { content: Buffer.from('anon') }, { content: '' }],
    })
    assert.deepEqual(atts.map(a => a.filename), ['error-context.txt', 'team-report.md', '01-req.md', 'draft.md'])

    const archAtts = collectAttachments({
      event: 'archive',
      config: { spec: { enabled: true, path: 'spec.md' } },
      agent: { session: { header: { cwd: root } } },
    })
    assert.deepEqual(archAtts.map(a => a.filename), ['spec.md'])
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('email createEmailChannel handles validation failures, transportName & unreachable custom host', async () => {
  const cfg = {
    email: { enabled: false, provider: 'qq', account: '', secret: '', host: '' },
  }
  const ch = createEmailChannel({ getConfig: () => cfg, logger: { info() {}, warn() {} } })
  assert.ok(['builtin', 'nodemailer'].includes(ch.transportName()))
  assert.equal((await ch.send({ event: 'gate', project: 'p', text: 'hi' })).reason.includes('关闭'), true)

  cfg.email.enabled = true
  assert.equal((await ch.send({ event: 'gate', project: 'p', text: 'hi' })).reason.includes('账号'), true)

  cfg.email.account = 'a@qq.com'
  assert.equal((await ch.send({ event: 'gate', project: 'p', text: 'hi' })).reason.includes('授权码'), true)

  cfg.email.secret = 'pass'
  cfg.email.provider = 'custom'
  assert.equal((await ch.send({ event: 'gate', project: 'p', text: 'hi' })).reason.includes('SMTP 主机'), true)

  // Bound unused local port -> guaranteed immediate connection failure without touching external network
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const closedPort = server.address().port
  await new Promise(resolve => server.close(resolve))

  cfg.email.host = '127.0.0.1'
  cfg.email.port = closedPort
  cfg.email.security = 'starttls'
  const testRes = await ch.test()
  assert.equal(testRes.ok, false)
  assert.ok(['builtin', 'nodemailer'].includes(testRes.via))
  assert.ok(testRes.detail.includes('发送失败'))
})

test('im channel handles webBaseCandidates, feishu priority, skipFeishu, dshIm service, HTTP probe, and all 6 webhooks', async () => {
  const prevEnv = { url: process.env.DSH_WEB_URL, port: process.env.DSH_PORT, wp: process.env.DSH_WEB_PORT }
  process.env.DSH_WEB_URL = 'http://127.0.0.1:4100/'
  process.env.DSH_PORT = '4200'
  process.env.DSH_WEB_PORT = '4300'
  try {
    assert.deepEqual(webBaseCandidates(), ['http://127.0.0.1:4100', 'http://127.0.0.1:4200', 'http://127.0.0.1:4300', 'http://127.0.0.1:3080'])
  } finally {
    if (prevEnv.url === undefined) delete process.env.DSH_WEB_URL
    else process.env.DSH_WEB_URL = prevEnv.url
    if (prevEnv.port === undefined) delete process.env.DSH_PORT
    else process.env.DSH_PORT = prevEnv.port
    if (prevEnv.wp === undefined) delete process.env.DSH_WEB_PORT
    else process.env.DSH_WEB_PORT = prevEnv.wp
  }

  let feishuReady = true
  let feishuCalls = 0
  const dshImCalls = []
  const cfg = {
    im: {
      enabled: true,
      botId: 'b1',
      targetId: 't1',
      webhook: { enabled: true, url: 'https://hook.test/send', kind: 'feishu' },
    },
  }
  const dshImSvc = {
    listBots: async () => [{ botId: 'b1', channel: 'wechat' }],
    listTargets: async () => [{ targetId: 't1' }],
    send: async (b, t, text) => {
      dshImCalls.push({ b, t, text })
      return { sent: true }
    },
  }

  const im = createImChannel({
    ctx: { get: name => (name === 'dshIm' ? dshImSvc : undefined) },
    getConfig: () => cfg,
    getFeishu: () => ({
      isReady: () => feishuReady,
      sendNotification: async () => { feishuCalls += 1; return { ok: true } },
    }),
    logger: { warn() {} },
  })

  assert.equal((await im.listBots()).length, 1)
  assert.equal((await im.listTargets('b1')).length, 1)
  assert.deepEqual(await im.send({ title: 'T', markdown: 'M' }), { ok: true, via: 'feishu' })
  assert.equal(feishuCalls, 1)

  // skipFeishu bypasses direct Feishu -> hits dshIm
  assert.deepEqual(await im.send({ title: 'T', markdown: 'M', skipFeishu: true }), { ok: true, via: 'dshIm' })
  assert.equal(dshImCalls.length, 1)

  // Fall back to HTTP probe -> webhooks across all 6 formats
  feishuReady = false
  dshImSvc.send = async () => ({ sent: false })
  const origFetch = globalThis.fetch
  const hookPayloads = []
  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url)
      if (u.endsWith('/api/dsh-im/delivery/messages')) {
        if (init.method === 'GET') return new Response('', { status: 405 })
        return new Response(JSON.stringify({ sent: true }), { status: 200 })
      }
      hookPayloads.push(JSON.parse(init.body))
      return new Response('{}', { status: 200 })
    }
    const viaHttp = await im.send({ title: 'T', markdown: 'M' })
    assert.equal(viaHttp.ok, true)
    assert.equal(viaHttp.via, 'http')

    cfg.im.botId = ''
    for (const kind of ['feishu', 'dingtalk', 'wecom', 'bark', 'pushplus', 'custom']) {
      cfg.im.webhook.kind = kind
      const whRes = await im.send({ title: 'Title', markdown: 'Body' })
      assert.equal(whRes.via, 'webhook')
      assert.equal(whRes.ok, true)
    }
    assert.equal(hookPayloads.length, 6)

    cfg.im.webhook.enabled = false
    const testRes = await im.test()
    assert.equal(testRes.ok, false)
    assert.ok(testRes.detail.includes('发送失败'))
  } finally {
    globalThis.fetch = origFetch
  }
})
