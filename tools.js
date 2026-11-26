/**
 * Flow Host 工具：开局路线、阶段门禁 v2、编号文档读写与投递。
 *
 * === 四条硬约束（沿用 S2 红线，v0.5.0 加一条） ===
 *
 * 1. **全局静态注册一次**：`index.js` 在插件级调用 `ctx.tools.register()`，绝不随模式增删，
 *    否则 `toolsChanged` 会打穿 prefix cache。
 * 2. **不抛异常**：所有可预期分支（缺服务、非根会话、用户取消、超时、未授权）都折算成
 *    结构化返回 + 明确文案，由模型继续决策。
 * 3. **模式回传走 `presentationMeta`**：只有本插件自己的工具写 `{flowTool, flowMode}`，
 *    `mode-projection.js` 据此折叠当前模式。
 * 4. **超时即停手**（v0.5.0）：门禁超时只登记票据 + 单次催办 + `hold`，**绝不**给出
 *    "先继续做安全部分"这类许可；hold 期间写文档与切 Build 一律被拒。
 *
 * @module dsh-flow/tools
 */
import { basename } from 'node:path'
import {
  DOC_IDS, FLOW_TOOL_NAMES, GATE_KINDS, GATE_NEXT_MODES, GATE_OPTION_LIMIT, ROUTE_CHOICES, STAGE_IDS,
  modeConfigOf, normalizeDocId,
} from './modes.js'
import {
  describeLevel, gateRequiredDocs, levelDef, levelOfSession, rememberLevel, shouldDeliverDocs,
} from './flow-level.js'
import {
  attachmentsOf, checkDocs, digestOf, docFileName, docTitle, docsNote, draftAttachment, ensureDocs, readDocText, writeDoc,
} from './flow-docs.js'
import {
  buildFixPackage, buildQaNotification, buildWhiteboxBrief, createReworkTracker, parseBlackbox, parseWhitebox,
} from './qa-handoff.js'
import { formatEmailGate, formatImGate } from './gate-tickets.js'
import {
  createDispatchStore, evaluateDeclaration, requiresDeclaration,
} from './dispatch-declare.js'

/** 开局路线工具名。 */
export const ROUTE_TOOL = FLOW_TOOL_NAMES[0]

/** 阶段门禁工具名。 */
export const GATE_TOOL = FLOW_TOOL_NAMES[1]

/** 文档骨架 / 校验 / 写入 / 投递工具名。 */
export const DOCS_INIT_TOOL = 'flow_docs_init'
export const DOCS_CHECK_TOOL = 'flow_docs_check'
export const DOCS_WRITE_TOOL = 'flow_docs_write'
export const SEND_DOC_TOOL = 'flow_send_doc'
export const UI_SKILL_TOOL = 'flow_ui_skill'
export const DISPATCH_TOOL = 'flow_dispatch_declare'
export const QA_HANDOFF_TOOL = 'flow_qa_handoff'

/** 派单工具候选（探测到哪个就报哪个）。 */
const DISPATCH_CANDIDATES = Object.freeze(['dsh_team_spawn', 'subagent', 'subagent_fork'])

/** 路线选项里"暂不执行"的哨兵值（不是模式）。 */
const SKIP = 'skip'

/** 超时硬上限：24 小时，挡住误填。 */
const MAX_TIMEOUT_SECONDS = 86_400

/** 面向上层调用方的固定文案。 */
export const TOOL_MESSAGES = Object.freeze({
  noAgent: '这个工具必须在某个会话回合内调用（当前没有 agent 上下文）。',
  subagent: '子代理不能向用户发起审批：请把待确认的问题与结论交回父会话，由父会话调用本工具。',
  noQuestions: '当前组合没有 userQuestions 服务，无法弹出原生提问框。',
  noProvider: '当前没有可用的提问应答方（可能未连接 Web 或绑定的同步私聊）。',
  aborted: '提问已被取消，用户没有做出选择。',
  /** 用户手动关闭卡片：这是"没选"，不是"没有应答方"，更不是拒绝。 */
  cancelled: '用户已关闭提问卡片（未做选择）。关闭不等于拒绝；需要继续请重新发起门禁。',
  notLive: '发起提问的会话已不是当前活动实例，无法等待用户答复。',
  replyQueued: '上一条答复还在等待投递，请稍后再问。',
  badIntent: '提问参数不符合原生意图校验，已放弃本次弹窗。',
  unknownAnswer: '用户的选择无法识别，请重新询问。',
  declined: '用户选择暂不执行，保持当前状态。',
  approved: '用户已同意切换。',
  revise: '用户要求继续调整当前阶段，本次不切换模式。',
  paused: '用户选择先暂停并由本人接管，本次不切换模式也不继续推进。',
  /** 超时后的唯一合法动作：等。 */
  hold: [
    '【严格停手】门禁已超时，票据已登记并已发一次催办。',
    '现在**不要**推进任何阶段、**不要**改代码、**不要**继续写文档。',
    '你只回一句「已登记 #<票据号>，等你决定」，然后结束本回合。',
    '只有用户明确回复「跳过继续 / 同意 / 暂停」之后，才允许继续。',
  ].join('\n'),
})

/**
 * 校验当前执行者是不是可提问的根会话。
 *
 * `user-questions/src/index.ts:299` 的 `assertLiveRoot()` 会对 subagent 抛
 * `DELEGATED_CALLER`。这里先拦一道，给出可读指引而不是异常。
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
 * 解析 `userQuestions` 服务（preset 隔离域 → agent 作用域 → 全局，三级回落）。
 *
 * @param {{ ctx: object, getUserQuestions?: () => object | undefined, agent?: object }} input
 * @returns {object | undefined}
 */
function resolveQuestions({ ctx, getUserQuestions, agent }) {
  let service
  try {
    service = typeof getUserQuestions === 'function' ? getUserQuestions() : ctx.get('userQuestions')
  } catch {
    service = undefined
  }
  if (service !== undefined && typeof service.ask === 'function') return service
  try {
    const presets = ctx.get('agentPresets')
    const fromPreset = typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'userQuestions') : undefined
    if (typeof fromPreset?.ask === 'function') return fromPreset
  } catch { /* 没有 preset 注册表，继续回落 */ }
  try {
    const local = agent?.ctx?.get?.('userQuestions')
    if (typeof local?.ask === 'function') return local
  } catch { /* 作用域不可读 */ }
  return undefined
}

/** 把提问异常折算成结构化结果。 */
function describeAskError(error) {
  const code = error !== null && typeof error === 'object' ? String(error.code ?? error.name ?? '') : ''
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ASK_ABORTED':
    case 'ASK_CANCELLED':
    case 'CANCELLED':
      return { via: 'aborted', text: TOOL_MESSAGES.cancelled }
    case 'ASK_TIMED_OUT': return { via: 'timeout' }
    case 'DELEGATED_CALLER': return { via: 'error', text: TOOL_MESSAGES.subagent }
    case 'CALLER_NOT_LIVE': return { via: 'error', text: TOOL_MESSAGES.notLive }
    case 'NO_PROVIDER': return { via: 'error', text: TOOL_MESSAGES.noProvider }
    case 'REPLY_QUEUED': return { via: 'error', text: TOOL_MESSAGES.replyQueued }
    case 'BAD_INTENT': return { via: 'error', text: TOOL_MESSAGES.badIntent }
    default: {
      // 宿主在"用户手动点叉"时可能只给一句 message、Code 为空 —— 按语义兜一次，
      // 不要把它误报成"当前没有可用的提问应答方"。
      if (/cancel(led)?\b|dismiss|closed by (the )?user|用户取消/i.test(message)) {
        return { via: 'aborted', text: TOOL_MESSAGES.cancelled }
      }
      if (/no provider|no answerer/i.test(message)) return { via: 'error', text: TOOL_MESSAGES.noProvider }
      return { via: 'error', text: `提问失败（${message}）` }
    }
  }
}

/**
 * 发起一次提问，返回结构化结果。
 *
 * v0.5.1 起只保留**同步问答**（路线选择这类一次性交互）。门禁已经改成非阻塞，
 * 不再需要 `askTimed` / `Promise.race` / `onDecision` 那套"前台竞速"逻辑。
 *
 * @param {{
 *   ctx: object,
 *   getUserQuestions?: () => object | undefined,
 *   questions: object[],
 *   agent: object,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ via: 'desktop'|'error', selected?: string, custom?: string, text?: string }>}
 */
async function askQuestion({ ctx, getUserQuestions, questions, agent, signal }) {
  const service = resolveQuestions({ ctx, getUserQuestions, agent })
  if (service === undefined || typeof service.ask !== 'function') {
    return { via: 'error', text: TOOL_MESSAGES.noQuestions }
  }

  let value
  try {
    value = await service.ask({ questions, agent, signal })
  } catch (error) {
    return describeAskError(error)
  }

  const items = Array.isArray(value?.answers) ? value.answers : []
  const item = items.find(entry => entry?.id === questions[0]?.id) ?? items[0]
  const selected = Array.isArray(item?.selected) && item.selected.length > 0 ? item.selected[0] : undefined
  const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
  if (selected === undefined && custom === '') {
    return { via: 'error', text: TOOL_MESSAGES.unknownAnswer }
  }
  return { via: 'desktop', selected, custom }
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
    presentationMeta(args, value) {
      const mode = typeof value?.mode === 'string' && value.mode !== '' ? value.mode : null
      return { flowTool: toolName, flowMode: mode }
    },
  }
}

/** 项目名（通知标题与邮件主题用）。 */
function projectNameOf(cwd) {
  const clean = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (clean === '') return '未命名工作区'
  return basename(clean) || '未命名工作区'
}

/** 归一化文档编号数组。 */
function docIdsOf(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalizeDocId).filter(Boolean))].sort()
}

/** 归一化附件路径数组（只做粗筛，真正的白名单在 `attachmentsOf`）。 */
function extrasOf(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item ?? '').trim())
    .filter(item => item !== '')
    .slice(0, 8)
}

/** 超时秒数：入参优先，其次配置，最后 30 分钟；0 表示不设超时。 */
function timeoutOf(args, config) {
  const raw = Number(args?.timeoutSeconds)
  if (Number.isFinite(raw)) return Math.max(0, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(raw)))
  const fallback = Number(config?.gate?.timeoutSeconds)
  if (Number.isFinite(fallback)) return Math.max(0, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(fallback)))
  return 1800
}

/**
 * 构造全部 Flow 工具。
 *
 * @param {{
 *   ctx: object,
 *   getConfig: () => object,
 *   switchMode: (agent: object, modeId: string, signal?: AbortSignal) => Promise<object>,
 *   bridge: { schedule: (agent: object) => boolean },
 *   logger?: { warn?: Function, info?: Function },
 *   getUserQuestions?: () => object | undefined,
 *   notifier?: { schedule?: Function, sendNow?: Function },
 *   im?: { send?: Function },
 *   email?: { send?: Function },
 *   tickets?: object,
 * }} deps
 * @returns {object[]} 可直接交给 `ctx.tools.register()` 的定义数组。
 */
export function createFlowTools({
  ctx, getConfig, switchMode, bridge, logger, getUserQuestions, notifier, im, email, tickets, settler, uiSkills,
}) {
  /** 读会话等级：显式入参 > 会话记忆（flow-level.js，与提示词同源）> 配置默认。 */
  function levelOf(sessionId, explicit) {
    return levelOfSession(getConfig(), sessionId, explicit)
  }

  /** 会话级派单声明（P4：门禁据此拦截 M/L 静默不派单）。 */
  const dispatchStore = createDispatchStore()

  /** 门禁切模式时的目标显示名（`flow` 表示"留在总控、进入下一阶段"）。 */
  function targetLabelOf(config, nextMode) {
    if (nextMode === 'off') return '普通模式'
    if (nextMode === 'flow') return 'Flow 的下一阶段'
    return modeConfigOf(config, nextMode).label
  }

  /** 发一封带附件的门禁邮件（不依赖分流策略：门禁必须走邮件带文档）。 */
  async function sendGateEmail({ project, markdown, attachments, event = 'gate' }) {
    if (typeof email?.send !== 'function') return { ok: false, via: 'email', reason: '邮箱渠道未装配' }
    try {
      return await email.send({ event, project, text: markdown, attachments })
    } catch (error) {
      return { ok: false, via: 'email', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 发一条 IM（纯文字；dsh-im 主动投递不支持附件）。 */
  async function sendIm({ title, markdown }) {
    if (typeof im?.send !== 'function') return { ok: false, via: 'im', reason: 'IM 渠道未装配' }
    try {
      return await im.send({ title, markdown })
    } catch (error) {
      return { ok: false, via: 'im', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /* ------------------------------------------------------------------ *
   * 工具 1：开局路线（含复杂度等级）
   * ------------------------------------------------------------------ */

  const routeTool = {
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
          description: '任务复杂度建议：S 局部交互改动/单点 Bug（不产文档，但必须 1 轮交互确认）；M 独立新模块（01/03/05/06/07）；L 从零建项目或架构重构（01–07 全套）。',
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
      const level = levelOf(sessionId, args?.level)
      const levelReason = typeof args?.levelReason === 'string' ? args.levelReason.trim() : ''
      rememberLevel(sessionId, level)

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
        const description = isRecommended && reason !== ''
          ? `推荐理由：${reason}`
          : base[modeId]
        return { label, description: modeId === SKIP ? description : `${description}｜等级 ${level}` }
      })

      const question = {
        id: 'flow-route',
        question: taskSummary === '' ? '这次走哪条路线？' : `这次走哪条路线？（需求：${taskSummary}）`,
        header: 'Flow 开局路线',
        detail: [
          `建议等级：${describeLevel(level)}`,
          levelReason === '' ? '' : `判断依据：${levelReason}`,
          '你可以一票升降级：在回复里直接说「升到 L」「降到 S」。',
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
      const docsHint = levelDef(level).docs.length === 0
        ? 'S 级：先做 1 轮交互与呈现细节确认，再直接施工。'
        : `本等级需要文档：${levelDef(level).docs.join(' / ')}；门禁前用 flow_docs_check 自检。`
      return {
        outcome: 'switched',
        mode: modeId,
        message: `用户已选定 ${applied?.label ?? modeId}，当前已切换至该模式${detail}。等级 ${level}｜${docsHint}`,
      }
    },
  }

  /* ------------------------------------------------------------------ *
   * 工具 2：阶段门禁 v2
   * ------------------------------------------------------------------ */

  const gateTool = {
    name: GATE_TOOL,
    description: [
      '（阶段强门禁 v2）在跨大阶段、外部阻断、验收或需要写文档授权时停下请用户拍板。',
      '',
      '`kind`：stage（阶段切换，默认）/ blocker（外部阻断求助）/ acceptance（人工验收）/ permission（只读会话申请写 .flow/docs 授权）。',
      '`docIds`：本门禁对应文档编号（如 ["03"]、["05"]、["06","07"]）；`attachments`：额外附件路径（如 04 阶段的 .flow/docs/preview/*.html）。',
      'M/L 级涉及文档产出的门禁若文档未落盘、为空或缺必填章节，本工具直接返回 `blocked` 不放行。',
      '',
      '**本工具是非阻塞的**：建票后立刻返回选项块，不弹原生卡片、也不等用户回答。',
      '返回体里带「强制指令」——必须把选项原样展示给用户，然后**立刻结束本轮对话**，严禁继续推进。',
      '',
      '用户回复 `#票据号 1 [意见]` 会重新进入本会话并自动结算（桌面直接回 `1` 也行，微信请带票据号）。',
      '`timeoutSeconds` 只影响催办：到点发**一次**邮件 + IM 摘要，绝不代表同意，也不解除 hold。',
      '从 Plan / Plan Ultra 切入 Build 时应当已把 05-dev-spec 落盘并把 specUpdated 设为 true。',
    ].join('\n'),
    parameters: {
      type: 'object',
      required: ['fromStage', 'nextMode', 'summary'],
      properties: {
        fromStage: { type: 'string', enum: [...STAGE_IDS], description: '当前所处阶段。' },
        nextMode: { type: 'string', enum: [...GATE_NEXT_MODES], description: '拟切换的目标模式；off 表示回到普通模式。' },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description: '本阶段极简结论：已完成项、关键决定、待确认风险。会作为审阅正文展示，也会进邮件摘要。',
        },
        specUpdated: { type: 'boolean', description: '是否已把终版方案写入 .flow/spec.md。' },
        kind: { type: 'string', enum: [...GATE_KINDS], description: '门禁形态，默认 stage。' },
        level: { type: 'string', enum: ['S', 'M', 'L'], description: '任务复杂度等级；缺省用会话记录或配置默认。' },
        docIds: {
          type: 'array',
          items: { type: 'string', enum: [...DOC_IDS] },
          description: '门禁对应文档编号，如 ["03"] / ["05"] / ["06","07"]。',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: '额外附件（工作区相对路径，如 .flow/docs/preview/home.html），随门禁邮件发出。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '桌面倒计时秒数；0 表示无限等；缺省取配置 gate.timeoutSeconds。',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '自定义选项标签（≤5 个，按顺序对应 IM 的 1/2/3）。缺省按 kind 生成。',
        },
        docId: { type: 'string', description: 'kind=permission 时：仅本次允许写入的文档编号。' },
        toStage: {
          type: 'string',
          enum: ['build'],
          description: '（可选）Flow 总控下推进到施工期时显式声明；与 nextMode:"flow" + docIds 含 "05" 等效，都会触发派单声明校验。',
        },
        draftContent: {
          type: 'string',
          maxLength: 120_000,
          description: 'kind=permission 且带 docId 时**必填**：要落盘的完整草稿正文。它只会进票据内存与邮件附件（.draft.md），授权前不写任何文件。',
        },
      },
    },
    output: outputOf(GATE_TOOL),

    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }

      const config = getConfig()
      const agent = guard.agent
      const sessionId = String(agent.session?.id ?? '')
      const cwd = String(agent.session?.header?.cwd ?? '')
      const project = projectNameOf(cwd)
      const kind = GATE_KINDS.includes(args?.kind) ? args.kind : 'stage'
      const level = levelOf(sessionId, args?.level)
      const fromStage = STAGE_IDS.includes(args?.fromStage) ? args.fromStage : STAGE_IDS[0]
      const nextMode = GATE_NEXT_MODES.includes(args?.nextMode) ? args.nextMode : 'build'
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      const specUpdated = args?.specUpdated === true
      const docIds = docIdsOf(args?.docIds)
      const extras = extrasOf(args?.attachments)
      const timeoutSeconds = kind === 'permission' ? 0 : timeoutOf(args, config)

      // ---- 顶替旧票：非阻塞模式没有"上一张票占着位置"这回事 ----
      // 门禁建票即返回，没人守着旧票；继续拿它硬拦新票只会让用户卡死。
      // 同会话、同类型的未决票一律标 superseded，方便"改完草稿重发门禁"。
      const superseded = tickets?.supersede?.({ sessionId, kind, reason: '被重发的门禁顶替' }) ?? []

      /* -------- permission：只读写文档授权 -------- */
      if (kind === 'permission') {
        return runPermissionGate({ agent, sessionId, project, args, exec })
      }

      /* -------- 文档必达校验 -------- */
      const required = gateRequiredDocs({ level, kind, fromStage, nextMode, explicit: docIds })
      const enforce = config?.docs?.enforce !== 'warn'
      const checked = checkDocs({ config, cwd, ids: [...new Set([...required, ...docIds])], level })
      if (enforce && required.length > 0 && checked.ok !== true) {
        const detail = checked.items
          .filter(item => item.ok !== true)
          .map(item => `- ${item.id} ${item.title}：${item.reasons.join('；')}`)
        return {
          outcome: 'blocked',
          message: [
            `门禁被拦下：等级 ${level} 的这一关必须有有效文档，当前缺 ${checked.failed.join(' ')}。`,
            ...detail,
            '',
            '下一步：flow_docs_init 生成骨架 → flow_docs_write 写正文（只读会话先走 kind=permission 拿授权）→ flow_docs_check 自检 → 再调本工具。',
          ].join('\n'),
        }
      }

      /* -------- 派单声明校验（M/L 进入施工前，三条路径都覆盖） -------- */
      const toStage = args?.toStage === 'build' ? 'build' : ''
      const needsDeclaration = requiresDeclaration({
        level, kind, nextMode, fromStage, docIds, toStage,
      })
      if (needsDeclaration) {
        const declaration = dispatchStore.get(sessionId)
        if (declaration === undefined) {
          return {
            outcome: 'blocked',
            message: [
              '门禁被拦下：M/L 级进入施工前必须先声明派单分工（封死"静默不派单"后门）。',
              `本轮判定：nextMode=${nextMode}${toStage === '' ? '' : ` / toStage=${toStage}`} → 视为进入施工期。`,
              '下一步：调 `flow_dispatch_declare({ assignments:[{ who:"build-worker", files:["path/a.js"] }] })`，',
              '拿到 `[调度声明]` 一行后再重试本门禁；没有派单工具时它会给出诚实降级结论，同样算有效声明。',
            ].join('\n'),
          }
        }
      }

      /* -------- 选项与票据 -------- */
      const optionSet = buildOptions({ kind, config, nextMode, fromStage, custom: args?.options })
      const targetLabel = targetLabelOf(config, nextMode)
      const ticket = tickets.create({
        sessionId,
        project,
        cwd,
        kind,
        level,
        fromStage,
        nextMode,
        question: [
          questionOf({ kind, fromStage, nextMode, config, targetLabel }),
          '',
          summary,
          specUpdated ? '' : (nextMode === 'build' || nextMode === 'review' ? '（注意：本次未标记方案已写入 .flow/spec.md）' : ''),
        ].filter(line => line !== '').join('\n'),
        options: optionSet.options,
        docIds,
        attachments: extras,
        summary,
        specUpdated,
        timeoutSeconds,
        /** 非阻塞建票：立刻 hold，挡住后续写盘与切模式，直到用户回话。 */
        hold: true,
        draftId: kind === 'permission' ? (normalizeDocId(args?.docId) ?? '') : '',
        draftContent: kind === 'permission' && typeof args?.draftContent === 'string' ? args.draftContent : '',
      })
      if (ticket?.error !== undefined) {
        return { outcome: 'blocked', message: `门禁未创建：${ticket.error}` }
      }

      /* -------- 文档投递（先投递再弹框：用户看到卡片时文档已经在邮箱里） -------- */
      const delivery = shouldDeliverDocs({ kind, docIds })
      let delivered = { email: undefined, im: undefined, skipped: [] }
      if (delivery.deliver) {
        delivered = await deliverGateDocs({
          config, cwd, project, ticket, docIds, extras, fromStage, nextMode, summary,
        })
      }

      /* -------- 非阻塞返回：建票即挂起，把选项交给用户，本回合立刻结束 -------- */
      const armed = timeoutSeconds > 0 && tickets?.armEscalation?.(ticket.id, timeoutSeconds * 1000, async () => {
        // 到点：登记 expired + 严格 hold，然后**只催办一次**，绝不替用户做决定。
        tickets.expire(ticket.id)
        if (tickets.markNotified(ticket.id) !== true) return
        const esc = await escalateOnce({ config, ticket, project, docIds, extras, summary, agent })
        logger?.info?.(`flow: 门禁 #${ticket.id} 超时，已催办一次（IM ${esc.im?.ok === true ? 'ok' : 'fail'} / 邮件 ${esc.email?.ok === true ? 'ok' : 'fail'}）`)
      }) === true

      return {
        outcome: 'awaiting-user',
        message: gateAwaitingBlock({
          ticket,
          options: optionSet.options,
          delivery,
          delivered,
          timeoutSeconds,
          armed,
          superseded,
          targetLabel,
          required,
          checked,
        }),
      }

    },
  }

  /* ------------------------------------------------------------------ *
   * 内部：选项 / 文案 / 投递 / 催办
   * ------------------------------------------------------------------ */

  /** 门禁问题文案。 */
  function questionOf({ kind, fromStage, nextMode, config, targetLabel }) {
    if (kind === 'blocker') return '外部条件卡住了，需要你决定怎么继续？'
    if (kind === 'acceptance') return '验收结果怎么处理？'
    if (kind === 'permission') return '要写入 .flow/docs 文档，授权范围选哪个？'
    const fromLabel = modeConfigOf(config, fromStage).label
    return `本阶段（${fromLabel}）已完成，是否切换到 ${targetLabel}？`
  }

  /**
   * 生成选项。**顺序即 IM 数字**（1/2/3），R1 的歧义规避依赖这一点。
   *
   * @returns {{ options: { label: string, description: string, action: string }[], planReview: boolean }}
   */
  function buildOptions({ kind, config, nextMode, fromStage, custom }) {
    const planToBuild = (fromStage === 'plan' || fromStage === 'plan-ultra') && nextMode === 'build'
    if (Array.isArray(custom) && custom.length > 0) {
      const actions = ['approve', 'skip', 'pause', 'revise', 'deny']
      return {
        options: custom.slice(0, GATE_OPTION_LIMIT).map((label, index) => ({
          label: String(label),
          description: `第 ${index + 1} 个选项（IM 回 ${index + 1}）`,
          action: actions[index] ?? 'approve',
        })),
        planReview: false,
      }
    }
    if (kind === 'acceptance') {
      return {
        options: [
          { label: '我开始验收，等我反馈', description: '立刻停表，由你在真机/浏览器上点验', action: 'accept' },
          { label: '先跳过，你继续做', description: '跳过项会写进最终报告的未验证清单', action: 'skip' },
          { label: '暂停，由我手动接管', description: '不切换模式，也不继续推进', action: 'pause' },
        ],
        planReview: false,
      }
    }
    if (kind === 'blocker') {
      return {
        options: [
          { label: '我已处理好，继续', description: '外部条件恢复，继续原计划', action: 'approve' },
          { label: '先跳过这项', description: '记入未验证清单，继续其它部分', action: 'skip' },
          { label: '暂停，由我手动接管', description: '整条流水线停下', action: 'pause' },
        ],
        planReview: false,
      }
    }
    const targetLabel = targetLabelOf(config, nextMode)
    const approveLabel = nextMode === 'flow'
      ? '同意，进入下一阶段（留在 Flow）'
      : `同意，切换到 ${targetLabel}`
    return {
      options: [
        { label: approveLabel, description: '切换到目标模式并继续推进', action: 'approve' },
        { label: '方案还需调整，继续当前阶段', description: '保持当前模式，继续打磨方案', action: 'revise' },
        { label: '先暂停，由我手动接管', description: '保持当前状态，由用户本人接手', action: 'pause' },
      ],
      planReview: planToBuild,
    }
  }

  /**
   * 非阻塞门禁的返回正文：一段"照抄给用户"的选项块 + 硬性停手指令。
   *
   * 工具建完票就返回了，后面推不推进完全取决于模型有没有老实停手，
   * 所以这段话必须写成**给模型看的强制命令**，而不是说明书。
   */
  function gateAwaitingBlock({ ticket, options, delivery, delivered, timeoutSeconds, armed, superseded, targetLabel, required, checked }) {
    const optionLines = options.map((option, index) => `${index + 1}. ${option.label}${option.description ? `｜${option.description}` : ''}`)
    const deliveredParts = []
    if (delivered?.email !== undefined) deliveredParts.push(`邮件${delivered.email?.ok === true ? '✓' : '✗'}`)
    if (delivered?.im !== undefined) deliveredParts.push(`IM${delivered.im?.ok === true ? '✓' : '✗'}`)
    const deliveryLine = delivery?.deliver === true
      ? `投递：${deliveredParts.length === 0 ? '无可用通道' : deliveredParts.join(' · ')}`
      : `投递：未启用（${delivery?.reason ?? '按配置跳过'}）`
    const supersededLine = Array.isArray(superseded) && superseded.length > 0
      ? `已顶替旧票：${superseded.map(item => `#${item.id}`).join(' ')}（旧票作废，只认这张）`
      : undefined
    const docsLine = Array.isArray(required) && required.length > 0
      ? `本关文档：${required.join(' ')}（${checked?.ok === true ? '已就绪' : '待补齐'}）`
      : undefined
    return [
      `门禁已建票 #${ticket.id} 并**立刻挂起**（hold 生效）。本回合到此为止，不要继续推进。`,
      '',
      '把下面整块原样展示给用户：',
      '',
      `──── Flow 门禁 #${ticket.id} · ${ticket.project} · ${ticket.fromStage} → ${targetLabel} ────`,
      ...optionLines,
      '0. 查看文档 / 草稿摘要',
      `回复：\`#${ticket.id} 1 你的意见\`（桌面也可直接回 \`1\`；微信请带 #${ticket.id}）`,
      deliveryLine,
      docsLine,
      supersededLine,
      '────────────────────────────────',
      '',
      timeoutSeconds > 0
        ? `超时 ${timeoutSeconds} 秒会催办一次（邮件 + IM），到点只催办，不会替你决定。`
        : '本票不设超时，等用户回话即可。',
      armed === true ? '催办定时器已挂上。' : undefined,
      '',
      '**强制指令：请向用户展示以上选项后立刻结束本轮对话，严禁在用户回复前继续推进任何工作。**',
      '用户回复会以 `[Flow 门禁决定]` 开头重新进入本会话，届时按其中的选项与附带指令执行。',
    ].filter(line => line !== undefined && line !== null).join('\n')
  }

  /** 门禁文档投递：邮件（带附件）+ IM（纯文字摘要）。 */
  async function deliverGateDocs({ config, cwd, project, ticket, docIds, extras, fromStage, nextMode, summary }) {
    const limit = Number(config?.email?.attachLimitBytes)
    const { attachments, skipped } = attachmentsOf({
      config,
      cwd,
      ids: docIds,
      extra: extras,
      drafts: ticket.draftContent ? [{ id: ticket.draftId, draftContent: ticket.draftContent }] : [],
      limitBytes: Number.isFinite(limit) && limit > 0 ? limit : 2 * 1024 * 1024,
    })
    const markdown = formatEmailGate(ticket, {
      summary: summary.slice(0, 800),
      docs: docIds,
      stage: `${fromStage} → ${nextMode}`,
    })
    const emailResult = await sendGateEmail({ project, markdown, attachments })
    const digestChars = Number(config?.gate?.imDigestChars)
    const imResult = await sendIm({
      title: 'Flow 阶段门禁待拍板',
      markdown: formatImGate(ticket, {
        digestChars: Number.isFinite(digestChars) && digestChars > 0 ? Math.floor(digestChars) : 200,
        docs: docIds,
      }),
    })
    if (Array.isArray(skipped) && skipped.length > 0) {
      logger?.warn?.(`flow: 门禁附件有跳过项 → ${skipped.join('；')}`)
    }
    logger?.info?.(`flow: 门禁 #${ticket.id} 投递 email=${emailResult.ok === true} im=${imResult.ok === true} 附件=${attachments.length}`)
    return { email: emailResult, im: imResult, skipped }
  }

  /** 超时催办：**恰好一次**，走 `gate.escalate` 指定的通道。 */
  async function escalateOnce({ config, ticket, project, docIds, extras, summary, agent }) {
    const strategy = ['im-first', 'email-first', 'both', 'off'].includes(config?.gate?.escalate)
      ? config.gate.escalate
      : 'both'
    if (strategy === 'off') return { im: undefined, email: undefined }
    const limit = Number(config?.email?.attachLimitBytes)
    const { attachments } = attachmentsOf({
      config,
      cwd: ticket.cwd,
      ids: docIds,
      extra: extras,
      drafts: ticket.draftContent ? [{ id: ticket.draftId, draftContent: ticket.draftContent }] : [],
      limitBytes: Number.isFinite(limit) && limit > 0 ? limit : 2 * 1024 * 1024,
    })
    const markdown = [
      `## Flow 门禁超时 #${ticket.id}`,
      '',
      `- 项目：${project}`,
      `- 阶段：${ticket.fromStage} → ${ticket.nextMode}`,
      `- 结论：${summary.slice(0, 800)}`,
      '',
      '**已严格停手，等你决定**。回 `#票据号 1/2/3 [意见]` 即可（跳过请回 2）。',
    ].join('\n')
    const payload = {
      title: `Flow 门禁超时 #${ticket.id}`,
      project,
      markdown,
      attachments,
      agent,
      session: agent?.session,
      strategy,
    }
    let sent
    try {
      sent = await notifier?.sendNow?.('gate-timeout', payload)
    } catch (error) {
      logger?.warn?.(`flow: 门禁催办失败 → ${error instanceof Error ? error.message : String(error)}`)
      sent = undefined
    }
    return { ...(sent ?? {}), strategy }
  }

  /* -------- permission 门禁 -------- */

  async function runPermissionGate({ agent, sessionId, project, args, exec }) {
    const wantDoc = normalizeDocId(args?.docId)
    const draftContent = typeof args?.draftContent === 'string' ? args.draftContent.trim() : ''

    // R7：申请落盘前必须让用户先看到草稿 —— 否则邮件没附件、IM 回 0 也没东西可读，
    // 用户等于在"看不到内容"的情况下授权，这个闭环必须堵死。
    if (wantDoc !== null && draftContent === '') {
      return {
        outcome: 'blocked',
        message: [
          `申请写入 ${docFileName(wantDoc)} 之前，必须先给 draftContent（完整草稿正文）。`,
          '正确顺序：① 在本回合消息里把方案/文档正文完整展示给用户 → ② 调本工具时把同一份正文放进 draftContent → ③ 用户看到草稿后再决定授权范围。',
          '草稿只会进票据内存与邮件附件（.draft.md），授权通过前不会写任何文件。',
        ].join('\n'),
      }
    }

    const options = [
      { label: '仅本次允许写这篇文章', description: wantDoc === null ? '只放行一次写操作' : `只放行 ${docFileName(wantDoc)}`, action: 'once' },
      { label: '本会话放行 .flow/docs 写入', description: '业务代码仍然只读，只放开文档目录', action: 'session-docs' },
      { label: '拒绝写入', description: '不写文档，继续只读流程', action: 'deny' },
    ]
    const ticket = tickets.create({
      sessionId,
      project,
      cwd: String(agent.session?.header?.cwd ?? ''),
      kind: 'permission',
      level: levelOf(sessionId),
      fromStage: 'plan',
      nextMode: 'off',
      question: '文档落盘需要写权限，授权范围选哪个？（业务代码仍保持只读）',
      options,
      docIds: [],
      attachments: [],
      timeoutSeconds: 0,
      /** 非阻塞建票：立刻 hold，未授权前写盘一律被拦。 */
      hold: true,
      draftId: wantDoc ?? '',
      draftContent,
    })
    if (ticket?.error !== undefined) {
      return { outcome: 'blocked', message: `门禁未创建：${ticket.error}` }
    }

    // 先把草稿发出去（邮件带 .draft.md 附件 + IM 短摘要），用户看到选项时已经有东西可读。
    let preview = { email: undefined, im: undefined }
    if (draftContent !== '') {
      preview = await deliverDraftPreview({ config: getConfig(), project, ticket, wantDoc, draftContent })
    }

    const deliveredParts = []
    if (preview.email !== undefined) deliveredParts.push(`邮件${preview.email?.ok === true ? '✓' : '✗'}`)
    if (preview.im !== undefined) deliveredParts.push(`IM${preview.im?.ok === true ? '✓' : '✗'}`)

    return {
      outcome: 'awaiting-user',
      message: [
        `授权门禁已建票 #${ticket.id} 并**立刻挂起**（hold 生效）。本回合到此为止，不要继续推进。`,
        '',
        '把下面整块原样展示给用户：',
        '',
        `──── Flow 写文档授权 #${ticket.id} · ${project} ────`,
        ...options.map((option, index) => `${index + 1}. ${option.label}｜${option.description}`),
        '0. 查看草稿摘要',
        `回复：\`#${ticket.id} 1\`（桌面也可直接回 \`1\`；微信请带 #${ticket.id}）`,
        wantDoc === null ? '本次申请：写 .flow/docs（不限单篇）' : `本次申请：${docFileName(wantDoc)}`,
        draftContent === '' ? '草稿：无' : '草稿：已作为 .draft.md 附件发出（授权通过前不落盘）',
        deliveredParts.length === 0 ? undefined : `投递：${deliveredParts.join(' · ')}`,
        '路径白名单硬编码：只放行 .flow/docs/** 与 .flow/spec.md，业务代码不受影响。',
        '────────────────────────────────',
        '',
        '**强制指令：请向用户展示以上选项后立刻结束本轮对话，严禁在用户回复前继续推进任何工作。**',
        '用户回复会以 `[Flow 门禁决定]` 开头重新进入本会话，届时按其中的选项执行。',
      ].filter(line => line !== undefined && line !== null).join('\n'),
    }
  }

  /**
   * 投递"尚未落盘"的草稿预览：邮件带 `.draft.md` 附件，IM 只发控长摘要。
   *
   * @param {{ config: object, project: string, ticket: object, wantDoc: string|null, draftContent: string }} input
   * @returns {Promise<{ email?: object, im?: object }>}
   */
  async function deliverDraftPreview({ config, project, ticket, wantDoc, draftContent }) {
    const attachment = draftAttachment({ id: wantDoc ?? '', draftContent })
    const markdown = formatEmailGate(ticket, {
      summary: draftContent.slice(0, 800),
      docs: [],
      stage: wantDoc === null ? '写文档授权' : `写文档授权 · ${docFileName(wantDoc)}`,
    })
    const emailResult = await sendGateEmail({
      project,
      markdown,
      attachments: attachment === undefined ? [] : [attachment],
    })
    const digestChars = Number(config?.gate?.imDigestChars)
    const imResult = await sendIm({
      title: 'Flow 写文档授权（含草稿）',
      markdown: formatImGate(ticket, {
        digestChars: Number.isFinite(digestChars) && digestChars > 0 ? Math.floor(digestChars) : 200,
        docs: [],
      }),
    })
    logger?.info?.(`flow: 授权门禁 #${ticket.id} 草稿预览 email=${emailResult.ok === true} im=${imResult.ok === true} 附件=${attachment === undefined ? 0 : 1}`)
    return { email: emailResult, im: imResult }
  }

  /* ------------------------------------------------------------------ *
   * 工具 3–6：文档骨架 / 校验 / 受控写入 / 投递
   * ------------------------------------------------------------------ */

  const docsInitTool = {
    name: DOCS_INIT_TOOL,
    description: [
      '（文档骨架）在 .flow/docs 下按需要生成编号文档骨架（01–07），已存在的默认不覆盖。',
      '只写模板与元信息头，不含任何用户内容，因此**不需要写授权**。',
      '生成后用 flow_docs_write 填正文，再用 flow_docs_check 自检。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '要生成的文档编号；缺省按当前等级生成整套。' },
        level: { type: 'string', enum: ['S', 'M', 'L'], description: '按哪个等级决定"整套"是哪些文档，缺省用会话等级。' },
        overwrite: { type: 'boolean', description: '是否覆盖已存在的文档（默认 false，覆盖会丢内容，慎用）。' },
      },
    },
    output: outputOf(DOCS_INIT_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      const sessionId = String(guard.agent.session?.id ?? '')
      const level = levelOf(sessionId, args?.level)
      const ids = docIdsOf(args?.ids)
      const wanted = ids.length > 0 ? ids : levelDef(level).docs
      if (wanted.length === 0) {
        return { outcome: 'skipped', message: `等级 ${level} 不需要编号文档（S 级只做 1 轮交互确认）。` }
      }
      const result = ensureDocs({ config, cwd, ids: wanted, overwrite: args?.overwrite === true })
      const lines = [
        '文档目录：.flow/docs',
        result.created.length === 0 ? '新建：无' : `新建：${result.created.join(' ')}`,
        result.skipped.length === 0 ? '已存在跳过：无' : `已存在跳过：${result.skipped.join(' ')}`,
        result.errors.length === 0 ? '' : `失败：${result.errors.map(item => `${item.id}(${item.reason})`).join('；')}`,
        '下一步：flow_docs_write 写正文 → flow_docs_check 自检。',
      ].filter(line => line !== '')
      return { outcome: result.errors.length === 0 ? 'ok' : 'partial', message: lines.join('\n') }
    },
  }

  const docsCheckTool = {
    name: DOCS_CHECK_TOOL,
    description: [
      '（文档自检）逐份校验文档是否存在、是否空壳、必填章节是否齐全，并给出整体结论。',
      '门禁前必须跑一次：M/L 级缺文档会被 flow_stage_gate 直接拦下。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '要校验的编号；缺省按当前等级的全套文档。' },
        level: { type: 'string', enum: ['S', 'M', 'L'], description: '按哪个等级的严格度校验，缺省用会话等级。' },
      },
    },
    output: outputOf(DOCS_CHECK_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      const level = levelOf(String(guard.agent.session?.id ?? ''), args?.level)
      const ids = docIdsOf(args?.ids)
      const wanted = ids.length > 0 ? ids : levelDef(level).docs
      if (wanted.length === 0) {
        return { outcome: 'skipped', message: `等级 ${level} 不需要编号文档。` }
      }
      const checked = checkDocs({ config, cwd, ids: wanted, level })
      const lines = checked.items.map(item => (item.ok
        ? `✓ ${item.id} ${item.title}（${item.bytes} B）`
        : `✗ ${item.id} ${item.title}：${item.reasons.join('；')}`))
      lines.push('', checked.ok ? `全部就绪（${level}）。` : `还缺 ${checked.failed.join(' ')}，补齐前门禁不放行。`)
      return { outcome: checked.ok ? 'ok' : 'blocked', message: lines.join('\n') }
    },
  }

  const docsWriteTool = {
    name: DOCS_WRITE_TOOL,
    description: [
      '（受控写文档）把正文写进 .flow/docs/<编号>-*.md、.flow/docs/preview/*.html 或 .flow/spec.md。',
      '路径白名单硬编码：**只**允许上述位置，业务代码永远写不到，因此只读沙箱下也能落文档。',
      '默认需要写授权（配置 docs.writePolicy=ask 时）：未授权会返回 needs-permission，',
      '此时先调 flow_stage_gate({kind:"permission"}) 让用户选 once / session-docs / deny。',
      '`deliver` 可顺手把写完的文档发邮件/IM（IM 只能发摘要，完整正文走邮件附件）。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['content'],
      properties: {
        id: { type: 'string', enum: [...DOC_IDS], description: '文档编号（01–07）。' },
        target: { type: 'string', enum: ['doc', 'spec', 'preview'], description: '写入目标，默认 doc。' },
        name: { type: 'string', description: 'target=preview 时的文件名（小写字母/数字/短横线）。' },
        content: { type: 'string', description: '完整正文（markdown 或 html）。' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: '覆盖或追加，默认 overwrite。' },
        deliver: { type: 'string', enum: ['none', 'email', 'im', 'both'], description: '写完后是否立即投递，默认 none。' },
      },
    },
    output: outputOf(DOCS_WRITE_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const agent = guard.agent
      const sessionId = String(agent.session?.id ?? '')
      const cwd = String(agent.session?.header?.cwd ?? '')
      const target = args?.target === 'spec' || args?.target === 'preview' ? args.target : 'doc'
      const docId = normalizeDocId(args?.id)

      if (target === 'doc' && docId === null) {
        return { outcome: 'unavailable', message: 'target=doc 时必须给 id（01–07）。' }
      }

      // 超时门禁的 hold 期间严格停手：连文档都不许写（否则等于变相推进）。
      const pendingHold = tickets?.holdOf?.(sessionId)
      if (pendingHold !== undefined && pendingHold !== null) {
        return {
          outcome: 'blocked',
          message: [
            `门禁 #${pendingHold.id} 已超时待决，现在是严格停手状态，不能写文档。`,
            `先让用户回 \`#${pendingHold.id} 1|2|3\`（或桌面 /flow gate answer ${pendingHold.id} 1），再继续。`,
          ].join('\n'),
        }
      }

      const allowed = tickets.canWrite(sessionId, {
        docId: docId ?? undefined,
        policy: config?.docs?.writePolicy === 'auto' ? 'auto' : 'ask',
        cwd,
      })
      if (allowed.ok !== true) {
        return {
          outcome: 'needs-permission',
          message: [
            `${allowed.reason}`,
            '下一步：调用 flow_stage_gate({ kind:"permission", docId:"<编号>" })，让用户选「仅本次 / 本会话放行 / 拒绝」。',
            '（只读会话不能直接改业务代码，但文档必须落盘，所以走这个受控写入。）',
          ].join('\n'),
        }
      }

      const written = writeDoc({
        config,
        cwd,
        target: target === 'doc' ? { kind: 'doc', id: docId } : { kind: target, name: args?.name },
        content: args?.content,
        mode: args?.mode === 'append' ? 'append' : 'overwrite',
      })
      if (written.ok !== true) return { outcome: 'error', message: `写入失败：${written.reason}` }

      if (allowed.scope === 'once') tickets.consumeOnce(sessionId)

      let deliveryNote = ''
      const deliver = args?.deliver
      if (deliver === 'email' || deliver === 'im' || deliver === 'both') {
        const sent = await deliverDoc({
          config,
          cwd,
          project: projectNameOf(cwd),
          docIds: docId === null ? [] : [docId],
          extras: target === 'preview' ? [written.path] : [],
          to: deliver,
        })
        deliveryNote = `\n投递：邮件${sent.email?.ok === true ? '✓' : '✗'} IM${sent.im?.ok === true ? '✓' : '✗'}`
      }

      return {
        outcome: 'ok',
        message: `已写入 ${written.path}（${written.bytes} B，授权 ${allowed.scope}）。${deliveryNote}`,
      }
    },
  }

  const sendDocTool = {
    name: SEND_DOC_TOOL,
    description: [
      '（按需投递文档）把已落盘的编号文档发给用户：`to=email` 走 SMTP 附件（完整正文），',
      '`to=im` 只能发摘要（dsh-im 主动投递不支持文件），`both` 两边都发。',
      '用途：01 默认不主动发邮件，但用户一句「发我邮箱」就要立刻发出并回执。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['docIds'],
      properties: {
        docIds: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '要投递的文档编号。' },
        to: { type: 'string', enum: ['email', 'im', 'both'], description: '投递通道，默认 email。' },
        note: { type: 'string', maxLength: 300, description: '附言，会写进邮件正文与 IM 摘要。' },
      },
    },
    output: outputOf(SEND_DOC_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      const ids = docIdsOf(args?.docIds)
      if (ids.length === 0) return { outcome: 'unavailable', message: '至少要给一个文档编号。' }
      const to = ['email', 'im', 'both'].includes(args?.to) ? args.to : 'email'
      const sent = await deliverDoc({
        config,
        cwd,
        project: projectNameOf(cwd),
        docIds: ids,
        extras: [],
        to,
        note: typeof args?.note === 'string' ? args.note.trim() : '',
      })
      const parts = []
      parts.push(`邮件：${sent.email === undefined ? '未请求' : (sent.email.ok === true ? '已发出（带附件）' : `失败（${sent.email.reason ?? '未知'}）`)}`)
      parts.push(`IM：${sent.im === undefined ? '未请求' : (sent.im.ok === true ? '已发出（摘要）' : `失败（${sent.im.reason ?? '未知'}）`)}`)
      if (Array.isArray(sent.skipped) && sent.skipped.length > 0) parts.push(`跳过：${sent.skipped.join('；')}`)
      return { outcome: sent.email?.ok === true || sent.im?.ok === true ? 'ok' : 'error', message: parts.join('\n') }
    },
  }

  /** 投递文档：邮件带附件，IM 只发摘要 + 「完整文档见邮箱」。 */
  async function deliverDoc({ config, cwd, project, docIds, extras, to, note = '' }) {
    const limit = Number(config?.email?.attachLimitBytes)
    const { attachments, skipped } = attachmentsOf({
      config,
      cwd,
      ids: docIds,
      extra: extras,
      limitBytes: Number.isFinite(limit) && limit > 0 ? limit : 2 * 1024 * 1024,
    })
    const maxChars = Number(config?.gate?.docDigestChars)
    const { text: digest } = digestOf({
      config,
      cwd,
      ids: docIds,
      maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 800,
    })
    const result = { email: undefined, im: undefined, skipped }

    if (to === 'email' || to === 'both') {
      const markdown = [
        '## Flow 文档投递',
        '',
        `- 项目：${project}`,
        `- 文档：${docIds.map(id => `${id} ${docTitle(id)}`).join('、')}`,
        note === '' ? '' : `- 附言：${note}`,
        '',
        '完整正文见附件。',
      ].filter(line => line !== '').join('\n')
      result.email = await sendGateEmail({ project, markdown, attachments, event: 'doc' })
    }
    if (to === 'im' || to === 'both') {
      const header = `[Flow 文档] ${project}\n${docIds.map(id => `${id} ${docTitle(id)}`).join('、')}`
      const tail = result.email === undefined
        ? '（仅 IM：只发摘要，完整正文请回桌面查看文件）'
        : '（完整文档已发至邮箱附件）'
      result.im = await sendIm({
        title: 'Flow 文档',
        markdown: `${header}\n——\n${digest}\n——\n${tail}${note === '' ? '' : `\n附言：${note}`}`,
      })
    }
    return result
  }

  /* ------------------------------------------------------------------ *
   * 工具 7：UI 设计 Skill 探测（非阻塞，纯对话三选一）
   * ------------------------------------------------------------------ */

  const uiSkillTool = {
    name: UI_SKILL_TOOL,
    description: [
      '（UI Skills 探测）进入 UI 与交互阶段前调用一次：探测本机是否装了 taste（design-taste-frontend/tasteskill）或 impeccable。',
      '已安装 → 返回分流建议（从 0 建新页优先 taste，老项目评审抛光优先 impeccable）。',
      '未安装 → 返回**纯对话**三选一（1 装 taste / 2 装 impeccable / 3 暂不安装用内置规范），',
      '不弹门禁、不阻塞流程；用户不回也可以按内置 ui-architect 规范继续。',
      '安装走 🟡 黄灯规则：先确认体积与来源，慢于 60s 或报代理错要停下来问。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '忽略一分钟缓存重新探测（刚装完 Skill 时用）。' },
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

  /* ------------------------------------------------------------------ *
   * 工具 8：派单声明（封死静默不派单）
   * ------------------------------------------------------------------ */

  const dispatchDeclareTool = {
    name: DISPATCH_TOOL,
    description: [
      '（派单声明）M/L 级进入施工前必须先调用一次：探测可用派单工具与只读能力，校验"模式×特种兵"分工与',
      '互不重叠文件白名单，并输出一行 `[调度声明]`。',
      '没有这一行，flow_stage_gate 在切 Build（或 05 定稿进入施工）时会直接 blocked。',
      '没有派单工具时返回诚实降级结论（单线程施工），仍然算有效声明。',
      '白名单任意两段的路径相同或互为父子目录，直接拒绝——子代理越界改文件就是这么来的。',
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
              duty: { type: 'string', description: '一句话职责（会写进 [调度声明]）。' },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: '该子代理可写的文件或目录前缀（互不重叠）。',
              },
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

  /* ------------------------------------------------------------------ *
   * 工具 9：双阶验收交接（06 → 07 简报 / 修复包 / 返工轮次 / qa 通知）
   * ------------------------------------------------------------------ */

  const rework = createReworkTracker()

  const qaHandoffTool = {
    name: QA_HANDOFF_TOOL,
    description: [
      '（双阶验收交接）把 06-blackbox-qa.md 的症状翻译成 07 的定因简报，或把 06+07 合成集中修复包；',
      '同时维护内部返工轮次（1–3 轮放行，第 4 轮硬拦并要求上报用户）。',
      'action=brief：生成给 qa-whitebox 的结构化简报（含 BUG 列表与取证要求）。',
      'action=package：合并 06 症状与 07 根因，生成施工方的集中修复任务包。',
      'action=round：推进一轮返工并返回是否放行；round=4 时 blocked=true。',
      'action=notify：把 06/07 作为附件走 qa 通知（正文置顶 🔴 阻塞项与待人工点验清单）。',
      'action=reset：用户裁决后清零轮次。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['brief', 'package', 'round', 'notify', 'reset'] },
        project: { type: 'string', description: '项目名（通知标题用），缺省取工作目录名。' },
      },
    },
    output: outputOf(QA_HANDOFF_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const agent = guard.agent
      const sessionId = String(agent.session?.id ?? '')
      const cwd = String(agent.session?.header?.cwd ?? '')
      const config = getConfig()
      const project = typeof args?.project === 'string' && args.project.trim() !== ''
        ? args.project.trim()
        : projectNameOf(cwd)
      const action = String(args?.action ?? '')

      if (action === 'round') {
        const state = rework.next(sessionId)
        if (state.blocked) {
          return {
            outcome: 'blocked',
            message: [
              `内部返工已到第 ${state.round} 轮，超过上限 ${state.max} 轮，硬拦。`,
              '请把「试过什么、报了哪些错、已排除什么、现在卡在哪」整理成一页交给用户裁决；',
              '不许再自行改代码，也不许把同一轮拆成两轮绕过计数。',
            ].join('\n'),
          }
        }
        return {
          outcome: 'ok',
          message: `第 ${state.round}/${state.max} 轮返工放行：改完只跑受影响路径的轻回归，然后重新交黑盒复验。`,
        }
      }
      if (action === 'reset') {
        rework.reset(sessionId)
        return { outcome: 'ok', message: '返工轮次已清零（请确保是用户裁决或新一轮任务，而不是为了绕过上限）。' }
      }

      const blackboxText = readDocText({ config, cwd, id: '06' })
      if (blackboxText.trim() === '') {
        return { outcome: 'blocked', message: '找不到 06-blackbox-qa.md：先让 qa-blackbox 产出报告，再来交接。' }
      }
      const whiteboxText = readDocText({ config, cwd, id: '07' })

      if (action === 'brief') {
        const parsed = parseBlackbox(blackboxText)
        const brief = buildWhiteboxBrief({
          project,
          bugs: parsed.bugs,
          manual: parsed.manual,
          source: '06-blackbox-qa.md',
        })
        return {
          outcome: 'ok',
          message: `已生成白盒任务简报（${parsed.bugs.length} 条 BUG / ${parsed.manual.length} 条人工点验）：\n\n${brief}`,
        }
      }

      if (action === 'package') {
        if (whiteboxText.trim() === '') {
          return { outcome: 'blocked', message: '找不到 07-whitebox-qa.md：先让 qa-whitebox 定因，再合并修复包。' }
        }
        const blackbox = parseBlackbox(blackboxText)
        const whitebox = parseWhitebox(whiteboxText)
        const pack = buildFixPackage({
          project,
          bugs: blackbox.bugs,
          roots: whitebox.roots,
          blackboxPath: '06-blackbox-qa.md',
          whiteboxPath: '07-whitebox-qa.md',
        })
        const state = rework.peek(sessionId)
        const head = state.allowed
          ? `修复包已生成（第 ${state.round}/${state.max} 轮之内，可继续）。`
          : `修复包已生成，但返工已用满 ${state.max} 轮：本轮修完必须上报用户裁决。`
        return {
          outcome: pack.missing.length > 0 ? 'partial' : 'ok',
          message: [
            head,
            `未定位：${pack.missing.length === 0 ? '无' : pack.missing.join(' ')}`,
            pack.blocked.length === 0 ? '🔴 Blocker：无' : `🔴 Blocker：${pack.blocked.join(' ')}`,
            '',
            pack.markdown,
          ].join('\n'),
        }
      }

      if (action === 'notify') {
        const payload = buildQaNotification({
          project,
          blackboxText,
          whiteboxText,
          blackboxName: '06-blackbox-qa.md',
          whiteboxName: '07-whitebox-qa.md',
        })
        const strategy = ['im-first', 'email-first', 'both', 'off'].includes(config?.notify?.qa)
          ? config.notify.qa
          : 'email-first'
        let sent
        try {
          sent = await notifier?.sendNow?.('qa', {
            title: `Flow 验收报告 ${project}`,
            project,
            markdown: payload.markdown,
            attachments: payload.attachments,
            agent,
            session: agent.session,
            strategy,
          })
        } catch (error) {
          return { outcome: 'error', message: `qa 通知发送失败：${error instanceof Error ? error.message : String(error)}` }
        }
        const emailOk = sent?.email?.ok === true
        const imOk = sent?.im?.ok === true
        return {
          outcome: emailOk || imOk ? 'ok' : 'error',
          message: [
            `qa 通知：邮件${emailOk ? '✓' : '✗'} IM${imOk ? '✓' : '✗'}（策略 ${strategy}）`,
            `附件：${payload.attachments.map(item => item.filename).join('、') || '无'}`,
            emailOk ? '' : '邮件未发出时，正文里仍保留了 🔴 阻塞项与人工点验清单。',
          ].filter(line => line !== '').join('\n'),
        }
      }

      return { outcome: 'unavailable', message: `未知 action：「${action}」` }
    },
  }

  return [
    routeTool, gateTool, docsInitTool, docsCheckTool, docsWriteTool,
    sendDocTool, uiSkillTool, dispatchDeclareTool, qaHandoffTool,
  ]
}

/** 暴露给命令层复用的小工具（保持单一实现，避免命令与工具两套逻辑漂移）。 */
export const TOOL_INTERNALS = Object.freeze({ projectNameOf, docIdsOf, docFileName, docsNote })
