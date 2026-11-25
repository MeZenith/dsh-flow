/**
 * 模式切换事务：`/flow` 命令与两个 Host 工具共用的唯一实现。
 *
 * 为什么必须抽成一份：S1 只有命令一个入口，S2 之后 `flow_choose_route` 与
 * `flow_stage_gate` 也会切换模式。两套实现必然会漂移（比如一边记得校验模型、
 * 另一边忘了 `keep` 语义），所以这里做成纯函数式事务，调用方只负责解析入参与报文案。
 *
 * 事务边界（只在**切换的那一刻**执行一次，绝不常驻干预）：
 *   1. 默认模型（可选）→ `agent.model.select()`
 *   2. 权限档位 → 优先 preset，缺失则回退底层 append
 *   3. 提示词无需动作 —— prompt-bridge 的动态 context 会在下一 step 自动重算
 *
 * 本函数**不抛异常**：每一步失败都折算成 `notes` 里的一条说明，
 * 这样命令能照常回执、工具能照常返回结构化结果。
 *
 * @module dsh-flow/switch-mode
 */
import { MODE_OFF, approvalFor, modeConfigOf, parseModelKey } from './modes.js'

/**
 * 解析默认模型并校验可用性。
 *
 * 校验失败不阻断切换：模型只是"推荐默认"，切到一个不存在的路由会让整个会话
 * 后续请求全失败，因此宁可跳过。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} key `provider::model`
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ ok: true, provider: string, model: string } | { ok: false, reason: string }>}
 */
export async function resolveModelTarget(ctx, key, signal) {
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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ session: object }} agent
 * @param {string} permission
 * @returns {{ via: 'preset' | 'fallback' | 'skipped' }}
 */
export function applyPermission(ctx, agent, permission) {
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
 * 执行一次完整的模式切换事务。
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   config: object,
 *   agent: { session: object, model: { select: (sel: object) => void } },
 *   modeId: string,
 *   signal?: AbortSignal,
 *   logger?: { warn: (message: string) => void },
 * }} input
 * @returns {Promise<{
 *   modeId: string,
 *   label: string,
 *   notes: string[],
 *   modelChanged: boolean,
 *   permission: string,
 *   permissionVia: 'preset' | 'fallback' | 'skipped',
 * }>}
 */
export async function applyModeSwitch({ ctx, config, agent, modeId, signal, logger }) {
  const notes = []
  const mode = modeConfigOf(config, modeId)

  // `off` 只关提示词：不动权限、不动模型，这是 S1 起就定下的语义。
  if (modeId === MODE_OFF) {
    return {
      modeId,
      label: mode.label,
      notes,
      modelChanged: false,
      permission: 'keep',
      permissionVia: 'skipped',
    }
  }

  // ---- 1) 默认模型：仅在配置了具体模型时切换一次 ----
  let modelChanged = false
  if (mode.model !== '') {
    const resolved = await resolveModelTarget(ctx, mode.model, signal)
    if (resolved.ok) {
      try {
        agent.model.select({ provider: resolved.provider, model: resolved.model })
        modelChanged = true
        notes.push(`模型 ${resolved.provider}::${resolved.model}`)
      } catch (error) {
        notes.push(`模型切换失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      notes.push(`未切换模型：${resolved.reason}`)
    }
  }

  // ---- 2) 权限档位 ----
  let permissionVia = 'skipped'
  try {
    const applied = applyPermission(ctx, agent, mode.permission)
    permissionVia = applied.via
    if (applied.via === 'preset') notes.push(`权限 ${mode.permission}`)
    else if (applied.via === 'fallback') notes.push(`权限 ${mode.permission}（底层写入）`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger?.warn(`flow: 权限切换失败 ${detail}`)
    notes.push(`权限切换失败：${detail}`)
  }

  return {
    modeId,
    label: mode.label,
    notes,
    modelChanged,
    permission: mode.permission,
    permissionVia,
  }
}
