/**
 * 门禁票据：状态机 + 决定 Promise + 超时单次催办 + 按项目落盘 + 文档写授权。
 *
 * === 为什么需要它 ===
 *
 * 原生 `userQuestions.askTimed()` 能给倒计时卡片，但**超时后的迟到答复只对
 * `ask_user_question` 工具生效**（宿主投影按工具名折叠，见 `user-questions/src/projection.ts`）。
 * 我们的门禁不是那个工具，所以超时后卡片会消失、也没有任何官方通道把"手机上回的那个 1"
 * 送回桌面会话。票据就是补这个洞：它是**跨会话**的唯一凭据，IM 遥控、桌面命令、超时催办
 * 全都围绕它对齐。
 *
 * === 状态机 ===
 *
 * ```
 * open ──桌面回复/IM 回复──▶ answered | skipped | paused | denied
 *   │
 *   ├─超时──▶ expired（hold=true，严格停手；之后仍可被 IM/桌面决定救回）
 *   └─重发门禁──▶ superseded（旧票作废，避免卡死在上一张票上）
 * ```
 *
 * 门禁已改为**非阻塞**：建票即返回，没有任何前台 Promise 在等决定。
 * 所以"到点催办"由 `armEscalation()` 的定时器负责，"决定到了就停表"由
 * `decide()` 内部 `cancelEscalation()` 负责 —— 不再有 waiter 这层中间人。
 *
 * @module dsh-flow/gate-tickets
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { GATE_FINAL_STATES } from './modes.js'
import { docFileName, docTitle } from './flow-docs.js'

/** 票据 ID 前缀：`t` + 4 位十六进制，手机上也好打。 */
const ID_PREFIX = 't'

/** 内存里最多保留的历史票据条数（防止长会话无界增长）。 */
const MAX_TICKETS = 200

/** 默认状态文件（相对会话 cwd）。 */
const DEFAULT_STATE_REL = '.flow/state/gates.json'

/**
 * 草稿内容上限：120 000 字符（与 `flow_stage_gate` 的 `draftContent.maxLength` 对齐）。
 *
 * 用字符而不是字节，是因为中文一字符≈3 字节，按字节限会让"看起来没多长"的中文草稿莫名被拒。
 * 草稿只活在内存里，不落 `.flow/docs/`，也不写状态文件。
 */
const MAX_DRAFT_CHARS = 120_000

/** 裁草稿：超限直接拒绝（返回 null），不做静默截断。 */
function clipDraft(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  if (value.length > MAX_DRAFT_CHARS) return null
  return value
}

/** 生成短 ID，避开已占用的。 */
function nextId(taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const raw = globalThis.crypto?.randomUUID?.()
    const tail = typeof raw === 'string'
      ? raw.replace(/-/g, '').slice(0, 4)
      : Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
    const id = `${ID_PREFIX}${tail.toLowerCase()}`
    if (!taken.has(id)) return id
  }
  return `${ID_PREFIX}${Date.now().toString(36).slice(-4)}`
}

/** 去掉【推荐】之类装饰，压到 8 个字以内，给 IM 的单行选项表用。 */
function shortLabel(label, max = 8) {
  const text = String(label ?? '').replace(/【[^】]*】/g, '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 选项动作 → 票据状态。 */
function stateOfAction(action) {
  switch (action) {
    case 'skip': return 'skipped'
    case 'pause': return 'paused'
    case 'deny': return 'denied'
    default: return 'answered'
  }
}

/**
 * 创建票据仓库。
 *
 * @param {{
 *   getConfig: () => object,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createGateTickets({ getConfig, logger, diag = () => {} }) {
  /** id → ticket（内存唯一真相）。 */
  const tickets = new Map()
  /** id → timer（单次超时催办；决定、顶替、卸载时立刻停表）。 */
  const escalations = new Map()
  /** sessionId → { scope:'once'|'session-docs'|'deny', docId?: string, at: number }（文档写授权）。 */
  const grants = new Map()
  /** 已加载过的项目状态文件（避免重复读盘）。 */
  const loaded = new Set()
  let disposed = false

  const warn = (message) => {
    try { logger?.warn?.(message) } catch { /* 日志通道异常不影响主流程 */ }
  }

  /** 状态文件绝对路径。 */
  function statePathOf(cwd) {
    const rel = typeof getConfig()?.docs?.dir === 'string' && getConfig().docs.dir.trim() !== ''
      ? getConfig().docs.dir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      : '.flow/docs'
    const stateRel = rel.endsWith('/docs') ? `${rel.slice(0, -5)}/state/gates.json` : DEFAULT_STATE_REL
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return null
    return resolve(cwd, stateRel)
  }

  /** 把票据裁成可落盘的纯数据（**草稿永不入盘**，重启后草稿即失效）。 */
  function plainOf(ticket) {
    return {
      id: ticket.id,
      sessionId: ticket.sessionId,
      project: ticket.project,
      cwd: ticket.cwd,
      kind: ticket.kind,
      level: ticket.level,
      fromStage: ticket.fromStage,
      nextMode: ticket.nextMode,
      question: ticket.question,
      options: ticket.options,
      docIds: ticket.docIds,
      attachments: ticket.attachments,
      summary: ticket.summary,
      specUpdated: ticket.specUpdated,
      action: ticket.action,
      grantApplied: ticket.grantApplied,
      grantConsumed: ticket.grantConsumed,
      modeApplied: ticket.modeApplied,
      createdAt: ticket.createdAt,
      deadline: ticket.deadline,
      timeoutSeconds: ticket.timeoutSeconds,
      state: ticket.state,
      hold: ticket.hold,
      notifiedAt: ticket.notifiedAt,
      decidedAt: ticket.decidedAt,
      decidedBy: ticket.decidedBy,
      note: ticket.note,
    }
  }

  /** 按项目落盘（原子写；失败只警告）。 */
  function persist(ticket) {
    if (getConfig()?.gate?.persist === false) return
    const path = statePathOf(ticket.cwd)
    if (path === null) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      const sameProject = [...tickets.values()]
        .filter(item => item.cwd === ticket.cwd)
        .slice(-MAX_TICKETS)
        .map(plainOf)
      const temp = `${path}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tickets: sameProject }, null, 2), 'utf8')
      try {
        renameSync(temp, path)
      } catch (error) {
        try { unlinkSync(temp) } catch { /* 已被清理 */ }
        throw error
      }
    } catch (error) {
      warn(`flow: 门禁票据落盘失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 首次接触某项目时把历史票据读回来（损坏就忽略，不炸插件）。 */
  function ensureLoaded(cwd) {
    const path = statePathOf(cwd)
    if (path === null || loaded.has(path) || !existsSync(path)) return
    loaded.add(path)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const list = Array.isArray(parsed?.tickets) ? parsed.tickets : []
      for (const item of list) {
        if (typeof item?.id !== 'string' || tickets.has(item.id)) continue
        tickets.set(item.id, {
          ...item,
          options: Array.isArray(item.options) ? item.options : [],
          docIds: Array.isArray(item.docIds) ? item.docIds : [],
          attachments: Array.isArray(item.attachments) ? item.attachments : [],
          hold: item.state === 'expired' && item.hold === true,
        })
      }
      diag(`tickets loaded ${list.length} from ${path}`)
    } catch (error) {
      warn(`flow: 门禁票据文件损坏，已忽略 → ${error instanceof Error ? error.message : String(error)}`)
      loaded.delete(path)
    }
  }

  /**
   * 新建票据。
   *
   * @param {object} input
   * @returns {object} 票据对象（含 `id`）。
   */
  function create(input) {
    ensureLoaded(input.cwd)
    const draft = clipDraft(input.draftContent)
    if (draft === null) {
      return { error: `草稿超过 ${MAX_DRAFT_CHARS} 字符上限，请先精简再申请授权` }
    }
    const id = nextId(new Set(tickets.keys()))
    const now = Date.now()
    const timeoutSeconds = Number.isFinite(input.timeoutSeconds) ? Math.max(0, Math.floor(input.timeoutSeconds)) : 0
    const ticket = {
      id,
      sessionId: String(input.sessionId ?? ''),
      project: String(input.project ?? '未命名工作区'),
      cwd: String(input.cwd ?? ''),
      kind: String(input.kind ?? 'stage'),
      level: String(input.level ?? 'M'),
      fromStage: String(input.fromStage ?? ''),
      nextMode: String(input.nextMode ?? ''),
      question: String(input.question ?? ''),
      options: Array.isArray(input.options) ? input.options : [],
      docIds: Array.isArray(input.docIds) ? input.docIds : [],
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      /** 阶段结论与"是否已落 spec"，供结算器在迟到批准时补发归档通知。 */
      summary: String(input.summary ?? ''),
      specUpdated: input.specUpdated === true,
      /** 结算动作（approve/skip/pause/revise/once/session-docs/deny）。 */
      action: '',
      /** 授权是否已写入 grants（重启后据此恢复）。 */
      grantApplied: false,
      /** 一次性授权是否已消费（防止重启后重放）。 */
      grantConsumed: false,
      /** 模式切换是否真的执行过。 */
      modeApplied: false,
      /** 申请落盘的草稿：只活内存，不写 `.flow/docs/`，也不进状态文件。 */
      draftId: String(input.draftId ?? ''),
      draftContent: draft,
      createdAt: now,
      deadline: timeoutSeconds > 0 ? now + timeoutSeconds * 1000 : 0,
      timeoutSeconds,
      state: 'open',
      /** 非阻塞门禁建票即 hold：写文档/切模式都要先被拦住，直到用户回话。 */
      hold: input.hold === true,
      notifiedAt: 0,
      decidedAt: 0,
      decidedBy: '',
      note: '',
    }
    tickets.set(id, ticket)
    if (tickets.size > MAX_TICKETS) {
      const oldest = [...tickets.values()]
        .filter(item => GATE_FINAL_STATES.includes(item.state))
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest !== undefined) tickets.delete(oldest.id)
    }
    persist(ticket)
    diag(`ticket create #${id} kind=${ticket.kind} session=${ticket.sessionId} docs=${ticket.docIds.join(',') || '-'}`)
    return ticket
  }

  /** 取票据（会先尝试加载该项目状态）。 */
  function find(id, cwd) {
    const key = String(id ?? '').replace(/^#/, '').trim().toLowerCase()
    if (key === '') return undefined
    if (cwd !== undefined) ensureLoaded(cwd)
    return tickets.get(key)
  }

  /** 全部票据（新→旧）。 */
  function list({ sessionId } = {}) {
    return [...tickets.values()]
      .filter(item => sessionId === undefined || item.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 待决票据：`open`，或超时后仍 hold 的 `expired`。
   * @param {string} sessionId
   */
  function openFor(sessionId) {
    return list({ sessionId }).filter(item => item.state === 'open' || (item.state === 'expired' && item.hold === true))
  }

  /** 正在 hold 的票据（每会话最多一张）。 */
  function holdOf(sessionId) {
    return openFor(sessionId).find(item => item.hold === true)
  }

  /**
   * 挂一次性超时催办定时器（门禁非阻塞化之后的唯一超时来源）。
   *
   * 前台工具建票后立刻返回，没人再守着"到点那一刻"，所以催办只能由这里的
   * `setTimeout` 触发。定时器 `unref()`，不会吊住宿主进程。
   *
   * @param {string} id
   * @param {number} delayMs
   * @param {() => unknown | Promise<unknown>} handler
   * @returns {boolean} 是否真的挂上了
   */
  function armEscalation(id, delayMs, handler) {
    const key = String(id ?? '').replace(/^#/, '')
    if (key === '') return false
    cancelEscalation(key)
    const delay = Number(delayMs)
    if (!Number.isFinite(delay) || delay <= 0 || typeof handler !== 'function') return false
    const timer = setTimeout(() => {
      escalations.delete(key)
      try {
        Promise.resolve(handler()).catch((error) => {
          warn(`flow: 门禁催办执行失败 → ${error instanceof Error ? error.message : String(error)}`)
        })
      } catch (error) {
        warn(`flow: 门禁催办执行失败 → ${error instanceof Error ? error.message : String(error)}`)
      }
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    escalations.set(key, timer)
    diag(`ticket escalation armed #${key} in ${delay}ms`)
    return true
  }

  /** 撤掉催办定时器；返回是否真的撤到了（用于"用户已开口就停表"的判定）。 */
  function cancelEscalation(id) {
    const key = String(id ?? '').replace(/^#/, '')
    const timer = escalations.get(key)
    if (timer === undefined) return false
    clearTimeout(timer)
    escalations.delete(key)
    diag(`ticket escalation cancelled #${key}`)
    return true
  }

  /** 这张票是不是还挂着催办。 */
  function hasEscalation(id) {
    return escalations.has(String(id ?? '').replace(/^#/, ''))
  }

  /**
   * 把同会话、同类型的未决票据标记为 `superseded`（改完草稿重发门禁时顶替旧票）。
   *
   * 非阻塞模式下没有"上一张票还占着位置"这回事了：旧票没人守着，
   * 继续拿它硬拦新票只会让用户卡死。顶替是唯一自洽的做法。
   *
   * @param {{ sessionId: string, kind?: string, reason?: string }} input
   * @returns {object[]} 被顶替的票据
   */
  function supersede({ sessionId, kind, reason = '' } = {}) {
    const key = String(sessionId ?? '')
    if (key === '') return []
    const hit = []
    for (const ticket of tickets.values()) {
      if (ticket.sessionId !== key) continue
      if (kind !== undefined && kind !== null && ticket.kind !== kind) continue
      const pending = ticket.state === 'open' || (ticket.state === 'expired' && ticket.hold === true)
      if (!pending) continue
      ticket.state = 'superseded'
      ticket.hold = false
      ticket.decidedAt = Date.now()
      ticket.decidedBy = 'supersede'
      ticket.note = String(reason)
      cancelEscalation(ticket.id)
      persist(ticket)
      hit.push(ticket)
    }
    if (hit.length > 0) diag(`ticket superseded ${hit.map(item => `#${item.id}`).join(' ')}`)
    return hit
  }

  /**
   * 落一个决定（桌面点选、IM 遥控、命令都走这里）。
   *
   * **只改状态与唤醒等待者，不做任何业务副作用** —— 授权、切模式等由
   * `gate-settle.js` 的结算器统一执行，避免"IM 迟到回复只改状态不落权"。
   *
   * @param {string} id
   * @param {{ action: string, by?: string, note?: string, effects?: object }} decision
   * @returns {{ ok: boolean, ticket?: object, reason?: string }}
   */
  function decide(id, { action, by = 'desktop', note = '', effects } = {}) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return { ok: false, reason: `票据 #${String(id)} 不存在` }
    if (GATE_FINAL_STATES.includes(ticket.state)) {
      return { ok: false, reason: `票据 #${ticket.id} 已经结算过（${ticket.state}）` }
    }
    const next = stateOfAction(action)
    ticket.state = next
    ticket.action = String(action)
    ticket.effects = effects
    ticket.hold = false
    ticket.decidedAt = Date.now()
    ticket.decidedBy = String(by)
    ticket.note = String(note ?? '')
    persist(ticket)
    // 决定一到立刻停表：非阻塞模式下，这是"不再催办"的唯一可靠信号。
    cancelEscalation(ticket.id)
    diag(`ticket decide #${ticket.id} action=${action} state=${next} by=${by} noteLen=${ticket.note.length}`)
    return { ok: true, ticket }
  }

  /** 标记超时（幂等）：登记 hold 并返回是否是第一次。 */
  function expire(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return { ok: false, reason: '票据不存在' }
    if (ticket.state !== 'open') return { ok: false, reason: `票据状态是 ${ticket.state}` }
    ticket.state = 'expired'
    ticket.hold = true
    persist(ticket)
    cancelEscalation(ticket.id)
    diag(`ticket expire #${ticket.id}`)
    return { ok: true, ticket }
  }

  /** 标记已催办（保证只发一次）。 */
  function markNotified(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    if (ticket.notifiedAt > 0) return false
    ticket.notifiedAt = Date.now()
    persist(ticket)
    return true
  }

  /** 解除 hold（用户明确要求"跳过继续"时由决定自动完成，这里给命令留后门）。 */
  function releaseHold(sessionId) {
    let released = 0
    for (const ticket of tickets.values()) {
      if (ticket.sessionId === sessionId && ticket.hold === true) {
        ticket.hold = false
        persist(ticket)
        released += 1
      }
    }
    return released
  }

  /* ---------------- 文档写授权（R6） ---------------- */

  /** 读某会话的写授权。 */
  function grantOf(sessionId) {
    return grants.get(String(sessionId ?? '')) ?? { scope: 'none' }
  }

  /** 写授权（由 `kind:'permission'` 门禁或配置 `docs.writePolicy='auto'` 触发）。 */
  function grant(sessionId, scope, { docId } = {}) {
    const key = String(sessionId ?? '')
    if (key === '') return { ok: false, reason: '会话 ID 缺失' }
    if (scope === 'deny') {
      grants.set(key, { scope: 'deny', at: Date.now() })
      return { ok: true, scope: 'deny' }
    }
    grants.set(key, { scope, docId: docId === undefined ? undefined : String(docId), at: Date.now() })
    diag(`docs grant session=${key} scope=${scope}${docId === undefined ? '' : ` doc=${docId}`}`)
    return { ok: true, scope }
  }

  /** 标记某张票据的授权已生效（落盘，供重启后恢复）。 */
  function markGrantApplied(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    ticket.grantApplied = true
    persist(ticket)
    return true
  }

  /** 标记某张票据的一次性授权已被消费（防重启后重放）。 */
  function markGrantConsumed(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    ticket.grantConsumed = true
    persist(ticket)
    return true
  }

  /** 标记某张票据的模式切换确实执行过。 */
  function markModeApplied(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    ticket.modeApplied = true
    persist(ticket)
    return true
  }

  /** 该会话最近一条仍有效的授权票据（未消费、动作是 once/session-docs）。 */
  function restorableGrant(sessionId, docId, cwd) {
    if (cwd !== undefined) ensureLoaded(cwd)
    const candidates = list({ sessionId }).filter(ticket => ticket.kind === 'permission'
      && (ticket.action === 'once' || ticket.action === 'session-docs')
      && ticket.grantConsumed !== true)
    for (const ticket of candidates) {
      if (ticket.action === 'session-docs') return ticket
      if (docId === undefined) return ticket
      if (ticket.draftId === '' || ticket.draftId === docId) return ticket
    }
    return undefined
  }

  /**
   * 校验一次写操作是否有授权。
   *
   * 内存 `grants` 缺失时（跨超时、跨重启）回查该会话最近的 permission 票据把授权补回来，
   * 这就是"IM 迟到答复只改状态、`flow_docs_write` 仍报未授权"的治本兜底。
   *
   * @param {string} sessionId
   * @param {{ docId?: string, policy?: string, cwd?: string }} input `policy='auto'` 时直接放行白名单内写入。
   * @returns {{ ok: true, scope: string, restored?: boolean } | { ok: false, reason: string }}
   */
  function canWrite(sessionId, { docId, policy = 'ask', cwd } = {}) {
    if (policy === 'auto') return { ok: true, scope: 'auto' }
    const current = grantOf(sessionId)
    if (current.scope === 'session-docs') return { ok: true, scope: 'session-docs' }
    if (current.scope === 'once') {
      if (current.docId !== undefined && docId !== undefined && current.docId !== docId) {
        return { ok: false, reason: `本次授权只允许写 ${current.docId}，不是 ${docId}` }
      }
      return { ok: true, scope: 'once' }
    }
    if (current.scope === 'deny') return { ok: false, reason: '你已拒绝本会话写入文档（deny）' }

    // 兜底：从票据里恢复（跨超时 / 跨重启）。
    const ticket = restorableGrant(sessionId, docId, cwd)
    if (ticket !== undefined) {
      grant(sessionId, ticket.action, { docId: ticket.draftId === '' ? undefined : ticket.draftId })
      markGrantApplied(ticket.id)
      diag(`docs grant restored from ticket #${ticket.id} scope=${ticket.action}`)
      return { ok: true, scope: ticket.action, restored: true }
    }
    return { ok: false, reason: '尚未授权：请先调用 flow_stage_gate({kind:"permission"}) 申请写文档授权' }
  }

  /** 消费掉一次性授权（成功写入后调用；同时把票据标记为已消费，防重启重放）。 */
  function consumeOnce(sessionId) {
    const key = String(sessionId ?? '')
    const current = grants.get(key)
    if (current?.scope !== 'once') return false
    grants.delete(key)
    const used = list({ sessionId: key }).find(ticket => ticket.kind === 'permission'
      && ticket.action === 'once'
      && ticket.grantApplied === true
      && ticket.grantConsumed !== true)
    if (used !== undefined) markGrantConsumed(used.id)
    return true
  }

  /** 卸载：撤掉所有催办定时器（不留悬挂 timer）。 */
  function dispose() {
    disposed = true
    for (const [id, timer] of escalations) {
      try { clearTimeout(timer) } catch { /* 忽略 */ }
      escalations.delete(id)
    }
    grants.clear()
  }

  return {
    create,
    find,
    list,
    openFor,
    holdOf,
    armEscalation,
    cancelEscalation,
    hasEscalation,
    supersede,
    decide,
    expire,
    markNotified,
    releaseHold,
    grantOf,
    grant,
    markGrantApplied,
    markGrantConsumed,
    markModeApplied,
    restorableGrant,
    canWrite,
    consumeOnce,
    statePathOf,
    isDisposed: () => disposed,
    dispose,
  }
}

/**
 * IM 门禁消息：**前 3 行固定是票据号与回复指引**，后面才能被截断。
 *
 * 这是本次实测踩过的坑（微信在模块名中间截断），所以模板顺序不可调整：
 * 摘要再重要也排在指引后面，宁可少说两句，也不能让用户看不到怎么回。
 *
 * @param {object} ticket
 * @param {{ digestChars?: number, docs?: string[] }} [options]
 * @returns {string}
 */
export function formatImGate(ticket, { digestChars = 200, docs } = {}) {
  const stage = ticket.fromStage !== '' && ticket.nextMode !== ''
    ? `${ticket.fromStage}→${ticket.nextMode}`
    : ticket.kind
  const map = ticket.options
    .map((option, index) => `${index + 1}=${shortLabel(option.label)}`)
    .join(' ')
  const docIds = Array.isArray(docs) ? docs : ticket.docIds
  const hasDraft = typeof ticket.draftContent === 'string' && ticket.draftContent.trim() !== ''
  const docLine = docIds.length === 0
    ? (hasDraft ? '文档：草稿未落盘（回复 0 看草稿摘要，完整草稿见邮箱附件）' : '文档：本门禁无附件')
    : `文档：${docIds.map(id => docFileName(id)).join(' ')} 已发邮箱附件（回复 0 看摘要）`
  const summaryRaw = String(ticket.question ?? '').replace(/\s+/g, ' ').trim()
  const summary = summaryRaw.length > digestChars ? `${summaryRaw.slice(0, Math.max(0, digestChars - 1))}…` : summaryRaw
  return [
    `[Flow 门禁 #${ticket.id}] ${ticket.project} · ${stage}`,
    `${map}（0=看文档摘要）`,
    `回复格式：#${ticket.id} 1 你的意见`,
    '——',
    summary === '' ? '（无摘要）' : summary,
    docLine,
  ].join('\n')
}

/** 邮件正文（比 IM 宽松，但同样把票据号与选项放最前）。 */
export function formatEmailGate(ticket, { summary = '', docs = ticket.docIds, stage } = {}) {
  const map = ticket.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')
  const hasDraft = typeof ticket.draftContent === 'string' && ticket.draftContent.trim() !== ''
  const draftName = hasDraft && ticket.draftId !== ''
    ? docFileName(ticket.draftId).replace(/\.md$/i, '.draft.md')
    : 'draft.md'
  const docLines = [
    docs.length === 0
      ? (hasDraft ? '' : '- 本门禁无文档附件')
      : docs.map(id => `- ${docFileName(id)}｜${docTitle(id)}（已作为附件）`).join('\n'),
    hasDraft ? `- ${draftName}｜尚未落盘草稿（已作为附件，授权通过后才写进 .flow/docs）` : '',
  ].filter(line => line !== '').join('\n')
  return [
    `## Flow 门禁 #${ticket.id}`,
    '',
    `- 项目：${ticket.project}`,
    `- 阶段：${stage ?? `${ticket.fromStage} → ${ticket.nextMode}`}`,
    `- 票据：\`#${ticket.id}\``,
    `- 超时：${ticket.timeoutSeconds > 0 ? `${ticket.timeoutSeconds} 秒` : '不设超时'}`,
    '',
    '## 待决问题',
    '',
    ticket.question === '' ? '（无）' : ticket.question,
    '',
    '## 选项',
    '',
    map,
    '',
    '## 附件',
    '',
    docLines,
    '',
    '## 回复方式',
    '',
    `- 桌面：直接在选择框点选，或输入 \`#${ticket.id} 1\``,
    `- IM：回复 \`#${ticket.id} 1\`（可跟一句意见，会原样转给桌面会话）`,
    `- 看文档摘要：回复 \`0\` 或 \`#${ticket.id} doc\``,
    ...(summary === '' ? [] : ['', '## 摘要', '', summary]),
  ].join('\n')
}
