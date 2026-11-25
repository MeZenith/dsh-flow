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
import { COMPACT_MESSAGES } from './compact-bridge.js'

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
export function createFlowCommand({ ctx, getConfig, readMode, bridge, logger, breaker, im, email, prompts }) {
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

  /**
   * `/flow prompts list`：列出版本、五大模式来源与特种兵清单。
   *
   * @param {object} store 提示词仓库。
   * @returns {string}
   */
  function promptsText(store) {
    const info = store.info()
    const lines = []
    lines.push(`提示词目录：${info.root}`)
    lines.push(`版本：${info.version}${info.updatedAt !== '' ? `（${info.updatedAt}）` : ''}｜清单条目 ${info.fileCount} 个`)
    lines.push(`底座契约来源：${info.base.label}${info.base.exists ? '' : '（文件缺失，已回落兜底）'}`)
    lines.push('', '五大模式来源：')
    for (const item of info.modes) {
      lines.push(`- ${item.id}：${item.label}${item.exists ? '' : '（md 缺失，已回落）'}`)
    }
    lines.push('', '官方特种兵：')
    for (const item of info.official) {
      lines.push(`- ${item.name}：${item.title || '（无标题）'}${item.exists ? '' : '（缺失）'}`)
    }
    lines.push('', `私有特种兵（${info.custom.length} 个）：`)
    if (info.custom.length === 0) {
      lines.push(`- 暂无。把 .md 放进 ${info.customDir} 即可，一键更新不会碰它。`)
    } else {
      for (const item of info.custom) lines.push(`- ${item.name}：${item.title || '（无标题）'}`)
    }
    lines.push('', '更新：`/flow prompts update` 拉远端最新版（不覆盖私有目录，也不改你的手改覆盖）')
    return lines.join('\n')
  }

  return {
    definitionId: COMMAND_ID,
    name: COMMAND_NAME,
    description: '切换 Flow 工作流模式（off / plan / plan-ultra / build / review / flow），或用 spec / compact 查看方案锚点与手动压缩，prompts list|update 查看与更新提示词库，retry / escalate / resume 处理熔断，notify-test 自检通知链路',
    input: { hint: '<mode> | status | spec | compact | prompts list|update | retry | escalate | resume | notify-test' },
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
          return { kind: 'error', text: COMPACT_MESSAGES.unavailable }
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

      // ---- 动作：熔断抢救 ----
      if (head === 'retry' || head === 'escalate' || head === 'resume') {
        if (breaker === undefined) {
          return { kind: 'error', text: '熔断器未装配（S3 未启用）。' }
        }
        if (head === 'retry') {
          breaker.retry(agent)
          return { kind: 'success', text: '已清零连续报错计数，并用当前模型重新投递上一条要求。' }
        }
        if (head === 'escalate') {
          const switched = await breaker.escalate(agent, signal)
          return {
            kind: 'success',
            text: switched
              ? '已切到救场强模型，并带报错摘要重新投递上一条要求。'
              : '没有可用的救场强模型（未配置或不可解析），已按当前模型重新投递。',
          }
        }
        breaker.resume(agent)
        return { kind: 'success', text: '已解除熔断暂停状态，等待你的新指令。' }
      }

      // ---- 动作：提示词清单 / 一键更新（S4）----
      if (head === 'prompts') {
        if (prompts?.store === undefined) {
          return { kind: 'error', text: '提示词仓库未装配，无法处理 prompts 子命令。' }
        }
        const sub = arg.split(/\s+/)[1] ?? 'list'
        if (sub === 'update') {
          if (typeof prompts.update !== 'function') {
            return { kind: 'error', text: '更新器未装配。' }
          }
          const { result, text } = await prompts.update(signal)
          return { kind: result.ok === true ? 'success' : 'error', text }
        }
        return { kind: 'success', text: promptsText(prompts.store) }
      }

      // ---- 动作：通知链路自检 ----
      if (head === 'notify-test') {
        if (im === undefined || email === undefined) {
          return { kind: 'error', text: '通知渠道未装配（S3 未启用）。' }
        }
        const imResult = await im.test()
        const emailResult = await email.test()
        const lines = [
          `IM：${imResult.ok ? '成功' : '失败'} — ${imResult.detail}`,
          `邮箱：${emailResult.ok ? '成功' : '失败'} — ${emailResult.detail}`,
        ]
        const bots = await im.listBots()
        if (bots.length > 0) {
          lines.push('', '已配置机器人：')
          for (const bot of bots) {
            const targets = await im.listTargets(bot.botId)
            const names = targets.map(item => item.targetId).filter(Boolean).join('、')
            lines.push(`- ${bot.botId}${bot.channel ? `（${bot.channel}）` : ''}${names === '' ? '' : ` → ${names}`}`)
          }
        } else {
          lines.push('', 'dsh-im 未返回机器人列表：可在「IM机器人」设置页确认连接，或改用 Webhook。')
        }
        return { kind: 'success', text: lines.join('\n') }
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
