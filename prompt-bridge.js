/**
 * 提示词注入桥：一个永不变的全局 section + 每个 Agent 一个动态 context。
 *
 * 分层策略（对应 Prefix Caching 红线）：
 * - 底座契约走 `systemPrompt.section()`，`order` 取固定最小值，**永不变动**，
 *   因此 system 节点 0 的文本字节级稳定，前缀缓存长期命中。
 * - 模式相关内容（勾选的全局提示词 + 模式专属提示词）走 `systemPrompt.context()`，
 *   `text` 是函数，每次装配/准入重新求值；它渲染成追加在末尾的
 *   `<system-reminder>` user 消息，**不动节点 0**。
 * - 切换模式因此**不需要重注册任何东西**：下一 step 的 `refreshContext()` 会自动拿到新文本，
 *   且 `RuntimeContextProjection` 只在内容变化时才追加新快照。
 *
 * @module dsh-flow/prompt-bridge
 */
import { buildModeText } from './mode-plan.js'

/** 全局底座 section 的名字（唯一，重复注册会抛错）。 */
export const BASE_SECTION = 'flow:base'

/** 每个 Agent 的模式 context 名字（scoped，按作用域隔离，同名会遮蔽全局）。 */
export const MODE_CONTEXT = 'flow:mode'

/**
 * 模式 context 在运行时上下文快照里的位置：排在所有内置 runtime context 之后
 * （内置最大为 WEB_SURFACE = 210），让模式硬规则压在人设与运行事实之后。
 */
const MODE_CONTEXT_ORDER = 500

/**
 * 注册全局底座 section。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {() => object} getConfig 读取当前配置的函数。
 * @returns {() => void} disposer。
 */
export function installBaseSection(ctx, getConfig) {
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
    // 函数形式：配置被编辑（插件重启后）也能拿到最新值；空串会被 renderPrompt 自动丢弃。
    text: () => {
      const value = getConfig()?.baseRules
      return typeof value === 'string' ? value : ''
    },
    // 用户可自由编辑正文；关掉插值，避免正文里出现 `{{...}}` 时把请求打挂。
    interpolate: false,
  })
}

/**
 * 为一个 Agent 注册模式 context。
 *
 * 必须在 `agent.ctx` 上注册：Agent 释放时自动清理；同时调用方要把返回的 disposer
 * 也挂到自己的 effect 上（双所有者），插件卸载时同样能清干净。
 *
 * @param {import('@deepseek-ai/cordis').Context} agentCtx `agent.ctx`。
 * @param {{ getConfig: () => object, getMode: () => string }} source 取值来源。
 * @returns {() => void} disposer。
 */
export function attachAgentModeContext(agentCtx, source) {
  return agentCtx.systemPrompt.context({
    name: MODE_CONTEXT,
    order: MODE_CONTEXT_ORDER,
    // required：即使某个组合关掉了可选 runtime context，模式约束仍然生效。
    required: true,
    interpolate: false,
    text: () => buildModeText(source.getConfig(), source.getMode()),
  })
}

/** 幂等拆除用的名字常量，供调用方核对。 */
export const PROMPT_NAMES = Object.freeze({ BASE_SECTION, MODE_CONTEXT })
