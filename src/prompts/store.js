/**
 * 提示词仓库：三层回落 + mtime 热加载 + 子代理同名覆盖层（Copy-on-Write）。
 *
 * v0.6.0 修复：
 * - B-01：补齐 `info()` 方法，彻底修复 `/flow prompts list` 崩溃；
 * - M-09：`customDir()` 每次按配置动态读取，改完 `prompts.customDir` 无需重启即生效；
 * - 复用 `src/shared/fs-safe.js` 的并发安全 `writeAtomic` 与 `displayPathOf`。
 *
 * @module dsh-flow/prompts/store
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_RULES, DEFAULT_MODE_PROMPTS } from '../config/schema.js'
import { PROMPT_MODES } from '../config/constants.js'
import { isPromptMode, modeConfigOf } from '../modes/registry.js'
import { displayPathOf, writeAtomic } from '../shared/fs-safe.js'

export { displayPathOf }

/** 插件内 `prompts/` 目录的绝对路径（保持在包根，兼容远程更新 URL）。 */
export const PROMPT_ROOT = fileURLToPath(new URL('../../prompts/', import.meta.url))

/**
 * 解析用户私有提示词目录（必须在插件包目录之外）。
 *
 * 优先级：`prompts.customDir` > `$DSH_PROFILE_DIR/data/dsh-flow/prompts/custom` > `~/.dsh-flow/prompts/custom`。
 */
export function resolveCustomDir({ getConfig, env = process.env, home = homedir() } = {}) {
  let configured = ''
  try {
    configured = String(getConfig?.()?.prompts?.customDir ?? '').trim()
  } catch { configured = '' }
  const base = configured !== ''
    ? configured
    : (String(env?.DSH_PROFILE_DIR ?? '').trim() !== ''
      ? join(String(env.DSH_PROFILE_DIR).trim(), 'data', 'dsh-flow', 'prompts', 'custom')
      : join(home, '.dsh-flow', 'prompts', 'custom'))
  return join(base, 'subagents')
}

/** 一次性无损迁移：旧 `<plugin>/prompts/custom/subagents` → 新目录。 */
export function migrateLegacyCustom({ legacyDir, targetDir, logger } = {}) {
  const copied = []
  const skipped = []
  const errors = []
  if (typeof legacyDir !== 'string' || typeof targetDir !== 'string' || legacyDir === targetDir) {
    return { copied, skipped, errors }
  }
  let names = []
  try {
    if (!existsSync(legacyDir)) return { copied, skipped, errors }
    names = readdirSync(legacyDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
  } catch (error) {
    errors.push(`读取旧目录失败：${error instanceof Error ? error.message : String(error)}`)
    return { copied, skipped, errors }
  }
  if (names.length === 0) return { copied, skipped, errors }
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (error) {
    errors.push(`创建新目录失败：${error instanceof Error ? error.message : String(error)}`)
    return { copied, skipped, errors }
  }
  for (const name of names) {
    const source = join(legacyDir, name)
    const target = join(targetDir, name)
    if (existsSync(target)) {
      skipped.push(name)
      continue
    }
    try {
      copyFileSync(source, target)
      copied.push(name)
    } catch (error) {
      errors.push(`${name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (copied.length > 0) {
    logger?.info?.(`flow: 已将 ${copied.length} 个私有提示词迁移到 ${targetDir}（旧目录保留未删）`)
  }
  return { copied, skipped, errors }
}

/** 需要注入目录摘要的模式。 */
export const ROSTER_MODES = Object.freeze(['flow', 'plan-ultra'])

/** 官方子代理名单。 */
export const OFFICIAL_SUBAGENTS = Object.freeze([
  'product-scout',
  'plan-auditor',
  'ui-architect',
  'build-worker',
  'qa-blackbox',
  'qa-whitebox',
  'reverse-engineer',
  'deep-debugger',
  'security-auditor',
  'qa-tester',
])

/** 子代理 ID 白名单：防路径穿越。 */
export const SUBAGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** 单文件内容上限（字符）。 */
const MAX_CONTENT_CHARS = 512 * 1024

/** 来源标签可读文案。 */
const SOURCE_LABEL = Object.freeze({
  override: '配置覆盖',
  file: '磁盘文件',
  fallback: '内置兜底',
})

/** 取 Markdown 首个非空行作为标题。 */
function firstHeading(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    return trimmed.replace(/^#+\s*/, '').slice(0, 60)
  }
  return ''
}

/**
 * 创建提示词仓库。
 *
 * @param {{
 *   getConfig: () => object,
 *   logger?: { warn?: Function, info?: Function },
 *   root?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 * }} deps
 */
export function createPromptStore({ getConfig, logger, root = PROMPT_ROOT, env = process.env, home = homedir() }) {
  const cache = new Map()
  const OFFICIAL_DIR = join(root, 'subagents')
  const LEGACY_CUSTOM_DIR = join(root, 'custom', 'subagents')
  const ROSTER_FILE = 'README.md'

  /** 动态读取当前用户私有目录（改配置立即生效，不需重启）。 */
  function currentCustomDir() {
    return resolveCustomDir({ getConfig, env, home })
  }

  const customMigration = migrateLegacyCustom({
    legacyDir: LEGACY_CUSTOM_DIR,
    targetDir: currentCustomDir(),
    logger,
  })

  function readCached(path) {
    try {
      const stat = statSync(path)
      const hit = cache.get(path)
      if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
      const text = readFileSync(path, 'utf8')
      cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text })
      return text
    } catch (error) {
      cache.delete(path)
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`flow: 读取提示词失败 ${path} → ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }
  }

  function writeAndEvict(path, text) {
    writeAtomic(path, text)
    cache.delete(path)
  }

  function overrideOf(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  function resolve(kind, id, filePath, override, fallback) {
    const overridden = overrideOf(override)
    if (overridden !== undefined) {
      return { text: overridden, source: 'override', path: filePath, kind, id }
    }
    const fromFile = readCached(filePath)
    if (typeof fromFile === 'string' && fromFile.trim() !== '') {
      return { text: fromFile, source: 'file', path: filePath, kind, id }
    }
    if (typeof fallback === 'string' && fallback.trim() !== '') {
      return { text: fallback, source: 'fallback', path: filePath, kind, id }
    }
    return { text: '', source: 'fallback', path: filePath, kind, id }
  }

  function base() {
    const config = getConfig()
    return resolve('base', 'base', join(root, 'base.md'), config?.baseRules, BASE_RULES)
  }

  function baseFile() {
    const text = readCached(join(root, 'base.md'))
    return typeof text === 'string' ? text : ''
  }

  function mode(modeId) {
    if (!isPromptMode(modeId)) {
      return { text: '', source: 'fallback', path: '', kind: 'mode', id: modeId }
    }
    const config = getConfig()
    return resolve(
      'mode',
      modeId,
      join(root, 'modes', `${modeId}.md`),
      modeConfigOf(config, modeId).prompt,
      DEFAULT_MODE_PROMPTS[modeId],
    )
  }

  function markdownIds(dir) {
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .filter(file => file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'readme.md')
        .map(file => file.replace(/\.md$/i, ''))
        .filter(id => SUBAGENT_ID_PATTERN.test(id))
        .sort()
    } catch {
      return []
    }
  }

  function listSubagents() {
    const customDir = currentCustomDir()
    const official = new Set(OFFICIAL_SUBAGENTS.filter(id => readCached(join(OFFICIAL_DIR, `${id}.md`)) !== undefined))
    for (const id of markdownIds(OFFICIAL_DIR)) official.add(id)
    const custom = new Set(markdownIds(customDir))
    const ids = [...new Set([...official, ...custom])].sort()

    return ids.map(id => {
      const customPath = join(customDir, `${id}.md`)
      const officialPath = join(OFFICIAL_DIR, `${id}.md`)
      const customText = readCached(customPath)
      const officialText = readCached(officialPath)
      const isOfficial = officialText !== undefined
      const isCustom = customText !== undefined
      const content = isCustom ? customText : (officialText ?? '')
      return {
        id,
        title: firstHeading(content),
        kind: isOfficial ? 'official' : 'custom',
        overridden: isOfficial && isCustom,
        content: content ?? '',
        resolvedPath: isCustom ? customPath : officialPath,
      }
    })
  }

  function subagent(name) {
    const id = String(name ?? '').trim().replace(/\.md$/i, '')
    if (!SUBAGENT_ID_PATTERN.test(id)) {
      return { text: '', source: 'fallback', path: '', kind: 'subagent', id }
    }
    const customDir = currentCustomDir()
    const customPath = join(customDir, `${id}.md`)
    const officialPath = join(OFFICIAL_DIR, `${id}.md`)
    const fromCustom = readCached(customPath)
    if (typeof fromCustom === 'string') {
      return { text: fromCustom, source: 'file', path: customPath, kind: 'subagent', id }
    }
    const fromOfficial = readCached(officialPath)
    if (typeof fromOfficial === 'string') {
      return { text: fromOfficial, source: 'file', path: officialPath, kind: 'subagent', id }
    }
    return { text: '', source: 'fallback', path: officialPath, kind: 'subagent', id }
  }

  function rosterInfo() {
    const customDir = currentCustomDir()
    const customPath = join(customDir, ROSTER_FILE)
    const officialPath = join(OFFICIAL_DIR, ROSTER_FILE)
    const customText = readCached(customPath)
    if (typeof customText === 'string' && customText.trim() !== '') {
      return { content: customText, source: 'custom', hasCustom: true, path: customPath }
    }
    return {
      content: readCached(officialPath) ?? '',
      source: 'official',
      hasCustom: false,
      path: officialPath,
    }
  }

  function customSubagents() {
    const customDir = currentCustomDir()
    const officialSet = new Set(OFFICIAL_SUBAGENTS)
    return markdownIds(customDir)
      .filter(id => !officialSet.has(id))
      .map(id => ({ name: id, title: firstHeading(readCached(join(customDir, `${id}.md`))) }))
  }

  function roster() {
    const customDir = currentCustomDir()
    const rInfo = rosterInfo()
    const entries = listSubagents()
    const lines = []

    if (rInfo.content.trim() !== '') {
      lines.push(rInfo.content.trim())
    } else {
      lines.push('## 子代理清单')
      lines.push('')
      lines.push('官方名单：' + OFFICIAL_SUBAGENTS.join('、'))
    }

    if (entries.length > 0) {
      lines.push('')
      lines.push('### 子代理与生效路径')
      for (const item of entries) {
        const marks = []
        if (item.kind === 'custom') marks.push('自定义')
        else if (item.overridden) marks.push('官方·已自定义')
        const suffix = marks.length > 0 ? `（${marks.join('，')}）` : ''
        lines.push(`- \`${item.id}\`${suffix}：${item.title || '（无标题）'} → ${item.resolvedPath}`)
      }
    }

    lines.push('')
    lines.push('官方目录：`' + OFFICIAL_DIR + '`')
    lines.push('覆盖目录：`' + customDir + '`')
    lines.push('')
    lines.push('需要哪位就读取其生效路径的正文，再装配进派单指令。')
    return lines.join('\n')
  }

  function validContent(content) {
    if (typeof content !== 'string') return '内容必须是字符串'
    if (content.length > MAX_CONTENT_CHARS) return `内容超过 ${MAX_CONTENT_CHARS} 字符上限`
    return undefined
  }

  function writeSubagent(id, content) {
    if (!SUBAGENT_ID_PATTERN.test(String(id ?? ''))) return { ok: false, reason: 'ID 不合法' }
    const problem = validContent(content)
    if (problem !== undefined) return { ok: false, reason: problem }
    const target = join(currentCustomDir(), `${id}.md`)
    try {
      writeAndEvict(target, content)
      return { ok: true, path: target }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function deleteSubagent(id) {
    if (!SUBAGENT_ID_PATTERN.test(String(id ?? ''))) return { ok: false, reason: 'ID 不合法' }
    const path = join(currentCustomDir(), `${id}.md`)
    try {
      if (existsSync(path)) unlinkSync(path)
      cache.delete(path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function writeRoster(content) {
    const problem = validContent(content)
    if (problem !== undefined) return { ok: false, reason: problem }
    const target = join(currentCustomDir(), ROSTER_FILE)
    try {
      writeAndEvict(target, content)
      return { ok: true, path: target }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function deleteRoster() {
    const path = join(currentCustomDir(), ROSTER_FILE)
    try {
      if (existsSync(path)) unlinkSync(path)
      cache.delete(path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function invalidate() {
    cache.clear()
  }

  function manifestInfo() {
    const raw = readCached(join(root, 'manifest.json'))
    if (typeof raw !== 'string') return { version: '', updatedAt: '', fileCount: 0 }
    try {
      const parsed = JSON.parse(raw)
      return {
        version: typeof parsed?.version === 'string' ? parsed.version : '',
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
        fileCount: Array.isArray(parsed?.files) ? parsed.files.length : 0,
      }
    } catch {
      return { version: '', updatedAt: '', fileCount: 0 }
    }
  }

  /**
   * 提示词仓库汇总信息（供 `/flow prompts list` 与诊断调用；修复 v0.5.1 B-01）。
   */
  function info() {
    const manifest = manifestInfo()
    const baseHit = base()
    const customDir = currentCustomDir()
    const baseExists = existsSync(join(root, 'base.md'))
    const modes = PROMPT_MODES.map(id => {
      const hit = mode(id)
      const exists = existsSync(join(root, 'modes', `${id}.md`))
      return {
        id,
        source: hit.source,
        label: SOURCE_LABEL[hit.source] ?? hit.source,
        exists,
      }
    })
    const official = OFFICIAL_SUBAGENTS.map(name => {
      const officialPath = join(OFFICIAL_DIR, `${name}.md`)
      const customPath = join(customDir, `${name}.md`)
      const customText = readCached(customPath)
      const officialText = readCached(officialPath)
      const exists = officialText !== undefined || customText !== undefined
      const content = customText ?? officialText ?? ''
      return {
        name,
        title: firstHeading(content),
        exists,
        overridden: officialText !== undefined && customText !== undefined,
      }
    })
    const custom = customSubagents()

    return {
      root: displayPathOf(root, home),
      customDir: displayPathOf(customDir, home),
      version: manifest.version || '未知',
      updatedAt: manifest.updatedAt,
      fileCount: manifest.fileCount,
      base: {
        source: baseHit.source,
        label: SOURCE_LABEL[baseHit.source] ?? baseHit.source,
        exists: baseExists,
      },
      modes,
      official,
      custom,
    }
  }

  function textOf(kind, id) {
    if (kind === 'base') return base().text
    if (kind === 'mode') return mode(id).text
    if (kind === 'subagent') return subagent(id).text
    if (kind === 'roster') return roster()
    return ''
  }

  return {
    root,
    officialDir: OFFICIAL_DIR,
    get customDir() { return currentCustomDir() },
    get display() {
      return {
        root: 'prompts',
        officialDir: 'prompts/subagents',
        customDir: displayPathOf(currentCustomDir(), home),
      }
    },
    legacyCustomDir: LEGACY_CUSTOM_DIR,
    customMigration,
    base,
    baseFile,
    mode,
    subagent,
    roster,
    rosterInfo,
    listSubagents,
    customSubagents,
    writeSubagent,
    deleteSubagent,
    writeRoster,
    deleteRoster,
    invalidate,
    manifestInfo,
    info,
    textOf,
  }
}
