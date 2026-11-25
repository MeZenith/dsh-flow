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

/** `flow_stage_gate` 的 `nextMode` 白名单（不含 `flow`：总控模式不是切换目标）。 */
export const GATE_NEXT_MODES = Object.freeze(['build', 'review', 'plan', 'off'])

/** `flow_choose_route` 的 `recommended` 白名单（三选一路线）。 */
export const ROUTE_CHOICES = Object.freeze(['plan', 'plan-ultra', 'build'])

/** 规范化工具入参里的模式 token：仅用于 meta 折叠，非法一律 null。 */
export function coerceModeToken(value) {
  return parseModeArg(typeof value === 'string' ? value : '')
}