/**
 * 提示词仓库：三层回落 + mtime 热加载 + 花名册。
 *
 * === 三层优先级（逐层回落） ===
 *
 * 1. **最高**：用户在设置页手动编辑保存的覆盖文本（存在配置里，**绝不回写磁盘**）。
 * 2. **中间**：插件 `prompts/` 目录下对应的 `.md`（改完文件不用重启，按 mtime 热加载）。
 * 3. **兜底**：代码内置极简文本（`config.js` 里的 `BASE_RULES` / `DEFAULT_MODE_PROMPTS`），
 *    防止用户误删整个 `prompts/` 目录把插件干崩。
 *
 * === 渐进式披露 ===
 *
 * 只有 `flow` / `plan-ultra` 会拿到花名册（`subagents/README.md` + 私有特种兵清单 + 目录绝对路径）。
 * 特种兵正文**永不**预装进系统提示词：大队长需要谁，自己去读对应 `.md` 再装配进派单指令。
 *
 * @module dsh-flow/prompt-store
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_RULES, DEFAULT_MODE_PROMPTS } from './config.js'
import { isPromptMode, modeConfigOf } from './modes.js'

/** 插件内 `prompts/` 目录的绝对路径（跟随插件安装位置）。 */
export const PROMPT_ROOT = fileURLToPath(new URL('./prompts/', import.meta.url))

/** 需要注入花名册的模式。 */
export const ROSTER_MODES = Object.freeze(['flow', 'plan-ultra'])

/** 官方特种兵名单（README 之外还要按文件存在性校验）。 */
export const OFFICIAL_SUBAGENTS = Object.freeze([
  'product-scout',
  'ui-architect',
  'reverse-engineer',
  'deep-debugger',
  'security-auditor',
  'qa-tester',
])

/** 来源标签，供 `/flow prompts list` 与设置页展示。 */
const SOURCE_LABEL = Object.freeze({
  override: '用户覆盖',
  file: '本地 md',
  builtin: '内置兜底',
  missing: '缺失',
})

/** 取 Markdown 首个非空行作为标题（去掉 # 前缀）。 */
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

  /** 带 mtime 缓存的读取；文件不存在时返回 undefined。 */
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

  /** 空串/非字符串一律当"没有覆盖"，让位给下一层。 */
  function overrideOf(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /** 统一的三层回落。 */
  function resolve(kind, id, filePath, override, fallback) {
    const overridden = overrideOf(override)
    if (overridden !== undefined) {
      return { text: overridden, source: 'override', label: SOURCE_LABEL.override, path: filePath, kind, id }
    }
    const fromFile = readCached(filePath)
    if (typeof fromFile === 'string' && fromFile.trim() !== '') {
      return { text: fromFile, source: 'file', label: SOURCE_LABEL.file, path: filePath, kind, id }
    }
    if (typeof fallback === 'string' && fallback.trim() !== '') {
      return { text: fallback, source: 'builtin', label: SOURCE_LABEL.builtin, path: filePath, kind, id }
    }
    return { text: '', source: 'missing', label: SOURCE_LABEL.missing, path: filePath, kind, id }
  }

  /** 底座工程契约。 */
  function base() {
    const config = getConfig()
    return resolve('base', 'base', join(root, 'base.md'), config?.baseRules, BASE_RULES)
  }

  /** 某个模式的专属提示词。 */
  function mode(modeId) {
    if (!isPromptMode(modeId)) {
      return { text: '', source: 'missing', label: SOURCE_LABEL.missing, path: '', kind: 'mode', id: modeId }
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

  /** 私有特种兵目录（用户扩展，一键更新永不触碰）。 */
  const CUSTOM_DIR = join(root, 'custom', 'subagents')
  const OFFICIAL_DIR = join(root, 'subagents')

  /**
   * 读取某个特种兵正文。
   *
   * 私有目录优先：同名时用户可以覆盖官方版，且不会被一键更新覆盖掉。
   *
   * @param {string} name 特种兵名（不含 `.md`）。
   */
  function subagent(name) {
    const safe = String(name ?? '').trim().replace(/\.md$/i, '')
    if (!/^[A-Za-z0-9._-]+$/.test(safe)) {
      return { text: '', source: 'missing', label: SOURCE_LABEL.missing, path: '', kind: 'subagent', id: safe }
    }
    const customPath = join(CUSTOM_DIR, `${safe}.md`)
    const officialPath = join(OFFICIAL_DIR, `${safe}.md`)
    const fromCustom = readCached(customPath)
    if (typeof fromCustom === 'string' && fromCustom.trim() !== '') {
      return { text: fromCustom, source: 'file', label: '私有 md', path: customPath, kind: 'subagent', id: safe }
    }
    const fromOfficial = readCached(officialPath)
    if (typeof fromOfficial === 'string' && fromOfficial.trim() !== '') {
      return { text: fromOfficial, source: 'file', label: SOURCE_LABEL.file, path: officialPath, kind: 'subagent', id: safe }
    }
    return { text: '', source: 'missing', label: SOURCE_LABEL.missing, path: officialPath, kind: 'subagent', id: safe }
  }

  /** 扫描私有目录，列出用户自建特种兵。 */
  function customSubagents() {
    if (!existsSync(CUSTOM_DIR)) return []
    try {
      return readdirSync(CUSTOM_DIR)
        .filter(file => file.toLowerCase().endsWith('.md'))
        // 说明文件不算特种兵
        .filter(file => file.toLowerCase() !== 'readme.md')
        .sort()
        .map(file => {
          const name = file.replace(/\.md$/i, '')
          const text = readCached(join(CUSTOM_DIR, file))
          return { name, title: firstHeading(text) }
        })
    } catch (error) {
      logger?.warn?.(`flow: 扫描私有特种兵失败 → ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** 官方特种兵清单（按目录实际内容排序，缺失的也列出来便于自检）。 */
  function officialSubagents() {
    return OFFICIAL_SUBAGENTS.map(name => {
      const path = join(OFFICIAL_DIR, `${name}.md`)
      const text = readCached(path)
      return {
        name,
        title: typeof text === 'string' ? firstHeading(text) : '',
        exists: typeof text === 'string' && text.trim() !== '',
      }
    })
  }

  /**
   * 花名册注入文本：README + 私有清单 + 目录绝对路径。
   *
   * 只给"谁在哪、擅长什么"，**不含正文**，保证提示词体积恒定。
   *
   * @returns {string} 空串表示不注入（目录缺失或 README 不可读）。
   */
  function roster() {
    const readme = readCached(join(OFFICIAL_DIR, 'README.md'))
    const custom = customSubagents()
    const lines = []
    if (typeof readme === 'string' && readme.trim() !== '') {
      lines.push(readme.trim())
    } else {
      lines.push('## 特种兵花名册（README 缺失）')
      lines.push('')
      lines.push('官方名单：' + OFFICIAL_SUBAGENTS.join('、'))
    }
    if (custom.length > 0) {
      lines.push('')
      lines.push('### 私有特种兵（用户扩展）')
      for (const item of custom) lines.push(`- \`${item.name}\`：${item.title || '（无标题）'}`)
    }
    lines.push('')
    lines.push(`官方目录：\`${OFFICIAL_DIR}\``)
    lines.push(`私有目录：\`${CUSTOM_DIR}\``)
    lines.push('')
    lines.push('需要哪位就读取对应 `.md` 正文，装配进派单指令；严禁凭花名册标题臆测其专业结论。')
    return lines.join('\n')
  }

  /** 清空 mtime 缓存（一键更新后调用，立即生效）。 */
  function invalidate() {
    cache.clear()
  }

  /** 当前清单（版本、来源、特种兵），供命令与设置页展示。 */
  function info() {
    const manifest = (() => {
      const raw = readCached(join(root, 'manifest.json'))
      if (typeof raw !== 'string') return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    })()
    const modes = ['plan', 'plan-ultra', 'build', 'review', 'flow'].map(id => {
      const hit = mode(id)
      return { id, source: hit.source, label: hit.label, path: hit.path, exists: existsSync(hit.path) }
    })
    const baseHit = base()
    return {
      root,
      exists: existsSync(root),
      version: typeof manifest?.version === 'string' ? manifest.version : '未安装',
      updatedAt: typeof manifest?.updatedAt === 'string' ? manifest.updatedAt : '',
      fileCount: Array.isArray(manifest?.files) ? manifest.files.length : 0,
      base: { source: baseHit.source, label: baseHit.label, path: baseHit.path, exists: existsSync(baseHit.path) },
      modes,
      official: officialSubagents(),
      custom: customSubagents(),
      customDir: CUSTOM_DIR,
      officialDir: OFFICIAL_DIR,
    }
  }

  /** 供 `buildModeText` 使用的轻量读取器：只回正文。 */
  function textOf(kind, id) {
    if (kind === 'base') return base().text
    if (kind === 'mode') return mode(id).text
    if (kind === 'subagent') return subagent(id).text
    if (kind === 'roster') return roster()
    return ''
  }

  return { root, base, mode, subagent, roster, invalidate, info, textOf, customSubagents, officialSubagents }
}
