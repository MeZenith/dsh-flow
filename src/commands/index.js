/**
 * `/flow` 主命令入口：分发模式切换、门禁、文档、提示词、飞书与运维子命令。
 *
 * @module dsh-flow/commands
 */
import { MODE_OFF } from '../config/constants.js'
import { modeConfigOf, parseModeArg } from '../modes/registry.js'
import { applyModeSwitch } from '../modes/switcher.js'
import { levelOfSession } from '../workflow/level.js'
import { handleGateCommand } from './gate.js'
import { handleDocsCommand, handleSpecCommand } from './docs.js'
import { handlePromptsCommand } from './prompts.js'
import {
  handleBreakerCommand, handleCompactCommand, handleFeishuCommand, handleHelpCommand, handleNotifyTestCommand,
} from './ops.js'

export const COMMAND_NAME = 'flow'
export const COMMAND_ID = 'dsh-flow'

const STATUS_TOKENS = new Set(['', 'status', 'list', '?'])

function choicesText() {
  return ['off', 'plan', 'plan-ultra', 'build', 'review', 'flow', 'spec', 'compact', 'feishu', 'help'].join(' / ')
}

export function createFlowCommand({
  ctx, getConfig, readMode, bridge, logger, breaker, im, email, prompts, tickets, settler, gateRouter, feishu, stateStore,
}) {
  async function statusText(agent, config) {
    const sessionId = String(agent.session?.id ?? '')
    const current = readMode(agent.session)
    const label = current === MODE_OFF ? '普通模式（off）' : modeConfigOf(config, current).label
    const level = levelOfSession(config, sessionId, undefined, stateStore)
    const openGates = tickets?.openFor?.(sessionId) ?? []
    const locked = breaker?.isLocked?.(agent) === true
    let feishuText = '未启用'
    if (feishu !== undefined) {
      try {
        const st = await feishu.status()
        feishuText = st.connected ? `🟢 已连接（${st.localAlias || st.botName}）` : (st.enabled ? `🟡 ${st.state}` : '未启用')
      } catch { feishuText = '未知' }
    }
    return [
      `Flow 当前模式：${label}｜任务等级：${level}｜写文档策略：${config?.docs?.writePolicy === 'ask' ? 'ask' : 'auto'}`,
      `待决门禁：${openGates.length === 0 ? '无' : openGates.map(t => `#${t.id}`).join(' ')}｜熔断态：${locked ? '🔴 已锁定' : '正常'}｜飞书直连：${feishuText}`,
      `可选：${choicesText()}`,
    ].join('\n')
  }

  return {
    definitionId: COMMAND_ID,
    name: COMMAND_NAME,
    description: '切换 Flow 工作流模式（off/plan/plan-ultra/build/review/flow），管理门禁、编号文档、提示词库、熔断抢救与直连飞书指挥官',
    input: { hint: '<mode> | status | help | gate ... | docs ... | spec | compact | prompts list|update | feishu status|connect|test | retry | escalate | resume | notify-test' },
    recordInput: true,

    async handler({ agent, rawInput, signal }) {
      const config = getConfig()
      // 保留原始大小写给需要用户附带意见的子命令；只对命令头做小写匹配。
      const rawArg = typeof rawInput === 'string' ? rawInput.trim() : ''
      const head = (rawArg.split(/\s+/)[0] ?? '').toLowerCase()

      if (head === 'help' || head === '-h' || head === '--help') return handleHelpCommand()
      if (head === 'gate') return await handleGateCommand({ agent, rawArg, getConfig, tickets, settler, gateRouter })
      if (head === 'docs') return handleDocsCommand({ agent, rawArg, config, stateStore })
      if (head === 'spec') return handleSpecCommand({ agent, config })
      if (head === 'compact') return await handleCompactCommand({ agent, signal, bridge })
      if (head === 'retry' || head === 'escalate' || head === 'resume') {
        return await handleBreakerCommand({ head, agent, signal, breaker })
      }
      if (head === 'prompts') return await handlePromptsCommand({ rawArg, signal, prompts })
      if (head === 'notify-test') return await handleNotifyTestCommand({ im, email, feishu })
      if (head === 'feishu') return await handleFeishuCommand({ rawArg, feishu })

      if (STATUS_TOKENS.has(head)) {
        return { kind: 'success', text: await statusText(agent, config) }
      }

      const target = parseModeArg(rawArg)
      if (target === null) {
        return { kind: 'error', text: `未知参数 "${rawArg}"。可选：${choicesText()}` }
      }

      const applied = await applyModeSwitch({ ctx, config, agent, modeId: target, signal, logger })
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
