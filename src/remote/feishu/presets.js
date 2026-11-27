/**
 * 飞书机器人身份预设：自定义名称、简介、内置公开头像候选与开放平台直达链接。
 *
 * 关键事实：
 * - 飞书扫码建应用 `lark.registerApp({ appPreset: { name, description, avatar } })`
 *   支持在创建前传入机器人名称、简介与 1–6 张公开 `http/https` 头像 URL；
 * - 应用创建完成后，飞书开放平台不提供静默改名/改头像的 OpenAPI，因此设置页同时支持：
 *   1. 创建前直接自定义名称、简介与头像（内置图标库或自定义公网 URL）；
 *   2. 创建后自定义本地显示昵称/本地头像，并提供一键直达飞书开放平台应用详情页的链接。
 *
 * @module dsh-flow/remote/feishu/presets
 */

export const DEFAULT_BOT_NAME = 'Flow 指挥官'
export const DEFAULT_BOT_DESCRIPTION = 'DSH Flow 远程研发指挥官：多项目派活、门禁一键拍板、熔断秒级抢救与文档直发'

/** 内置公开头像候选（均为稳定公开 PNG 图标 URL，符合飞书 `appPreset.avatar` 公网 URL 要求）。 */
export const AVATAR_PRESETS = Object.freeze([
  {
    id: 'commander',
    label: '指挥官（默认）',
    url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f680.png',
    emoji: '🚀',
  },
  {
    id: 'robot',
    label: '智能助手',
    url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f916.png',
    emoji: '🤖',
  },
  {
    id: 'compass',
    label: '领航罗盘',
    url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f9ed.png',
    emoji: '🧭',
  },
  {
    id: 'lightning',
    label: '极速开发',
    url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/26a1.png',
    emoji: '⚡',
  },
  {
    id: 'shield',
    label: '质量守卫',
    url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f6e1.png',
    emoji: '🛡️',
  },
  {
    id: 'cat',
    label: '代码猫猫',
    url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f431.png',
    emoji: '🐱',
  },
])

/** 校验一个 URL 是否为合法的公开 http/https 图片地址。 */
export function isPublicHttpUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 1024) return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false
    return true
  } catch {
    return false
  }
}

/**
 * 校验并归一化头像 URL 列表（1–6 个公开 URL；支持传 preset id、单个 URL 或数组）。
 *
 * @param {string | string[] | undefined} input
 * @returns {{ ok: true, urls: string[] } | { ok: false, reason: string }}
 */
export function resolveAvatarUrls(input) {
  const rawList = Array.isArray(input) ? input : (typeof input === 'string' && input.trim() !== '' ? [input.trim()] : [])
  const out = []
  for (const raw of rawList) {
    const item = String(raw ?? '').trim()
    if (item === '') continue
    const preset = AVATAR_PRESETS.find(p => p.id === item)
    const candidate = preset ? preset.url : item
    if (!isPublicHttpUrl(candidate)) {
      return { ok: false, reason: `头像地址必须是公开可访问的 https:// 图片 URL（飞书扫码建应用不支持本地路径或 Base64）：${item.slice(0, 60)}` }
    }
    if (!out.includes(candidate)) out.push(candidate)
    if (out.length >= 6) break
  }
  if (out.length === 0) out.push(AVATAR_PRESETS[0].url)
  return { ok: true, urls: out }
}

/**
 * 组装传给 `lark.registerApp({ appPreset })` 的参数。
 *
 * 注：`@larksuiteoapi/node-sdk` 1.77+ 读取 `appPreset.desc`（不是 `description`）。
 *
 * @param {{ name?: string, description?: string, avatarUrl?: string | string[] }} input
 * @returns {{ ok: true, appPreset: { name: string, desc: string, avatar: string[] } } | { ok: false, reason: string }}
 */
export function buildAppPreset({ name, description, avatarUrl } = {}) {
  const cleanName = String(name ?? '').trim().slice(0, 32) || DEFAULT_BOT_NAME
  const cleanDesc = String(description ?? '').trim().slice(0, 120) || DEFAULT_BOT_DESCRIPTION
  const avatars = resolveAvatarUrls(avatarUrl)
  if (!avatars.ok) return avatars
  return {
    ok: true,
    appPreset: {
      name: cleanName,
      desc: cleanDesc,
      avatar: avatars.urls,
    },
  }
}

/** 飞书开放平台应用基本信息页直达链接（用于创建后继续调整图标/名称）。 */
export function openPlatformAppUrl(appId, domain = 'feishu') {
  const host = domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
  const id = String(appId ?? '').trim()
  return id === '' ? `https://${host}/app` : `https://${host}/app/${encodeURIComponent(id)}/baseinfo`
}
