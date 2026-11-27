/**
 * 零依赖一键更新提示词。
 *
 * v0.6.0 修复：
 * - M-08：只检查相对 `entry.path` 是否命中 `custom/`，不再误伤安装在路径含 `custom` 目录下的用户；
 * - 使用并发安全的 `writeAtomic`；
 * - 用 UTF-8 字节数校验 `MAX_BYTES`。
 *
 * @module dsh-flow/prompts/updater
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../shared/fs-safe.js'

/** 官方默认源（raw.githubusercontent 的 prompts 目录）。 */
export const DEFAULT_SOURCE_URL = 'https://raw.githubusercontent.com/MeZenith/dsh-flow/main/prompts'

/** 内置镜像源，按顺序兜底。 */
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
  /^docs\/[a-z0-9-]+\.md$/,
]

/** 单文件体积上限（字节）。 */
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

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function normalizeSource(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return DEFAULT_SOURCE_URL
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

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

export function describeFetchError(error) {
  const name = error?.name ?? ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AbortError' || name === 'TimeoutError') return '请求超时'
  if (/ECONNRESET|socket hang up|reset/i.test(message)) return '连接被重置'
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '域名解析失败'
  if (/HTTP \d+/.test(message)) return message
  return message
}

export function parseVersion(value) {
  if (typeof value !== 'string') return []
  const parts = value.trim().replace(/^v/i, '').split(/[.+-]/)
  const numbers = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break
    numbers.push(Number(part))
  }
  return numbers
}

export function compareVersion(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

function parseTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Number.NaN
}

function readLocal(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

function readLocalManifest(root) {
  const text = readLocal(join(root, 'manifest.json'))
  if (text === undefined) return {}
  try {
    const parsed = JSON.parse(text)
    return {
      version: typeof parsed?.version === 'string' ? parsed.version : undefined,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined,
    }
  } catch {
    return {}
  }
}

export function detectDowngrade(remote, local) {
  const remoteVersion = remote?.version
  const localVersion = local?.version
  const versionOrder = remoteVersion !== undefined && localVersion !== undefined
    ? compareVersion(remoteVersion, localVersion)
    : 0

  if (versionOrder < 0) {
    return {
      downgrade: true,
      reason: `远端版本 ${remoteVersion} 早于本地 ${localVersion}`,
    }
  }

  const remoteTime = parseTime(remote?.updatedAt)
  const localTime = parseTime(local?.updatedAt)
  if (Number.isFinite(remoteTime) && Number.isFinite(localTime) && remoteTime < localTime) {
    return {
      downgrade: true,
      reason: `远端更新时间 ${remote.updatedAt} 早于本地 ${local.updatedAt}`,
    }
  }

  return { downgrade: false }
}

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

    // P1-11 修复：先校验 Content-Length 再流式限容读取，杜绝超大响应体全量入内存引发 OOM。
    const contentLen = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(contentLen) && contentLen > MAX_BYTES) {
      try { await response.body?.cancel?.() } catch { /* 忽略 */ }
      throw new Error(`文件过大（${contentLen} 字节）`)
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader()
      const chunks = []
      let totalBytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined || value === null) continue
          const buf = Buffer.from(value)
          totalBytes += buf.byteLength
          if (totalBytes > MAX_BYTES) {
            try { await reader.cancel() } catch { /* 忽略 */ }
            controller.abort()
            throw new Error(`文件过大（超过 ${MAX_BYTES} 字节上限）`)
          }
          chunks.push(buf)
        }
      } finally {
        try { reader.releaseLock?.() } catch { /* 忽略 */ }
      }
      return Buffer.concat(chunks, totalBytes).toString('utf8')
    }

    const text = await response.text()
    const byteLen = Buffer.byteLength(text, 'utf8')
    if (byteLen > MAX_BYTES) throw new Error(`文件过大（${byteLen} 字节）`)
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

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
    let mirrorHost = base
    try { mirrorHost = new URL(base).host } catch { /* 原样展示 */ }
    result.mirrorHost = mirrorHost
    result.note = `主源不可达，已自动切换到镜像 ${mirrorHost}（jsDelivr 对 @main 有 CDN 缓存延迟，刚推送的改动可能尚未同步）。`
    logger?.info?.(`flow: 主源不可达，已切换到镜像 ${mirrorHost} → ${base}`)
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

  const localManifest = readLocalManifest(root)
  const downgrade = detectDowngrade(
    { version: result.version, updatedAt: typeof manifest.updatedAt === 'string' ? manifest.updatedAt : undefined },
    localManifest,
  )
  if (downgrade.downgrade === true) {
    result.downgrade = true
    result.localVersion = localManifest.version
    result.localUpdatedAt = localManifest.updatedAt
    result.reason = `远端版本早于本地（${downgrade.reason}），可能是镜像缓存滞后，已跳过以避免回退`
    result.ok = true
    logger?.info?.(`flow: ${result.reason}`)
    return result
  }

  for (const entry of checked.files) {
    if (signal?.aborted === true) {
      result.reason = '已取消'
      return result
    }
    // 只检查相对 entry.path，避免绝对安装目录含 `custom` 字样时误拦。
    const segments = entry.path.split('/')
    if (segments.includes('custom')) {
      result.failed.push({ path: entry.path, reason: '拒绝写入 custom 目录' })
      continue
    }

    const target = join(root, entry.path)
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
  if (result.ok === true) {
    // P1-11 修复：所有远端文件校验并落盘成功后，原子回写本地 manifest.json，确保版本号与防降级校验同步。
    try {
      writeAtomic(join(root, 'manifest.json'), manifestText)
    } catch (error) {
      result.failed.push({ path: 'manifest.json', reason: error instanceof Error ? error.message : String(error) })
      result.ok = false
    }
  }
  if (result.ok !== true) {
    logger?.warn?.(`flow: 提示词更新有 ${result.failed.length} 个文件失败`)
  }
  logger?.info?.(`flow: 提示词更新完成，更新 ${result.updated.length} 个、跳过 ${result.skipped.length} 个`)
  return result
}

export function formatUpdateResult(result) {
  if (result.downgrade === true) {
    return [
      `已跳过：${result.reason}。`,
      `- 源：${result.source}`,
      `- 本地版本：${result.localVersion ?? '未知'}`,
      '本地文件保持不变。',
    ].join('\n')
  }
  if (result.ok !== true && result.updated.length === 0) {
    return `提示词更新失败：${result.reason ?? '原因未知'}（源：${result.source}）`
  }
  const lines = []
  lines.push(result.ok === true ? '提示词已更新。' : '提示词更新未完成。')
  lines.push(`- 源：${result.source}`)
  if (result.fallback === true) {
    lines.push(`- 已切换镜像：${result.mirrorHost ?? result.source}`)
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
