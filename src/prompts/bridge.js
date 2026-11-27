/**
 * 提示词注入桥：一个永不变的全局 section + 每个 Agent 三个动态 context。
 *
 * v0.6.0 修复：
 * - B-04：`attachAgentModeContext` 支持并正确传递 `agent.session?.id` 与 `stateStore`，
 *   确保会话级 S/M/L 等级变化立即反映到模式提示词块中。
 *
 * @module dsh-flow/prompts/bridge
 */
import { buildModeText } from '../modes/planner.js'
import { isPromptMode } from '../modes/registry.js'
import { buildSpecNote } from '../modes/spec-anchor.js'
import { docsNote } from '../workflow/docs.js'
import { levelOfSession } from '../workflow/level.js'

/** 全局底座 section 的名字。 */
export const BASE_SECTION = 'flow:base'

/** 每个 Agent 的模式 context 名字。 */
export const MODE_CONTEXT = 'flow:mode'

/** 模式 context 排序：排在所有内置 runtime context 之后。 */
const MODE_CONTEXT_ORDER = 500

/** 每个 Agent 的方案锚点 context 名字。 */
export const SPEC_CONTEXT = 'flow:spec'
const SPEC_CONTEXT_ORDER = 300

/** 每个 Agent 的文档进度 context 名字（声明在 PROMPT_NAMES 之前，避免 TDZ）。 */
export const DOCS_CONTEXT = 'flow:docs'
const DOCS_CONTEXT_ORDER = 380

/** 幂等拆除用的名字常量。 */
export const PROMPT_NAMES = Object.freeze({ BASE_SECTION, MODE_CONTEXT, SPEC_CONTEXT, DOCS_CONTEXT })

/** 注册全局底座 section。 */
export function installBaseSection(ctx, source) {
  const order = (() => {
    try {
      return ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY') + 1
    } catch {
      return -999
    }
  })()

  return ctx.systemPrompt.section({
    name: BASE_SECTION,
    order,
    text: () => {
      const resolved = source.getConfig()?.baseRules
      const override = typeof resolved === 'string' && resolved.trim() !== '' ? resolved : undefined
      if (override !== undefined) return override
      return typeof source.store?.base === 'function' ? source.store.base().text : ''
    },
    interpolate: false,
  })
}

/** 为一个 Agent 注册模式 context。 */
export function attachAgentModeContext(agentCtx, source) {
  return agentCtx.systemPrompt.context({
    name: MODE_CONTEXT,
    order: MODE_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: () => buildModeText(source.getConfig(), source.getMode(), source.store, {
      sessionId: source.agent?.session?.id,
      stateStore: source.stateStore,
    }),
  })
}

/** 为一个 Agent 注册方案锚点 context（off 模式下静默不注入）。 */
export function attachAgentSpecContext(agentCtx, source) {
  return agentCtx.systemPrompt.context({
    name: SPEC_CONTEXT,
    order: SPEC_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: () => {
      const config = source.getConfig()
      const modeId = source.getMode()
      if (!isPromptMode(modeId)) return ''
      const label = typeof config?.modes?.[modeId]?.label === 'string' ? config.modes[modeId].label : modeId
      return buildSpecNote({ agent: source.agent, config, modeId, modeLabel: label })
    },
  })
}

/** 为一个 Agent 注册文档进度便利贴（≤5 行；模板正文永不进提示词；off 模式下不注入）。 */
export function attachAgentDocsContext(agentCtx, source) {
  return agentCtx.systemPrompt.context({
    name: DOCS_CONTEXT,
    order: DOCS_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: () => {
      try {
        if (typeof source.getMode === 'function' && !isPromptMode(source.getMode())) return ''
        const config = source.getConfig()
        const cwd = source.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return ''
        const sessionId = String(source.agent?.session?.id ?? '')
        return docsNote({
          config,
          cwd,
          level: levelOfSession(config, sessionId, undefined, source.stateStore),
        })
      } catch {
        return ''
      }
    },
  })
}
