/**
 * 工具 1：`flow_choose_route` — 开局四选一路由（含 S/M/L 任务等级与自定义升降级解析）。
 *
 * v0.6.0 修复：
 * - M-07：解析用户自定义输入 `asked.custom`（如「升到 L」「降到 S」「改 M」），真正兑现「一票升降级」承诺！
 *
 * @module dsh-flow/tools/route
 */
import { FLOW_TOOL_NAMES, ROUTE_CHOICES } from '../config/constants.js'
import { modeConfigOf } from '../modes/registry.js'
import { describeLevel, levelDef, levelOfSession, rememberLevel } from '../workflow/level.js'
import { askQuestion, outputOf, rootGuard, TOOL_MESSAGES } from './common.js'

export const ROUTE_TOOL = FLOW_TOOL_NAMES[0]
const SKIP = 'skip'

/** 从用户自由补充文本里提取显式升降级意图（如「升到 L」「降到 S」「按 M 走」）。 */
export function parseLevelOverride(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const match = /(?:升|降|改|按|用|选|level|等级)\s*(?:到|成|为|级|:|：)?\s*([SML])\b/i.exec(raw)
    ?? /^([SML])\s*级?$/i.exec(raw)
  return match ? match[1].toUpperCase() : null
}

export function createRouteTool({ ctx, getConfig, switchMode, getUserQuestions, stateStore }) {
  return {
    name: ROUTE_TOOL,
    description: [
      '（Flow 模式开局）把执行路线交给用户拍板：弹出原生四选一提问框，',
      '选项为 Plan / Plan Ultra / Build / 暂不执行，并把你给出的一项标为【推荐】。',
      '`level` 是你建议的任务复杂度（S 局部改动 / M 中型功能 / L 从零重构），会写进选项说明，',
      '用户仍可一票升降级。用户选定路线后本工具直接完成模式切换（含默认模型与权限档位），',
      '返回结果里告知你已切换到哪个模式；用户选「暂不执行」时不切换，你应当停下。',
      '仅在收到新需求、且尚未确定路线时调用一次。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['recommended', 'reason', 'taskSummary'],
      properties: {
        recommended: {
          type: 'string',
          enum: [...ROUTE_CHOICES],
          description: '你推荐用户选择的路线：plan（轻量）、plan-ultra（复杂）、build（需求已明确）。',
        },
        level: {
          type: 'string',
          enum: ['S', 'M', 'L'],
          description: '任务复杂度建议：S 局部改动/单点 Bug；M 独立新模块（01/03/05/06/07）；L 从零建项目或架构重构（01–07 全套）。',
        },
        levelReason: {
          type: 'string',
          maxLength: 300,
          description: '一句话说明为什么是这个等级（影响文件数、是否新模块、是否动架构）。',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 400,
          description: '一句话推荐理由，会作为推荐项的描述展示给用户。',
        },
        taskSummary: {
          type: 'string',
          minLength: 1,
          maxLength: 400,
          description: '用一句话复述用户需求，帮助用户确认你理解正确。',
        },
      },
    },
    output: outputOf(ROUTE_TOOL),

    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }

      const config = getConfig()
      const sessionId = String(guard.agent.session?.id ?? '')
      const rawRecommended = typeof args?.recommended === 'string' ? args.recommended : ''
      const recommended = ROUTE_CHOICES.includes(rawRecommended) ? rawRecommended : 'plan'
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      const taskSummary = typeof args?.taskSummary === 'string' ? args.taskSummary.trim() : ''
      let level = levelOfSession(config, sessionId, args?.level, stateStore)
      const levelReason = typeof args?.levelReason === 'string' ? args.levelReason.trim() : ''
      rememberLevel(sessionId, level, stateStore)

      const choiceModes = ['plan', 'plan-ultra', 'build', SKIP]
      const base = {
        plan: '轻量读码，输出改动清单与风险点',
        'plan-ultra': '复杂需求多视角深度拆解，多轮对齐锁死方案',
        build: '需求已足够明确，直接开干写代码并验证',
        skip: '保持当前状态，先不切换模式',
      }
      const options = choiceModes.map((modeId) => {
        const isRecommended = modeId === recommended
        const name = modeId === SKIP ? '暂不执行（退出）' : modeConfigOf(config, modeId).label
        const label = modeId === SKIP || !isRecommended ? name : `【推荐】${name}`
        const description = isRecommended && reason !== '' ? `推荐理由：${reason}` : base[modeId]
        return { label, description: modeId === SKIP ? description : `${description}｜等级 ${level}` }
      })

      const question = {
        id: 'flow-route',
        question: taskSummary === '' ? '这次走哪条路线？' : `这次走哪条路线？（需求：${taskSummary}）`,
        header: 'Flow 开局路线',
        detail: [
          `建议等级：${describeLevel(level)}`,
          levelReason === '' ? '' : `判断依据：${levelReason}`,
          '你可以一票升降级：在补充说明里直接写「升到 L」「降到 S」或「改 M」。',
        ].filter(line => line !== '').join('\n'),
        options,
        multiSelect: false,
      }

      const asked = await askQuestion({
        ctx,
        getUserQuestions,
        questions: [question],
        agent: guard.agent,
        signal: exec?.signal,
      })
      if (asked.via !== 'desktop') {
        return { outcome: 'unavailable', message: asked.text ?? TOOL_MESSAGES.unknownAnswer }
      }

      // M-07：解析用户自定义补充里的 S/M/L 升降级指令。
      const overriddenLevel = parseLevelOverride(asked.custom)
      if (overriddenLevel !== null) {
        level = overriddenLevel
        rememberLevel(sessionId, level, stateStore)
      }

      const index = options.findIndex(option => option.label === asked.selected)
      let modeId = index === -1 ? undefined : choiceModes[index]
      // 若用户只填了自定义升降级（未选选项），默认走 recommended 路线。
      if (modeId === undefined && overriddenLevel !== null) {
        modeId = recommended
      }
      if (modeId === undefined) return { outcome: 'unavailable', message: TOOL_MESSAGES.unknownAnswer }

      if (modeId === SKIP) {
        return { outcome: 'declined', message: TOOL_MESSAGES.declined }
      }

      const applied = await switchMode(guard.agent, modeId, exec?.signal)
      const detail = Array.isArray(applied?.notes) && applied.notes.length > 0
        ? `（${applied.notes.join('｜')}）`
        : ''
      const docsHint = levelDef(level).docs.length === 0
        ? 'S 级：先做 1 轮交互与呈现细节确认，再直接施工。'
        : `本等级需要文档：${levelDef(level).docs.join(' / ')}；门禁前用 flow_docs_check 自检。`
      const customNote = asked.custom ? `\n用户补充：${asked.custom}` : ''
      return {
        outcome: 'switched',
        mode: modeId,
        message: `用户已选定 ${applied?.label ?? modeId}，当前已切换至该模式${detail}。等级 ${level}${overriddenLevel ? '（用户一票调整）' : ''}｜${docsHint}${customNote}`,
      }
    },
  }
}
