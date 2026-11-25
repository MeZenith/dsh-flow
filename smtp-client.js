/**
 * 零依赖 ESM SMTP 客户端（备用通路）。
 *
 * 为什么需要它：`nodemailer` 只存在于 profile 的 node_modules 里，而本插件是
 * 软链目录 —— Node 按 realpath 解析会落到工作区，裸 import 直接 MISS（S1 踩过）。
 * 主通路仍是 `nodemailer`（通过 `createRequire(profileRoot)` 加载），
 * 这个文件只作为解析失败或版本异常时的兜底，保证通知链路不断。
 *
 * 支持：隐式 TLS（465）/ STARTTLS（587）/ 明文；AUTH PLAIN、AUTH LOGIN；
 * `multipart/mixed` + base64 附件；RFC 2047 UTF-8 显示名与 RFC 2231 文件名；
 * 点填充（dot-stuffing）与 CRLF 规范化。
 *
 * @module dsh-flow/smtp-client
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** 单行响应读取上限，防止异常服务器把内存撑爆。 */
const MAX_RESPONSE_BYTES = 64 * 1024

/** SMTP 会话超时。 */
const SESSION_TIMEOUT_MS = 30_000

/** 逐行折行的 base64。 */
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
  const value = String(text ?? '')
  // eslint-disable-next-line no-control-regex -- 头部里出现控制字符必须编码
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** RFC 2231 的文件名参数（UTF-8 百分号编码）。 */
export function encodeFilenameParam(filename) {
  return `UTF-8''${encodeURIComponent(String(filename ?? 'attachment'))}`
}

/**
 * 组装整封邮件（含附件）。
 *
 * @param {{
 *   fromName?: string, from: string, to: string, subject: string,
 *   text: string, attachments?: { filename: string, content: Buffer, contentType?: string }[],
 * }} message
 * @returns {string} 已就绪、可直接 DATA 发送的报文。
 */
export function buildMimeMessage(message) {
  const fromName = typeof message.fromName === 'string' ? message.fromName.trim() : ''
  const fromHeader = fromName === ''
    ? message.from
    : `${encodeHeaderValue(fromName)} <${message.from}>`
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const lines = [
    `From: ${fromHeader}`,
    `To: ${message.to}`,
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
    const filename = String(attachment.filename ?? 'attachment')
    const contentType = attachment.contentType ?? 'application/octet-stream'
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

/** 点填充：行首单独的点要写成两个点。 */
function dotStuff(payload) {
  return payload.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..')
}

/**
 * 一个极简 SMTP 会话：只覆盖"建立连接 → EHLO → 可选 STARTTLS → AUTH → 投递一封"。
 */
class SmtpSession {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.pending = null
    this.closed = false
    this.attach(socket)
  }

  attach(socket) {
    this.socket = socket
    socket.setTimeout(SESSION_TIMEOUT_MS)
    socket.on('data', chunk => this.onData(chunk))
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
    const lines = this.buffer.split('\r\n')
    // 末尾可能是半行，留到下一次
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!/^\d{3}/.test(line)) continue
      // `250-` 表示还有后续行，`250 ` 才是结束
      if (line[3] === '-') continue
      const waiter = this.pending
      this.pending = null
      waiter?.resolve({ code: Number(line.slice(0, 3)), text: line.slice(4) })
    }
  }

  fail(error) {
    const waiter = this.pending
    this.pending = null
    waiter?.reject(error)
  }

  /** 等待一条以空格分隔的完整响应；超时或状态码不符即拒绝。 */
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

/** 打开一个 socket（TLS 或明文）。 */
function openSocket(host, port, security) {
  return new Promise((resolve, reject) => {
    const socket = security === 'ssl'
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port })
    const onError = (error) => {
      socket.off(security === 'ssl' ? 'secureConnect' : 'connect', onReady)
      reject(error)
    }
    const onReady = () => {
      socket.off('error', onError)
      resolve(socket)
    }
    socket.once('error', onError)
    socket.once(security === 'ssl' ? 'secureConnect' : 'connect', onReady)
  })
}

/**
 * 投递一封邮件（内置通路）。
 *
 * @param {{
 *   host: string, port: number, security: 'ssl' | 'starttls',
 *   user: string, pass: string,
 *   fromName?: string, from: string, to: string, subject: string,
 *   text: string, attachments?: object[],
 * }} options
 * @returns {Promise<{ ok: true, transport: 'builtin', host: string, port: number }>}
 */
export async function sendMailWithBuiltin(options) {
  let socket = await openSocket(options.host, options.port, options.security)
  const session = new SmtpSession(socket)
  try {
    await session.expect(220)

    let capabilities = await ehlo(session)
    if (options.security === 'starttls') {
      if (!capabilities.includes('STARTTLS')) throw new Error('服务器未声明 STARTTLS 支持')
      await starttls(session, options.host)
      capabilities = await ehlo(session)
    }

    if (options.user !== '') {
      const plain = Buffer.from(`\0${options.user}\0${options.pass}`, 'utf8').toString('base64')
      session.write(`AUTH PLAIN ${plain}\r\n`)
      const response = await session.expect([235, 334])
      if (response.code === 334) {
        // 回退 AUTH LOGIN
        session.write(`${Buffer.from(options.user, 'utf8').toString('base64')}\r\n`)
        await session.expect(334)
        session.write(`${Buffer.from(options.pass, 'utf8').toString('base64')}\r\n`)
        await session.expect(235)
      }
    }

    session.write(`MAIL FROM:<${options.from}>\r\n`)
    await session.expect(250)
    session.write(`RCPT TO:<${options.to}>\r\n`)
    await session.expect([250, 251])
    session.write('DATA\r\n')
    await session.expect(354)

    const message = buildMimeMessage({
      fromName: options.fromName,
      from: options.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      attachments: options.attachments,
    })
    session.write(`${dotStuff(message)}\r\n.\r\n`)
    await session.expect(250)

    session.write('QUIT\r\n')
    return { ok: true, transport: 'builtin', host: options.host, port: options.port }
  } finally {
    session.destroy()
  }
}

/** 发送 EHLO 并返回大写能力列表。 */
async function ehlo(session) {
  const host = 'dsh-flow.local'
  session.write(`EHLO ${host}\r\n`)
  const response = await session.expect(250)
  return String(response.text ?? '').toUpperCase()
}

/** 在既有连接上发起 TLS 升级。 */
async function starttls(session, host) {
  session.write('STARTTLS\r\n')
  await session.expect(220)
  const upgraded = await new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: session.socket, servername: host })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', reject)
  })
  // 旧 socket 的监听要整体摘掉，避免升级后误解帧
  session.socket.removeAllListeners()
  session.attach(upgraded)
}
