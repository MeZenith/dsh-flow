/**
 * 飞书交互卡片构造器（Card JSON 2.0）。
 *
 * 四类核心卡片：
 * 1. 工作区/会话选择器卡片（`/m` 或首次对话）
 * 2. 阶段门禁审批卡片（+ 结算后的灰态不可点击卡片）
 * 3. 熔断紧急抢救卡片（+ 解锁后的恢复态卡片）
 * 4. 阶段完结/通用汇总卡片 + 连通性测试卡片
 *
 * 所有按钮的 `behaviors` 采用 `callback`，附带轻量 JSON `value`，
 * 便于 3 秒内秒回 toast 并原地 `im.v1.message.patch` 更新卡片状态。
 *
 * @module dsh-flow/remote/feishu/cards
 */
import { docFileName } from '../../workflow/docs.js'
import { DEFAULT_BOT_NAME } from './presets.js'

function clip(text, max = 900) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function cardHeader(title, subtitle, template = 'blue') {
  return {
    template,
    title: { tag: 'plain_text', content: title },
    ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
  }
}

function mdBlock(content) {
  return { tag: 'markdown', content: String(content ?? '') }
}

function buttonEl({ text, type = 'default', value }) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    size: 'medium',
    behaviors: [{ type: 'callback', value }],
  }
}

function buttonColumnSet(buttons) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.map(btn => ({
      tag: 'column',
      width: 'auto',
      elements: [btn],
    })),
  }
}

/** 1. 工作区与在线会话选择卡片。 */
export function buildWorkspaceCard({ workspaces = [], sessions = [], activeFocus, botAlias = DEFAULT_BOT_NAME }) {
  const elements = []
  const focusLabel = activeFocus?.project
    ? `当前聚焦：**${activeFocus.project}**${activeFocus.sessionId ? `（\`${activeFocus.sessionId.slice(0, 8)}\`）` : ''}`
    : '当前未聚焦任何会话，请点击下方按钮选择项目，或直接输入 `@项目名 你的指令`。'
  elements.push(mdBlock(focusLabel))

  if (sessions.length > 0) {
    elements.push(mdBlock('**在线桌面会话（点击即切换指挥目标）**'))
    const buttons = sessions.slice(0, 8).map(item => {
      const badge = item.isTripped ? '🚨' : item.pendingGateIds?.length > 0 ? '🟡' : '🟢'
      const isFocused = activeFocus?.sessionId === item.sessionId
      return buttonEl({
        text: `${badge} ${item.project} [${item.mode}]`,
        type: isFocused ? 'primary' : 'default',
        value: {
          kind: 'focus:session',
          sessionId: item.sessionId,
          cwd: item.cwd,
          project: item.project,
        },
      })
    })
    elements.push(buttonColumnSet(buttons))
  } else {
    elements.push(mdBlock('暂无在线桌面会话。若工作区列表里有项目，可点下方按钮尝试唤醒，或在 DSH 桌面端打开目录。'))
  }

  const offlineWorkspaces = workspaces.filter(ws => ws.onlineCount === 0).slice(0, 6)
  if (offlineWorkspaces.length > 0) {
    elements.push(mdBlock('**最近使用工作区（离线）**'))
    elements.push(buttonColumnSet(offlineWorkspaces.map(ws => buttonEl({
      text: `📁 ${ws.name}`,
      type: 'default',
      value: {
        kind: 'focus:workspace',
        cwd: ws.cwd,
        project: ws.name,
      },
    }))))
  }

  elements.push(mdBlock('常用指令：`/m` 项目面板 · `/p` 查看待决门禁/熔断 · `/mode build` 切模式 · `/stop` 中止 · `@项目名 指令` 直发'))

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`${botAlias} · 项目指挥台`, `在线会话 ${sessions.length} 个 · 工作区 ${workspaces.length} 个`, 'wathet'),
    body: { elements },
  }
}

/** 2. 阶段门禁审批卡片。 */
export function buildGateCard({ ticket, botAlias = DEFAULT_BOT_NAME }) {
  const stage = ticket.fromStage && ticket.nextMode
    ? `${ticket.fromStage} → ${ticket.nextMode}`
    : ticket.kind
  const docList = Array.isArray(ticket.docIds) && ticket.docIds.length > 0
    ? ticket.docIds.map(id => `\`${docFileName(id)}\``).join('、')
    : (ticket.draftContent ? '未落盘草稿（已随附或可点摘要）' : '无关联文档')

  const elements = [
    mdBlock([
      `**项目**：${ticket.project}　｜　**阶段**：${stage}　｜　**票据**：\`#${ticket.id}\``,
      `**文档**：${docList}`,
    ].join('\n')),
    { tag: 'hr' },
    mdBlock(clip(ticket.summary || ticket.question || '请确认是否推进到下一阶段。', 1500)),
  ]

  const optionButtons = (Array.isArray(ticket.options) ? ticket.options : []).map((opt, index) => buttonEl({
    text: `${index + 1}. ${opt.label}`,
    type: index === 0 ? 'primary' : (opt.action === 'pause' || opt.action === 'deny' ? 'danger' : 'default'),
    value: {
      kind: 'gate:decide',
      ticketId: ticket.id,
      token: String(index + 1),
      action: opt.action,
      label: opt.label,
    },
  }))

  optionButtons.push(buttonEl({
    text: '📄 查看文档摘要',
    type: 'default',
    value: {
      kind: 'gate:digest',
      ticketId: ticket.id,
    },
  }))

  elements.push(buttonColumnSet(optionButtons))
  elements.push(mdBlock(`如需附带修改意见，可直接回复：\`#${ticket.id} 1 你的具体意见\``))

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`Flow 门禁待拍板 · #${ticket.id}`, `${botAlias} · ${ticket.project}`, 'orange'),
    body: { elements },
  }
}

/** 2b. 门禁已结算后的回写卡片（原地移除按钮防重复点击）。 */
export function buildGateResolvedCard({ ticket, action, label, by = 'feishu', note = '', effects, botAlias = DEFAULT_BOT_NAME }) {
  const byText = by === 'feishu' ? '飞书卡片' : by === 'desktop' ? '桌面端' : by === 'cmd' ? '桌面命令' : by
  const modeNote = effects?.mode?.applied === true ? ` · 已切到 ${effects.mode.label ?? effects.mode.mode}` : ''
  const scopeNote = effects?.scope ? ` · 授权 ${effects.scope}` : ''

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`✅ 门禁已结算 · #${ticket.id}`, `${botAlias} · ${ticket.project}`, 'green'),
    body: {
      elements: [
        mdBlock([
          `**决定**：${label || action}（经由 ${byText}${modeNote}${scopeNote}）`,
          note ? `**附带意见**：${clip(note, 400)}` : '',
          `**原摘要**：${clip(ticket.summary || ticket.question, 400)}`,
        ].filter(Boolean).join('\n')),
      ],
    },
  }
}

/** 3. 熔断告警抢救卡片。 */
export function buildBrakeCard({ brake, botAlias = DEFAULT_BOT_NAME }) {
  const errLines = (Array.isArray(brake.errors) ? brake.errors : [])
    .slice(-5)
    .map((line, idx) => `${idx + 1}. \`${clip(line, 200)}\``)
    .join('\n')

  const buttons = [
    buttonEl({
      text: '🔄 1. 原模型重试',
      type: 'primary',
      value: { kind: 'brake:action', sessionId: brake.sessionId, action: 'retry', project: brake.project },
    }),
    buttonEl({
      text: '🧠 2. 切救场强模型诊断',
      type: 'default',
      value: { kind: 'brake:action', sessionId: brake.sessionId, action: 'escalate', project: brake.project },
    }),
    buttonEl({
      text: '🔓 3. 仅解除熔断',
      type: 'danger',
      value: { kind: 'brake:action', sessionId: brake.sessionId, action: 'resume', project: brake.project },
    }),
  ]

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`🚨 Flow 熔断急刹 · ${brake.project}`, `${botAlias} · 连续失败 ${brake.streak}/${brake.threshold} 次`, 'red'),
    body: {
      elements: [
        mdBlock([
          `**项目**：${brake.project}　｜　**模式**：${brake.mode || 'off'}`,
          '**最近报错**：',
          errLines || '（无详细报错）',
        ].join('\n')),
        { tag: 'hr' },
        buttonColumnSet(buttons),
        mdBlock('也可直接回复 `3 你的新指令` 解除暂停并改派任务。'),
      ],
    },
  }
}

/** 3b. 熔断已解除后的回写卡片。 */
export function buildBrakeResolvedCard({ project, reason = 'manual', detail = '', botAlias = DEFAULT_BOT_NAME }) {
  const verb = reason === 'retry'
    ? '已清零计数并用原模型重试'
    : reason === 'escalate'
      ? '已切换救场强模型继续诊断'
      : reason === 'user-message'
        ? '用户已发新消息自动解除'
        : '已解除熔断暂停'
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`🟢 熔断已解除 · ${project}`, `${botAlias}`, 'grey'),
    body: {
      elements: [
        mdBlock([`**状态**：${verb}`, detail].filter(Boolean).join('\n')),
      ],
    },
  }
}

/** 4. 通用汇总 / 完成通知卡片。 */
export function buildSummaryCard({ title, project = '', markdown = '', template = 'blue', botAlias = DEFAULT_BOT_NAME }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(title || 'Flow 进展同步', `${botAlias}${project ? ` · ${project}` : ''}`, template),
    body: {
      elements: [mdBlock(clip(markdown, 2500))],
    },
  }
}

export const STREAM_ELEMENT_ID = 'stream_md'

const MODE_GUIDE_ITEMS = Object.freeze([
  { id: 'flow', label: '🚀 Flow 全托管', desc: '提需求 → 审方案 → 自动写码与验收（推荐）' },
  { id: 'plan', label: '📋 Plan 规划', desc: '只读调研与快速出方案，不动业务代码' },
  { id: 'plan-ultra', label: '🧠 Plan Ultra', desc: '复杂需求多视角深度架构评审' },
  { id: 'build', label: '🔨 Build 写代码', desc: '按方案专注实现与改代码' },
  { id: 'review', label: '🔍 Review 验收', desc: '独立审查改动与黑盒/白盒测试' },
  { id: 'off', label: '💬 普通模式', desc: '关闭 Flow 规则，回到原生对话' },
])

/** 5. 设置页「发送飞书测试卡片」。 */
export function buildTestCard({ botAlias = DEFAULT_BOT_NAME, domain = 'feishu', appId = '' }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`✅ ${botAlias} 连通测试`, `飞书直连正常（${domain}）`, 'green'),
    body: {
      elements: [
        mdBlock([
          '收到这张互动卡片，说明 **dsh-flow 直连飞书** 的发消息与 WebSocket 长连接均已打通。',
          appId ? `- App ID：\`${appId}\`` : '',
          `- 时间：${new Date().toISOString()}`,
          '',
          '点击下方按钮即可测试互动卡片回调（3 秒内回执）：',
        ].filter(Boolean).join('\n')),
        buttonColumnSet([
          buttonEl({
            text: '📂 选择项目',
            type: 'primary',
            value: { kind: 'ui:open-workspaces' },
          }),
          buttonEl({
            text: '🧭 切换模式',
            type: 'default',
            value: { kind: 'ui:open-modes' },
          }),
          buttonEl({
            text: '👍 测试回调',
            type: 'default',
            value: { kind: 'ui:ping' },
          }),
        ]),
      ],
    },
  }
}

/** 6. 开箱欢迎与 1 分钟使用指南卡片（首次连上 / 发「帮助」「菜单」「/help」自动推送）。 */
export function buildWelcomeCard({ botAlias = DEFAULT_BOT_NAME, sessions = [], activeFocus } = {}) {
  const focusLine = activeFocus?.project
    ? `当前聚焦：**${activeFocus.project}**`
    : (sessions.length > 0
      ? `检测到桌面端有 **${sessions.length}** 个在线项目（${sessions.slice(0, 3).map(s => s.project).join('、')}）`
      : '请先在电脑端打开 DSH 会话，这里就能随时远程指挥。')

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`👋 你好，我是 ${botAlias}`, '手机飞书直连桌面 DSH · 随时派活与一键拍板', 'blue'),
    body: {
      elements: [
        mdBlock(focusLine),
        { tag: 'hr' },
        mdBlock([
          '**3 秒上手（不用背命令，点按钮就行）**',
          '1. **直接打字**：像聊天一样提需求，AI 会在卡片里**实时流式回复**你。',
          '2. **切项目 / 切模式**：点下方按钮（或在输入框打 `/` 呼出快捷菜单）。',
          '3. **自动推送拍板**：桌面端遇到方案审批、报错熔断或工具权限确认时，会自动给你弹按钮卡片，点一下电脑立刻继续干活。',
        ].join('\n')),
        { tag: 'hr' },
        mdBlock([
          '**常用快捷指令速查**',
          '• `/m` — 打开项目指挥台，切换桌面项目',
          '• `/mode` — 弹出模式选择卡片（或 `/mode flow` 直接切）',
          '• `/p` — 查看所有待拍板门禁与熔断告警',
          '• `/stop` — 立即停止当前正在回答的 AI',
          '• `@项目名 你的指令` — 一步切项目并下达任务',
          '• `/new 目录名 首条指令` — 在目标目录新建会话',
          '• `/id` — 查看你的 `open_id`（用于设置白名单）',
        ].join('\n')),
        buttonColumnSet([
          buttonEl({ text: '📂 选择项目', type: 'primary', value: { kind: 'ui:open-workspaces' } }),
          buttonEl({ text: '🧭 切换模式', type: 'default', value: { kind: 'ui:open-modes' } }),
          buttonEl({ text: '📋 查看待办', type: 'default', value: { kind: 'ui:open-pending' } }),
        ]),
      ],
    },
  }
}

/** 7. 图形化模式切换卡片（`/mode` 或点「🧭 切换模式」弹出）。 */
export function buildModeCard({ project = '当前项目', sessionId = '', currentMode = 'off', botAlias = DEFAULT_BOT_NAME }) {
  const descLines = MODE_GUIDE_ITEMS.map(item => (
    `${item.id === currentMode ? '👉 ' : ''}**${item.label}** — ${item.desc}`
  )).join('\n')

  const buttons = MODE_GUIDE_ITEMS.map(item => buttonEl({
    text: item.label,
    type: item.id === currentMode ? 'primary' : 'default',
    value: {
      kind: 'mode:switch',
      sessionId,
      project,
      mode: item.id,
    },
  }))

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`🧭 切换模式 · ${project}`, `${botAlias} · 当前：${currentMode}`, 'indigo'),
    body: {
      elements: [
        mdBlock(descLines),
        { tag: 'hr' },
        buttonColumnSet(buttons),
      ],
    },
  }
}

/** 8a. 实时流式回复进行中卡片（支持 CardKit `streaming_mode: true` 与 `patchCard` 双通道）。 */
export function buildStreamingReplyCard({
  project = '桌面会话',
  mode = 'off',
  sessionId = '',
  markdown = '⏳ 正在思考…',
  botAlias = DEFAULT_BOT_NAME,
  streaming = false,
}) {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      ...(streaming
        ? {
          streaming_mode: true,
          summary: { content: `${project} 正在思考…` },
        }
        : {}),
    },
    header: cardHeader(`⏳ ${project} · ${mode}`, `${botAlias} · 思考中`, 'blue'),
    body: {
      elements: [
        { tag: 'markdown', element_id: STREAM_ELEMENT_ID, content: String(markdown || '⏳ 正在思考…') },
        buttonColumnSet([
          buttonEl({
            text: '⏹ 停止',
            type: 'danger',
            value: { kind: 'turn:abort', sessionId, project },
          }),
        ]),
      ],
    },
  }
}

/** 8b. 流式回复定稿卡片（完整 Markdown + 底部轻量快捷操作栏）。 */
export function buildFinalReplyCard({
  project = '桌面会话',
  mode = 'off',
  sessionId = '',
  markdown = '',
  status = 'completed',
  partInfo = '',
  showActions = true,
  botAlias = DEFAULT_BOT_NAME,
}) {
  const icon = status === 'aborted' ? '⏹' : status === 'error' ? '⚠️' : '✅'
  const template = status === 'aborted' ? 'grey' : status === 'error' ? 'red' : 'wathet'
  const suffix = partInfo ? `（${partInfo}）` : ''
  const elements = [
    { tag: 'markdown', element_id: STREAM_ELEMENT_ID, content: String(markdown || '（无文本输出）') },
  ]
  if (showActions) {
    elements.push({ tag: 'hr' })
    elements.push(buttonColumnSet([
      buttonEl({ text: '📂 换项目', type: 'default', value: { kind: 'ui:open-workspaces' } }),
      buttonEl({ text: '🧭 切模式', type: 'default', value: { kind: 'ui:open-modes', sessionId, project } }),
      buttonEl({ text: '📋 待办', type: 'default', value: { kind: 'ui:open-pending' } }),
      buttonEl({ text: '📖 指南', type: 'default', value: { kind: 'ui:open-help' } }),
    ]))
  }
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: false,
      summary: { content: clip(markdown.replace(/\s+/g, ' '), 60) || `${project} 回复完成` },
    },
    header: cardHeader(`${icon} ${project} · ${mode}${suffix}`, botAlias, template),
    body: { elements },
  }
}

/** 9a. DSH 普通工具执行审批卡片（竞争式审批：手机或电脑任意一端先点即生效）。 */
export function buildToolApprovalCard({
  approvalId,
  project = '桌面会话',
  toolName = '未知工具',
  reason = '',
  summary = '',
  botAlias = DEFAULT_BOT_NAME,
}) {
  const lines = [
    `**项目**：${project}　｜　**工具**：\`${toolName}\``,
    reason ? `**说明**：${clip(reason, 400)}` : '',
    summary ? `**操作内容**：\n\`\`\`\n${clip(summary, 700)}\n\`\`\`` : '',
  ].filter(Boolean).join('\n')

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(`🔐 工具执行审批 · ${toolName}`, `${botAlias} · ${project}`, 'orange'),
    body: {
      elements: [
        mdBlock(lines),
        { tag: 'hr' },
        buttonColumnSet([
          buttonEl({
            text: '✅ 允许本次',
            type: 'primary',
            value: { kind: 'approval:decide', approvalId, decision: 'allowed-once' },
          }),
          buttonEl({
            text: '❌ 拒绝',
            type: 'danger',
            value: { kind: 'approval:decide', approvalId, decision: 'rejected' },
          }),
        ]),
      ],
    },
  }
}

/** 9b. DSH 工具执行审批完成回写卡片（原地移除按钮防误点）。 */
export function buildToolApprovalResolvedCard({
  project = '桌面会话',
  toolName = '工具',
  decision = 'allowed-once',
  by = 'feishu',
  botAlias = DEFAULT_BOT_NAME,
}) {
  const byText = by === 'feishu' ? '飞书卡片' : by === 'desktop' ? '桌面端' : '系统'
  const isAllowed = decision === 'allowed-once'
  const isCancelled = decision === 'cancelled'
  const title = isAllowed
    ? `✅ 已允许执行 · ${toolName}`
    : isCancelled
      ? `⏹ 审批已取消 · ${toolName}`
      : `❌ 已拒绝执行 · ${toolName}`
  const template = isAllowed ? 'green' : 'grey'

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(title, `${botAlias} · ${project}`, template),
    body: {
      elements: [
        mdBlock(`**结果**：${isAllowed ? '允许本次执行' : isCancelled ? '已取消' : '已拒绝'}（经由 ${byText}）`),
      ],
    },
  }
}
