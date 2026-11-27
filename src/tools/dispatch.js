/**
 * 工具 8：`flow_dispatch_declare` — M/L 级施工前派单声明。
 *
 * @module dsh-flow/tools/dispatch
 */
import { evaluateDeclaration } from '../workflow/dispatch.js'
import { outputOf, rootGuard } from './common.js'

export const DISPATCH_TOOL = 'flow_dispatch_declare'

export function createDispatchTool({ ctx, dispatchStore }) {
  return {
    name: DISPATCH_TOOL,
    description: [
      '（派单声明）M/L 级进入施工前必须先调用一次：探测可用派单工具与只读能力，校验"模式×特种兵"分工与',
      '互不重叠文件白名单，并输出一行 `[调度声明]`。',
      '没有派单工具时返回诚实降级结论（单线程施工），仍然算有效声明。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['assignments'],
      properties: {
        assignments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['who', 'files'],
            properties: {
              who: { type: 'string', description: '子代理角色，如 build-worker / plan-auditor / qa-blackbox。' },
              duty: { type: 'string', description: '一句话职责。' },
              files: { type: 'array', items: { type: 'string' }, description: '该子代理可写的文件或目录前缀（互不重叠）。' },
            },
          },
        },
        note: { type: 'string', maxLength: 300, description: '补充说明，如"本轮单线程，未派子代理"。' },
      },
    },
    output: outputOf(DISPATCH_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const sessionId = String(guard.agent.session?.id ?? '')
      const note = typeof args?.note === 'string' ? args.note.trim() : ''
      const evaluated = await evaluateDeclaration({ ctx, assignments: args?.assignments, note })
      if (evaluated.ok !== true) {
        return { outcome: 'blocked', message: evaluated.errors.join('\n') }
      }

      dispatchStore.remember(sessionId, {
        groups: evaluated.groups.length,
        files: evaluated.groups.reduce((sum, group) => sum + group.files.length, 0),
        tools: evaluated.probe.tools,
        readOnly: evaluated.probe.readOnly.mode,
        agentPresets: evaluated.probe.agentPresets.names,
        line: evaluated.line,
      })

      const degraded = evaluated.probe.tools.length === 0
      return { outcome: degraded ? 'degraded' : 'ok', message: evaluated.details.join('\n') }
    },
  }
}
