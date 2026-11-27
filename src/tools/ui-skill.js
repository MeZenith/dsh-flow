/**
 * 工具 7：`flow_ui_skill` — UI 设计 Skill 非阻塞探测。
 *
 * @module dsh-flow/tools/ui-skill
 */
import { outputOf, rootGuard } from './common.js'

export const UI_SKILL_TOOL = 'flow_ui_skill'

export function createUiSkillTool({ uiSkills }) {
  return {
    name: UI_SKILL_TOOL,
    description: [
      '（UI Skills 探测）进入 UI 与交互阶段前调用一次：探测本机是否装了 taste（design-taste-frontend/tasteskill）或 impeccable。',
      '已安装 → 返回分流建议；未安装 → 返回纯对话三选一，不弹门禁、不阻塞流程。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '忽略一分钟缓存重新探测。' },
      },
    },
    output: outputOf(UI_SKILL_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      if (uiSkills === undefined || typeof uiSkills.probe !== 'function') {
        return {
          outcome: 'unavailable',
          message: '[Flow UI Skills] 探测器未装配：按内置 `ui-architect` 规范执行（Token + 8 态矩阵 + 断点 + ≥44px）。',
        }
      }
      const result = await uiSkills.probe(cwd, { force: args?.refresh === true })
      const lines = [result.text]
      if (result.ok === true && result.names.length > 0) {
        lines.push('', `探测到的 Skill：${result.names.slice(0, 12).join('、')}${result.names.length > 12 ? ' …' : ''}`)
      }
      if (result.ok !== true) {
        lines.push('', `探测状态：${result.source}（不影响流程，按内置规范继续）`)
      }
      const outcome = result.recommendation === 'builtin'
        ? (result.ok === true ? 'choose' : 'unavailable')
        : 'ready'
      return { outcome, message: lines.join('\n') }
    },
  }
}
