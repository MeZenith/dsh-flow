/**
 * 零依赖一键更新提示词。
 *
 * - 用 Node 原生 `fetch` 拉远端 `manifest.json` 与 `.md`，**不需要 git**。
 * - 每步都校验：manifest 结构、路径白名单（拒绝 `..` 穿越）、文件 sha256。
 * - 只下载变化的文件，先写 `*.tmp` 再原子替换；失败不动原文件。
 * - **绝不触碰 `prompts/custom/`**，也不改用户在设置页手改的配置值。
 * - 完成后回调让 `prompt-store` 失效缓存，无需重启即生效。
 *
 * @module dsh-flow/prompt-updater
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 官方默认源（raw.githubusercontent 的 prompts 目录）。 */
export const DEFAULT_SOURCE_URL = 'https://raw.githubusercontent.com/MeZenith/dsh-flow/main/prompts'

/**
 * 内置镜像源，按顺序兜底。
 *
 * 实测：部分网络环境下 `raw.githubusercontent.com` 与 `github.com` 都不可达，
 * 而 jsDelivr 的 GitHub CDN 通常可用。配置源失败后自动依次尝试这些镜像，
 * 只要有一个成功就继续，并在回执里说明实际用的是哪个源。
 */
export const MIRROR_SOURCES = Object.freeze([
  'https://cdn.jsdelivr.net/gh/MeZenith/dsh-flow@main/prompts',
  DEFAULT_SOURCE_URL,
])

/** 允许被远端覆盖的路径白名单。 */
const ALLOWED = [
  /^manifest\.json$/,
  /^base\.md$/,
  /^modes\/[a-z0-9-]+\.md$/,
  /^subagents\/README\.md$/,
  /^subagents\/[A-Za-z0-9._-]+\.md$/,
]

/** 单文件体积上限：提示词不该这么大，超了直接拒收。 */
const MAX_BYTES = 512 * 1024

/** 拉取超时（毫秒）。 */
const TIMEOUT_MS = 20_000

/** 路径是否在允许范围内（含穿越防护）。 */
export function isAllowedPath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\')) return false
  return ALLOWED.some(rule => rule.test(path))
}

/** 计算 UTF-8 字节的 sha256 小写十六进制。 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 规范化源地址：去掉尾部斜杠，缺协议时按 https 补。 */
export function normalizeSource(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return DEFAULT_SOURCE_URL
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * 源地址链：配置源优先；仅在允许镜像回退时追加内置镜像。
 *
 * @param {string} [configured] 用户配置的源。
 * @param {boolean} [allowMirror] 是否允许回退到镜像（默认允许）。
 * @returns {string[]}
 */
export function buildSourceChain(configured, allowMirror = true) {
  const first = normalizeSource(configured)
  if (allowMirror === false) return [first]
  const chain = [first]
  for (const mirror of MIRROR_SOURCES) {
    const normalized = normalizeSource(mirror)
    if (!chain.includes(normalized)) chain.push(normalized)
  }
  return chain
}

/** 把 fetch 异常归一成可读原因（超时 / 连接重置 / 解析失败 / HTTP 状态）。 */
export function describeFetchError(error) {
  const name = error?.name ?? ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AbortError' || name === 'TimeoutError') return '请求超时'
  if (/ECONNRESET|socket hang up|reset/i.test(message)) return '连接被重置'
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '域名解析失败'
  if (/HTTP \d+/.test(message)) return message
  return message
}

/** 带超时的 GET 文本。 */
async function fetchText(url, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-flow/prompt-updater' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_BYTES) throw new Error(`文件过大（${text.length} 字节）`)
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** 读本地文件，不存在返回 undefined。 */
function readLocal(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** 原子写：先写临时文件再 rename。 */
function writeAtomic(path, text) {
  const temp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* 临时文件可能已被清理 */ }
    throw error
  }
}

/**
 * 校验远端 manifest。
 *
 * @param {unknown} value 解析后的 JSON。
 * @returns {{ ok: true, files: Array<{ path: string, sha256: string }> } | { ok: false, reason: string }}
 */
export function validateManifest(value) {
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'manifest 不是对象' }
  const files = value.files
  if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: 'manifest.files 为空或不是数组' }
  const seen = new Set()
  const out = []
  for (const item of files) {
    if (item === null || typeof item !== 'object') return { ok: false, reason: 'files 条目不是对象' }
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    const digest = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : ''
    if (!isAllowedPath(path)) return { ok: false, reason: `路径不在白名单或含穿越：${path || '(空)'}` }
    if (!/^[a-f0-9]{64}$/.test(digest)) return { ok: false, reason: `sha256 非法：${path}` }
    if (seen.has(path)) return { ok: false, reason: `重复路径：${path}` }
    seen.add(path)
    out.push({ path, sha256: digest })
  }
  return { ok: true, files: out }
}

/**
 * 执行一次更新。
 *
 * @param {{
 *   sourceUrl?: string,
 *   root: string,
 *   signal?: AbortSignal,
 *   logger?: { warn?: Function, info?: Function },
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   source: string,
 *   version?: string,
 *   updated: string[],
 *   skipped: string[],
 *   failed: Array<{ path: string, reason: string }>,
 *   reason?: string,
 * }>}
 */
export async function updatePrompts({ sourceUrl, root, signal, logger, allowMirrorFallback = true }) {
  const chain = buildSourceChain(sourceUrl, allowMirrorFallback)
  const requested = chain[0]
  const result = {
    ok: false,
    source: requested,
    requested,
    fallback: false,
    primaryError: '',
    note: '',
    updated: [],
    skipped: [],
    failed: [],
  }

  // 逐源尝试拉 manifest：主源失败且禁用回退时直接报错。
  let base
  let manifestText
  const attempts = []
  for (const candidate of chain) {
    if (signal?.aborted === true) {
      result.reason = '已取消'
      return result
    }
    try {
      manifestText = await fetchText(`${candidate}/manifest.json`, signal)
      base = candidate
      break
    } catch (error) {
      attempts.push(`${candidate} → ${describeFetchError(error)}`)
    }
  }
  if (base === undefined || manifestText === undefined) {
    result.primaryError = attempts[0] ?? '未知错误'
    result.reason = allowMirrorFallback === false
      ? `主源不可达，且已禁用镜像回退：${result.primaryError}`
      : `所有源均不可用：${attempts.join('；')}`
    return result
  }
  result.source = base
  if (base !== requested) {
    result.fallback = true
    result.primaryError = attempts[0] ?? '主源不可达'
    result.note = '镜像（jsDelivr）对 @main 有 CDN 缓存延迟，刚推送的改动可能尚未同步。'
    logger?.info?.(`flow: 主源不可达，已回退镜像 ${base}`)
  }

  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    result.reason = 'manifest 不是合法 JSON'
    return result
  }

  const checked = validateManifest(manifest)
  if (checked.ok !== true) {
    result.reason = checked.reason
    return result
  }

  result.version = typeof manifest.version === 'string' ? manifest.version : undefined

  for (const entry of checked.files) {
    if (signal?.aborted === true) {
      result.reason = '已取消'
      return result
    }
    const target = join(root, entry.path)
    // 双保险：即使白名单被改坏，也不允许写到 custom/ 或目录之外。
    if (target.includes(`${join('custom')}`)) {
      result.failed.push({ path: entry.path, reason: '拒绝写入 custom 目录' })
      continue
    }

    const local = readLocal(target)
    if (local !== undefined && sha256(local) === entry.sha256) {
      result.skipped.push(entry.path)
      continue
    }

    try {
      const text = await fetchText(`${base}/${entry.path}`, signal)
      if (sha256(text) !== entry.sha256) {
        result.failed.push({ path: entry.path, reason: 'sha256 与 manifest 不符，已放弃该文件' })
        continue
      }
      writeAtomic(target, text)
      result.updated.push(entry.path)
    } catch (error) {
      result.failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  result.ok = result.failed.length === 0
  if (result.ok !== true) {
    logger?.warn?.(`flow: 提示词更新有 ${result.failed.length} 个文件失败`)
  }
  logger?.info?.(`flow: 提示词更新完成，更新 ${result.updated.length} 个、跳过 ${result.skipped.length} 个`)
  return result
}

/**
 * 把更新结果渲染成一行人话回执。
 *
 * @param {Awaited<ReturnType<typeof updatePrompts>>} result
 * @returns {string}
 */
export function formatUpdateResult(result) {
  if (result.ok !== true && result.updated.length === 0) {
    return `提示词更新失败：${result.reason ?? '原因未知'}（源：${result.source}）`
  }
  const lines = []
  lines.push(result.ok === true ? '提示词已更新。' : '提示词更新未完成。')
  lines.push(`- 源：${result.source}`)
  if (result.fallback === true) {
    lines.push(`- 主源不可达：${result.primaryError || '原因未知'}`)
    if (typeof result.note === 'string' && result.note !== '') lines.push(`- 提示：${result.note}`)
  }
  if (result.version !== undefined) lines.push(`- 版本：${result.version}`)
  lines.push(`- 更新 ${result.updated.length} 个：${result.updated.length > 0 ? result.updated.join('、') : '（无）'}`)
  lines.push(`- 跳过 ${result.skipped.length} 个（内容未变）`)
  if (result.failed.length > 0) {
    lines.push(`- 失败 ${result.failed.length} 个：`)
    for (const item of result.failed) lines.push(`  - ${item.path} → ${item.reason}`)
  }
  if (result.reason !== undefined && result.ok !== true) lines.push(`- 说明：${result.reason}`)
  return lines.join('\n')
}
