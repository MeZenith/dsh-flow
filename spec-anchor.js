/**
 * `.flow/spec.md` 方案锚点：读取、缓存、摘要提取与"便利贴"生成。
 *
 * 设计要点（对应 S2 红线）：
 *
 * 1. **绝不把整份文件塞进 `required` context**。`required: true` 的 runtime context
 *    在压缩后会由 `RuntimeContextProjection` 自动重挂，重挂的是"便利贴"而不是全文，
 *    否则每次压缩都重新灌一遍大文件，token 会爆。
 * 2. **按 `mtimeMs` + `size` 缓存**：文件没变就不重复读盘。缓存的是**文件内容**，
 *    "便利贴"每次按当前模式重新拼（模式变了，前缀要跟着变）。
 * 3. **文件不存在时安静返回空串**：不报错、不创建空文件 —— `.flow/spec.md` 是
 *    用户按需建立的工作文件，不是插件的落盘依赖。
 * 4. **路径穿越防护**：`spec.path` 是可配置字符串，必须限制在会话 cwd 之内。
 *
 * @module dsh-flow/spec-anchor
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 相对会话 cwd 的默认方案文件路径。 */
export const DEFAULT_SPEC_PATH = '.flow/spec.md'

/** 摘要块起始标记。 */
export const SUMMARY_OPEN = '<!-- flow:summary -->'

/** 摘要块结束标记。 */
export const SUMMARY_CLOSE = '<!-- /flow:summary -->'

/** 便利贴里提示模型"去看全文"的固定尾句。 */
const FULL_TEXT_HINT = '（以上为摘要；完整细节请用读文件工具查看上面的路径）'

/** 摘要字符上限的硬边界：配置写多大都不允许失控。 */
const MAX_CHARS_CEILING = 4000

/** 缓存：绝对路径 → { mtimeMs, size, text }。 */
const fileCache = new Map()

/**
 * 解析方案文件的绝对路径。
 *
 * @param {object} config 纯数据配置。
 * @param {{ session: { header: { cwd?: string } } }} agent
 * @returns {{ absolute: string, display: string } | null} 无 cwd 或路径非法时返回 null。
 */
export function specPathOf(config, agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return null

  const raw = config?.spec?.path
  const configured = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_SPEC_PATH
  if (isAbsolute(configured)) return null

  const absolute = resolve(cwd, configured)
  const rel = relative(resolve(cwd), absolute)
  // 穿越防护：`..` 开头或又变成绝对路径，说明跑出了工作区。
  if (rel.startsWith('..') || isAbsolute(rel)) return null

  return { absolute, display: configured }
}

/**
 * 读取方案文件，命中缓存时不读盘。
 *
 * @param {object} config
 * @param {object} agent
 * @returns {{ exists: boolean, absolute: string | null, display: string, bytes: number, text: string }}
 */
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
    return {
      exists: true,
      absolute: target.absolute,
      display: target.display,
      bytes: stat.size,
      text: cached.text,
    }
  }

  let text = ''
  try {
    text = readFileSync(target.absolute, 'utf8')
  } catch {
    return { exists: false, absolute: target.absolute, display: target.display, bytes: 0, text: '' }
  }

  fileCache.set(target.absolute, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return { exists: true, absolute: target.absolute, display: target.display, bytes: stat.size, text }
}

/**
 * 提取方案摘要。
 *
 * 优先取 `<!-- flow:summary -->` 与 `<!-- /flow:summary -->` 之间的内容；
 * 标记缺失或为空时回退到正文前 `maxChars` 个字符。
 *
 * @param {string} text 文件全文。
 * @param {number} maxChars 上限。
 * @returns {{ summary: string, fromMarkedBlock: boolean }}
 */
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

/**
 * 把摘要截到上限，超长时补省略号。
 * @param {string} text
 * @param {number} limit
 */
function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/** 把配置里的 `maxChars` 归一成合法正整数。 */
function normalizeLimit(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 600
  if (numeric < 80) return 80
  return Math.min(numeric, MAX_CHARS_CEILING)
}

/** 字节数转人类可读。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * 生成注入 `required` context 的"方案便利贴"。
 *
 * 任何异常都返回空串（宁可这一轮不注入，也不要让 prompt 装配抛错）。
 *
 * @param {{ agent: object, config: object, modeId: string, modeLabel: string }} input
 * @returns {string}
 */
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

/**
 * 供 `/flow spec` 命令使用的诊断视图。
 * @param {{ agent: object, config: object }} input
 * @returns {{ enabled: boolean, exists: boolean, display: string, bytes: number, summary: string, fromMarkedBlock: boolean }}
 */
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

/** 清空缓存（测试与配置变更时使用）。 */
export function clearSpecCache() {
  fileCache.clear()
}

/** 绝对路径拼接工具，供调用方探测文件是否存在（不读内容）。 */
export function joinSpecPath(cwd, configured) {
  return join(cwd, configured)
}
