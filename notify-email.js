/**
 * 邮箱通知渠道。
 *
 * 两条通路：
 * - **首选 `nodemailer`**：它只装在 profile 的 node_modules 里，而本插件是软链目录，
 *   裸 import 会按 realpath 落到工作区并 MISS（S1 教训）。所以用
 *   `createRequire(<profileRoot>/package.json)` 显式从 profile 解析。
 * - **兜底内置 `smtp-client.js`**：零依赖实现，覆盖 465/587/明文 + 附件。
 *
 * 主题强制带状态标签：`[dsh-flow][熔断告警] 项目名`。
 * 附件单件上限由配置控制（默认 2 MB），超限降级为"截断说明"文本附件。
 *
 * @module dsh-flow/notify-email
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveSmtp } from './smtp-presets.js'
import { sendMailWithBuiltin } from './smtp-client.js'
import { readSpecFile } from './spec-anchor.js'
import { NOTIFY_SUBJECT_TAG } from './modes.js'

/** 默认附件上限：2 MB。 */
const DEFAULT_ATTACH_LIMIT = 2 * 1024 * 1024

/** 收集可能的 profile 根目录，按可信度排序。 */
function profileRoots() {
  const roots = []
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
    ? process.env.DSH_PROFILE
    : 'web'
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    roots.push(join(process.env.DSH_HOME, 'profiles', profile))
    roots.push(join(process.env.DSH_HOME, profile))
  }
  roots.push(join(homedir(), '.dsh', 'profiles', profile))
  if (profile !== 'web') roots.push(join(homedir(), '.dsh', 'profiles', 'web'))
  return roots
}

/**
 * 创建邮箱渠道。
 *
 * @param {{
 *   getConfig: () => object,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createEmailChannel({ getConfig, logger }) {
  /** 已解析的 transport：`{ kind:'nodemailer', mod } | { kind:'builtin' }`。 */
  let transport

  /** 只解析一次，失败也缓存（避免每封邮件都重试解析）。 */
  function loadTransport() {
    if (transport !== undefined) return transport
    for (const root of profileRoots()) {
      try {
        if (!existsSync(join(root, 'package.json'))) continue
        const requireFromProfile = createRequire(join(root, 'package.json'))
        const mod = requireFromProfile('nodemailer')
        if (mod !== null && typeof mod === 'object' && typeof mod.createTransport === 'function') {
          transport = { kind: 'nodemailer', mod, resolvedFrom: root }
          logger?.info?.(`flow: 邮件使用 nodemailer（解析自 ${root}）`)
          return transport
        }
      } catch { /* 该根目录没有 nodemailer，继续下一个 */ }
    }
    transport = { kind: 'builtin' }
    logger?.info?.('flow: 邮件使用内置 SMTP 客户端（未解析到 nodemailer）')
    return transport
  }

  /** 当前邮箱配置（含默认值兜底）。 */
  function settings() {
    const email = getConfig()?.email ?? {}
    const account = typeof email.account === 'string' ? email.account.trim() : ''
    const to = typeof email.to === 'string' && email.to.trim() !== '' ? email.to.trim() : account
    return {
      enabled: email.enabled === true,
      provider: email.provider,
      fromName: typeof email.fromName === 'string' && email.fromName.trim() !== '' ? email.fromName.trim() : 'dsh-flow',
      account,
      secret: typeof email.secret === 'string' ? email.secret : '',
      to,
      host: email.host,
      port: email.port,
      security: email.security,
      attachLimitBytes: Number.isFinite(email.attachLimitBytes) && email.attachLimitBytes > 0
        ? Math.floor(email.attachLimitBytes)
        : DEFAULT_ATTACH_LIMIT,
    }
  }

  /**
   * 投递一封邮件。
   *
   * @param {{ event: string, project: string, text: string, attachments?: object[] }} input
   * @returns {Promise<{ ok: boolean, via: string, reason?: string }>}
   */
  async function send({ event, project, text, attachments }) {
    const email = settings()
    if (!email.enabled) return { ok: false, via: 'email', reason: '邮箱渠道已在设置中关闭' }
    if (email.account === '' || email.to === '') {
      return { ok: false, via: 'email', reason: '未填写邮箱账号 / 收件人' }
    }
    if (email.secret === '') return { ok: false, via: 'email', reason: '未填写授权码' }

    const smtp = resolveSmtp(email)
    if (smtp === null) return { ok: false, via: 'email', reason: 'SMTP 主机无法确定（自定义模式需填 host）' }

    const tag = NOTIFY_SUBJECT_TAG[event] ?? '通知'
    const subject = `[dsh-flow][${tag}] ${project}`
    const picked = attachments ?? []
    const { accepted, notes } = enforceLimit(picked, email.attachLimitBytes)
    const body = notes.length === 0 ? text : `${text}\n\n---\n${notes.join('\n')}`

    const resolved = loadTransport()
    if (resolved.kind === 'nodemailer') {
      try {
        const transporter = resolved.mod.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.security === 'ssl',
          auth: { user: email.account, pass: email.secret },
          ...(smtp.security === 'ssl' ? {} : { requireTLS: true }),
        })
        await transporter.sendMail({
          from: `"${email.fromName}" <${email.account}>`,
          to: email.to,
          subject,
          text: body,
          attachments: accepted.map(item => ({ filename: item.filename, content: item.content, contentType: item.contentType })),
        })
        return { ok: true, via: 'nodemailer' }
      } catch (error) {
        logger?.warn?.(`flow: nodemailer 投递失败 → ${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, via: 'nodemailer', reason: error instanceof Error ? error.message : String(error) }
      }
    }

    try {
      await sendMailWithBuiltin({
        host: smtp.host,
        port: smtp.port,
        security: smtp.security,
        user: email.account,
        pass: email.secret,
        fromName: email.fromName,
        from: email.account,
        to: email.to,
        subject,
        text: body,
        attachments: accepted,
      })
      return { ok: true, via: 'builtin' }
    } catch (error) {
      logger?.warn?.(`flow: 内置 SMTP 投递失败 → ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, via: 'builtin', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 设置页「发送测试邮件」：不依赖活跃会话。
   * @returns {Promise<{ ok: boolean, via: string, detail: string }>}
   */
  async function test() {
    const email = settings()
    const resolved = loadTransport()
    const smtp = resolveSmtp(email)
    const route = smtp === null ? '未知主机' : `${smtp.host}:${smtp.port} (${smtp.security})`
    const result = await send({
      event: 'gate',
      project: 'dsh-flow 测试',
      text: [
        '这是 dsh-flow 的测试邮件。',
        '',
        `- 时间：${new Date().toISOString()}`,
        `- 服务商：${email.provider ?? 'qq'}`,
        `- 路由：${route}`,
        `- 通路：${resolved.kind}`,
        `- 发件人：${email.fromName} <${email.account || '未配置'}>`,
        `- 收件人：${email.to || '未配置'}`,
      ].join('\n'),
    })
    return {
      ok: result.ok,
      via: result.via,
      detail: result.ok
        ? `已通过 ${result.via} 发送（${route}）`
        : `发送失败：${result.reason ?? '未知原因'}（通路 ${resolved.kind}，路由 ${route}）`,
    }
  }

  /** 预览当前会用的 transport 名称，供设置页展示。 */
  function transportName() {
    return loadTransport().kind
  }

  return { send, test, transportName, settings }
}

/**
 * 按体积上限筛选附件：超限的替换成说明文本，不静默丢弃。
 * @param {{ filename: string, content: Buffer, contentType?: string }[]} attachments
 * @param {number} limit
 */
export function enforceLimit(attachments, limit) {
  const accepted = []
  const notes = []
  for (const item of attachments) {
    const size = Buffer.isBuffer(item.content) ? item.content.length : 0
    if (size <= limit) {
      accepted.push(item)
      continue
    }
    const notice = `附件 ${item.filename} 超过 ${(limit / (1024 * 1024)).toFixed(1)} MB 上限（实际 ${(size / 1024).toFixed(1)} KB），已跳过。`
    notes.push(notice)
    accepted.push({
      filename: `${item.filename}.truncated.txt`,
      content: Buffer.from(`${notice}\n\n（原文件未随信发送，请到工作区查看。）`, 'utf8'),
      contentType: 'text/plain; charset=UTF-8',
    })
  }
  return { accepted, notes }
}

/**
 * 按事件挑选附件。
 *
 * @param {{ event: string, config: object, agent?: object, errorContext?: string, teamReport?: string }} input
 * @returns {{ filename: string, content: Buffer, contentType?: string }[]}
 */
export function collectAttachments({ event, config, agent, errorContext, teamReport }) {
  const out = []

  if (event === 'brake' && typeof errorContext === 'string' && errorContext !== '') {
    out.push({
      filename: 'error-context.txt',
      content: Buffer.from(errorContext, 'utf8'),
      contentType: 'text/plain; charset=UTF-8',
    })
  }

  if (typeof teamReport === 'string' && teamReport !== '') {
    out.push({
      filename: 'team-report.md',
      content: Buffer.from(teamReport, 'utf8'),
      contentType: 'text/markdown; charset=UTF-8',
    })
  }

  if (event === 'archive' && agent !== undefined) {
    const spec = readSpecFile(config, agent)
    if (spec.exists) {
      out.push({
        filename: 'spec.md',
        content: Buffer.from(spec.text, 'utf8'),
        contentType: 'text/markdown; charset=UTF-8',
      })
    }
  }

  return out
}
