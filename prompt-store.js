/**
 * 提示词仓库：三层回落 + mtime 热加载 + 子代理同名覆盖层（Copy-on-Write）。
 *
 * === 三层优先级（逐层回落） ===
 *
 * 1. **override**：设置页手动保存的覆盖文本（存在配置里，绝不回写磁盘）。
 * 2. **file**：插件 `prompts/` 下对应的 `.md`（按 mtime 热加载，改完不用重启）。
 * 3. **fallback**：代码内置兜底文本（`config.js` 的 `BASE_RULES` / `DEFAULT_MODE_PROMPTS`）。
 *
 * === 子代理防覆盖（Copy-on-Write） ===
 *
 * **永不修改 `prompts/subagents/` 下的官方文件**，否则一键更新会覆盖用户改动。
 * 改名/新增一律写 `prompts/custom/subagents/<id>.md`；目录改写写
 * `prompts/custom/subagents/README.md`。读取优先级：
 * `custom/subagents/<name>.md` > `subagents/<name>.md`。
 *
 * === 渐进式披露 ===
 *
 * 只有 `flow` / `plan-ultra` 拿到目录摘要，子代理正文永不预装进系统提示词。
 *
 * @module dsh-flow/prompt-store
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_RULES, DEFAULT_MODE_PROMPTS } from './config.js'
import { isPromptMode, modeConfigOf } from './modes.js'

/** 插件内 `prompts/` 目录的绝对路径。 */
export const PROMPT_ROOT = fileURLToPath(new URL('./prompts/', import.meta.url))

/** 需要注入目录摘要的模式。 */
export const ROSTER_MODES = Object.freeze(['flow', 'plan-ultra'])

/** 官方子代理名单。 */
export const OFFICIAL_SUBAGENTS = Object.freeze([
  'product-scout',
  'ui-architect',
  'reverse-engineer',
  'deep-debugger',
  'security-auditor',
  'qa-tester',
])

/** 子代理 ID 白名单：防路径穿越。 */
export const SUBAGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** 单文件内容上限（字符）。 */
const MAX_CONTENT_CHARS = 512 * 1024

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
 * }} deps
 */
export function createPromptStore({ getConfig, logger, root = PROMPT_ROOT }) {
  /** 绝对路径 → { mtimeMs, size, text } */
  const cache = new Map()

  const OFFICIAL_DIR = join(root, 'subagents')
  const CUSTOM_DIR = join(root, 'custom', 'subagents')
  const ROSTER_FILE = 'README.md'

  /** 带 mtime 缓存的读取；不存在返回 undefined。 */
  function readCached(path) {
    try {
      const info = statSync(path)
      const hit = cache.get(path)
      if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.text
      const text = readFileSync(path, 'utf8')
      cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text })
      return text
    } catch (error) {
      cache.delete(path)
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`flow: 读取提示词失败 ${path} → ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }
  }

  /** 原子写：先写临时文件再 rename。 */
  function writeAtomic(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, text, 'utf8')
    try {
      renameSync(temp, path)
    } catch (error) {
      try { unlinkSync(temp) } catch { /* 可能已被清理 */ }
      throw error
    }
    cache.delete(path)
  }

  /** 空串/非字符串视为"没有覆盖"，让位给下一层。 */
  function overrideOf(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /** 统一三层回落。 */
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

  /** 底座工程契约。 */
  function base() {
    const config = getConfig()
    return resolve('base', 'base', join(root, 'base.md'), config?.baseRules, BASE_RULES)
  }

  /** 某个模式的专属提示词。 */
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

  /** 目录下所有 `.md`（排除 README），按名字排序。 */
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

  /**
   * 合并后的子代理清单（官方 + 自定义，去重）。
   *
   * @returns {Array<{ id: string, title: string, kind: 'official'|'custom', overridden: boolean, content: string, resolvedPath: string }>}
   */
  function listSubagents() {
    const official = new Set(OFFICIAL_SUBAGENTS.filter(id => readCached(join(OFFICIAL_DIR, `${id}.md`)) !== undefined))
    for (const id of markdownIds(OFFICIAL_DIR)) official.add(id)
    const custom = new Set(markdownIds(CUSTOM_DIR))
    const ids = [...new Set([...official, ...custom])].sort()

    return ids.map(id => {
      const customPath = join(CUSTOM_DIR, `${id}.md`)
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

  /** 读取单个子代理（custom 优先）。 */
  function subagent(name) {
    const id = String(name ?? '').trim().replace(/\.md$/i, '')
    if (!SUBAGENT_ID_PATTERN.test(id)) {
      return { text: '', source: 'fallback', path: '', kind: 'subagent', id }
    }
    const customPath = join(CUSTOM_DIR, `${id}.md`)
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

  /** 目录（README）状态：自定义优先。 */
  function rosterInfo() {
    const customPath = join(CUSTOM_DIR, ROSTER_FILE)
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

  /** 用户自建（非官方）子代理清单。 */
  function customSubagents() {
    const officialSet = new Set(OFFICIAL_SUBAGENTS)
    return markdownIds(CUSTOM_DIR)
      .filter(id => !officialSet.has(id))
      .map(id => ({ name: id, title: firstHeading(readCached(join(CUSTOM_DIR, `${id}.md`))) }))
  }

  /**
   * 注入给 flow / plan-ultra 的目录摘要。
   *
   * 只给"谁在哪、擅长什么、看哪个文件"，不含正文；每条附带**实际生效的最终路径**。
   */
  function roster() {
    const info = rosterInfo()
    const entries = listSubagents()
    const lines = []

    if (info.content.trim() !== '') {
      lines.push(info.content.trim())
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
    lines.push('覆盖目录：`' + CUSTOM_DIR + '`')
    lines.push('')
    lines.push('需要哪位就读取其生效路径的正文，再装配进派单指令。')
    return lines.join('\n')
  }

  /** 校验写入内容。 */
  function validContent(content) {
    if (typeof content !== 'string') return '内容必须是字符串'
    if (content.length > MAX_CONTENT_CHARS) return `内容超过 ${MAX_CONTENT_CHARS} 字符上限`
    return undefined
  }

  /** 写入子代理覆盖层（从不触碰官方文件）。 */
  function writeSubagent(id, content) {
    if (!SUBAGENT_ID_PATTERN.test(String(id ?? ''))) return { ok: false, reason: 'ID 不合法' }
    const problem = validContent(content)
    if (problem !== undefined) return { ok: false, reason: problem }
    try {
      writeAtomic(join(CUSTOM_DIR, `${id}.md`), content)
      return { ok: true, path: join(CUSTOM_DIR, `${id}.md`) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 删除子代理覆盖层（官方项即"恢复默认"）。 */
  function deleteSubagent(id) {
    if (!SUBAGENT_ID_PATTERN.test(String(id ?? ''))) return { ok: false, reason: 'ID 不合法' }
    const path = join(CUSTOM_DIR, `${id}.md`)
    try {
      if (existsSync(path)) unlinkSync(path)
      cache.delete(path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 写入自定义目录文件。 */
  function writeRoster(content) {
    const problem = validContent(content)
    if (problem !== undefined) return { ok: false, reason: problem }
    try {
      writeAtomic(join(CUSTOM_DIR, ROSTER_FILE), content)
      return { ok: true, path: join(CUSTOM_DIR, ROSTER_FILE) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 删除自定义目录文件（目录恢复默认）。 */
  function deleteRoster() {
    const path = join(CUSTOM_DIR, ROSTER_FILE)
    try {
      if (existsSync(path)) unlinkSync(path)
      cache.delete(path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 清空 mtime 缓存（一键更新后调用）。 */
  function invalidate() {
    cache.clear()
  }

  /** manifest 摘要。 */
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

  /** 供 `buildModeText` 使用的轻量读取器。 */
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
    customDir: CUSTOM_DIR,
    base,
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
    textOf,
  }
}
