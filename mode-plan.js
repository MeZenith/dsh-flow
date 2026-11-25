/**
 * 纯函数：由配置 + 当前模式计算“该注入什么文本”。
 *
 * 不做 IO、不碰 ctx，便于单测与快速回归。
 *
 * @module dsh-flow/mode-plan
 */
import { isPromptMode, modeConfigOf } from './modes.js'

/** 拼接顺序分隔：空行。 */
const JOINER = '\n\n'

/**
 * 计算某个模式要注入的运行时上下文正文。
 *
 * 顺序：先按 promptSets 声明顺序拼接“已启用且勾选了该模式”的全局提示词，
 * 再接当前模式的专属提示词 —— 模式硬规则压在人设之后，语义优先级更高。
 *
 * 防御：`off`、未配置的模式、空正文、非字符串输入一律安全退化为 `''`。
 *
 * @param {object} config 已校验的插件配置（可能被部分覆盖）。
 * @param {string} modeId 当前模式。
 * @returns {string} 可直接作为 systemPrompt.context 文本的字符串；空串表示不注入。
 */
export function buildModeText(config, modeId) {
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

  const own = modeConfigOf(config, modeId).prompt.trim()
  if (own !== '') parts.push(own)

  return parts.join(JOINER)
}

/**
 * 当前模式是否真的会产生注入内容，供 Host 侧做无谓注册的短路判断。
 * @param {object} config
 * @param {string} modeId
 * @returns {boolean}
 */
export function hasModeText(config, modeId) {
  return buildModeText(config, modeId) !== ''
}
