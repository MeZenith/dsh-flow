/**
 * `.flow/docs/` 编号文档仓库：模板读取、骨架生成、带 mtime 缓存的章节校验、受控写入、摘要与附件。
 *
 * v0.6.0 修复：
 * - 统一改用 `src/shared/fs-safe.js` 的 `assertInsideRoot`（修复新建文件祖先软链逃逸 + `./` 前缀误拒）；
 * - 统一改用并发安全的 `writeAtomic` 与限容读盘 `readTextBounded` / `readBufferBounded`；
 * - 为 `checkDoc` 增加有界 `mtime+size` 缓存，避免 `docsNote()` 每步重复同步读 7 份文件；
 * - `attachmentsOf` 的 `extra` 附件也全部走 `assertInsideRoot` 软链核验。
 *
 * @module dsh-flow/workflow/docs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOC_IDS, DOC_TITLES, normalizeDocId } from '../config/constants.js'
import { isDocSubstantive, levelDef } from './level.js'
import {
  assertInsideRoot, normalizeRelDir, readBufferBounded, readTextBounded, writeAtomic,
} from '../shared/fs-safe.js'

export const DOC_TEMPLATE_ROOT = fileURLToPath(new URL('../../prompts/docs/', import.meta.url))
export const DEFAULT_DOCS_DIR = '.flow/docs'
export const SPEC_RELATIVE = '.flow/spec.md'

const MAX_DOC_BYTES = 512 * 1024
const DEFAULT_ATTACH_LIMIT = 2 * 1024 * 1024
const META_RE = /<!--\s*flow:doc\b[^>]*-->/
const MAX_CHECK_CACHE = 128

export const REQUIRED_SECTIONS = Object.freeze({
  '01': [1, 2, 3, 4, 5, 6, 7, 8],
  '02': [1, 2, 3, 4, 5],
  '03': [1, 2, 3, 4, 5, 6, 7],
  '04': [1, 2, 3, 4, 5, 6, 7],
  '05': [1, 2, 3, 4, 5, 6, 7],
  '06': [1, 2, 3, 4, 5, 6],
  '07': [1, 2, 3, 4, 5, 6, 7],
})

const templateCache = new Map()
const docCheckCache = new Map()

function fallbackTemplate(id) {
  const meta = DOC_TITLES[id]
  const hint = '（本节必填，见 prompts/docs/' + docFileName(id) + ' 的细则。）'
  const sections = (REQUIRED_SECTIONS[id] ?? []).map(n => `## ${n}. 待填写\n\n${hint}\n`)
  return [`# ${id} ${meta?.title ?? '文档'}`, '', ...sections].join('\n')
}

export function docFileName(id) {
  const meta = DOC_TITLES[id]
  return meta === undefined ? `${id}.md` : `${id}-${meta.slug}.md`
}

export function docTitle(id) {
  return DOC_TITLES[id]?.title ?? id
}

export function docsDirOf(config, cwd) {
  const rel = normalizeRelDir(config?.docs?.dir, DEFAULT_DOCS_DIR) || DEFAULT_DOCS_DIR
  return { rel, abs: resolve(cwd, rel) }
}

export function resolveTarget({ config, cwd, target }) {
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
    return { ok: false, reason: '会话工作目录不可用，无法定位文档路径' }
  }
  const dirs = docsDirOf(config, cwd)
  const kind = target?.kind ?? 'doc'
  let candidate

  if (kind === 'doc') {
    const id = normalizeDocId(target?.id)
    if (id === null) return { ok: false, reason: `文档编号不合法：「${String(target?.id ?? '')}」` }
    candidate = join(dirs.abs, docFileName(id))
  } else if (kind === 'preview') {
    const name = String(target?.name ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      return { ok: false, reason: '预览文件名只允许小写字母/数字/短横线（≤64 字符）' }
    }
    candidate = join(dirs.abs, 'preview', `${name}.html`)
  } else if (kind === 'spec') {
    candidate = resolve(cwd, SPEC_RELATIVE)
  } else {
    return { ok: false, reason: `未知写入目标类型：「${String(kind)}」` }
  }

  const inside = assertInsideRoot(cwd, candidate)
  if (!inside.ok) return inside

  const inDocs = inside.rel === dirs.rel || inside.rel.startsWith(`${dirs.rel}/`)
  const isSpec = inside.rel === SPEC_RELATIVE
  if (!inDocs && !isSpec) {
    return { ok: false, reason: `只允许写 ${dirs.rel}/** 与 ${SPEC_RELATIVE}，已拒绝：${inside.rel}` }
  }

  return { ok: true, abs: inside.abs, display: inside.rel }
}

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

function withMeta(id, text) {
  if (META_RE.test(text)) return text
  const stamp = new Date().toISOString()
  return `<!-- flow:doc id="${id}" version="1" updatedAt="${stamp}" -->\n\n${text}`
}

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
      for (const key of [...docCheckCache.keys()]) {
        if (key.startsWith(`${target.abs}|`)) docCheckCache.delete(key)
      }
      created.push(id)
    } catch (error) {
      errors.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { created, skipped, errors }
}

function headingNumbers(text) {
  const found = new Set()
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^#{2,4}\s*0?([0-9]{1,2})[.、:：\s]/)
    if (match !== null) found.add(Number(match[1]))
  }
  return found
}

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

  let stat
  try {
    stat = statSync(target.abs)
    if (!stat.isFile()) throw new Error('not a file')
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

  const cacheKey = `${target.abs}|${docId}|${level}`
  const hit = docCheckCache.get(cacheKey)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.result
  }

  const read = readTextBounded(target.abs, MAX_DOC_BYTES * 2)
  if (!read.ok) {
    return {
      id: docId,
      title,
      exists: true,
      path: target.display,
      bytes: stat.size,
      missing: [...(REQUIRED_SECTIONS[docId] ?? [])],
      reasons: [read.reason],
      ok: false,
    }
  }

  const text = read.text
  const bytes = Buffer.byteLength(text, 'utf8')
  const reasons = []
  const substantive = isDocSubstantive(text, level)
  if (substantive.ok !== true) reasons.push(substantive.reason ?? '内容无效')
  if (!META_RE.test(text)) reasons.push('缺少 flow:doc 元信息头（可由 flow_docs_write 自动补）')

  const found = headingNumbers(text)
  const missing = (REQUIRED_SECTIONS[docId] ?? []).filter(n => !found.has(n))
  if (missing.length > 0) reasons.push(`缺必填章节：${missing.map(n => `§${n}`).join(' ')}`)

  const result = {
    id: docId,
    title,
    exists: true,
    path: target.display,
    bytes,
    missing,
    reasons,
    ok: reasons.length === 0,
  }
  docCheckCache.delete(cacheKey)
  docCheckCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  while (docCheckCache.size > MAX_CHECK_CACHE) {
    const oldest = docCheckCache.keys().next().value
    if (oldest === undefined) break
    docCheckCache.delete(oldest)
  }
  return result
}

export function checkDocs({ config, cwd, ids, level = 'M' }) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeDocId).filter(Boolean))].sort()
  const items = wanted.map(id => checkDoc({ config, cwd, id, level }))
  const failed = items.filter(item => item.ok !== true).map(item => item.id)
  return { items, ok: failed.length === 0, failed }
}

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
    let finalText
    if (mode === 'append' && existsSync(resolved.abs)) {
      const existing = readTextBounded(resolved.abs, MAX_DOC_BYTES)
      if (!existing.ok) return { ok: false, reason: existing.reason }
      finalText = `${existing.text.replace(/\s*$/, '')}\n\n${text}`
    } else {
      finalText = target?.kind === 'preview' ? text : withMeta(resolvedId, text)
    }
    writeAtomic(resolved.abs, finalText)
    for (const key of [...docCheckCache.keys()]) {
      if (key.startsWith(`${resolved.abs}|`)) docCheckCache.delete(key)
    }
    const written = statSync(resolved.abs)
    return { ok: true, path: resolved.display, bytes: written.size }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function docsNote({ config, cwd, level = 'M' }) {
  try {
    if (config?.docs?.enabled === false) return ''
    const def = levelDef(level)
    if (def.docs.length === 0) return ''
    const items = checkDocs({ config, cwd, ids: def.docs, level })
    const ready = items.items.filter(item => item.ok).map(item => item.id)
    const missing = items.failed
    const dirs = docsDirOf(config, cwd)
    const writeHint = config?.docs?.writePolicy === 'ask'
      ? '写文档用 flow_docs_write（缺授权先走 flow_stage_gate kind=permission）'
      : '写文档直接用 flow_docs_write 落盘（白名单限 .flow/docs/** 与 .flow/spec.md，无需写盘授权）'
    const lines = [
      `[Flow 文档] 等级 ${def.id}｜目录 ${dirs.rel}`,
      ready.length === 0 ? '已就绪：无' : `已就绪：${ready.join(' ')}`,
      missing.length === 0 ? '缺：无' : `缺：${missing.join(' ')}`,
      `门禁前必须齐备：${def.docs.join(' ')}（flow_docs_check 逐份校验）`,
      writeHint,
    ]
    return lines.slice(0, 5).join('\n')
  } catch {
    return ''
  }
}

export function readDocText({ config, cwd, id }) {
  const target = resolveTarget({ config, cwd, target: { kind: 'doc', id } })
  if (target.ok !== true) return ''
  const read = readTextBounded(target.abs, MAX_DOC_BYTES * 2)
  return read.ok ? read.text : ''
}

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
    const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…（已截断，完整见文档附件）` : body
    parts.push({ id, title: docTitle(id), chars: body.length })
    blocks.push(`【${id} ${docTitle(id)}】\n${clipped}`)
  }
  return { text: blocks.join('\n\n'), parts }
}

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
    const read = readBufferBounded(target.abs, limitBytes)
    if (!read.ok) {
      skipped.push(`${id}：${read.code === 'ENOENT' ? '尚未落盘' : read.reason}`)
      continue
    }
    attachments.push({
      filename: docFileName(id),
      content: read.content,
      contentType: 'text/markdown; charset=UTF-8',
    })
  }

  for (const raw of Array.isArray(extra) ? extra : []) {
    const rel = String(raw ?? '').trim().replace(/\\/g, '/')
    if (rel === '' || isAbsolute(rel)) {
      skipped.push(`${rel || '(空路径)'}：非法路径`)
      continue
    }
    const checked = assertInsideRoot(cwd, rel)
    if (!checked.ok) {
      skipped.push(`${rel}：${checked.reason}`)
      continue
    }
    const read = readBufferBounded(checked.abs, limitBytes)
    if (!read.ok) {
      skipped.push(`${rel}：${read.code === 'ENOENT' ? '读不到文件' : read.reason}`)
      continue
    }
    attachments.push({
      filename: checked.rel.split('/').pop() ?? rel,
      content: read.content,
      contentType: /\.html?$/i.test(rel) ? 'text/html; charset=UTF-8' : 'application/octet-stream',
    })
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
