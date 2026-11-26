/**
 * 纯函数：由配置 + 当前模式计算“该注入什么文本”。
 *
 * 不做落盘；读文件的能力由调用方以 `store` 注入，便于单测与快速回归。
 *
 * S4 变化：模式正文与花名册都改由 `prompt-store` 提供（三层回落 + mtime 热加载），
 * 这里只负责拼接顺序与"哪些模式要注入花名册"。
 *
 * @module dsh-flow/mode-plan
 */
import { isPromptMode, modeConfigOf } from './modes.js'
import { gateRequiredDocs, levelDef, levelOfSession, notifyNodesOf } from './flow-level.js'

/** 拼接顺序分隔：空行。 */
const JOINER = '\n\n'

/** 需要注入花名册的模式（与 prompt-store 保持一致）。 */
const ROSTER_MODES = new Set(['flow', 'plan-ultra'])

/**
 * 生成"当前等级 + 必做文档 + 门禁要求"的动态块。
 *
 * **唯一来源是 `flow-level.js`**：提示词正文里不写死文档清单，页面注入什么就按什么做；
 * 这样改等级矩阵只需改一处，不会出现"提示词要 01–05、门禁只查 03"的漂移。
 *
 * @param {object} config 插件配置。
 * @param {string} [sessionId] 会话 ID（用于读取用户选定/升降过的等级）。
 * @returns {string} 形如 `[Flow 等级与文档] …` 的多行文本；S 级也返回（说明不需要文档）。
 */
export function buildLevelBlock(config, sessionId) {
  const level = levelOfSession(config, sessionId)
  const def = levelDef(level)
  const docs = def.docs.length === 0 ? '无（S 级不产编号文档）' : def.docs.join(' ')
  const buildGate = gateRequiredDocs({ level, kind: 'stage', nextMode: 'build' })
  const acceptGate = gateRequiredDocs({ level, kind: 'acceptance' })
  const notify = notifyNodesOf(level)
  return [
    `[Flow 等级与文档] 等级 ${def.id}｜人工停点 ${def.stops} 次`,
    `必做文档：${docs}`,
    buildGate.length === 0 ? '切 Build 门禁：S 级不校验文档' : `切 Build 前必须齐备：${buildGate.join(' ')}`,
    acceptGate.length === 0 ? '验收门禁：S 级不校验文档' : `验收门禁必须齐备：${acceptGate.join(' ')}`,
    notify.length === 0 ? '通知节点：无（S 级不发通知）' : `通知节点：${notify.join(' / ')}（03 起主动投递文档）`,
    '写文档前先 flow_docs_check 自检；缺文档门禁会直接拦下。',
  ].join('\n')
}

/**
 * 计算某个模式要注入的运行时上下文正文。
 *
 * 顺序：先按 promptSets 声明顺序拼接"已启用且勾选了该模式"的全局提示词，
 * 再接当前模式的专属提示词，然后（仅 flow / plan-ultra）附上特种兵花名册，
 * 最后追加等级/文档/门禁动态块（与 `flow-level.js` 同源）。
 *
 * 防御：`off`、未配置的模式、空正文、非字符串输入一律安全退化为 `''`。
 *
 * @param {object} config 已校验的插件配置（可能被部分覆盖）。
 * @param {string} modeId 当前模式。
 * @param {{ mode?: Function, roster?: Function }} [store] 提示词仓库。
 * @param {{ sessionId?: string }} [context] 会话上下文（用于等级）。
 * @returns {string} 可直接作为 systemPrompt.context 文本的字符串；空串表示不注入。
 */
export function buildModeText(config, modeId, store, context = {}) {
  if (!isPromptMode(modeId)) return ''

  const parts = []
  const sets = Array.isArray(config?.promptSets) ? config.promptSets : []
  for (const set of sets) {
    if (set === null || typeof set !== 'object') continue
    if (set.enabled === false) continue
    const text = typeof set.text === 'string' ? set.text.trim() : ''
    if (text === '') continue
    const modes = Array.isArray(set.modes) ? set.modes : []
    if (!modes.includes(modeId)) continue
    parts.push(text)
  }

  // 模式正文：优先用 store（配置覆盖 → 本地 md → 内置兜底），无 store 时退回配置值。
  const fromStore = typeof store?.mode === 'function' ? store.mode(modeId).text : undefined
  const own = (typeof fromStore === 'string' ? fromStore : modeConfigOf(config, modeId).prompt).trim()
  if (own !== '') parts.push(own)

  // 渐进式披露：只给花名册，不给特种兵正文。
  if (ROSTER_MODES.has(modeId) && typeof store?.roster === 'function') {
    const roster = store.roster().trim()
    if (roster !== '') parts.push(roster)
  }

  const levelBlock = buildLevelBlock(config, context?.sessionId)
  if (levelBlock !== '') parts.push(levelBlock)

  return parts.join(JOINER)
}

/**
 * 当前模式是否真的会产生注入内容，供 Host 侧做无谓注册的短路判断。
 * @param {object} config
 * @param {string} modeId
 * @param {{ mode?: Function, roster?: Function }} [store]
 * @returns {boolean}
 */
export function hasModeText(config, modeId, store) {
  return buildModeText(config, modeId, store) !== ''
}

/** Flow 托管档位：一次拍板全托管（默认）或每阶段确认。 */
export const AUTONOMY_CHOICES = Object.freeze(['one-gate', 'step-by-step'])

/**
 * 读取当前托管档位（配置缺失时按默认 `one-gate`）。
 * @param {object} config
 * @returns {'one-gate'|'step-by-step'}
 */
export function autonomyOf(config) {
  const value = config?.behavior?.flowAutonomy
  return value === 'step-by-step' ? 'step-by-step' : 'one-gate'
}
