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

/** 拼接顺序分隔：空行。 */
const JOINER = '\n\n'

/** 需要注入花名册的模式（与 prompt-store 保持一致）。 */
const ROSTER_MODES = new Set(['flow', 'plan-ultra'])

/**
 * 计算某个模式要注入的运行时上下文正文。
 *
 * 顺序：先按 promptSets 声明顺序拼接“已启用且勾选了该模式”的全局提示词，
 * 再接当前模式的专属提示词，最后（仅 flow / plan-ultra）附上特种兵花名册 ——
 * 模式硬规则压在人设之后，语义优先级更高；花名册放最后，方便按需翻阅。
 *
 * 防御：`off`、未配置的模式、空正文、非字符串输入一律安全退化为 `''`。
 *
 * @param {object} config 已校验的插件配置（可能被部分覆盖）。
 * @param {string} modeId 当前模式。
 * @param {{ mode?: Function, roster?: Function }} [store] 提示词仓库。
 * @returns {string} 可直接作为 systemPrompt.context 文本的字符串；空串表示不注入。
 */
export function buildModeText(config, modeId, store) {
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
