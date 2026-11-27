/**
 * `.flow/spec.md` 方案锚点：安全路径解析（含软链防护）、限容读取、有界缓存与“便利贴”生成。
 *
 * @module dsh-flow/modes/spec-anchor
 */
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { assertInsideRoot, readTextBounded } from '../shared/fs-safe.js'
import { DEFAULT_SPEC_PATH } from '../config/schema.js'

export { DEFAULT_SPEC_PATH }
export const SUMMARY_OPEN = '<!-- flow:summary -->'
export const SUMMARY_CLOSE = '<!-- /flow:summary -->'

const FULL_TEXT_HINT = '（以上为摘要；完整细节请用读文件工具查看上面的路径）'
const MAX_CHARS_CEILING = 4000
const MAX_SPEC_BYTES = 1024 * 1024
const MAX_CACHE_ENTRIES = 64

/** 有界缓存：绝对路径 → { mtimeMs, size, text }。 */
const fileCache = new Map()

function setCache(key, entry) {
  fileCache.delete(key)
  fileCache.set(key, entry)
  while (fileCache.size > MAX_CACHE_ENTRIES) {
    const oldest = fileCache.keys().next().value
    if (oldest === undefined) break
    fileCache.delete(oldest)
  }
}

export function specPathOf(config, agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return null

  const raw = config?.spec?.path
  const configured = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_SPEC_PATH
  if (isAbsolute(configured)) return null

  const checked = assertInsideRoot(cwd, configured)
  if (!checked.ok) return null
  return { absolute: checked.abs, display: configured }
}

export function readSpecFile(config, agent) {
  const target = specPathOf(config, agent)
  if (target === null) {
    return { exists: false, absolute: null, display: String(config?.spec?.path ?? DEFAULT_SPEC_PATH), bytes: 0, text: '' }
  }

  let stat
  try {
    stat = statSync(target.absolute)
  } catch {
    fileCache.delete(target.absolute)
    return { exists: false, absolute: target.absolute, display: target.display, bytes: 0, text: '' }
  }
  if (!stat.isFile()) {
    return { exists: false, absolute: target.absolute, display: target.display, bytes: 0, text: '' }
  }

  const cached = fileCache.get(target.absolute)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { exists: true, absolute: target.absolute, display: target.display, bytes: stat.size, text: cached.text }
  }

  const read = readTextBounded(target.absolute, MAX_SPEC_BYTES)
  if (!read.ok) {
    fileCache.delete(target.absolute)
    return { exists: false, absolute: target.absolute, display: target.display, bytes: 0, text: '' }
  }

  setCache(target.absolute, { mtimeMs: stat.mtimeMs, size: stat.size, text: read.text })
  return { exists: true, absolute: target.absolute, display: target.display, bytes: stat.size, text: read.text }
}

function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function normalizeLimit(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 600
  if (numeric < 80) return 80
  return Math.min(numeric, MAX_CHARS_CEILING)
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function extractSummary(text, maxChars) {
  const limit = normalizeLimit(maxChars)
  const source = typeof text === 'string' ? text : ''

  const open = source.indexOf(SUMMARY_OPEN)
  if (open !== -1) {
    const start = open + SUMMARY_OPEN.length
    const close = source.indexOf(SUMMARY_CLOSE, start)
    if (close !== -1) {
      const block = source.slice(start, close).trim()
      if (block !== '') return { summary: truncate(block, limit), fromMarkedBlock: true }
    }
  }

  return { summary: truncate(source.trim(), limit), fromMarkedBlock: false }
}

export function buildSpecNote({ agent, config, modeId, modeLabel }) {
  try {
    if (config?.spec?.enabled === false) return ''
    const spec = readSpecFile(config, agent)
    if (!spec.exists) return ''

    const { summary } = extractSummary(spec.text, config?.spec?.maxChars)
    if (summary === '') return ''

    const stage = typeof modeLabel === 'string' && modeLabel !== '' ? modeLabel : modeId
    return [
      '[Flow 方案锚点]',
      `路径：${spec.display}（${formatBytes(spec.bytes)}）｜当前阶段：${stage}`,
      summary,
      FULL_TEXT_HINT,
    ].join('\n')
  } catch {
    return ''
  }
}

export function inspectSpec({ agent, config }) {
  const enabled = config?.spec?.enabled !== false
  const spec = readSpecFile(config, agent)
  if (!spec.exists) {
    return { enabled, exists: false, display: spec.display, bytes: 0, summary: '', fromMarkedBlock: false }
  }
  const extracted = extractSummary(spec.text, config?.spec?.maxChars)
  return {
    enabled,
    exists: true,
    display: spec.display,
    bytes: spec.bytes,
    summary: extracted.summary,
    fromMarkedBlock: extracted.fromMarkedBlock,
  }
}

export function clearSpecCache() {
  fileCache.clear()
}

export function joinSpecPath(cwd, configured) {
  return join(cwd, configured)
}
