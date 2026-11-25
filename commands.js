/**
 * `/flow` 命令：模式切换的**人类入口**。
 *
 * 为什么走命令而不是自有 Remote：命令是原生通道（`SessionFace.command()` 已存在），
 * 且 `command/run` 是 log-only 事件 —— 既能让 `flowMode` 投影从日志派生，
 * 又不需要 Typert 构建期 codegen。代价是每次切换在对话里留一条命令行，
 * 与原生 `/permission` 芯片完全同构（后者同样走命令）。
 *
 * S2 起本命令不再自己实现切换事务：`switch-mode.js` 是命令与两个工具共用的唯一实现，
 * 避免两套逻辑漂移。这里只负责解析参数、调用事务、组织回执。
 *
 * @module dsh-flow/commands
 */
import {
  MODE_OFF, modeConfigOf, parseModeArg,
} from './modes.js'
import { applyModeSwitch } from './switch-mode.js'
import { inspectSpec } from './spec-anchor.js'

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'flow'

/** 命令定义 ID。 */
export const COMMAND_ID = 'dsh-flow'

/** 状态类参数的别名：只回报当前模式，不改变任何状态。 */
const STATUS_TOKENS = new Set(['', 'status', 'list', '?'])

/** 可选项提示串。 */
function choicesText() {
  return ['off', 'plan', 'plan-ultra', 'build', 'review', 'flow', 'spec', 'compact'].join(' / ')
}

/** 字节数转人类可读。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * 构造命令定义。
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getConfig: () => object,
 *   readMode: (session: object) => string,
 *   bridge: { runNow: (agent: object, signal: AbortSignal) => Promise<object> },
 *   logger?: { warn: (msg: string) => void },
 * }} deps
 * @returns {object} 交给 `ctx.commands.register()` 的定义。
 */
export function createFlowCommand({ ctx, getConfig, readMode, bridge, logger }) {
  /** 当前模式的回执文案。 */
  function statusText(agent, config) {
    const current = readMode(agent.session)
    const label = current === MODE_OFF ? '普通模式（off）' : modeConfigOf(config, current).label
    return `Flow 当前模式：${label}｜可选：${choicesText()}`
  }

  /** `/flow spec`：只看方案锚点状态，不读盘两次（inspectSpec 内部有缓存）。 */
  function specText(agent, config) {
    const spec = inspectSpec({ agent, config })
    if (!spec.enabled) {
      return `方案锚点已关闭（设置里 spec.enabled = false）。路径：${spec.display}`
    }
    if (!spec.exists) {
      return `方案锚点：${spec.display} 尚未创建。需要时由你自己建立该文件，插件不会自动创建。`
    }
    const mark = spec.fromMarkedBlock ? '来自 <!-- flow:summary --> 摘要块' : '取自正文前段'
    const preview = spec.summary.split('\n').slice(0, 6).join('\n')
    return [
      `方案锚点：${spec.display}（${formatBytes(spec.bytes)}），摘要${mark}：`,
      preview,
    ].join('\n')
  }

  return {
    definitionId: COMMAND_ID,
    name: COMMAND_NAME,
    description: '切换 Flow 工作流模式（off / plan / plan-ultra / build / review / flow），或用 spec / compact 查看方案锚点与手动压缩',
    input: { hint: '<mode> | status | spec | compact' },
    // 保留 args：`flowMode` 投影正是从 command/run 的 args 派生当前模式。
    recordInput: true,

    async handler({ agent, rawInput, signal }) {
      const config = getConfig()
      const arg = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
      const head = arg.split(/\s+/)[0] ?? ''

      // ---- 只读：查看方案锚点 ----
      if (head === 'spec') return { kind: 'success', text: specText(agent, config) }

      // ---- 动作：手动压缩 ----
      if (head === 'compact') {
        if (typeof bridge?.runNow !== 'function') {
          return { kind: 'error', text: 'compaction 服务不可用，无法压缩。' }
        }
        // 命令不持有回合，天然处于 idle；`runNow` 内部仍会按错误码回报 busy。
        const outcome = await bridge.runNow(agent, signal)
        if (outcome.ok === true) {
          const result = outcome.result
          if (result === null || result === undefined) {
            return { kind: 'success', text: '没有可压缩的历史。' }
          }
          const shadowed = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
          const tokens = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0
          return {
            kind: 'success',
            text: `已压缩 ${shadowed} 条历史（约 ${tokens} tokens）。`,
            ...(typeof result.summarySeq === 'number' ? { sourceEventSeq: result.summarySeq } : {}),
          }
        }
        return { kind: 'error', text: outcome.text }
      }

      // ---- 只读：当前模式 ----
      if (STATUS_TOKENS.has(head)) {
        return { kind: 'success', text: statusText(agent, config) }
      }

      // ---- 切换 ----
      const target = parseModeArg(arg)
      if (target === null) {
        return {
          kind: 'error',
          text: `未知参数 "${arg}"。可选：${choicesText()}`,
        }
      }

      const applied = await applyModeSwitch({
        ctx,
        config,
        agent,
        modeId: target,
        signal,
        logger,
      })

      const detail = applied.notes.length === 0 ? '' : `（${applied.notes.join('｜')}）`
      const announce = config?.behavior?.announce !== false
      if (target === MODE_OFF) {
        return {
          kind: 'success',
          text: announce
            ? `已关闭 Flow 模式提示词${detail}（权限与模型保持不变）`
            : '已关闭 Flow 模式提示词（权限与模型保持不变）',
        }
      }
      return {
        kind: 'success',
        text: announce ? `Flow 模式：${applied.label}${detail}` : `Flow 模式：${applied.label}`,
      }
    },
  }
}
