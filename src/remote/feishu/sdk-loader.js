/**
 * `@larksuiteoapi/node-sdk` 惰性加载器与代理豁免工具。
 *
 * 设计红线：
 * - 插件根入口绝不顶层静态 `import '@larksuiteoapi/node-sdk'`，确保在未安装依赖的精简环境也能正常加载；
 * - 真正启用飞书或发起扫码建应用时再惰性解析（依次尝试 ESM import、插件目录 require、DSH profile 目录 require）；
 * - 提供测试注入钩子 `setFeishuSdkOverride`，单测零网络即可全链路验证。
 *
 * @module dsh-flow/remote/feishu/sdk-loader
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_PKG = fileURLToPath(new URL('../../../package.json', import.meta.url))

let sdkOverride
let cachedSdk

/** 供单测注入 mock SDK（传 undefined 清除）。 */
export function setFeishuSdkOverride(mock) {
  sdkOverride = mock
  cachedSdk = undefined
}

/** 将飞书开放平台与扫码建应用域名加入 `NO_PROXY`，避免本地代理劫持长连接或 OAuth 建应用请求。 */
export function ensureNoProxyForFeishu(domain = 'feishu') {
  if (typeof process === 'undefined' || !process.env) return
  const hosts = domain === 'lark'
    ? ['open.larksuite.com', 'accounts.larksuite.com']
    : ['open.feishu.cn', 'accounts.feishu.cn']
  const current = String(process.env.NO_PROXY ?? process.env.no_proxy ?? '')
  const parts = current.split(',').map(item => item.trim()).filter(Boolean)
  let changed = false
  for (const host of hosts) {
    if (!parts.some(item => item.toLowerCase() === host)) {
      parts.push(host)
      changed = true
    }
  }
  if (changed) {
    const next = parts.join(',')
    process.env.NO_PROXY = next
    process.env.no_proxy = next
  }
}

function candidatePkgPaths() {
  const list = [PLUGIN_PKG]
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
    ? process.env.DSH_PROFILE
    : 'web'
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    list.push(join(process.env.DSH_HOME, 'profiles', profile, 'package.json'))
  }
  list.push(join(homedir(), '.dsh', 'profiles', profile, 'package.json'))
  if (profile !== 'web') {
    list.push(join(homedir(), '.dsh', 'profiles', 'web', 'package.json'))
  }
  return list
}

/**
 * 惰性加载 `@larksuiteoapi/node-sdk`。
 *
 * @returns {Promise<{ ok: true, lark: any } | { ok: false, reason: string }>}
 */
export async function loadFeishuSdk() {
  if (sdkOverride !== undefined) return { ok: true, lark: sdkOverride }
  if (cachedSdk !== undefined) return { ok: true, lark: cachedSdk }

  try {
    const mod = await import('@larksuiteoapi/node-sdk')
    const lark = mod?.default?.Client ? mod.default : mod
    if (lark !== undefined && typeof lark.Client === 'function') {
      cachedSdk = lark
      return { ok: true, lark }
    }
  } catch { /* 继续走 createRequire 兜底 */ }

  for (const pkgPath of candidatePkgPaths()) {
    try {
      if (!existsSync(pkgPath)) continue
      const req = createRequire(pkgPath)
      const mod = req('@larksuiteoapi/node-sdk')
      const lark = mod?.default?.Client ? mod.default : mod
      if (lark !== undefined && typeof lark.Client === 'function') {
        cachedSdk = lark
        return { ok: true, lark }
      }
    } catch { /* 下一个候选路径 */ }
  }

  return {
    ok: false,
    reason: '未找到 @larksuiteoapi/node-sdk。请在插件目录执行 `npm install`（或重新通过 `dsh plugin add` 安装依赖）后再启用飞书直连。',
  }
}
