/**
 * 模式切换事务：命令、工具、门禁结算器共用的唯一切换实现。
 *
 * @module dsh-flow/modes/switcher
 */
import { MODE_OFF } from '../config/constants.js'
import { approvalFor, modeConfigOf, parseModelKey } from './registry.js'

export async function resolveModelTarget(ctx, key, signal) {
  const target = parseModelKey(key)
  if (target === null) return { ok: false, reason: '格式应为 provider::model' }

  const llm = ctx?.get?.('llm')
  if (llm === undefined) return { ok: false, reason: '此组合没有 llm 服务' }

  try {
    await llm.resolveModelInfo(target.provider, target.model, signal)
    return { ok: true, ...target }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `模型不可用（${detail}）` }
  }
}

export function applyPermission(ctx, agent, permission) {
  if (permission === 'keep') return { via: 'skipped' }

  const session = agent.session
  const presets = ctx?.get?.('permissionPresets')
  const names = Array.isArray(presets?.names) ? presets.names : []
  if (presets !== undefined && names.includes(permission)) {
    presets.set(session, permission)
    return { via: 'preset' }
  }

  session.append('sandbox/mode', { mode: permission })
  session.append('approval/policy', { policy: approvalFor(permission) })
  return { via: 'fallback' }
}

export async function applyModeSwitch({ ctx, config, agent, modeId, signal, logger }) {
  const notes = []
  const mode = modeConfigOf(config, modeId)

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

  let permissionVia = 'skipped'
  try {
    const applied = applyPermission(ctx, agent, mode.permission)
    permissionVia = applied.via
    if (applied.via === 'preset') notes.push(`权限 ${mode.permission}`)
    else if (applied.via === 'fallback') notes.push(`权限 ${mode.permission}（底层写入）`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`flow: 权限切换失败 ${detail}`)
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
