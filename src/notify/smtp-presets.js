/**
 * SMTP 服务商预设：把「选一个服务商」翻译成真实的 host / port / security。
 *
 * @module dsh-flow/notify/smtp-presets
 */
import { SMTP_PROVIDERS } from '../config/constants.js'

/** 预设表：`host` 为 null 表示按账号后缀推导。 */
export const SMTP_PRESETS = Object.freeze({
  qq: { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, security: 'ssl' },
  netease: { label: '网易邮箱', host: null, port: 465, security: 'ssl' },
  gmail: { label: 'Google Gmail', host: 'smtp.gmail.com', port: 465, security: 'ssl' },
  custom: { label: '自定义 SMTP', host: null, port: 465, security: 'ssl' },
})

const NETEASE_HOSTS = Object.freeze([
  ['@126.com', 'smtp.126.com'],
  ['@yeah.net', 'smtp.yeah.net'],
])

/** 从账号推断网易主机。 */
export function neteaseHostOf(account) {
  const value = typeof account === 'string' ? account.trim().toLowerCase() : ''
  for (const [suffix, host] of NETEASE_HOSTS) {
    if (value.endsWith(suffix)) return host
  }
  return 'smtp.163.com'
}

/** 归一化服务商 id。 */
export function normalizeProvider(value) {
  return typeof value === 'string' && SMTP_PROVIDERS.includes(value) ? value : 'qq'
}

/** 解析出实际可用的 SMTP 连接参数。 */
export function resolveSmtp(settings) {
  const provider = normalizeProvider(settings?.provider)
  const preset = SMTP_PRESETS[provider]
  const account = typeof settings?.account === 'string' ? settings.account.trim() : ''

  let host
  if (provider === 'custom') {
    host = typeof settings?.host === 'string' ? settings.host.trim() : ''
  } else if (preset.host !== null) {
    host = preset.host
  } else {
    host = neteaseHostOf(account)
  }
  if (host === '') return null

  let port = preset.port
  if (provider === 'custom') {
    const raw = Number(settings?.port)
    port = Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 465
  }

  const security = provider === 'custom'
    ? (settings?.security === 'starttls' ? 'starttls' : 'ssl')
    : preset.security

  return { host, port, security, provider }
}

/** 设置页用：判断哪些字段应展示。 */
export function presetVisibility(provider) {
  const custom = normalizeProvider(provider) === 'custom'
  return { advanced: custom, host: custom, port: custom, security: custom }
}
