/**
 * 全仓领域常量与纯归一化工具（零副作用、零外部依赖）。
 *
 * @module dsh-flow/config/constants
 */

/* ---------------- 模式 ---------------- */

export const MODE_OFF = 'off'
export const MODE_IDS = Object.freeze(['plan', 'plan-ultra', 'build', 'review', 'flow'])
export const PROMPT_MODES = MODE_IDS
export const MODE_CHOICES = Object.freeze([MODE_OFF, ...MODE_IDS])

export const MODE_PRESETS = Object.freeze({
  plan: { label: 'Plan', description: '日常快速读码与方案规划', permission: 'read-only' },
  'plan-ultra': { label: 'Plan Ultra', description: '复杂需求深度多视角规划', permission: 'read-only' },
  build: { label: 'Build', description: '专注按方案编写与修改代码', permission: 'workspace-write' },
  review: { label: 'Review', description: '独立审查 git diff 与验收', permission: 'read-only' },
  flow: { label: 'Flow', description: '全能总控入口，按阶段推进', permission: 'workspace-write' },
})

export const OFF_LABEL = '普通模式'
export const OFF_DESCRIPTION = '关闭模式提示词，不修改权限与模型'

export const PERMISSION_CHOICES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
  'keep',
])

export const AUTONOMY_CHOICES = Object.freeze(['one-gate', 'step-by-step'])

/* ---------------- 工具 & 阶段 ---------------- */

export const FLOW_TOOL_NAMES = Object.freeze(['flow_choose_route', 'flow_stage_gate'])
export const STAGE_IDS = Object.freeze(['plan', 'plan-ultra', 'build', 'review'])
export const GATE_NEXT_MODES = Object.freeze(['build', 'review', 'plan', 'flow', 'off'])
export const ROUTE_CHOICES = Object.freeze(['plan', 'plan-ultra', 'build'])

/* ---------------- 通知 & SMTP ---------------- */

export const NOTIFY_STRATEGIES = Object.freeze(['im-first', 'email-first', 'both', 'off'])
export const NOTIFY_EVENTS = Object.freeze(['brake', 'gate', 'team', 'archive', 'qa', 'doc', 'gate-timeout'])
export const SMTP_PROVIDERS = Object.freeze(['qq', 'netease', 'gmail', 'custom'])
export const FEISHU_DOMAINS = Object.freeze(['feishu', 'lark'])
export const HIGH_RISK_APPROVAL_POLICIES = Object.freeze(['allow', 'pin', 'desktop-only'])

/** 邮件主题状态标签（已统一合并 v0.5+ 新增事件）。 */
export const NOTIFY_SUBJECT_TAG = Object.freeze({
  brake: '熔断告警',
  gate: '待拍板',
  team: '团队异常',
  archive: '任务完结',
  qa: '验收报告',
  doc: '文档投递',
  'gate-timeout': '门禁超时',
})

/* ---------------- 分级 / 文档 / 门禁 ---------------- */

export const LEVEL_IDS = Object.freeze(['S', 'M', 'L'])
export const GATE_KINDS = Object.freeze(['stage', 'blocker', 'acceptance', 'permission'])
export const GATE_OPTION_LIMIT = 5

export const DOC_IDS = Object.freeze(['01', '02', '03', '04', '05', '06', '07'])
export const DOC_TITLES = Object.freeze({
  '01': { title: '需求分析说明书', slug: 'requirements' },
  '02': { title: '同类产品调研', slug: 'research' },
  '03': { title: '技术方案与环境体检', slug: 'tech-and-env' },
  '04': { title: 'UI 与交互规范', slug: 'ui-spec' },
  '05': { title: '最终开发文档（SSOT）', slug: 'dev-spec' },
  '06': { title: '黑盒测试报告', slug: 'blackbox-qa' },
  '07': { title: '白盒测试报告', slug: 'whitebox-qa' },
})

export const REMOTE_TOKENS = Object.freeze(['1', '2', '3', '0', 'doc'])
export const GATE_STATES = Object.freeze(['open', 'answered', 'skipped', 'paused', 'denied', 'expired', 'superseded'])
export const GATE_FINAL_STATES = Object.freeze(['answered', 'skipped', 'paused', 'denied', 'superseded'])
export const DOC_GRANT_SCOPES = Object.freeze(['once', 'session-docs', 'deny'])

/* ---------------- 纯归一化工具 ---------------- */

export function normalizeLevel(value, fallback = 'M') {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return LEVEL_IDS.includes(text) ? text : fallback
}

export function normalizeDocId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  const head = text.match(/^(0?[1-7])/)?.[1] ?? ''
  const padded = head.length === 1 ? `0${head}` : head
  return DOC_IDS.includes(padded) ? padded : null
}
