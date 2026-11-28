/**
 * 门禁结算执行器：决定之后的一切状态副作用都在此收敛执行。
 *
 * v0.6.0 修复：
 * - B-03：批准切模式时优先通过 `syncModeCommand`（执行 `/flow <nextMode>` 命令写入 `command/run`），
 *   让 `flowMode` 投影与顶部模式芯片立即同步；不可用时再回落到 `switchMode`；
 * - 新增 `onSettled` 回调，供 RemoteHub 自动把飞书门禁卡片更新为「已结算」灰态。
 *
 * @module dsh-flow/gates/settler
 */
import { GATE_FINAL_STATES } from '../config/constants.js'
import { modeConfigOf } from '../modes/registry.js'

function scopeOfAction(action) {
  if (action === 'once' || action === 'session-docs' || action === 'deny') return action
  return undefined
}

function isApproval(action) {
  return action === 'approve' || action === 'accept'
}

/**
 * 创建结算执行器。
 *
 * @param {{
 *   getConfig: () => object,
 *   switchMode: (agent: object, modeId: string, signal?: AbortSignal) => Promise<object>,
 *   syncModeCommand?: (agent: object, modeId: string) => Promise<{ ok: boolean, label?: string, notes?: string[] }>,
 *   bridge?: { schedule: (agent: object) => boolean },
 *   notifier?: { schedule?: Function },
 *   tickets: object,
 *   resolveAgent: (sessionId: string) => object | undefined,
 *   onSettled?: (payload: { ticket: object, action: string, by: string, note: string, effects: object }) => void,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createGateSettler({
  getConfig, switchMode, syncModeCommand, bridge, notifier, tickets, resolveAgent, onSettled, logger, diag = () => {},
}) {
  const inFlight = new Set()

  const warn = (message) => {
    try { logger?.warn?.(message) } catch { /* best-effort: 宿主 logger 异常时不阻断门禁结算 */ }
  }

  async function applyEffects(ticket, action) {
    const effects = {}

    if (ticket.kind === 'permission') {
      const scope = scopeOfAction(action)
      if (scope !== undefined) {
        tickets.grant(ticket.sessionId, scope, {
          docId: ticket.draftId === '' ? undefined : ticket.draftId,
        })
        tickets.markGrantApplied(ticket.id)
        effects.scope = scope
        diag(`settle grant #${ticket.id} scope=${scope}`)
      }
      return effects
    }

    if (isApproval(action)) {
      const agent = resolveAgent(ticket.sessionId)
      if (agent === undefined || agent === null) {
        effects.mode = {
          applied: false,
          reason: `桌面会话 #${ticket.sessionId || '(未知)'} 当前不在线，模式切换未执行`,
        }
        warn(`flow: 门禁 #${ticket.id} 批准但目标会话不在线，模式切换未执行`)
        return effects
      }

      const config = getConfig()
      const labelFallback = ticket.nextMode === 'off'
        ? '普通模式'
        : modeConfigOf(config, ticket.nextMode).label

      let applied
      try {
        // B-03 修复：优先经由 `/flow <mode>` 命令切换，使 session 日志写入 `command/run`，
        // 从而同步 `flowMode` 投影与前端模式芯片；命令通道不可用时再退回 `switchMode`。
        if (typeof syncModeCommand === 'function') {
          const synced = await syncModeCommand(agent, ticket.nextMode)
          if (synced?.ok === true) {
            applied = {
              label: synced.label ?? labelFallback,
              notes: Array.isArray(synced.notes) ? synced.notes : [],
              via: 'command',
            }
          }
        }
        if (applied === undefined) {
          applied = await switchMode(agent, ticket.nextMode)
        }
        tickets.markModeApplied(ticket.id)
        effects.mode = {
          applied: true,
          mode: ticket.nextMode,
          label: applied?.label ?? labelFallback,
          notes: Array.isArray(applied?.notes) ? applied.notes : [],
        }
        diag(`settle mode #${ticket.id} → ${ticket.nextMode} via=${applied?.via ?? 'direct'}`)
      } catch (error) {
        effects.mode = { applied: false, reason: error instanceof Error ? error.message : String(error) }
        warn(`flow: 门禁 #${ticket.id} 模式切换失败 → ${effects.mode.reason}`)
        return effects
      }

      const autoCompact = config?.behavior?.autoCompactOnGate !== false
      if (autoCompact && typeof bridge?.schedule === 'function') {
        try {
          // P1-7 修复：门禁批准时若会话已空闲，先原地同步执行一次压缩，避免随后的 `followup` 抢跑导致 `busy`。
          if (agent.status === 'idle' && typeof bridge.runNow === 'function') {
            const immediate = await bridge.runNow(agent)
            if (immediate?.ok === true) {
              effects.compactScheduled = true
              effects.compacted = true
            } else if (immediate?.code === 'busy') {
              effects.compactScheduled = bridge.schedule(agent) === true
            } else {
              effects.compactScheduled = false
            }
          } else {
            effects.compactScheduled = bridge.schedule(agent) === true
          }
        } catch {
          effects.compactScheduled = false
        }
        if (!effects.compactScheduled) {
          warn('flow: 阶段切换后未能登记自动压缩（可能已有待办或在卸载中）')
        }
      }

      if (ticket.specUpdated === true || ticket.fromStage === 'review') {
        try {
          notifier?.schedule?.('archive', {
            title: ticket.fromStage === 'review' ? 'Flow 验收通过' : 'Flow 方案定稿',
            project: ticket.project,
            agent,
            session: agent.session,
            markdown: [
              ticket.fromStage === 'review' ? '## 验收通过' : '## 方案定稿',
              '',
              `- 项目：${ticket.project}`,
              `- 阶段：${ticket.fromStage} → ${ticket.nextMode}`,
              `- 票据：#${ticket.id}`,
              `- 结论：${String(ticket.summary ?? '').slice(0, 1200)}`,
              ticket.specUpdated === true ? '- 方案已写入 `.flow/spec.md`（随信附上）' : '- 本次未标记方案落盘',
            ].join('\n'),
          })
          effects.archived = true
        } catch (error) {
          warn(`flow: 归档通知登记失败 → ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    return effects
  }

  async function settle(id, { action, by = 'desktop', note = '' } = {}) {
    const ticket = tickets.find(id)
    if (ticket === undefined) return { ok: false, reason: `票据 #${String(id).replace(/^#/, '')} 不存在` }
    if (GATE_FINAL_STATES.includes(ticket.state)) {
      return {
        ok: false,
        already: true,
        action: ticket.action || ticket.state,
        ticket,
        reason: `票据 #${ticket.id} 已经结算过（${ticket.state}）`,
      }
    }
    if (inFlight.has(ticket.id)) {
      return {
        ok: false,
        already: true,
        action: ticket.action || ticket.state,
        ticket,
        reason: `票据 #${ticket.id} 正在结算中，请勿重复操作`,
      }
    }

    inFlight.add(ticket.id)
    try {
      // P0-5 修复：先原子占位结算票据，再执行异步副作用，杜绝双端并发/连点 TOCTOU 状态撕裂。
      const decided = tickets.decide(ticket.id, { action, by, note })
      if (decided.ok !== true) {
        return {
          ok: false,
          already: GATE_FINAL_STATES.includes(ticket.state),
          action: ticket.action || action,
          ticket,
          reason: decided.reason,
        }
      }
      const effects = await applyEffects(decided.ticket, action)
      decided.ticket.effects = effects
      try {
        onSettled?.({ ticket: decided.ticket, action, by, note, effects })
      } catch { /* 回调异常不影响结算 */ }
      return { ok: true, already: false, action, ticket: decided.ticket, effects }
    } finally {
      inFlight.delete(ticket.id)
    }
  }

  return { settle, applyEffects }
}
