/**
 * 任务复杂度分级（S / M / L）与文档矩阵。
 *
 * v0.6.0 修复：
 * - 修复 B-07：黑盒人工点验门禁（`kind:'acceptance', explicit:['06']`）仅要求 `06` 存在，
 *   不再在白盒 07 尚未开工前死锁拦截；终态验收（未单独限定 `['06']`）仍要求 `06 + 07`；
 * - 支持传入实例级 `stateStore` 持久化会话等级（保留无参内存回退兼容单测）。
 *
 * @module dsh-flow/workflow/level
 */
import { DOC_IDS, normalizeDocId, normalizeLevel } from '../config/constants.js'

const MIN_DOC_CHARS = 200
const fallbackLevels = new Map()

export function rememberLevel(sessionId, level, stateStore) {
  const normalized = normalizeLevel(level)
  const key = String(sessionId ?? '')
  if (key === '') return normalized
  if (typeof stateStore?.setLevel === 'function') stateStore.setLevel(key, normalized)
  fallbackLevels.set(key, normalized)
  if (fallbackLevels.size > 500) {
    const oldest = fallbackLevels.keys().next().value
    if (oldest !== undefined) fallbackLevels.delete(oldest)
  }
  return normalized
}

export function levelOfSession(config, sessionId, explicit, stateStore) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return normalizeLevel(explicit)
  const key = String(sessionId ?? '')
  const persisted = typeof stateStore?.getLevel === 'function' ? stateStore.getLevel(key) : undefined
  if (persisted !== undefined) return normalizeLevel(persisted)
  const remembered = fallbackLevels.get(key)
  if (remembered !== undefined) return remembered
  return normalizeLevel(config?.docs?.level, 'M')
}

export function clearFallbackLevels() {
  fallbackLevels.clear()
}

export const LEVELS = Object.freeze({
  S: {
    id: 'S',
    label: 'S 级·局部改动',
    summary: '局部交互改动 / 单点 Bug：不做产品调研、不发通知，但必须 1 轮交互与呈现细节确认',
    docs: Object.freeze([]),
    gates: Object.freeze(['confirm']),
    stops: 1,
    notify: Object.freeze([]),
    minDocChars: MIN_DOC_CHARS,
  },
  M: {
    id: 'M',
    label: 'M 级·中型功能',
    summary: '独立新模块 / 中型功能：需求深挖 → 精写 01+03 → 05 定稿 → 黑盒 06 → 白盒 07',
    docs: Object.freeze(['01', '03', '05', '06', '07']),
    gates: Object.freeze(['tech-env', 'dev-spec', 'acceptance']),
    stops: 2,
    notify: Object.freeze(['03', '05', 'acceptance']),
    minDocChars: MIN_DOC_CHARS,
  },
  L: {
    id: 'L',
    label: 'L 级·从零/重构',
    summary: '从零建项目 / 架构重构：01–07 全套编号文档、全过程通知与 Plan Ultra 审计询问',
    docs: Object.freeze([...DOC_IDS]),
    gates: Object.freeze(['tech-env', 'ui-spec', 'dev-spec', 'acceptance']),
    stops: 3,
    notify: Object.freeze(['03', '04', '05', 'acceptance']),
    minDocChars: MIN_DOC_CHARS,
  },
})

export function levelDef(level) {
  return LEVELS[normalizeLevel(level)] ?? LEVELS.M
}

export function requiredDocsOf(level) {
  return [...levelDef(level).docs]
}

export function gateRequiredDocs({ level, kind = 'stage', fromStage = '', nextMode = '', explicit = [] } = {}) {
  const def = levelDef(level)
  const required = new Set()
  const explicitNorm = (Array.isArray(explicit) ? explicit : []).map(normalizeDocId).filter(Boolean)

  if (kind === 'stage' && nextMode !== 'flow' && (nextMode === 'build' || nextMode === 'review')) {
    const base = def.id === 'L' ? ['01', '02', '03', '04', '05'] : def.id === 'M' ? ['01', '03', '05'] : []
    for (const id of base) required.add(id)
  }
  if (kind === 'acceptance' && def.id !== 'S') {
    // 黑盒第一棒人工点验门禁（仅声明了 06）：此时白盒 07 尚未开工，不应强制拦截 07。
    const isBlackboxOnly = explicitNorm.length === 1 && explicitNorm[0] === '06'
    required.add('06')
    if (!isBlackboxOnly) required.add('07')
  }

  for (const id of explicitNorm) required.add(id)

  void fromStage
  return [...required].sort()
}

export function shouldDeliverDocs({ kind = 'stage', docIds = [] } = {}) {
  const ids = (Array.isArray(docIds) ? docIds : []).map(normalizeDocId).filter(Boolean)
  if (kind === 'permission' || kind === 'blocker') return { deliver: false, reason: '提权/阻断门禁不附带编号文档' }
  if (ids.length === 0) return { deliver: false, reason: '未声明文档' }
  if (ids.every(id => id === '01')) return { deliver: false, reason: '01 需求阶段按约定不主动投递邮件附件' }
  return { deliver: true, reason: '按投递矩阵主动投递' }
}

export function notifyNodesOf(level) {
  return [...levelDef(level).notify]
}

export function describeLevel(level) {
  const def = levelDef(level)
  const docs = def.docs.length === 0 ? '无编号文档' : `文档 ${def.docs.join('/')}`
  return `${def.label}：${def.summary}（${docs}；人工停点 ${def.stops} 次）`
}

export function isDocSubstantive(content, level) {
  const text = typeof content === 'string' ? content : ''
  if (text.trim() === '') return { ok: false, reason: '内容为空' }
  const def = levelDef(level)
  if (text.trim().length < def.minDocChars) {
    return { ok: false, reason: `内容过短（${text.trim().length} < ${def.minDocChars} 字符），像空壳骨架` }
  }
  if (/（待填写）|TODO:\s*填写|<!--\s*pending\s*-->/i.test(text)) {
    return { ok: false, reason: '仍含未替换的占位符' }
  }
  return { ok: true }
}
