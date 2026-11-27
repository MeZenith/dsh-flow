/**
 * 传输无关的远程控制中枢（RemoteHub）。
 *
 * 任何远程通道（当前直连飞书；未来 Mobile PWA / Quick Tunnel / Cloudflare Workers E2EE）
 * 只需要绑定到这 7 个业务原语 + 统一事件总线即可，核心工作流代码零耦合。
 *
 * @module dsh-flow/remote/hub
 */
import { parseModeArg } from '../modes/registry.js'
import { attachmentsOf } from '../workflow/docs.js'

/**
 * 创建远程控制中枢。
 *
 * @param {{
 *   bridge: ReturnType<typeof import('./harness-bridge.js').createHarnessBridge>,
 *   tickets: object,
 *   settler: object,
 *   gateRouter: object,
 *   breaker: object,
 *   getConfig: () => object,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createRemoteHub({ bridge, tickets, settler, gateRouter, breaker, getConfig, logger }) {
  const listeners = new Set()

  /** 订阅远程事件（gate:created / gate:settled / brake:tripped / brake:unlocked / docs:ready / session:completed）。 */
  function onEvent(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /** 广播远程事件（单监听器异常绝不阻断其他通道）。 */
  function emit(type, payload) {
    for (const listener of [...listeners]) {
      try {
        const maybePromise = listener(type, payload)
        if (maybePromise !== undefined && typeof maybePromise.catch === 'function') {
          maybePromise.catch((error) => {
            logger?.warn?.(`flow: RemoteHub 事件(${type})处理失败 → ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error) {
        logger?.warn?.(`flow: RemoteHub 事件(${type})异常 → ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /* ---- 7 大核心原语 ---- */

  function listWorkspaces() {
    return bridge.listWorkspaces()
  }

  function listSessions(filter) {
    return bridge.listSessions(filter)
  }

  async function sendPrompt({ sessionId, cwd, text, createIfMissing = false, source = 'remote' }) {
    return bridge.sendPrompt({ sessionId, cwd, text, createIfMissing, source })
  }

  /**
   * 远程结算门禁票据并唤醒桌面会话。
   * 支持传 `token`（'1'|'2'|'3'）或直接传 `action`（'approve'|'revise'|'pause'|'skip'|'once'|'session-docs'|'deny'）。
   */
  async function settleGate({ ticketId, token, action, note = '', by = 'feishu' }) {
    const ticket = tickets.find(ticketId)
    if (ticket === undefined) return { ok: false, reason: `未找到门禁票据 #${String(ticketId ?? '').replace(/^#/, '')}` }

    let resolvedAction = typeof action === 'string' ? action.trim() : ''
    let resolvedLabel = ''

    if (token !== undefined && token !== null && String(token).trim() !== '') {
      const idx = Number(token) - 1
      const option = Array.isArray(ticket.options) ? ticket.options[idx] : undefined
      if (option === undefined) {
        return { ok: false, reason: `#${ticket.id} 没有第 ${token} 个选项` }
      }
      resolvedAction = option.action
      resolvedLabel = option.label
    } else if (resolvedAction !== '') {
      const option = Array.isArray(ticket.options)
        ? ticket.options.find(item => item.action === resolvedAction)
        : undefined
      resolvedLabel = option?.label ?? resolvedAction
    } else {
      return { ok: false, reason: '缺少选项编号或动作' }
    }

    gateRouter?.cancelPendingEscalations?.(ticket.sessionId)
    const settled = await settler.settle(ticket.id, { action: resolvedAction, by, note })
    if (settled.ok !== true) {
      return {
        ok: false,
        already: settled.already === true,
        ticket: settled.ticket ?? ticket,
        reason: settled.reason ?? '结算失败',
      }
    }

    const forwarded = gateRouter?.forwardDecision?.({
      ticket: settled.ticket,
      action: resolvedAction,
      label: resolvedLabel || resolvedAction,
      note,
      fromIm: true,
      by,
    }) ?? { ok: false, reason: '路由未就绪' }

    const effectSummary = gateRouter?.describeEffects?.(settled.effects) ?? ''
    return {
      ok: true,
      ticket: settled.ticket,
      action: resolvedAction,
      label: resolvedLabel || resolvedAction,
      effects: settled.effects,
      effectSummary,
      forwarded: forwarded.ok === true,
      forwardReason: forwarded.reason,
    }
  }

  /** 读取门禁关联文档摘要。 */
  function getGateDigest(ticketId) {
    const ticket = tickets.find(ticketId)
    if (ticket === undefined) return { ok: false, reason: `未找到票据 #${String(ticketId ?? '').replace(/^#/, '')}` }
    const text = gateRouter?.buildDigest?.(ticket) ?? ''
    return { ok: true, ticket, text }
  }

  /** 收集指定文档或草稿的文件 Buffer（供飞书直接发送文件消息）。 */
  function collectDocFiles({ cwd, docIds = [], extras = [], drafts = [] }) {
    const config = getConfig()
    const limit = Number(config?.email?.attachLimitBytes)
    return attachmentsOf({
      config,
      cwd,
      ids: docIds,
      extra: extras,
      drafts,
      limitBytes: Number.isFinite(limit) && limit > 0 ? Math.max(limit, 5 * 1024 * 1024) : 10 * 1024 * 1024,
    })
  }

  /** 远程处理熔断抢救。 */
  async function resolveBrake({ sessionId, action, prompt = '' }) {
    return breaker.resolveRemoteAction({ sessionId, action, prompt })
  }

  /** 远程切换模式。 */
  async function switchMode({ sessionId, mode }) {
    const target = parseModeArg(mode)
    if (target === null) return { ok: false, reason: `不支持的模式：${mode}（可选 off / plan / plan-ultra / build / review / flow）` }
    return bridge.switchSessionMode(sessionId, target)
  }

  /** 远程中止当前回合。 */
  function abortSession(sessionId) {
    return bridge.abortSession(sessionId)
  }

  /** 获取当前全部未决门禁与熔断列表。 */
  function listPending() {
    const gates = gateRouter?.listAllGateCandidates?.() ?? []
    const trips = breaker?.listTrips?.() ?? []
    return { gates, trips }
  }

  return {
    onEvent,
    emit,
    listWorkspaces,
    listSessions,
    sendPrompt,
    settleGate,
    getGateDigest,
    collectDocFiles,
    resolveBrake,
    switchMode,
    abortSession,
    listPending,
  }
}
