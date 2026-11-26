/**
 * 门禁结算执行器：**决定之后的一切状态副作用都只在这里发生**。
 *
 * === 为什么必须收敛到一处 ===
 *
 * 真机踩到的坑：IM 迟到/脱离前台的答复只改写了 `gates.json` 的状态并 steer 了一段文案，
 * 授权没写进 `grants`、模式没真切 —— 等于"嘴上批了，系统不认"。
 * 根因不是某一行写错了，而是**副作用散落在前台调用后面**：桌面点选走 `tools.js` 的那一段，
 * IM 抢先/迟到走 `gate-router.js` 的那一段，两条路各写各的，迟早分叉。
 *
 * 所以这里做成唯一入口：桌面点选、IM 抢先、IM 迟到、`/flow gate answer`、超时催办后的回复，
 * 全部调 `settle()`。顺序固定为「副作用先落地 → 再改票据状态并唤醒等待者」，
 * 保证前台工具拿到决定时，授权/模式已经生效。
 *
 * @module dsh-flow/gate-settle
 */
import { GATE_FINAL_STATES } from './modes.js'

/** 动作 → 授权口径。 */
function scopeOfAction(action) {
  if (action === 'once' || action === 'session-docs' || action === 'deny') return action
  return undefined
}

/** 动作是否会推进阶段。 */
function isApproval(action) {
  return action === 'approve' || action === 'accept'
}

/**
 * 创建结算执行器。
 *
 * @param {{
 *   getConfig: () => object,
 *   switchMode: (agent: object, modeId: string, signal?: AbortSignal) => Promise<object>,
 *   bridge?: { schedule: (agent: object) => boolean },
 *   notifier?: { schedule?: Function },
 *   tickets: object,
 *   resolveAgent: (sessionId: string) => object | undefined,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createGateSettler({
  getConfig, switchMode, bridge, notifier, tickets, resolveAgent, logger, diag = () => {},
}) {
  const warn = (message) => {
    try { logger?.warn?.(message) } catch { /* 忽略日志通道异常 */ }
  }

  /**
   * 应用一个决定的所有副作用（幂等：同一票据重复调用只会补做未完成的副作用）。
   *
   * @param {object} ticket
   * @param {string} action
   * @returns {Promise<{ scope?: string, mode?: object, compactScheduled?: boolean, archived?: boolean }>}
   */
  async function applyEffects(ticket, action) {
    const effects = {}

    /* ---- 授权门禁：立刻写入 grants（跨超时/跨重启由 canWrite 兜底再补一次） ---- */
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

    /* ---- 阶段/验收/阻断门禁：真正切模式，而不是发一段文字假装切了 ---- */
    if (isApproval(action)) {
      const agent = resolveAgent(ticket.sessionId)
      if (agent === undefined || agent === null) {
        // 桌面会话不在线（重启后未恢复）：如实记账，交给用户用 /flow 手动切。
        effects.mode = {
          applied: false,
          reason: `桌面会话 #${ticket.sessionId || '(未知)'} 当前不在线，模式切换未执行`,
        }
        warn(`flow: 门禁 #${ticket.id} 批准但目标会话不在线，模式切换未执行`)
        return effects
      }
      try {
        const applied = await switchMode(agent, ticket.nextMode)
        tickets.markModeApplied(ticket.id)
        effects.mode = {
          applied: true,
          mode: ticket.nextMode,
          label: applied?.label ?? ticket.nextMode,
          notes: Array.isArray(applied?.notes) ? applied.notes : [],
        }
        diag(`settle mode #${ticket.id} → ${ticket.nextMode}`)
      } catch (error) {
        effects.mode = { applied: false, reason: error instanceof Error ? error.message : String(error) }
        warn(`flow: 门禁 #${ticket.id} 模式切换失败 → ${effects.mode.reason}`)
        return effects
      }

      const config = getConfig()
      const autoCompact = config?.behavior?.autoCompactOnGate !== false
      if (autoCompact && typeof bridge?.schedule === 'function') {
        try {
          effects.compactScheduled = bridge.schedule(agent) === true
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

  /**
   * 结算一张票据。
   *
   * @param {string} id 票据号（可带 `#`）。
   * @param {{ action: string, by?: string, note?: string }} decision
   * @returns {Promise<{
   *   ok: boolean, already?: boolean, action?: string,
   *   ticket?: object, effects?: object, reason?: string,
   * }>}
   */
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

    // 非阻塞门禁下不再有前台等待者：决定之后一律由路由负责唤醒桌面会话。
    const effects = await applyEffects(ticket, action)
    const decided = tickets.decide(ticket.id, { action, by, note, effects })
    if (decided.ok !== true) {
      return { ok: false, action, reason: decided.reason }
    }
    return { ok: true, already: false, action, ticket: decided.ticket, effects }
  }

  return { settle, applyEffects }
}
