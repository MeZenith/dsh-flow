/**
 * 公共文件系统与路径安全原语。
 *
 * 统一收口全仓的原子写、路径穿越防护（含新建文件的祖先目录 realpath 核验）、
 * 限容读取与路径脱敏展示，彻底消除四处手写口径漂移与并发 .tmp 冲突。
 *
 * @module dsh-flow/shared/fs-safe
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'

/** 把路径分隔符统一为正斜杠，方便跨平台前缀比较。 */
export function toPosixPath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** 归一化相对路径前缀（去 `./` 与尾 `/`，拒绝绝对路径或 `..` 穿越）。 */
export function normalizeRelDir(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : ''
  const candidate = toPosixPath(raw === '' ? fallback : raw)
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')
  if (candidate === '.') return ''
  const bad = candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate) || candidate.split('/').includes('..')
  if (bad) {
    if (fallback === '' || fallback === value) return ''
    return normalizeRelDir(fallback, '')
  }
  return candidate
}

/**
 * 并发安全的原子写：临时文件名带 pid + 随机短串，避免并发写同一目标互相覆盖。
 *
 * @param {string} absPath
 * @param {string | Buffer} content
 */
export function writeAtomic(absPath, content) {
  mkdirSync(dirname(absPath), { recursive: true })
  const token = `${process.pid}.${randomUUID().slice(0, 8)}`
  const temp = `${absPath}.${token}.tmp`
  if (Buffer.isBuffer(content)) writeFileSync(temp, content)
  else writeFileSync(temp, String(content), 'utf8')
  try {
    renameSync(temp, absPath)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* 已被清理 */ }
    throw error
  }
}

/**
 * 向上查找距离 `target` 最近的已存在路径（文件本身或其祖先目录）。
 *
 * @param {string} target
 * @returns {string | null}
 */
function nearestExistingPath(target) {
  let current = resolve(target)
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * 核验目标路径是否严格位于 `rootDir` 之内（含符号链接逃逸防护）。
 *
 * 与旧实现不同：即便目标文件尚未创建，也会对最近已存在的祖先目录做 `realpathSync`，
 * 封堵 `.flow/docs` 本身是外部软链时“新建文件绕过 realpath”的逃逸口。
 *
 * @param {string} rootDir 必须是绝对路径。
 * @param {string} candidate 绝对路径或相对 `rootDir` 的路径。
 * @returns {{ ok: true, abs: string, rel: string } | { ok: false, reason: string }}
 */
export function assertInsideRoot(rootDir, candidate) {
  if (typeof rootDir !== 'string' || rootDir === '' || !isAbsolute(rootDir)) {
    return { ok: false, reason: '工作目录不可用（非绝对路径）' }
  }
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, reason: '目标路径为空' }
  }

  const rootAbs = resolve(rootDir)
  const targetAbs = isAbsolute(candidate) ? resolve(candidate) : resolve(rootAbs, normalize(candidate))
  const rel = toPosixPath(relative(rootAbs, targetAbs))
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return { ok: false, reason: '目标路径跑出了工作区，已拒绝' }
  }

  try {
    const realRoot = realpathSync(rootAbs)
    const anchor = nearestExistingPath(targetAbs)
    if (anchor !== null) {
      const realAnchor = realpathSync(anchor)
      const relReal = toPosixPath(relative(realRoot, realAnchor))
      if (relReal === '..' || relReal.startsWith('../') || isAbsolute(relReal)) {
        return { ok: false, reason: '目标路径经符号链接指向工作区外，已拒绝' }
      }
    }
  } catch {
    return { ok: false, reason: '无法解析工作区真实路径，已拒绝' }
  }

  return { ok: true, abs: targetAbs, rel }
}

/**
 * 限容读取 UTF-8 文本：先 `statSync().size` 检查体积，避免误读超大文件撑爆内存。
 *
 * @param {string} absPath
 * @param {number} [maxBytes]
 * @returns {{ ok: true, text: string, bytes: number, mtimeMs: number } | { ok: false, code: string, reason: string }}
 */
export function readTextBounded(absPath, maxBytes = 2 * 1024 * 1024) {
  let info
  try {
    info = statSync(absPath)
  } catch (error) {
    return { ok: false, code: error?.code ?? 'ENOENT', reason: '文件不存在' }
  }
  if (!info.isFile()) return { ok: false, code: 'EISDIR', reason: '目标不是普通文件' }
  if (info.size > maxBytes) {
    return {
      ok: false,
      code: 'ETOOLARGE',
      reason: `文件体积 ${(info.size / 1024).toFixed(1)} KB 超过上限 ${(maxBytes / 1024).toFixed(1)} KB`,
    }
  }
  try {
    const text = readFileSync(absPath, 'utf8')
    return { ok: true, text, bytes: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    return { ok: false, code: error?.code ?? 'EIO', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 限容读取 Buffer（附件用）：先查 size，再读盘。
 *
 * @param {string} absPath
 * @param {number} maxBytes
 * @returns {{ ok: true, content: Buffer, bytes: number } | { ok: false, code: string, reason: string }}
 */
export function readBufferBounded(absPath, maxBytes) {
  let info
  try {
    info = statSync(absPath)
  } catch (error) {
    return { ok: false, code: error?.code ?? 'ENOENT', reason: '文件不存在' }
  }
  if (!info.isFile()) return { ok: false, code: 'EISDIR', reason: '目标不是普通文件' }
  if (Number.isFinite(maxBytes) && maxBytes > 0 && info.size > maxBytes) {
    return {
      ok: false,
      code: 'ETOOLARGE',
      reason: `超过上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MB（实际 ${(info.size / 1024).toFixed(1)} KB）`,
    }
  }
  try {
    const content = readFileSync(absPath)
    return { ok: true, content, bytes: info.size }
  } catch (error) {
    return { ok: false, code: error?.code ?? 'EIO', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把绝对路径收敛成可公开的脱敏展示形式：家目录内 `~/…`，否则只留两级尾段。
 *
 * @param {string} filePath
 * @param {string} [home]
 * @returns {string}
 */
export function displayPathOf(filePath, home = homedir()) {
  const full = String(filePath ?? '')
  if (full === '') return ''
  const normalized = toPosixPath(full)
  const homeNormalized = toPosixPath(String(home ?? ''))
  if (homeNormalized !== '' && normalized.toLowerCase().startsWith(homeNormalized.toLowerCase())) {
    return `~${normalized.slice(homeNormalized.length)}`
  }
  const parts = normalized.split('/').filter(Boolean)
  return parts.length <= 2 ? normalized : `…/${parts.slice(-2).join('/')}`
}
