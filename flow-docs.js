/**
 * `.flow/docs/` 编号文档仓库：模板读取、骨架生成、章节校验、受控写入、摘要与附件。
 *
 * === 三条设计约束 ===
 *
 * 1. **模板只在写骨架时读盘**。`prompts/docs/*.md` 是按需资源，**永不进入系统提示词**；
 *    注入侧只用 `docsNote()` 生成的 ≤5 行便利贴（等级 / 已有 / 缺哪份）。
 * 2. **写入路径焊死**。`resolveTarget()` 把目标限定在 `.flow/docs/**` 与 `.flow/spec.md`，
 *    先 `resolve()` 再做 `relative()` 前缀判断，最后 `realpath()` 二次核对，
 *    防 `..`、防绝对路径、防符号链接逃逸。业务代码永远不在白名单里。
 * 3. **写操作走宿主侧**。`flow_docs_write` 由插件进程落盘，因此 `read-only` 沙箱下也能写
 *    文档 —— 这不是绕沙箱，而是沙箱护栏本来就允许的"插件自己的产物"；授权由
 *    `flow_stage_gate({kind:'permission'})` 把关，见 `gate-tickets.js`。
 *
 * @module dsh-flow/flow-docs
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOC_IDS, DOC_TITLES, normalizeDocId } from './modes.js'
import { isDocSubstantive, levelDef } from './flow-level.js'

/** 插件内文档模板目录。 */
export const DOC_TEMPLATE_ROOT = fileURLToPath(new URL('./prompts/docs/', import.meta.url))

/** 默认文档目录（相对会话 cwd）。 */
export const DEFAULT_DOCS_DIR = '.flow/docs'

/** 方案锚点（与 `spec-anchor.js` 保持一致，写授权里也允许它）。 */
export const SPEC_RELATIVE = '.flow/spec.md'

/** 单份文档上限：超过它几乎肯定是贴了整份日志，拒绝而不是截断。 */
const MAX_DOC_BYTES = 512 * 1024

/** 附件单件上限默认值（与 `notify-email.js` 的默认一致）。 */
const DEFAULT_ATTACH_LIMIT = 2 * 1024 * 1024

/** 文档元信息头。 */
const META_RE = /<!--\s*flow:doc\b[^>]*-->/

/** 每份文档的必填章节号（与 `prompts/docs/*.md` 的一级小节一一对应）。 */
export const REQUIRED_SECTIONS = Object.freeze({
  '01': [1, 2, 3, 4, 5, 6, 7, 8],
  '02': [1, 2, 3, 4, 5],
  '03': [1, 2, 3, 4, 5, 6, 7],
  '04': [1, 2, 3, 4, 5, 6, 7],
  '05': [1, 2, 3, 4, 5, 6, 7],
  '06': [1, 2, 3, 4, 5, 6],
  '07': [1, 2, 3, 4, 5, 6, 7],
})

/** 模板读盘缓存：绝对路径 → { mtimeMs, size, text }。 */
const templateCache = new Map()

/** 模板缺失时的兜底骨架（只保证章节号齐全，正文由模型自己写）。 */
function fallbackTemplate(id) {
  const meta = DOC_TITLES[id]
  const hint = '（本节必填，见 prompts/docs/' + docFileName(id) + ' 的细则。）'
  const sections = (REQUIRED_SECTIONS[id] ?? []).map(n => `## ${n}. 待填写\n\n${hint}\n`)
  return [`# ${id} ${meta?.title ?? '文档'}`, '', ...sections].join('\n')
}

/** 文档文件名：`03-tech-and-env.md`。 */
export function docFileName(id) {
  const meta = DOC_TITLES[id]
  return meta === undefined ? `${id}.md` : `${id}-${meta.slug}.md`
}

/** 文档可读标题。 */
export function docTitle(id) {
  return DOC_TITLES[id]?.title ?? id
}

/**
 * 文档目录（相对 + 绝对）。
 * @param {object} config 纯数据配置。
 * @param {string} cwd 会话工作目录。
 * @returns {{ rel: string, abs: string }}
 */
export function docsDirOf(config, cwd) {
  const raw = typeof config?.docs?.dir === 'string' && config.docs.dir.trim() !== '' ? config.docs.dir.trim() : DEFAULT_DOCS_DIR
  const rel = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  return { rel, abs: resolve(cwd, rel) }
}

/** 把 Windows 反斜杠统一成正斜杠，供前缀比较。 */
function slash(text) {
  return text.replace(/\\/g, '/')
}

/** 相对 cwd 的展示路径。 */
function displayPath(cwd, abs) {
  const rel = slash(relative(resolve(cwd), abs))
  return rel === '' ? '.' : rel
}

/**
 * 解析并校验一个写入目标。
 *
 * @param {{ config: object, cwd: string, target: object }} input
 *   `target` 形如 `{ kind:'doc', id:'03' }` / `{ kind:'spec' }` / `{ kind:'preview', name:'home' }`。
 * @returns {{ ok: true, abs: string, display: string } | { ok: false, reason: string }}
 */
export function resolveTarget({ config, cwd, target }) {
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
    return { ok: false, reason: '会话工作目录不可用，无法定位文档路径' }
  }
  const dirs = docsDirOf(config, cwd)
  const kind = target?.kind ?? 'doc'
  let abs

  if (kind === 'doc') {
    const id = normalizeDocId(target?.id)
    if (id === null) return { ok: false, reason: `文档编号不合法：「${String(target?.id ?? '')}」` }
    abs = join(dirs.abs, docFileName(id))
  } else if (kind === 'preview') {
    const name = String(target?.name ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      return { ok: false, reason: '预览文件名只允许小写字母/数字/短横线（≤64 字符）' }
    }
    abs = join(dirs.abs, 'preview', `${name}.html`)
  } else if (kind === 'spec') {
    abs = resolve(cwd, SPEC_RELATIVE)
  } else {
    return { ok: false, reason: `未知写入目标类型：「${String(kind)}」` }
  }

  const relToCwd = slash(relative(resolve(cwd), abs))
  if (relToCwd.startsWith('..') || isAbsolute(relToCwd)) {
    return { ok: false, reason: '目标路径跑出了工作区，已拒绝' }
  }
  const inDocs = relToCwd === dirs.rel || relToCwd.startsWith(`${dirs.rel}/`)
  const isSpec = relToCwd === SPEC_RELATIVE
  if (!inDocs && !isSpec) {
    return { ok: false, reason: `只允许写 ${dirs.rel}/** 与 ${SPEC_RELATIVE}，已拒绝：${relToCwd}` }
  }

  // 符号链接逃逸：目标已存在时用真实路径再核一次（不存在就只信上面的前缀判断）。
  try {
    const realAbs = realpathSync(abs)
    const realCwd = realpathSync(cwd)
    const relViaReal = slash(relative(realCwd, realAbs))
    if (relViaReal.startsWith('..') || isAbsolute(relViaReal)) {
      return { ok: false, reason: '目标路径经符号链接指向工作区外，已拒绝' }
    }
  } catch { /* 目标不存在：正常，新建即可 */ }

  return { ok: true, abs, display: relToCwd }
}

/** 读模板（带 mtime 缓存）；缺文件时返回兜底骨架。 */
export function templateOf(id) {
  const docId = normalizeDocId(id)
  if (docId === null) return ''
  const path = join(DOC_TEMPLATE_ROOT, docFileName(docId))
  try {
    const info = statSync(path)
    const hit = templateCache.get(path)
    if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.text
    const text = readFileSync(path, 'utf8')
    templateCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text })
    return text
  } catch {
    templateCache.delete(path)
    return fallbackTemplate(docId)
  }
}

/** 原子写：先写临时文件再 rename，失败不留半成品。 */
function writeAtomic(abs, text) {
  mkdirSync(dirname(abs), { recursive: true })
  const temp = `${abs}.tmp`
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, abs)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* 已被清理 */ }
    throw error
  }
}

/** 生成/补齐元信息头。 */
function withMeta(id, text) {
  if (META_RE.test(text)) return text
  const stamp = new Date().toISOString()
  return `<!-- flow:doc id="${id}" version="1" updatedAt="${stamp}" -->\n\n${text}`
}

/**
 * 生成缺失文档的骨架（不需要写授权：只落模板，不含用户内容）。
 *
 * @param {{ config: object, cwd: string, ids?: string[], overwrite?: boolean }} input
 * @returns {{ created: string[], skipped: string[], errors: { id: string, reason: string }[] }}
 */
export function ensureDocs({ config, cwd, ids, overwrite = false }) {
  const wanted = (Array.isArray(ids) && ids.length > 0 ? ids : [...DOC_IDS]).map(normalizeDocId).filter(Boolean)
  const created = []
  const skipped = []
  const errors = []

  for (const id of wanted) {
    const target = resolveTarget({ config, cwd, target: { kind: 'doc', id } })
    if (target.ok !== true) {
      errors.push({ id, reason: target.reason })
      continue
    }
    if (!overwrite && existsSync(target.abs)) {
      skipped.push(id)
      continue
    }
    try {
      writeAtomic(target.abs, withMeta(id, templateOf(id)))
      created.push(id)
    } catch (error) {
      errors.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { created, skipped, errors }
}

/** 取二级及以下小节号集合（`## 3. xxx` → 3）。一级标题是文档标题，不参与章节计数。 */
function headingNumbers(text) {
  const found = new Set()
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^#{2,4}\s*0?([0-9]{1,2})[.、:：\s]/)
    if (match !== null) found.add(Number(match[1]))
  }
  return found
}

/**
 * 校验单份文档：存在、非空壳、必填章节齐全、元信息头在位。
 *
 * @param {{ config: object, cwd: string, id: string, level?: string }} input
 * @returns {{ id: string, title: string, exists: boolean, path: string, bytes: number, missing: number[], reasons: string[], ok: boolean }}
 */
export function checkDoc({ config, cwd, id, level = 'M' }) {
  const docId = normalizeDocId(id)
  const title = docId === null ? String(id) : docTitle(docId)
  if (docId === null) {
    return { id: String(id), title, exists: false, path: '', bytes: 0, missing: [], reasons: ['文档编号不合法'], ok: false }
  }
  const target = resolveTarget({ config, cwd, target: { kind: 'doc', id: docId } })
  if (target.ok !== true) {
    return { id: docId, title, exists: false, path: '', bytes: 0, missing: [], reasons: [target.reason], ok: false }
  }

  let text = ''
  let bytes = 0
  try {
    text = readFileSync(target.abs, 'utf8')
    bytes = Buffer.byteLength(text, 'utf8')
  } catch {
    return {
      id: docId,
      title,
      exists: false,
      path: target.display,
      bytes: 0,
      missing: [...(REQUIRED_SECTIONS[docId] ?? [])],
      reasons: ['文档尚未落盘'],
      ok: false,
    }
  }

  const reasons = []
  const substantive = isDocSubstantive(text, level)
  if (substantive.ok !== true) reasons.push(substantive.reason ?? '内容无效')
  if (!META_RE.test(text)) reasons.push('缺少 flow:doc 元信息头（可由 flow_docs_write 自动补）')

  const found = headingNumbers(text)
  const missing = (REQUIRED_SECTIONS[docId] ?? []).filter(n => !found.has(n))
  if (missing.length > 0) reasons.push(`缺必填章节：${missing.map(n => `§${n}`).join(' ')}`)

  return {
    id: docId,
    title,
    exists: true,
    path: target.display,
    bytes,
    missing,
    reasons,
    ok: reasons.length === 0,
  }
}

/**
 * 批量校验。
 * @param {{ config: object, cwd: string, ids: string[], level?: string }} input
 * @returns {{ items: object[], ok: boolean, failed: string[] }}
 */
export function checkDocs({ config, cwd, ids, level = 'M' }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeDocId).filter(Boolean))].sort()
  const items = wanted.map(id => checkDoc({ config, cwd, id, level }))
  const failed = items.filter(item => item.ok !== true).map(item => item.id)
  return { items, ok: failed.length === 0, failed }
}

/**
 * 受控写入（调用方必须先校验写授权）。
 *
 * @param {{ config: object, cwd: string, target: object, content: string, mode?: 'overwrite'|'append' }} input
 * @returns {{ ok: true, path: string, bytes: number } | { ok: false, reason: string }}
 */
export function writeDoc({ config, cwd, target, content, mode = 'overwrite' }) {
  const text = typeof content === 'string' ? content : ''
  if (text.trim() === '') return { ok: false, reason: '内容为空，拒绝写入' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_DOC_BYTES) {
    return { ok: false, reason: `内容 ${(bytes / 1024).toFixed(1)} KB，超过单份文档 ${MAX_DOC_BYTES / 1024} KB 上限（疑似贴了整份日志）` }
  }
  const resolved = resolveTarget({ config, cwd, target })
  if (resolved.ok !== true) return { ok: false, reason: resolved.reason }

  try {
    const resolvedId = target?.kind === 'preview' ? '' : (normalizeDocId(target?.id) ?? 'spec')
    const finalText = mode === 'append' && existsSync(resolved.abs)
      ? `${readFileSync(resolved.abs, 'utf8').replace(/\s*$/, '')}\n\n${text}`
      : (target?.kind === 'preview' ? text : withMeta(resolvedId, text))
    writeAtomic(resolved.abs, finalText)
    const written = statSync(resolved.abs)
    return { ok: true, path: resolved.display, bytes: written.size }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 给系统提示词用的文档便利贴，**最多 5 行**（硬上限，防止提示词膨胀）。
 *
 * @param {{ config: object, cwd: string, level?: string }} input
 * @returns {string}
 */
export function docsNote({ config, cwd, level = 'M' }) {
  try {
    if (config?.docs?.enabled === false) return ''
    const def = levelDef(level)
    if (def.docs.length === 0) return ''
    const items = checkDocs({ config, cwd, ids: def.docs, level })
    const ready = items.items.filter(item => item.ok).map(item => item.id)
    const missing = items.failed
    const dirs = docsDirOf(config, cwd)
    const lines = [
      `[Flow 文档] 等级 ${def.id}｜目录 ${dirs.rel}`,
      ready.length === 0 ? '已就绪：无' : `已就绪：${ready.join(' ')}`,
      missing.length === 0 ? '缺：无' : `缺：${missing.join(' ')}`,
      `门禁前必须齐备：${def.docs.join(' ')}（flow_docs_check 逐份校验）`,
      '写文档用 flow_docs_write（只允许 .flow/docs/** 与 .flow/spec.md）；缺授权先走 flow_stage_gate kind=permission',
    ]
    return lines.slice(0, 5).join('\n')
  } catch {
    return ''
  }
}

/** 读文档正文（不存在返回空串）。 */
export function readDocText({ config, cwd, id }) {
  const target = resolveTarget({ config, cwd, target: { kind: 'doc', id } })
  if (target.ok !== true) return ''
  try {
    return readFileSync(target.abs, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 文档核心摘要：给 IM 按需拉取用（IM 不能发附件，只能回文字）。
 *
 * 策略：去掉元信息头与代码块围栏后的前若干行，按 `maxChars` 截断并标注。
 *
 * @param {{ config: object, cwd: string, ids: string[], maxChars?: number }} input
 * @returns {{ text: string, parts: { id: string, title: string, chars: number }[] }}
 */
export function digestOf({ config, cwd, ids, maxChars = 800 }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeDocId).filter(Boolean))].sort()
  const parts = []
  const blocks = []
  for (const id of wanted) {
    const raw = readDocText({ config, cwd, id })
    if (raw === '') {
      parts.push({ id, title: docTitle(id), chars: 0 })
      blocks.push(`【${id} ${docTitle(id)}】尚未落盘`)
      continue
    }
    const body = raw
      .replace(META_RE, '')
      .replace(/```[\s\S]*?```/g, '（代码块略）')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…（已截断，完整见邮箱附件）` : body
    parts.push({ id, title: docTitle(id), chars: body.length })
    blocks.push(`【${id} ${docTitle(id)}】\n${clipped}`)
  }
  return { text: blocks.join('\n\n'), parts }
}

/**
 * 把"还没落盘"的草稿做成邮件附件（`.draft.md`）。
 *
 * 用途：只读写授权门禁必须让用户先看到方案正文才能决定要不要放行 —— 此时文件还在内存里，
 * `.flow/docs/` 一个字节都没写。文件名带 `.draft` 后缀，避免用户误以为已经落盘。
 *
 * @param {{ id?: string, draftContent?: string, draftName?: string }} input
 * @returns {{ filename: string, content: Buffer, contentType: string } | undefined}
 */
export function draftAttachment({ id, draftContent, draftName }) {
  const text = typeof draftContent === 'string' ? draftContent : ''
  if (text.trim() === '') return undefined
  const base = typeof draftName === 'string' && draftName.trim() !== ''
    ? draftName.trim()
    : (normalizeDocId(id) === null
      ? 'draft.md'
      : docFileName(normalizeDocId(id)).replace(/\.md$/i, '.draft.md'))
  return {
    filename: base.endsWith('.draft.md') ? base : `${base.replace(/\.md$/i, '')}.draft.md`,
    content: Buffer.from(text, 'utf8'),
    contentType: 'text/markdown; charset=UTF-8',
  }
}

/**
 * 把文档与额外附件读成邮件附件数组。
 *
 * @param {{ config: object, cwd: string, ids: string[], extra?: string[], drafts?: { id?: string, draftContent?: string }[], limitBytes?: number }} input
 * @returns {{ attachments: { filename: string, content: Buffer, contentType: string }[], skipped: string[] }}
 */
export function attachmentsOf({ config, cwd, ids, extra = [], drafts = [], limitBytes = DEFAULT_ATTACH_LIMIT }) {
  const attachments = []
  const skipped = []
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeDocId).filter(Boolean))].sort()

  for (const id of wanted) {
    const target = resolveTarget({ config, cwd, target: { kind: 'doc', id } })
    if (target.ok !== true) {
      skipped.push(`${id}：${target.reason}`)
      continue
    }
    try {
      const content = readFileSync(target.abs)
      if (content.length > limitBytes) {
        skipped.push(`${id}：超过附件上限 ${(limitBytes / 1024 / 1024).toFixed(1)} MB`)
        continue
      }
      attachments.push({
        filename: docFileName(id),
        content,
        contentType: 'text/markdown; charset=UTF-8',
      })
    } catch {
      skipped.push(`${id}：尚未落盘`)
    }
  }

  for (const raw of Array.isArray(extra) ? extra : []) {
    const rel = String(raw ?? '').trim().replace(/\\/g, '/')
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      skipped.push(`${rel || '(空路径)'}：非法路径`)
      continue
    }
    const abs = resolve(cwd, rel)
    const relToCwd = slash(relative(resolve(cwd), abs))
    if (relToCwd.startsWith('..')) {
      skipped.push(`${rel}：跑出工作区`)
      continue
    }
    try {
      const content = readFileSync(abs)
      if (content.length > limitBytes) {
        skipped.push(`${rel}：超过附件上限`)
        continue
      }
      attachments.push({
        filename: relToCwd.split('/').pop() ?? rel,
        content,
        contentType: /\.html?$/i.test(rel) ? 'text/html; charset=UTF-8' : 'application/octet-stream',
      })
    } catch {
      skipped.push(`${rel}：读不到文件`)
    }
  }

  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const attachment = draftAttachment(draft)
    if (attachment === undefined) {
      skipped.push('草稿为空，未作为附件')
      continue
    }
    if (attachment.content.length > limitBytes) {
      skipped.push(`草稿超过附件上限 ${(limitBytes / 1024 / 1024).toFixed(1)} MB`)
      continue
    }
    attachments.push(attachment)
  }

  return { attachments, skipped }
}
