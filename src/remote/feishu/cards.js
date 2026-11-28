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

function shortSessionId(sessionId) {
  const clean = String(sessionId ?? '').trim()
  if (clean === '') return ''
  const stripped = clean.replace(/^session-/i, '')
  return (stripped || clean).slice(0, 8)
}

function buttonEl({ text, type = 'default', value }) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: clip(text, 28) },
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

/** 按每行最多 `perRow` 个按钮分行排布，避免窄屏手机 6–8 个按钮挤在同一行（P2-1 修复）。 */
function buttonRows(buttons, perRow = 3) {
  const rows = []
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttonColumnSet(buttons.slice(i, i + perRow)))
  }
  return rows
}

/** 1. 工作区与在线会话选择卡片。 */
export function buildWorkspaceCard({
  workspaces = [],
  sessions = [],
  activeFocus,
  botAlias = DEFAULT_BOT_NAME,
  bindKey = '',
  isGroup = false,
}) {
  const scopeMeta = bindKey ? { bindKey, isGroup: isGroup === true } : {}
  const elements = []
  const focusLabel = activeFocus?.project
    ? `当前聚焦：**${activeFocus.project}**${activeFocus.sessionId ? `（\`${shortSessionId(activeFocus.sessionId)}\`）` : ''}`
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
          project: clip(item.project, 40),
          ...scopeMeta,
        },
      })
    })
    elements.push(...buttonRows(buttons, 3))
  } else {
    elements.push(mdBlock('暂无在线桌面会话。若工作区列表里有项目，可点下方按钮尝试唤醒，或在 DSH 桌面端打开目录。'))
  }

  const offlineWorkspaces = workspaces.filter(ws => ws.onlineCount === 0).slice(0, 6)
  if (offlineWorkspaces.length > 0) {
    elements.push(mdBlock('**最近使用工作区（离线）**'))
    elements.push(...buttonRows(offlineWorkspaces.map(ws => buttonEl({
      text: `📁 ${ws.name}`,
      type: 'default',
      value: {
        kind: 'focus:workspace',
        cwd: ws.cwd,
        ...(ws.workspaceId ? { workspaceId: ws.workspaceId } : {}),
        project: clip(ws.name, 40),
        ...scopeMeta,
      },
    })), 3))
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
      label: clip(opt.label, 32),
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

  elements.push(...buttonRows(optionButtons, 3))
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
        ...buttonRows(buttons, 3),
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

const SENSITIVE_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|credential|dsn|connection[_-]?string)/i

/** 对文本中的常见密钥、凭证、私钥与连接串密码做脱敏（防止经审批卡片外泄至飞书云端历史）。 */
export function redactSensitiveText(text) {
  let out = String(text ?? '')
  if (out === '') return ''
  out = out.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
  out = out.replace(/(\b(?:proxy-)?authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s"',;}\n]+/gi, '$1[REDACTED]')
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi, '$1[REDACTED]$3')
  out = out.replace(/((?:["'])?\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|cookie|credential|dsn)\b(?:["'])?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, '$1[REDACTED]')
  return out
}

/** 深度脱敏对象中的敏感字段，用于审批参数 JSON 序列化前清洗。 */
export function redactSensitiveValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item, seen))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = redactSensitiveValue(v, seen)
    }
  }
  return out
}

/** 使用比正文最长反引号序列更长的围栏包裹代码块，防止内容中的 ``` 冲破卡片渲染。 */
export function wrapCodeFence(text) {
  const body = String(text ?? '')
  let maxRun = 2
  for (const match of body.matchAll(/`+/g)) {
    if (match[0].length > maxRun) maxRun = match[0].length
  }
  const fence = '`'.repeat(maxRun + 1)
  return `${fence}\n${body}\n${fence}`
}

const HIGH_RISK_TOOL_RE = /^(?:bash|shell|exec|run_command|terminal|powershell|cmd|delete_file|remove_file|unlink|rmdir)$/i
const HIGH_RISK_TEXT_RULES = Object.freeze([
  { re: /\brm\s+-[a-z]*[rf][a-z]*/i, label: '递归强制删除 (rm)' },
  { re: /\b(?:del\s+\/[fq]|rmdir\s+\/s|remove-item\b[^\n]*-recurse)/i, label: '强制删除文件/目录' },
  { re: /\bgit\s+push\s+(?:--force(?:-with-lease)?|-f)\b/i, label: 'Git 强制推送' },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/i, label: 'Git 破坏性清理/重置' },
  { re: /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, label: '数据库删表/清库' },
  { re: /\b(?:chmod\s+777|mkfs\b|shutdown\b|reg\s+delete)\b/i, label: '高危系统/权限指令' },
  { re: /(?:curl|wget)[^\n|]*\|\s*(?:ba)?sh\b|\biex\s*\(/i, label: '远程脚本直接执行' },
])

/** 对 DSH 工具审批请求做风险分级，识别 Shell / 删文件 / 破坏性命令等高危操作。 */
export function classifyApprovalRisk({ toolName = '', reason = '', input, summary = '' } = {}) {
  const reasons = []
  const cleanTool = String(toolName ?? '').trim()
  if (HIGH_RISK_TOOL_RE.test(cleanTool)) {
    reasons.push(`敏感工具 \`${cleanTool}\``)
  }
  let inputText = ''
  if (typeof input === 'string') inputText = input
  else if (input !== undefined && input !== null) {
    try { inputText = JSON.stringify(input) } catch { inputText = '' }
  }
  const corpus = [reason, summary, inputText].filter(Boolean).join('\n')
  for (const rule of HIGH_RISK_TEXT_RULES) {
    if (rule.re.test(corpus)) reasons.push(rule.label)
  }
  return {
    level: reasons.length > 0 ? 'high' : 'normal',
    reasons: [...new Set(reasons)],
  }
}

/** 9a. DSH 普通工具执行审批卡片（支持三档高危护栏：allow / pin / desktop-only）。 */
export function buildToolApprovalCard({
  approvalId,
  project = '桌面会话',
  toolName = '未知工具',
  reason = '',
  summary = '',
  botAlias = DEFAULT_BOT_NAME,
  risk,
  highRiskPolicy = 'allow',
}) {
  const safeReason = redactSensitiveText(reason)
  const safeSummary = redactSensitiveText(summary)
  const isHighRisk = risk?.level === 'high'
  const effectivePolicy = isHighRisk ? highRiskPolicy : 'allow'
  const riskReasons = Array.isArray(risk?.reasons) && risk.reasons.length > 0
    ? risk.reasons.join('、')
    : ''

  const policyNotice = effectivePolicy === 'desktop-only'
    ? '🔒 已启用「高危仅桌面确认」：请回到桌面端确认放行，飞书仅可拒绝。'
    : effectivePolicy === 'pin'
      ? `🔐 已启用「高危 PIN 二次确认」：请回复 \`/approve ${approvalId} <PIN>\` 放行，或点下方拒绝。`
      : ''

  const lines = [
    `**项目**：${project}　｜　**工具**：\`${toolName}\``,
    isHighRisk ? `⚠️ **高危操作识别**：${riskReasons || '高风险动作'}` : '',
    safeReason ? `**说明**：${clip(safeReason, 400)}` : '',
    safeSummary ? `**操作内容**：\n${wrapCodeFence(clip(safeSummary, 700))}` : '',
    policyNotice,
  ].filter(Boolean).join('\n')

  const buttons = effectivePolicy === 'allow'
    ? [
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
    ]
    : [
      buttonEl({
        text: '❌ 拒绝',
        type: 'danger',
        value: { kind: 'approval:decide', approvalId, decision: 'rejected' },
      }),
    ]

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(
      isHighRisk ? `⚠️ 高危工具执行审批 · ${toolName}` : `🔐 工具执行审批 · ${toolName}`,
      `${botAlias} · ${project}`,
      isHighRisk ? 'red' : 'orange',
    ),
    body: {
      elements: [
        mdBlock(lines),
        { tag: 'hr' },
        buttonColumnSet(buttons),
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
  const byText = by === 'feishu' ? '飞书卡片' : by === 'desktop' ? '桌面端' : by === 'timeout' ? '超时自动结束' : '系统'
  const isAllowed = decision === 'allowed-once'
  const isCancelled = decision === 'cancelled'
  const isUnavailable = decision === 'unavailable'
  const title = isAllowed
    ? `✅ 已允许执行 · ${toolName}`
    : isUnavailable
      ? `⌛ 审批已结束 · ${toolName}`
      : isCancelled
        ? `⏹ 审批已取消 · ${toolName}`
        : `❌ 已拒绝执行 · ${toolName}`
  const template = isAllowed ? 'green' : 'grey'
  const statusText = isAllowed
    ? '允许本次执行'
    : isUnavailable
      ? (by === 'timeout' ? '审批已超时，未执行' : '飞书已断开，审批结束')
      : isCancelled
        ? '已取消'
        : '已拒绝'

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: cardHeader(title, `${botAlias} · ${project}`, template),
    body: {
      elements: [
        mdBlock(`**结果**：${statusText}（经由 ${byText}）`),
      ],
    },
  }
}
