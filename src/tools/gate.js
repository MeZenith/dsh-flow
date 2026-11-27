/**
 * 工具 2：`flow_stage_gate` — 阶段强门禁 v3（非阻塞 + 飞书卡片实时推送 + D-01 直写放行）。
 *
 * v0.6.0 核心改进：
 * - B-06 修复：`tickets.supersede` 移至所有校验通过、真正创建新票前，被拦截时绝不误删旧票；
 * - D-01 落地：`docs.writePolicy === 'auto'` 时，若模型仍误调 `kind:"permission"`，立即返回已授权，
 *   彻底消灭「先大纲 → 审批写权限 → 落盘 → 再审批方案」的两次弹窗；
 * - 门禁推送解耦：所有门禁建票后立即通过 `remoteHub.emit('gate:created', ...)` 推送飞书互动卡片与文档文件，
 *   不再因 `shouldDeliverDocs` 跳过而让手机收不到首个门禁！
 *
 * @module dsh-flow/tools/gate
 */
import {
  DOC_IDS, FLOW_TOOL_NAMES, GATE_KINDS, GATE_NEXT_MODES, GATE_OPTION_LIMIT, STAGE_IDS,
  normalizeDocId,
} from '../config/constants.js'
import { modeConfigOf } from '../modes/registry.js'
import { gateRequiredDocs, levelOfSession, shouldDeliverDocs } from '../workflow/level.js'
import { attachmentsOf, checkDocs, docFileName, draftAttachment } from '../workflow/docs.js'
import { requiresDeclaration } from '../workflow/dispatch.js'
import { formatEmailGate, formatImGate } from '../gates/tickets.js'
import {
  docIdsOf, extrasOf, outputOf, projectNameOf, rootGuard, sendGateEmail, sendIm, targetLabelOf, timeoutOf,
} from './common.js'

export const GATE_TOOL = FLOW_TOOL_NAMES[1]

export function createGateTool({
  getConfig, logger, notifier, im, email, tickets, dispatchStore, remoteHub, stateStore,
}) {
  function questionOf({ kind, fromStage, config, targetLabel }) {
    if (kind === 'blocker') return '外部条件卡住了，需要你决定怎么继续？'
    if (kind === 'acceptance') return '验收结果怎么处理？'
    if (kind === 'permission') return '要写入 .flow/docs 文档，授权范围选哪个？'
    const fromLabel = modeConfigOf(config, fromStage).label
    return `本阶段（${fromLabel}）已完成，是否切换到 ${targetLabel}？`
  }

  function buildOptions({ kind, config, nextMode, fromStage, custom }) {
    const planToBuild = (fromStage === 'plan' || fromStage === 'plan-ultra') && nextMode === 'build'
    if (Array.isArray(custom) && custom.length > 0) {
      const actions = ['approve', 'skip', 'pause', 'revise', 'deny']
      return {
        options: custom.slice(0, GATE_OPTION_LIMIT).map((label, index) => ({
          label: String(label),
          description: `第 ${index + 1} 个选项（直接回复 ${index + 1}）`,
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

  function gateAwaitingBlock({
    ticket, options, delivery, delivered, feishuPushed, timeoutSeconds, armed, superseded, targetLabel, required, checked,
  }) {
    const optionLines = options.map((option, index) => `${index + 1}. ${option.label}${option.description ? `｜${option.description}` : ''}`)
    const deliveredParts = []
    if (feishuPushed) deliveredParts.push('飞书卡片✓')
    if (delivered?.email !== undefined) deliveredParts.push(`邮件${delivered.email?.ok === true ? '✓' : '✗'}`)
    if (delivered?.im !== undefined) deliveredParts.push(`IM${delivered.im?.ok === true ? '✓' : '✗'}`)
    const deliveryLine = deliveredParts.length > 0
      ? `投递：${deliveredParts.join(' · ')}`
      : `投递：本地等待（${delivery?.reason ?? '未配置远端通道'}）`
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
      `回复：桌面直接回 \`1\`（可附意见，如 \`1 把按钮改蓝\`）；飞书可直接点卡片按钮；其他 IM 请带 \`#${ticket.id} 1\``,
      deliveryLine,
      docsLine,
      supersededLine,
      '────────────────────────────────',
      '',
      timeoutSeconds > 0
        ? `超时 ${timeoutSeconds} 秒会催办一次，到点只催办，不会替你决定。`
        : '本票不设超时，等用户回话即可。',
      armed === true ? '催办定时器已挂上。' : undefined,
      '',
      '**强制指令：请向用户展示以上选项后立刻结束本轮对话，严禁在用户回复前继续推进任何工作。**',
      '用户回复会以 `[Flow 门禁决定]` 开头重新进入本会话，届时按其中的选项与附带指令执行。',
    ].filter(line => line !== undefined && line !== null).join('\n')
  }

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
    const emailResult = await sendGateEmail(email, { project, markdown, attachments })
    const digestChars = Number(config?.gate?.imDigestChars)
    const imResult = await sendIm(im, {
      title: 'Flow 阶段门禁待拍板',
      sessionId: ticket.sessionId,
      markdown: formatImGate(ticket, {
        digestChars: Number.isFinite(digestChars) && digestChars > 0 ? Math.floor(digestChars) : 200,
        docs: docIds,
      }),
    })
    if (Array.isArray(skipped) && skipped.length > 0) {
      logger?.warn?.(`flow: 门禁附件有跳过项 → ${skipped.join('；')}`)
    }
    logger?.info?.(`flow: 门禁 #${ticket.id} 投递 email=${emailResult.ok === true} im=${imResult.ok === true} 附件=${attachments.length}`)
    return { email: emailResult, im: imResult, skipped, attachments }
  }

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
      '**已严格停手，等你决定**。桌面回 `1/2/3`、飞书点卡片按钮或回复 `#票据号 1/2/3 [意见]` 即可。',
    ].join('\n')
    let sent
    try {
      sent = await notifier?.sendNow?.('gate-timeout', {
        title: `Flow 门禁超时 #${ticket.id}`,
        project,
        markdown,
        attachments,
        agent,
        session: agent?.session,
        strategy,
      })
    } catch (error) {
      logger?.warn?.(`flow: 门禁催办失败 → ${error instanceof Error ? error.message : String(error)}`)
      sent = undefined
    }
    return { ...(sent ?? {}), strategy }
  }

  async function deliverDraftPreview({ config, project, ticket, wantDoc, draftContent }) {
    const attachment = draftAttachment({ id: wantDoc ?? '', draftContent })
    const markdown = formatEmailGate(ticket, {
      summary: draftContent.slice(0, 800),
      docs: [],
      stage: wantDoc === null ? '写文档授权' : `写文档授权 · ${docFileName(wantDoc)}`,
    })
    const emailResult = await sendGateEmail(email, {
      project,
      markdown,
      attachments: attachment === undefined ? [] : [attachment],
    })
    const digestChars = Number(config?.gate?.imDigestChars)
    const imResult = await sendIm(im, {
      title: 'Flow 写文档授权（含草稿）',
      sessionId: ticket.sessionId,
      markdown: formatImGate(ticket, {
        digestChars: Number.isFinite(digestChars) && digestChars > 0 ? Math.floor(digestChars) : 200,
        docs: [],
      }),
    })
    return { email: emailResult, im: imResult, attachments: attachment ? [attachment] : [] }
  }

  async function runPermissionGate({ agent, sessionId, project, args }) {
    const config = getConfig()
    // D-01：docs.writePolicy 默认为 auto，直接放行 .flow/docs/** 与 .flow/spec.md，不弹多余权限门禁。
    if (config?.docs?.writePolicy !== 'ask') {
      return {
        outcome: 'approved',
        message: '当前配置允许直接写入 `.flow/docs/**` 与 `.flow/spec.md`（docs.writePolicy=auto），无需额外审批。请直接调用 `flow_docs_write` 落盘文档，再经由阶段门禁交用户审阅完整方案。',
      }
    }

    const wantDoc = normalizeDocId(args?.docId)
    const draftContent = typeof args?.draftContent === 'string' ? args.draftContent.trim() : ''

    if (wantDoc !== null && draftContent === '') {
      return {
        outcome: 'blocked',
        message: [
          `申请写入 ${docFileName(wantDoc)} 之前，必须先给 draftContent（完整草稿正文）。`,
          '正确顺序：① 在本回合消息里把方案/文档正文完整展示给用户 → ② 调本工具时把同一份正文放进 draftContent → ③ 用户看到草稿后再决定授权范围。',
        ].join('\n'),
      }
    }

    const options = [
      { label: '仅本次允许写这篇文章', description: wantDoc === null ? '只放行一次写操作' : `只放行 ${docFileName(wantDoc)}`, action: 'once' },
      { label: '本会话放行 .flow/docs 写入', description: '业务代码仍然只读，只放开文档目录', action: 'session-docs' },
      { label: '拒绝写入', description: '不写文档，继续只读流程', action: 'deny' },
    ]

    // B-06：所有校验通过后才顶替旧票。
    tickets?.supersede?.({ sessionId, kind: 'permission', reason: '被重发的授权门禁顶替' })

    const ticket = tickets.create({
      sessionId,
      project,
      cwd: String(agent.session?.header?.cwd ?? ''),
      kind: 'permission',
      level: levelOfSession(config, sessionId, undefined, stateStore),
      fromStage: 'plan',
      nextMode: 'off',
      question: '文档落盘需要写权限，授权范围选哪个？（业务代码仍保持只读）',
      options,
      docIds: [],
      attachments: [],
      timeoutSeconds: 0,
      hold: true,
      draftId: wantDoc ?? '',
      draftContent,
    })
    if (ticket?.error !== undefined) {
      return { outcome: 'blocked', message: `门禁未创建：${ticket.error}` }
    }

    let preview = { email: undefined, im: undefined, attachments: [] }
    if (draftContent !== '') {
      preview = await deliverDraftPreview({ config, project, ticket, wantDoc, draftContent })
    }
    remoteHub?.emit?.('gate:created', { ticket, attachments: preview.attachments, summary: ticket.question })

    const deliveredParts = []
    if (remoteHub !== undefined) deliveredParts.push('远程通道✓')
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
        `回复：桌面直接回 \`1\`；飞书点卡片按钮；其他 IM 回复 \`#${ticket.id} 1\``,
        wantDoc === null ? '本次申请：写 .flow/docs（不限单篇）' : `本次申请：${docFileName(wantDoc)}`,
        draftContent === '' ? '草稿：无' : '草稿：已作为 .draft.md 附件发出（授权通过前不落盘）',
        deliveredParts.length === 0 ? undefined : `投递：${deliveredParts.join(' · ')}`,
        '路径白名单硬编码：只放行 .flow/docs/** 与 .flow/spec.md，业务代码不受影响。',
        '────────────────────────────────',
        '',
        '**强制指令：请向用户展示以上选项后立刻结束本轮对话，严禁在用户回复前继续推进任何工作。**',
      ].filter(line => line !== undefined && line !== null).join('\n'),
    }
  }

  return {
    name: GATE_TOOL,
    description: [
      '（阶段强门禁）在跨大阶段、外部阻断或验收时停下请用户拍板。',
      '`kind`：stage（阶段切换，默认）/ blocker（外部阻断）/ acceptance（人工验收）/ permission（仅在 docs.writePolicy=ask 时需要）。',
      '当 `docs.writePolicy=auto`（默认）时，`.flow/docs/**` 与 `.flow/spec.md` 可直接调用 `flow_docs_write` 落盘，随后直接调用本工具把完整文档和结构化结论一次交用户拍板！',
      '本工具是非阻塞的：建票后立即返回选项块并同步推送至飞书卡片，必须把选项展示给用户后立刻结束本回合。',
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
          description: '本阶段结构化结论：核心方案要点、关键取舍、影响文件与待确认风险（避免空泛大纲）。',
        },
        specUpdated: { type: 'boolean', description: '是否已把终版方案写入 .flow/spec.md。' },
        kind: { type: 'string', enum: [...GATE_KINDS], description: '门禁形态，默认 stage。' },
        level: { type: 'string', enum: ['S', 'M', 'L'], description: '任务复杂度等级；缺省用会话记录或配置默认。' },
        docIds: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '门禁对应文档编号，如 ["03"] / ["05"] / ["06","07"]。' },
        attachments: { type: 'array', items: { type: 'string' }, description: '额外附件（工作区相对路径，如 .flow/docs/preview/home.html）。' },
        timeoutSeconds: { type: 'number', description: '超时催办秒数；0 表示不设超时。' },
        options: { type: 'array', items: { type: 'string' }, description: '自定义选项标签（≤5 个）。' },
        docId: { type: 'string', description: 'kind=permission 时：目标文档编号。' },
        toStage: { type: 'string', enum: ['build'], description: 'Flow 总控推进到施工期时显式声明。' },
        draftContent: { type: 'string', maxLength: 120_000, description: 'kind=permission 且带 docId 时的完整草稿正文。' },
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
      const level = levelOfSession(config, sessionId, args?.level, stateStore)
      const fromStage = STAGE_IDS.includes(args?.fromStage) ? args.fromStage : STAGE_IDS[0]
      const nextMode = GATE_NEXT_MODES.includes(args?.nextMode) ? args.nextMode : 'build'
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      const specUpdated = args?.specUpdated === true
      const docIds = docIdsOf(args?.docIds)
      const extras = extrasOf(args?.attachments)
      const timeoutSeconds = kind === 'permission' ? 0 : timeoutOf(args, config)

      if (kind === 'permission') {
        return runPermissionGate({ agent, sessionId, project, args })
      }

      /* ---- 1. 文档必达校验（在 supersede 之前！） ---- */
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
            '下一步：flow_docs_init 生成骨架 → flow_docs_write 写正文 → flow_docs_check 自检 → 再调本工具。',
          ].join('\n'),
        }
      }

      /* ---- 2. 派单声明校验（在 supersede 之前！） ---- */
      const toStage = args?.toStage === 'build' ? 'build' : ''
      const needsDeclaration = requiresDeclaration({ level, kind, nextMode, fromStage, docIds, toStage })
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

      /* ---- 3. 校验全部通过后，再顶替旧票并建新票（修复 B-06） ---- */
      const superseded = tickets?.supersede?.({ sessionId, kind, reason: '被重发的门禁顶替' }) ?? []

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
        hold: true,
      })
      if (ticket?.error !== undefined) {
        return { outcome: 'blocked', message: `门禁未创建：${ticket.error}` }
      }

      /* ---- 4. 收集附件并推送：飞书卡片始终实时推送，邮件/旧IM按规则投递 ---- */
      const delivery = shouldDeliverDocs({ kind, docIds })
      let delivered = { email: undefined, im: undefined, skipped: [], attachments: [] }
      if (delivery.deliver) {
        delivered = await deliverGateDocs({
          config, cwd, project, ticket, docIds, extras, fromStage, nextMode, summary,
        })
      } else {
        const limit = Number(config?.email?.attachLimitBytes)
        const gathered = attachmentsOf({
          config,
          cwd,
          ids: docIds,
          extra: extras,
          limitBytes: Number.isFinite(limit) && limit > 0 ? limit : 2 * 1024 * 1024,
        })
        delivered.attachments = gathered.attachments
        // 即使没有文档附件，如果用户配了 IM/飞书，也确保远程能即时收到门禁提醒！
        if (config?.notify?.gate !== 'off') {
          const digestChars = Number(config?.gate?.imDigestChars)
          delivered.im = await sendIm(im, {
            title: 'Flow 阶段门禁待拍板',
            sessionId: ticket.sessionId,
            markdown: formatImGate(ticket, {
              digestChars: Number.isFinite(digestChars) && digestChars > 0 ? Math.floor(digestChars) : 200,
              docs: docIds,
            }),
          })
        }
      }

      let feishuPushed = false
      if (remoteHub !== undefined) {
        remoteHub.emit('gate:created', {
          ticket,
          attachments: delivered.attachments ?? [],
          summary,
        })
        feishuPushed = true
      }

      const armed = timeoutSeconds > 0 && tickets?.armEscalation?.(ticket.id, timeoutSeconds * 1000, async () => {
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
          feishuPushed,
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
}
