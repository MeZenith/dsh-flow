/**
 * 模式元数据与纯工具：模式 ID 白名单、显示顺序、默认模型复合 key 编解码、权限档位映射。
 *
 * 本模块零依赖、零副作用，Host 与 Client 各自持有一份等价的模式 ID 列表
 * （Client 不能相对 import 兄弟模块，见 client.js 顶部注释）。
 *
 * @module dsh-flow/modes
 */

/** 关闭态：不注入任何模式提示词，也不改动权限与模型。 */
export const MODE_OFF = 'off'

/** 五个正式模式，顺序即菜单顺序。 */
export const MODE_IDS = Object.freeze(['plan', 'plan-ultra', 'build', 'review', 'flow'])

/** 投影 apply() 认可的全部取值（含 off）。任何其它输入一律忽略。 */
export const MODE_CHOICES = Object.freeze([MODE_OFF, ...MODE_IDS])

/** 内置模式显示名与一句话说明；Config 的默认值也取自这里，避免两处漂移。 */
export const MODE_PRESETS = Object.freeze({
  plan: {
    label: 'Plan',
    description: '日常快速读码与方案规划',
    permission: 'read-only',
  },
  'plan-ultra': {
    label: 'Plan Ultra',
    description: '复杂需求深度多视角规划',
    permission: 'read-only',
  },
  build: {
    label: 'Build',
    description: '专注按方案编写与修改代码',
    permission: 'workspace-write',
  },
  review: {
    label: 'Review',
    description: '独立审查 git diff 与验收',
    permission: 'read-only',
  },
  flow: {
    label: 'Flow',
    description: '全能总控入口，按阶段推进',
    permission: 'workspace-write',
  },
})

/** 关闭态的显示名与说明，供 Client 菜单渲染。 */
export const OFF_LABEL = '普通模式'
export const OFF_DESCRIPTION = '关闭模式提示词，不修改权限与模型'

/** 权限档位选择值。`keep` 表示切换模式时完全不动权限。 */
export const PERMISSION_CHOICES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
  'keep',
])

/** 归一化一个用户输入的模式 token：去空白、转小写。 */
export function normalizeModeToken(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

/**
 * 从 `/flow` 的 rawInput 解析出首个 token，并校验是否属于 MODE_CHOICES。
 * @param {string} rawInput 命令名之后的原始文本。
 * @returns {string | null} 合法模式，或 null（status / list / 拼写错误 / 空）。
 */
export function parseModeArg(rawInput) {
  const token = normalizeModeToken(rawInput).split(/\s+/)[0] ?? ''
  return MODE_CHOICES.includes(token) ? token : null
}

/** 是否为正式模式（排除 off），用于判断是否需要注入提示词。 */
export function isPromptMode(mode) {
  return MODE_IDS.includes(mode)
}

/** 默认模型的复合 key 分隔符：`provider::model`。 */
export const MODEL_KEY_SEPARATOR = '::'

/**
 * 解析 `provider::model`。空串表示“不自动切换”。
 * @param {string} key 配置值。
 * @returns {{ provider: string, model: string } | null}
 */
export function parseModelKey(key) {
  if (typeof key !== 'string') return null
  const text = key.trim()
  if (text === '') return null
  const at = text.indexOf(MODEL_KEY_SEPARATOR)
  if (at <= 0) return null
  const provider = text.slice(0, at).trim()
  const model = text.slice(at + MODEL_KEY_SEPARATOR.length).trim()
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * 生成 `provider::model`。
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
export function formatModelKey(provider, model) {
  return `${String(provider)}${MODEL_KEY_SEPARATOR}${String(model)}`
}

/**
 * 权限档位 → 审批策略。走底层回退路径时才用得到。
 * @param {string} permission
 * @returns {'ask' | 'never'}
 */
export function approvalFor(permission) {
  return permission === 'danger-full-access' ? 'never' : 'ask'
}

/**
 * 读取一个模式的配置，缺失时回落内置默认（防御部分覆盖的 Config）。
 * @param {object} config 已校验的插件配置。
 * @param {string} modeId
 * @returns {{ label: string, description: string, model: string, permission: string, prompt: string }}
 */
export function modeConfigOf(config, modeId) {
  const preset = MODE_PRESETS[modeId]
  const raw = config?.modes?.[modeId]
  return {
    label: typeof raw?.label === 'string' && raw.label !== '' ? raw.label : (preset?.label ?? modeId),
    description: typeof raw?.description === 'string' ? raw.description : (preset?.description ?? ''),
    model: typeof raw?.model === 'string' ? raw.model : '',
    permission: PERMISSION_CHOICES.includes(raw?.permission)
      ? raw.permission
      : (preset?.permission ?? 'keep'),
    prompt: typeof raw?.prompt === 'string' ? raw.prompt : '',
  }
}

/* ------------------------------------------------------------------ *
 * S2 增量常量
 * ------------------------------------------------------------------ */

/**
 * 工具名清单。
 *
 * 投影侧（`mode-projection.js`）要靠它校验 `tool/result.data.meta.flowTool`，
 * 只有本插件自己的工具写下的 meta 才允许改动 `flowMode`。放在这里而不是工具模块里，
 * 是为了让投影不依赖 `tools.js`（避免循环 import，也避免投影被工具模块的副作用牵连）。
 */
export const FLOW_TOOL_NAMES = Object.freeze(['flow_choose_route', 'flow_stage_gate'])

/** `flow_stage_gate` 的 `fromStage` 白名单。 */
export const STAGE_IDS = Object.freeze(['plan', 'plan-ultra', 'build', 'review'])

/** `flow_stage_gate` 的 `nextMode` 白名单（含 `flow`：Flow 总控推进内部阶段，不切出模式）。 */
export const GATE_NEXT_MODES = Object.freeze(['build', 'review', 'plan', 'flow', 'off'])

/** `flow_choose_route` 的 `recommended` 白名单（三选一路线）。 */
export const ROUTE_CHOICES = Object.freeze(['plan', 'plan-ultra', 'build'])

/** 规范化工具入参里的模式 token：仅用于 meta 折叠，非法一律 null。 */
export function coerceModeToken(value) {
  return parseModeArg(typeof value === 'string' ? value : '')
}
/* ------------------------------------------------------------------ *
 * S3 增量常量
 * ------------------------------------------------------------------ */

/** 通知分流策略。 */
export const NOTIFY_STRATEGIES = Object.freeze(['im-first', 'email-first', 'both', 'off'])

/** 四类通知事件。 */
export const NOTIFY_EVENTS = Object.freeze(['brake', 'gate', 'team', 'archive', 'qa'])

/** SMTP 服务商预设。 */
export const SMTP_PROVIDERS = Object.freeze(['qq', 'netease', 'gmail', 'custom'])

/** 邮件主题状态标签。 */
export const NOTIFY_SUBJECT_TAG = Object.freeze({
  brake: '熔断告警',
  gate: '待拍板',
  team: '团队异常',
  archive: '任务完结',
  qa: '验收报告',
})

/* ------------------------------------------------------------------ *
 * v0.5.0 增量常量：复杂度分级 / 文档编号 / 门禁形态 / 遥控令牌
 * ------------------------------------------------------------------ */

/**
 * 任务复杂度等级。
 *
 * S 级不产编号文档（但必须做 1 轮交互确认），M/L 级按 `flow-level.js` 的矩阵产出文档。
 * 这里只放 ID，语义与矩阵统一由 `flow-level.js` 持有，避免两处漂移。
 */
export const LEVEL_IDS = Object.freeze(['S', 'M', 'L'])

/** 门禁形态。`permission` 用于只读会话申请写文档授权。 */
export const GATE_KINDS = Object.freeze(['stage', 'blocker', 'acceptance', 'permission'])

/** 门禁选项上限（原生提问卡片可读性上限）。 */
export const GATE_OPTION_LIMIT = 5

/** 文档编号（顺序即流水线顺序）。 */
export const DOC_IDS = Object.freeze(['01', '02', '03', '04', '05', '06', '07'])

/** 文档标题与文件名主干；`flow-docs.js` 与提示词共用这一份。 */
export const DOC_TITLES = Object.freeze({
  '01': { title: '需求分析说明书', slug: 'requirements' },
  '02': { title: '同类产品调研', slug: 'research' },
  '03': { title: '技术方案与环境体检', slug: 'tech-and-env' },
  '04': { title: 'UI 与交互规范', slug: 'ui-spec' },
  '05': { title: '最终开发文档（SSOT）', slug: 'dev-spec' },
  '06': { title: '黑盒测试报告', slug: 'blackbox-qa' },
  '07': { title: '白盒测试报告', slug: 'whitebox-qa' },
})

/**
 * 遥控指令令牌：`1/2/3` 对应门禁选项顺序，`0` 与 `doc` 拉取文档核心章节。
 *
 * 为什么不用 4/5：手机上数字最短，且与熔断现有 `1/2/3` 语义不冲突（熔断靠 `#项目名` 消歧）。
 */
export const REMOTE_TOKENS = Object.freeze(['1', '2', '3', '0', 'doc'])

/** 门禁票据状态机。 */
export const GATE_STATES = Object.freeze(['open', 'answered', 'skipped', 'paused', 'denied', 'expired', 'superseded'])

/** 终态：`superseded` 也是终态 —— 被新票顶替的旧票不许再被结算。 */
export const GATE_FINAL_STATES = Object.freeze(['answered', 'skipped', 'paused', 'denied', 'superseded'])

/** 通知事件增量（v0.5.0）：文档投递与门禁超时催办。 */
export const NOTIFY_EVENTS_V5 = Object.freeze(['doc', 'gate-timeout'])

/** 新事件的主题标签。 */
export const NOTIFY_SUBJECT_TAG_V5 = Object.freeze({
  doc: '文档投递',
  'gate-timeout': '门禁超时',
})

/** 文档写授权的会话作用域取值。 */
export const DOC_GRANT_SCOPES = Object.freeze(['once', 'session-docs', 'deny'])

/** 把所有未知等级归一到 S/M/L（默认 M：宁可多要文档，也不要漏）。 */
export function normalizeLevel(value, fallback = 'M') {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return LEVEL_IDS.includes(text) ? text : fallback
}

/** 校验文档编号；支持 `'03'`、`'3'`、`'03-tech-and-env.md'` 三种写法。 */
export function normalizeDocId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  const head = text.match(/^(0?[1-7])/)?.[1] ?? ''
  const padded = head.length === 1 ? `0${head}` : head
  return DOC_IDS.includes(padded) ? padded : null
}
