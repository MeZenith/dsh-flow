/**
 * S2 的两个 Host 工具：开局路线选择与阶段强门禁。
 *
 * 三条硬约束（对应 S2 红线）：
 *
 * 1. **全局静态注册一次**：`index.js` 在插件级调用 `ctx.tools.register()`，
 *    绝不注册到 `agent.ctx`、也绝不随模式增删 —— 否则 `toolsChanged` 会把
 *    prefix cache 打穿。
 * 2. **不抛异常**：所有可预期分支（缺服务、非根会话、用户取消、后端未应答）
 *    都折算成结构化返回 + 明确文案，由模型继续决策。
 * 3. **模式回传走 `presentationMeta`**：`tool/result` 事件本身不带工具名，
 *    但它带工具私有的 `meta`（`batch.ts:260`，`Session.append` 校验其可序列化）。
 *    这里把 `{ flowTool, flowMode }` 写进 `meta`，`mode-projection.js` 直接折叠，
 *    既不解析模型可见文本，也不自造 session event。
 *
 * @module dsh-flow/tools
 */
import { FLOW_TOOL_NAMES, GATE_NEXT_MODES, ROUTE_CHOICES, STAGE_IDS, modeConfigOf } from './modes.js'

/** 开局路线工具名。 */
export const ROUTE_TOOL = FLOW_TOOL_NAMES[0]

/** 阶段门禁工具名。 */
export const GATE_TOOL = FLOW_TOOL_NAMES[1]

/** 路线选项里"暂不执行"的哨兵值（不是模式）。 */
const SKIP = 'skip'

/** 面向上层调用方的固定文案。 */
export const TOOL_MESSAGES = Object.freeze({
  noAgent: '这个工具必须在某个会话回合内调用（当前没有 agent 上下文）。',
  subagent: '子代理不能向用户发起审批：请把待确认的问题与结论交回父会话，由父会话调用本工具。',
  noQuestions: '当前组合没有 userQuestions 服务，无法弹出原生提问框。',
  noProvider: '当前没有可用的提问应答方（可能未连接 Web 或绑定的同步私聊）。',
  aborted: '提问已被取消，用户没有做出选择。',
  notLive: '发起提问的会话已不是当前活动实例，无法等待用户答复。',
  replyQueued: '上一条答复还在等待投递，请稍后再问。',
  badIntent: '提问参数不符合原生意图校验，已放弃本次弹窗。',
  unknownAnswer: '用户的选择无法识别，请重新询问。',
  declined: '用户选择暂不执行，保持当前状态。',
  approved: '用户已同意切换。',
  revise: '用户要求继续调整当前阶段，本次不切换模式。',
  paused: '用户选择先暂停并由本人接管，本次不切换模式也不继续推进。',
})

/**
 * 校验当前执行者是不是可提问的根会话。
 *
 * `user-questions/src/index.ts:299` 的 `assertLiveRoot()` 会对 subagent 抛
 * `DELEGATED_CALLER`、对非活动实例抛 `CALLER_NOT_LIVE`。这里先自己拦一道，
 * 让模型拿到**可读的指引**而不是一个异常。
 *
 * @param {{ agent?: object }} exec
 * @returns {{ agent: object } | { error: string }}
 */
function rootGuard(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return { error: TOOL_MESSAGES.noAgent }
  const origin = agent.session?.header?.origin
  if (origin === 'subagent') return { error: TOOL_MESSAGES.subagent }
  return { agent }
}

/**
 * 发起一次单问单选提问，把一切可预期失败折算成结果对象。
 *
 * @param {{
 *   ctx: object,
 *   questions: object[],
 *   agent: object,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ ok: true, selected: string } | { ok: false, text: string }>}
 */
async function askOnce({ ctx, questions, agent, signal }) {
  let userQuestions
  try {
    userQuestions = ctx.get('userQuestions')
  } catch {
    userQuestions = undefined
  }
  if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
    return { ok: false, text: TOOL_MESSAGES.noQuestions }
  }

  try {
    const answer = await userQuestions.ask({ questions, agent, signal })
    const items = Array.isArray(answer?.answers) ? answer.answers : []
    const item = items.find(entry => entry?.id === questions[0]?.id) ?? items[0]
    const selected = Array.isArray(item?.selected) && item.selected.length > 0 ? item.selected[0] : undefined
    if (typeof selected !== 'string' || selected === '') {
      return { ok: false, text: TOOL_MESSAGES.unknownAnswer }
    }
    return { ok: true, selected }
  } catch (error) {
    const code = error !== null && typeof error === 'object'
      ? String(error.code ?? error.name ?? '')
      : ''
    switch (code) {
      case 'ASK_ABORTED': return { ok: false, text: TOOL_MESSAGES.aborted }
      case 'DELEGATED_CALLER': return { ok: false, text: TOOL_MESSAGES.subagent }
      case 'CALLER_NOT_LIVE': return { ok: false, text: TOOL_MESSAGES.notLive }
      case 'NO_PROVIDER': return { ok: false, text: TOOL_MESSAGES.noProvider }
      case 'REPLY_QUEUED': return { ok: false, text: TOOL_MESSAGES.replyQueued }
      case 'BAD_INTENT': return { ok: false, text: TOOL_MESSAGES.badIntent }
      default: {
        const detail = error instanceof Error ? error.message : String(error)
        return { ok: false, text: `${TOOL_MESSAGES.noProvider}（${detail}）` }
      }
    }
  }
}

/** 统一构造工具输出定义：模型可见文本 + 投影可见 meta。 */
function outputOf(toolName) {
  return {
    schema: {
      type: 'object',
      required: ['outcome', 'message'],
      properties: {
        outcome: { type: 'string' },
        mode: { type: 'string' },
        compactScheduled: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    /** 模型只看到人话，不看到 JSON —— 少一层解析噪音。 */
    render(args, value) {
      const text = typeof value?.message === 'string' ? value.message : ''
      return [{ type: 'text', text: text === '' ? '（无返回）' : text }]
    },
    /**
     * 写进 `tool/result.data.meta`，供 `flowMode` 投影折叠。
     * `flowMode` 为 null 表示本次没有切换（投影会原样忽略）。
     */
    presentationMeta(args, value) {
      const mode = typeof value?.mode === 'string' && value.mode !== '' ? value.mode : null
      return { flowTool: toolName, flowMode: mode }
    },
  }
}

/**
 * 构造两个工具定义。
 *
 * @param {{
 *   ctx: object,
 *   getConfig: () => object,
 *   switchMode: (agent: object, modeId: string, signal?: AbortSignal) => Promise<object>,
 *   bridge: { schedule: (agent: object) => boolean },
 *   logger?: { warn?: Function },
 * }} deps
 * @returns {object[]} 可直接交给 `ctx.tools.register()` 的定义数组。
 */
export function createFlowTools({ ctx, getConfig, switchMode, bridge, logger }) {
  const routeTool = {
    name: ROUTE_TOOL,
    description: [
      '（Flow 模式开局）把执行路线交给用户拍板：弹出原生四选一提问框，',
      '选项为 Plan / Plan Ultra / Build / 暂不执行，并把你给出的一项标为【推荐】。',
      '用户选定前 3 项之一时，本工具会直接完成模式切换（含默认模型与权限档位），',
      '返回结果里告知你已切换到哪个模式；用户选「暂不执行」时不切换，你应当停下，',
      '不要自行推进。仅在收到新需求、且尚未确定路线时调用一次。',
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
      if (guard.error !== undefined) {
        return { outcome: 'unavailable', message: guard.error }
      }

      const config = getConfig()
      const rawRecommended = typeof args?.recommended === 'string' ? args.recommended : ''
      const recommended = ROUTE_CHOICES.includes(rawRecommended) ? rawRecommended : 'plan'
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      const taskSummary = typeof args?.taskSummary === 'string' ? args.taskSummary.trim() : ''

      /** 选项顺序与模式一一对应，回填时按 label 精确匹配。 */
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
        const label = modeId === SKIP
          ? name
          : isRecommended
            ? `【推荐】${name}`
            : name
        const description = isRecommended && reason !== ''
          ? `推荐理由：${reason}`
          : base[modeId]
        return { label, description }
      })

      const question = {
        id: 'flow-route',
        question: taskSummary === '' ? '这次走哪条路线？' : `这次走哪条路线？（需求：${taskSummary}）`,
        header: 'Flow 开局路线',
        options,
        multiSelect: false,
      }

      const asked = await askOnce({ ctx, questions: [question], agent: guard.agent, signal: exec?.signal })
      if (asked.ok !== true) return { outcome: 'unavailable', message: asked.text }

      const index = options.findIndex(option => option.label === asked.selected)
      const modeId = index === -1 ? undefined : choiceModes[index]
      if (modeId === undefined) return { outcome: 'unavailable', message: TOOL_MESSAGES.unknownAnswer }

      if (modeId === SKIP) {
        return { outcome: 'declined', message: TOOL_MESSAGES.declined }
      }

      const applied = await switchMode(guard.agent, modeId, exec?.signal)
      const detail = Array.isArray(applied?.notes) && applied.notes.length > 0
        ? `（${applied.notes.join('｜')}）`
        : ''
      return {
        outcome: 'switched',
        mode: modeId,
        message: `用户已选定 ${applied?.label ?? modeId}，当前已切换至该模式${detail}。请按该模式的约束继续。`,
      }
    },
  }

  const gateTool = {
    name: GATE_TOOL,
    description: [
      '（阶段强门禁）在跨大阶段前停下来请用户拍板：弹出原生三选一确认框，',
      '选项为「同意，切换到目标模式」/「方案还需调整，继续当前阶段」/「先暂停，由我手动接管」。',
      '只有用户明确同意时才会自动切换模式（含默认模型与权限档位）；',
      '另外两种选择都不会切换，你必须保持当前状态。',
      '从 Plan / Plan Ultra 切入 Build 时应当已经把终版方案写入 .flow/spec.md，并把 specUpdated 设为 true。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['fromStage', 'nextMode', 'summary', 'specUpdated'],
      properties: {
        fromStage: {
          type: 'string',
          enum: [...STAGE_IDS],
          description: '当前所处阶段。',
        },
        nextMode: {
          type: 'string',
          enum: [...GATE_NEXT_MODES],
          description: '拟切换的目标模式；off 表示回到普通模式。',
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description: '本阶段的极简结论：已完成项、关键决定、待确认风险。会作为审阅正文展示。',
        },
        specUpdated: {
          type: 'boolean',
          description: '是否已把终版方案写入 .flow/spec.md。',
        },
      },
    },
    output: outputOf(GATE_TOOL),

    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) {
        return { outcome: 'unavailable', message: guard.error }
      }

      const config = getConfig()
      const rawFrom = typeof args?.fromStage === 'string' ? args.fromStage : ''
      const fromStage = STAGE_IDS.includes(rawFrom) ? rawFrom : STAGE_IDS[0]
      const rawNext = typeof args?.nextMode === 'string' ? args.nextMode : ''
      const nextMode = GATE_NEXT_MODES.includes(rawNext) ? rawNext : 'build'
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      const specUpdated = args?.specUpdated === true

      const targetLabel = nextMode === 'off' ? '普通模式' : modeConfigOf(config, nextMode).label
      const approveLabel = `同意，切换到 ${targetLabel}`
      const reviseLabel = '方案还需调整，继续当前阶段'
      const pauseLabel = '先暂停，由我手动接管'

      const detailLines = [summary]
      if (!specUpdated && (nextMode === 'build' || nextMode === 'review')) {
        detailLines.push('（注意：本次未标记方案已写入 .flow/spec.md）')
      }

      /** 仅从规划切入实施时用原生 `plan-review` 呈现；其余情况走通用选项卡片。 */
      const planToBuild = (fromStage === 'plan' || fromStage === 'plan-ultra') && nextMode === 'build'

      const question = {
        id: 'flow-gate',
        question: `本阶段（${modeConfigOf(config, fromStage).label}）已完成，是否切换到 ${targetLabel}？`,
        header: 'Flow 阶段门禁',
        detail: detailLines.filter(line => typeof line === 'string' && line !== '').join('\n'),
        options: [
          { label: approveLabel, description: '切换到目标模式并继续推进' },
          { label: reviseLabel, description: '保持当前模式，继续打磨方案' },
          { label: pauseLabel, description: '保持当前状态，由用户本人接手' },
        ],
        multiSelect: false,
        ...(planToBuild ? { intent: { kind: 'plan-review', approve: approveLabel } } : {}),
      }

      const asked = await askOnce({ ctx, questions: [question], agent: guard.agent, signal: exec?.signal })
      if (asked.ok !== true) return { outcome: 'unavailable', message: asked.text }

      if (asked.selected === pauseLabel) {
        return { outcome: 'paused', message: TOOL_MESSAGES.paused }
      }
      if (asked.selected !== approveLabel) {
        // 只要不是明确同意，就绝不切换模式与权限。
        return { outcome: 'revise', message: TOOL_MESSAGES.revise }
      }

      const applied = await switchMode(guard.agent, nextMode, exec?.signal)
      const autoCompact = config?.behavior?.autoCompactOnGate !== false
      const compactScheduled = autoCompact ? bridge.schedule(guard.agent) === true : false

      if (autoCompact && !compactScheduled) {
        logger?.warn?.('flow: 阶段切换后未能登记自动压缩（可能已有待办或在卸载中）')
      }

      const detail = Array.isArray(applied?.notes) && applied.notes.length > 0
        ? `（${applied.notes.join('｜')}）`
        : ''
      const compactNote = compactScheduled ? '，将在本回合结束后自动压缩一次上下文' : ''
      return {
        outcome: 'approved',
        mode: nextMode,
        compactScheduled,
        message: `${TOOL_MESSAGES.approved}当前已切换至 ${applied?.label ?? targetLabel}${detail}${compactNote}。请按新阶段的约束继续。`,
      }
    },
  }

  return [routeTool, gateTool]
}
