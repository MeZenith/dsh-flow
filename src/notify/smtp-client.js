/**
 * 零依赖 ESM SMTP 客户端（备用通路）。
 *
 * v0.6.0 修复（B-08）：
 * - 完整累积多行 `250-` EHLO 响应，正确识别 `STARTTLS` / `AUTH PLAIN` / `AUTH LOGIN`；
 * - 规范实现 `AUTH PLAIN` 与 `AUTH LOGIN` 回退（不再把 PLAIN 的 334 错当 LOGIN 流程）；
 * - 对地址与 MIME 头部剥离 `\r\n` 控制字符，防止 SMTP 命令/头部注入；
 * - 为 `openSocket` 增加连接超时，防止握手挂死。
 *
 * @module dsh-flow/notify/smtp-client
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const MAX_RESPONSE_BYTES = 64 * 1024
const SESSION_TIMEOUT_MS = 30_000

/** 去掉回车换行和控制字符，防头部与命令注入。 */
export function sanitizeHeaderField(value) {
  return String(value ?? '').replace(/[\r\n\0]+/g, ' ').trim()
}

/** 清理 SMTP 邮箱地址（禁止空白、尖括号、控制字符）。 */
export function sanitizeSmtpAddress(value) {
  const clean = sanitizeHeaderField(value).replace(/[<>]/g, '').trim()
  if (clean === '' || /\s/.test(clean) || !clean.includes('@')) {
    throw new Error(`非法邮箱地址：${clean || '(空)'}`)
  }
  return clean
}

function base64Lines(buffer) {
  const encoded = buffer.toString('base64')
  const lines = []
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76))
  }
  return lines.join('\r\n')
}

/** RFC 2047 编码一个头部值：纯 ASCII 原样，否则用 B 编码。 */
export function encodeHeaderValue(text) {
  const value = sanitizeHeaderField(text)
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** RFC 2231 的文件名参数（UTF-8 百分号编码）。 */
export function encodeFilenameParam(filename) {
  return `UTF-8''${encodeURIComponent(sanitizeHeaderField(filename || 'attachment'))}`
}

/** 组装整封邮件（含附件）。 */
export function buildMimeMessage(message) {
  const from = sanitizeSmtpAddress(message.from)
  const to = sanitizeSmtpAddress(message.to)
  const fromName = sanitizeHeaderField(message.fromName)
  const fromHeader = fromName === ''
    ? from
    : `${encodeHeaderValue(fromName)} <${from}>`
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const lines = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ]

  if (attachments.length === 0) {
    lines.push(
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(message.text ?? '', 'utf8')),
    )
    return `${lines.join('\r\n')}\r\n`
  }

  const boundary = `----dsh-flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  lines.push(
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(message.text ?? '', 'utf8')),
  )

  for (const attachment of attachments) {
    const filename = sanitizeHeaderField(attachment.filename ?? 'attachment') || 'attachment'
    const contentType = sanitizeHeaderField(attachment.contentType ?? 'application/octet-stream') || 'application/octet-stream'
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    lines.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${ascii}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${ascii}"; filename*=${encodeFilenameParam(filename)}`,
      '',
      base64Lines(Buffer.from(attachment.content ?? Buffer.alloc(0))),
    )
  }

  lines.push(`--${boundary}--`)
  return `${lines.join('\r\n')}\r\n`
}

function dotStuff(payload) {
  return payload.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..')
}

/** 极简 SMTP 会话（支持完整多行响应累积）。 */
class SmtpSession {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.multiLines = []
    this.pending = null
    this.closed = false
    this.attach(socket)
  }

  attach(socket) {
    this.socket = socket
    socket.setTimeout(SESSION_TIMEOUT_MS)
    socket.on('data', chunk => this.onData(chunk))
    socket.on('timeout', () => this.fail(new Error('SMTP 连接超时')))
    socket.on('error', error => this.fail(error))
    socket.on('close', () => {
      this.closed = true
      this.fail(new Error('SMTP 连接已关闭'))
    })
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8')
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      this.fail(new Error('SMTP 响应超长'))
      return
    }
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!/^\d{3}/.test(line)) continue
      const text = line.slice(4)
      if (line[3] === '-') {
        this.multiLines.push(text)
        continue
      }
      const allLines = [...this.multiLines, text]
      this.multiLines = []
      const waiter = this.pending
      this.pending = null
      waiter?.resolve({
        code: Number(line.slice(0, 3)),
        text,
        lines: allLines,
      })
    }
  }

  fail(error) {
    const waiter = this.pending
    this.pending = null
    waiter?.reject(error)
  }

  expect(codes) {
    const list = Array.isArray(codes) ? codes : [codes]
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('SMTP 连接已关闭'))
        return
      }
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        this.pending = null
        finish(reject, new Error('SMTP 响应超时'))
      }, SESSION_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending = {
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      }
    }).then((response) => {
      if (!list.includes(response.code)) {
        throw new Error(`SMTP 返回 ${response.code}：${response.text}`)
      }
      return response
    })
  }

  write(payload) {
    this.socket.write(payload)
  }

  destroy() {
    try {
      this.socket.destroy()
    } catch { /* 已关闭 */ }
  }
}

/** 打开一个 socket（TLS 或明文），带连接超时保护。 */
function openSocket(host, port, security, timeoutMs = SESSION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = security === 'ssl'
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port })
    const event = security === 'ssl' ? 'secureConnect' : 'connect'
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('error', onError)
      socket.off(event, onReady)
    }
    const onError = (error) => {
      if (settled) return
      settled = true
      cleanup()
      try { socket.destroy() } catch { /* 忽略 */ }
      reject(error)
    }
    const onReady = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }
    const timer = setTimeout(() => {
      onError(new Error(`SMTP 连接超时（${host}:${port}）`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    socket.once('error', onError)
    socket.once(event, onReady)
  })
}

/** 发送 EHLO 并返回所有能力行的大写合并文本。 */
async function ehlo(session) {
  session.write('EHLO dsh-flow.local\r\n')
  const response = await session.expect(250)
  return response.lines.join('\n').toUpperCase()
}

/** 在既有连接上发起 TLS 升级。 */
async function starttls(session, host) {
  session.write('STARTTLS\r\n')
  await session.expect(220)
  const rawSocket = session.socket
  rawSocket.removeAllListeners()
  const upgraded = await new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: rawSocket, servername: host })
    const timer = setTimeout(() => {
      try { socket.destroy() } catch { /* 忽略 */ }
      reject(new Error('SMTP STARTTLS 升级超时'))
    }, SESSION_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
  session.buffer = ''
  session.multiLines = []
  session.attach(upgraded)
}

/** 执行 AUTH LOGIN。 */
async function authLogin(session, user, pass) {
  session.write('AUTH LOGIN\r\n')
  await session.expect(334)
  session.write(`${Buffer.from(user, 'utf8').toString('base64')}\r\n`)
  await session.expect(334)
  session.write(`${Buffer.from(pass, 'utf8').toString('base64')}\r\n`)
  await session.expect(235)
}

/** 执行认证：按服务器声明的 AUTH 机制选择 PLAIN 或 LOGIN，PLAIN 不支持时自动回退 LOGIN。 */
async function authenticate(session, capabilities, user, pass) {
  const authLine = capabilities.split('\n').find(line => /^AUTH[\s=]/.test(line)) ?? ''
  const supportsPlain = /\bPLAIN\b/.test(authLine)
  const supportsLogin = /\bLOGIN\b/.test(authLine)

  if (!supportsPlain && supportsLogin) {
    await authLogin(session, user, pass)
    return
  }

  const plain = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
  session.write(`AUTH PLAIN ${plain}\r\n`)
  const response = await session.expect([235, 334, 502, 504])
  if (response.code === 235) return
  if (response.code === 334) {
    // 某些服务器忽略初始响应，需要第二行再发送 PLAIN token。
    session.write(`${plain}\r\n`)
    await session.expect(235)
    return
  }
  // 502 / 504 表示服务器不支持 AUTH PLAIN，回退到 AUTH LOGIN。
  await authLogin(session, user, pass)
}

/** 投递一封邮件（内置通路）。 */
export async function sendMailWithBuiltin(options) {
  const from = sanitizeSmtpAddress(options.from)
  const to = sanitizeSmtpAddress(options.to)
  const socket = await openSocket(options.host, options.port, options.security)
  const session = new SmtpSession(socket)
  try {
    await session.expect(220)

    let capabilities = await ehlo(session)
    if (options.security === 'starttls') {
      if (!capabilities.includes('STARTTLS')) throw new Error('服务器未声明 STARTTLS 支持')
      await starttls(session, options.host)
      capabilities = await ehlo(session)
    }

    if (typeof options.user === 'string' && options.user !== '') {
      await authenticate(session, capabilities, options.user, String(options.pass ?? ''))
    }

    session.write(`MAIL FROM:<${from}>\r\n`)
    await session.expect(250)
    session.write(`RCPT TO:<${to}>\r\n`)
    await session.expect([250, 251])
    session.write('DATA\r\n')
    await session.expect(354)

    const message = buildMimeMessage({
      fromName: options.fromName,
      from,
      to,
      subject: options.subject,
      text: options.text,
      attachments: options.attachments,
    })
    session.write(`${dotStuff(message)}\r\n.\r\n`)
    await session.expect(250)

    session.write('QUIT\r\n')
    try { await session.expect(221) } catch { /* 部分服务器不回 221 直接关连接 */ }
    try { session.socket.end() } catch { /* 已关闭 */ }
    return { ok: true, transport: 'builtin', host: options.host, port: options.port }
  } finally {
    session.destroy()
  }
}
