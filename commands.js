/**
 * `/flow` 命令：模式切换的唯一写入口。
 *
 * 为什么走命令而不是自有 Remote：命令是原生通道（`SessionFace.command()` 已存在），
 * 且 `command/run` 是 log-only 事件 —— 既能让 `flowMode` 投影从日志派生，
 * 又不需要 Typert 构建期 codegen。代价是每次切换在对话里留一条命令行，
 * 与原生 `/permission` 芯片完全同构（后者同样走命令）。
 *
 * 事务边界（只在**切换的那一刻**执行一次，绝不常驻干预）：
 *   1. 默认模型（可选）→ `agent.model.select()`
 *   2. 权限档位 → 优先 preset，缺失则回退底层 append
 *   3. 提示词无需动作 —— 由 prompt-bridge 的动态 context 自动生效
 *
 * @module dsh-flow/commands
 */
import {
  MODE_OFF, approvalFor, modeConfigOf, parseModelKey, parseModeArg,
} from './modes.js'

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'flow'

/** 命令定义 ID。 */
export const COMMAND_ID = 'dsh-flow'

/** 状态类参数的别名：只回报当前模式，不改变任何状态。 */
const STATUS_TOKENS = new Set(['', 'status', 'list', '?'])

/** 可选项提示串。 */
function choicesText() {
  return ['off', 'plan', 'plan-ultra', 'build', 'review', 'flow'].join(' / ')
}

/**
 * 解析默认模型并校验可用性。
 * @returns {Promise<{ ok: true, provider: string, model: string } | { ok: false, reason: string }>}
 */
async function resolveModelTarget(ctx, key, signal) {
  const target = parseModelKey(key)
  if (target === null) return { ok: false, reason: '格式应为 provider::model' }

  const llm = ctx.get('llm')
  if (llm === undefined) return { ok: false, reason: '此组合没有 llm 服务' }

  try {
    await llm.resolveModelInfo(target.provider, target.model, signal)
    return { ok: true, ...target }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `模型不可用（${detail}）` }
  }
}

/**
 * 写入权限档位。
 *
 * 优先走 `permissionPresets.set()`：它会额外记录一条预设身份事件，与 `/permission`
 * 芯片完全一致。若该档位不是已配置的预设（例如默认表里没有 `read-only`），
 * 直接回退到底层写路径 —— 与 `setSandboxMode` / `setApprovalPolicy` 的实现逐字一致，
 * 因此不需要用户去改全局预设表。
 *
 * @returns {{ via: 'preset' | 'fallback' | 'skipped', error?: string }}
 */
function applyPermission(ctx, agent, permission) {
  if (permission === 'keep') return { via: 'skipped' }

  const session = agent.session
  const presets = ctx.get('permissionPresets')
  const names = Array.isArray(presets?.names) ? presets.names : []
  if (presets !== undefined && names.includes(permission)) {
    presets.set(session, permission)
    return { via: 'preset' }
  }

  // 底层回退：与 @deepseek-ai/dsh-sandbox-policy / dsh-user-approval 的写路径同形。
  session.append('sandbox/mode', { mode: permission })
  session.append('approval/policy', { policy: approvalFor(permission) })
  return { via: 'fallback' }
}

/**
 * 构造命令定义。
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getConfig: () => object,
 *   readMode: (session: object) => string,
 *   logger?: { warn: (msg: string) => void },
 * }} deps
 * @returns {object} 交给 `ctx.commands.register()` 的定义。
 */
export function createFlowCommand({ ctx, getConfig, readMode, logger }) {
  return {
    definitionId: COMMAND_ID,
    name: COMMAND_NAME,
    description: '切换 Flow 工作流模式（off / plan / plan-ultra / build / review / flow）',
    input: { hint: '<mode> | status' },
    // 保留 args：`flowMode` 投影正是从 command/run 的 args 派生当前模式。
    recordInput: true,

    async handler({ agent, rawInput, signal }) {
      const config = getConfig()
      const arg = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''

      // ---- 只读分支：不改任何状态 ----
      if (STATUS_TOKENS.has(arg.split(/\s+/)[0] ?? '')) {
        const current = readMode(agent.session)
        const label = current === MODE_OFF ? '普通模式（off）' : modeConfigOf(config, current).label
        return { kind: 'success', text: `Flow 当前模式：${label}｜可选：${choicesText()}` }
      }

      // ---- 切换分支 ----
      const target = parseModeArg(arg)
      if (target === null) {
        return {
          kind: 'error',
          text: `未知模式 "${arg}"。可选：${choicesText()}`,
        }
      }

      if (target === MODE_OFF) {
        return { kind: 'success', text: '已关闭 Flow 模式提示词（权限与模型保持不变）' }
      }

      const mode = modeConfigOf(config, target)
      const notes = []

      // 1) 默认模型 —— 仅在配置了具体模型时切换一次。
      if (mode.model !== '') {
        const resolved = await resolveModelTarget(ctx, mode.model, signal)
        if (resolved.ok) {
          try {
            agent.model.select({ provider: resolved.provider, model: resolved.model })
            notes.push(`模型 ${resolved.provider}::${resolved.model}`)
          } catch (error) {
            notes.push(`模型切换失败：${error instanceof Error ? error.message : String(error)}`)
          }
        } else {
          notes.push(`未切换模型：${resolved.reason}`)
        }
      }

      // 2) 权限档位。
      try {
        const applied = applyPermission(ctx, agent, mode.permission)
        if (applied.via === 'preset') notes.push(`权限 ${mode.permission}`)
        else if (applied.via === 'fallback') notes.push(`权限 ${mode.permission}（底层写入）`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logger?.warn(`flow: 权限切换失败 ${detail}`)
        notes.push(`权限切换失败：${detail}`)
      }

      const detail = notes.length === 0 ? '' : `（${notes.join('｜')}）`
      const announce = config?.behavior?.announce !== false
      return {
        kind: 'success',
        text: announce
          ? `Flow 模式：${mode.label}${detail}`
          : `Flow 模式：${mode.label}`,
      }
    },
  }
}
