/**
 * 任务复杂度分级（S / M / L）与文档矩阵。
 *
 * 这一份是本插件里"等级 → 要做哪些文档、在哪些门禁前必须齐备、哪些节点要通知"的
 * **唯一来源**：提示词（`prompts/modes/*.md`）、`flow:docs` 便利贴、`flow_stage_gate`
 * 的拦截判断全部读这里，避免"文档里写 S/M/L 一套、代码里判断另一套"的经典漂移。
 *
 * 纯函数、零依赖、无副作用，便于单测与快照断言。
 *
 * @module dsh-flow/flow-level
 */
import { DOC_IDS, normalizeDocId, normalizeLevel } from './modes.js'

/** 单份文档的最短有效长度（字符）：低于它视为"空壳"。 */
const MIN_DOC_CHARS = 200

/**
 * 会话等级记忆：`sessionId → S|M|L`。
 *
 * 放在这里（而不是 `tools.js` 内部）是因为 `prompt-bridge.js` 的 `flow:docs` 便利贴
 * 也要读同一个值 —— 提示词说"你是 M 级要写 5 份文档"、工具却按 S 级放行，是最难查的漂移。
 */
const sessionLevels = new Map()

/**
 * 记一次等级（路由工具选中或用户升降级后调用）。
 * @param {string} sessionId
 * @param {string} level
 * @returns {string} 归一后的等级
 */
export function rememberLevel(sessionId, level) {
  const normalized = normalizeLevel(level)
  const key = String(sessionId ?? '')
  if (key !== '') sessionLevels.set(key, normalized)
  return normalized
}

/**
 * 读会话等级：显式入参 > 会话记忆 > 配置默认 > M。
 * @param {object} config
 * @param {string} sessionId
 * @param {string} [explicit]
 * @returns {string}
 */
export function levelOfSession(config, sessionId, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return normalizeLevel(explicit)
  const remembered = sessionLevels.get(String(sessionId ?? ''))
  if (remembered !== undefined) return remembered
  return normalizeLevel(config?.docs?.level, 'M')
}

/**
 * 三个等级的定义。
 *
 * - `docs`：该等级**全流程**需要的文档（不含 `01` 单发的例外逻辑）。
 * - `stops`：需要人工拍板的门禁数量（S 级只有 1 次交互确认，不产文档）。
 * - `notify`：需要主动投递（邮件/IM）的门禁点。
 */
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

/**
 * 读取等级定义；未知等级回落到 M（宁可多要文档，不要漏）。
 *
 * @param {string} level
 * @returns {{ id: string, label: string, summary: string, docs: readonly string[], gates: readonly string[], stops: number, notify: readonly string[], minDocChars: number }}
 */
export function levelDef(level) {
  return LEVELS[normalizeLevel(level)] ?? LEVELS.M
}

/**
 * 该等级需要的全部文档编号（全集，用于"还差哪些"的进度展示）。
 * @param {string} level
 * @returns {string[]}
 */
export function requiredDocsOf(level) {
  return [...levelDef(level).docs]
}

/**
 * 单个门禁前必须齐备的文档。
 *
 * 规则（与 `.flow/docs/05` 的投递矩阵一一对应）：
 * - `permission` / `blocker`：不要求文档（提权与外部阻断本身就不产文档）；
 * - `acceptance`：M/L 都要 `06` + `07`（白盒报告即使是"本轮无缺陷"也要落盘）；
 * - `stage` 且目标是 Build / Review：M 要 `01 03 05`，L 要 `01 02 03 04 05`；
 * - 其余（回 Plan / off、切 plan-ultra 等）：不要求。
 *
 * @param {{ level?: string, kind?: string, fromStage?: string, nextMode?: string, explicit?: string[] }} input
 * @returns {string[]} 去重后的文档编号
 */
export function gateRequiredDocs({ level, kind = 'stage', fromStage = '', nextMode = '', explicit = [] } = {}) {
  const def = levelDef(level)
  const required = new Set()

  // `flow` = Flow 总控推进内部阶段（不切出模式），文档要求由调用方用 `docIds` 显式声明；
  // 这里不按 nextMode 推导，否则"03 阶段门禁"会被误要求 05。
  if (kind === 'stage' && nextMode !== 'flow' && (nextMode === 'build' || nextMode === 'review')) {
    const base = def.id === 'L' ? ['01', '02', '03', '04', '05'] : def.id === 'M' ? ['01', '03', '05'] : []
    for (const id of base) required.add(id)
  }
  if (kind === 'acceptance' && def.id !== 'S') {
    required.add('06')
    required.add('07')
  }

  // 显式声明的文档一律要校验存在性（用户说"这次必须带 05"就真的必须带）。
  for (const raw of Array.isArray(explicit) ? explicit : []) {
    const id = normalizeDocId(raw)
    if (id !== null) required.add(id)
  }

  // 阶段切换本身不影响 `fromStage` 的文档要求，保留参数是为了未来按来源阶段区分。
  void fromStage
  return [...required].sort()
}

/**
 * 门禁是否要主动投递文档（邮件 + IM 摘要）。
 *
 * 投递矩阵：`01` 永不主动发（用户要求：需求确认阶段不发）；`03/04/05/06/07`
 * 在门禁待拍板时主动投递；`permission` / `blocker` 不投。
 *
 * @param {{ kind?: string, docIds?: string[] }} input
 * @returns {{ deliver: boolean, reason: string }}
 */
export function shouldDeliverDocs({ kind = 'stage', docIds = [] } = {}) {
  const ids = (Array.isArray(docIds) ? docIds : []).map(normalizeDocId).filter(Boolean)
  if (kind === 'permission' || kind === 'blocker') return { deliver: false, reason: '提权/阻断门禁不投递文档' }
  if (ids.length === 0) return { deliver: false, reason: '未声明文档' }
  if (ids.every(id => id === '01')) return { deliver: false, reason: '01 需求阶段按约定不主动投递' }
  return { deliver: true, reason: '按投递矩阵主动投递' }
}

/**
 * 该等级需要主动通知（邮件/IM）的门禁点，用于提示词里的流程说明。
 * @param {string} level
 * @returns {string[]}
 */
export function notifyNodesOf(level) {
  return [...levelDef(level).notify]
}

/**
 * 生成一句人话的等级说明（提示词与工具回执共用）。
 * @param {string} level
 * @returns {string}
 */
export function describeLevel(level) {
  const def = levelDef(level)
  const docs = def.docs.length === 0 ? '无编号文档' : `文档 ${def.docs.join('/')}`
  return `${def.label}：${def.summary}（${docs}；人工停点 ${def.stops} 次）`
}

/**
 * 按等级判断一份文档内容是否"有效"（非空壳）。
 *
 * 只做长度与占位符检查；章节齐全度由 `flow-docs.js` 的 `checkDoc()` 负责。
 *
 * @param {string} content
 * @param {string} level
 * @returns {{ ok: boolean, reason?: string }}
 */
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
