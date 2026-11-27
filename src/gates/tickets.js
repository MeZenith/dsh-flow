/**
 * 门禁票据：状态机 + 超时单次催办 + 按项目落盘 + 文档写授权。
 *
 * v0.6.0 修复：
 * - M-05：`plainOf` 持久化 `draftId`，恢复时同时保留 `open` 与 `expired` 票据的 `hold`；
 * - B-11：`statePathOf` 校验结果路径仍在 cwd 根内，并用并发安全的 `writeAtomic`；
 * - M-06：支持 `releaseTicket(id)` 单票解除 hold；
 * - 新增 `onEvent` 回调，方便 RemoteHub / 飞书卡片同步更新状态。
 *
 * @module dsh-flow/gates/tickets
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { GATE_FINAL_STATES } from '../config/constants.js'
import { docFileName, docTitle } from '../workflow/docs.js'
import { assertInsideRoot, normalizeRelDir, writeAtomic } from '../shared/fs-safe.js'

const ID_PREFIX = 't'
const MAX_TICKETS = 200
const DEFAULT_STATE_REL = '.flow/state/gates.json'
const MAX_DRAFT_CHARS = 120_000

function clipDraft(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  if (value.length > MAX_DRAFT_CHARS) return null
  return value
}

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

function shortLabel(label, max = 8) {
  const text = String(label ?? '').replace(/【[^】]*】/g, '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

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
 *   onEvent?: (type: string, ticket: object) => void,
 * }} deps
 */
export function createGateTickets({ getConfig, logger, diag = () => {}, onEvent }) {
  const tickets = new Map()
  const escalations = new Map()
  const grants = new Map()
  const loaded = new Set()
  let disposed = false

  const warn = (message) => {
    try { logger?.warn?.(message) } catch { /* 忽略 */ }
  }

  function emit(type, ticket) {
    if (typeof onEvent !== 'function') return
    try { onEvent(type, ticket) } catch { /* 事件监听异常不影响票据状态 */ }
  }

  /** 状态文件绝对路径（校验必须在 cwd 内，防配置越界）。 */
  function statePathOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return null
    const rel = normalizeRelDir(getConfig()?.docs?.dir, '.flow/docs')
    const stateRel = rel.endsWith('/docs') ? `${rel.slice(0, -5)}/state/gates.json` : DEFAULT_STATE_REL
    const target = resolve(cwd, stateRel)
    return assertInsideRoot(cwd, target).ok === true ? target : null
  }

  /** 把票据裁成可落盘的纯数据（草稿正文不入盘，但保留 draftId 以恢复 once 授权约束）。 */
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
      draftId: ticket.draftId,
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

  function persist(ticket) {
    if (getConfig()?.gate?.persist === false) return
    const path = statePathOf(ticket.cwd)
    if (path === null) return
    try {
      const sameProject = [...tickets.values()]
        .filter(item => item.cwd === ticket.cwd)
        .slice(-MAX_TICKETS)
        .map(plainOf)
      writeAtomic(path, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tickets: sameProject }, null, 2))
    } catch (error) {
      warn(`flow: 门禁票据落盘失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 首次接触某项目时把历史票据读回来。 */
  function ensureLoaded(cwd) {
    const path = statePathOf(cwd)
    if (path === null || loaded.has(path) || !existsSync(path)) return
    loaded.add(path)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const list = Array.isArray(parsed?.tickets) ? parsed.tickets : []
      for (const item of list) {
        if (typeof item?.id !== 'string' || tickets.has(item.id)) continue
        const isPending = item.state === 'open' || item.state === 'expired'
        tickets.set(item.id, {
          ...item,
          draftId: typeof item.draftId === 'string' ? item.draftId : '',
          draftContent: '',
          options: Array.isArray(item.options) ? item.options : [],
          docIds: Array.isArray(item.docIds) ? item.docIds : [],
          attachments: Array.isArray(item.attachments) ? item.attachments : [],
          // 重启后保留 open 与 expired 两种未决票据的 hold，防止重启绕过门禁。
          hold: isPending && item.hold === true,
        })
      }
      diag(`tickets loaded ${list.length} from ${path}`)
    } catch (error) {
      warn(`flow: 门禁票据文件损坏，已忽略 → ${error instanceof Error ? error.message : String(error)}`)
      loaded.delete(path)
    }
  }

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
      summary: String(input.summary ?? ''),
      specUpdated: input.specUpdated === true,
      action: '',
      grantApplied: false,
      grantConsumed: false,
      modeApplied: false,
      draftId: String(input.draftId ?? ''),
      draftContent: draft,
      createdAt: now,
      deadline: timeoutSeconds > 0 ? now + timeoutSeconds * 1000 : 0,
      timeoutSeconds,
      state: 'open',
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
    emit('created', ticket)
    return ticket
  }

  function find(id, cwd) {
    const key = String(id ?? '').replace(/^#/, '').trim().toLowerCase()
    if (key === '') return undefined
    if (cwd !== undefined) ensureLoaded(cwd)
    return tickets.get(key)
  }

  function list({ sessionId } = {}) {
    return [...tickets.values()]
      .filter(item => sessionId === undefined || item.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  function openFor(sessionId) {
    return list({ sessionId }).filter(item => item.state === 'open' || (item.state === 'expired' && item.hold === true))
  }

  function holdOf(sessionId) {
    return openFor(sessionId).find(item => item.hold === true)
  }

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

  function cancelEscalation(id) {
    const key = String(id ?? '').replace(/^#/, '')
    const timer = escalations.get(key)
    if (timer === undefined) return false
    clearTimeout(timer)
    escalations.delete(key)
    diag(`ticket escalation cancelled #${key}`)
    return true
  }

  function hasEscalation(id) {
    return escalations.has(String(id ?? '').replace(/^#/, ''))
  }

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
      emit('superseded', ticket)
      hit.push(ticket)
    }
    if (hit.length > 0) diag(`ticket superseded ${hit.map(item => `#${item.id}`).join(' ')}`)
    return hit
  }

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
    cancelEscalation(ticket.id)
    diag(`ticket decide #${ticket.id} action=${action} state=${next} by=${by} noteLen=${ticket.note.length}`)
    emit('decided', ticket)
    return { ok: true, ticket }
  }

  function expire(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return { ok: false, reason: '票据不存在' }
    if (ticket.state !== 'open') return { ok: false, reason: `票据状态是 ${ticket.state}` }
    ticket.state = 'expired'
    ticket.hold = true
    persist(ticket)
    cancelEscalation(ticket.id)
    diag(`ticket expire #${ticket.id}`)
    emit('expired', ticket)
    return { ok: true, ticket }
  }

  function markNotified(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    if (ticket.notifiedAt > 0) return false
    ticket.notifiedAt = Date.now()
    persist(ticket)
    return true
  }

  /** 解除单张票据的 hold（给 `/flow gate release <id>` 精准使用）。 */
  function releaseTicket(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined || ticket.hold !== true) return false
    ticket.hold = false
    persist(ticket)
    emit('released', ticket)
    return true
  }

  /** 解除某会话所有处于 hold 的票据。 */
  function releaseHold(sessionId) {
    let released = 0
    for (const ticket of tickets.values()) {
      if (ticket.sessionId === sessionId && ticket.hold === true) {
        ticket.hold = false
        persist(ticket)
        emit('released', ticket)
        released += 1
      }
    }
    return released
  }

  /* ---------------- 文档写授权 ---------------- */

  function grantOf(sessionId) {
    return grants.get(String(sessionId ?? '')) ?? { scope: 'none' }
  }

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

  function markGrantApplied(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    ticket.grantApplied = true
    persist(ticket)
    return true
  }

  function markGrantConsumed(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    ticket.grantConsumed = true
    persist(ticket)
    return true
  }

  function markModeApplied(id) {
    const ticket = tickets.get(String(id ?? '').replace(/^#/, ''))
    if (ticket === undefined) return false
    ticket.modeApplied = true
    persist(ticket)
    return true
  }

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

  function canWrite(sessionId, { docId, policy = 'auto', cwd } = {}) {
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

    const ticket = restorableGrant(sessionId, docId, cwd)
    if (ticket !== undefined) {
      grant(sessionId, ticket.action, { docId: ticket.draftId === '' ? undefined : ticket.draftId })
      markGrantApplied(ticket.id)
      diag(`docs grant restored from ticket #${ticket.id} scope=${ticket.action}`)
      return { ok: true, scope: ticket.action, restored: true }
    }
    return { ok: false, reason: '尚未授权：请先调用 flow_stage_gate({kind:"permission"}) 申请写文档授权' }
  }

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
    ensureLoaded,
    armEscalation,
    cancelEscalation,
    hasEscalation,
    supersede,
    decide,
    expire,
    markNotified,
    releaseTicket,
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

/** IM 门禁消息：前 3 行固定票据号与回复指引。 */
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
    ? (hasDraft ? '文档：草稿未落盘（回复 0 看草稿摘要，完整草稿见邮箱/飞书文件）' : '文档：本门禁无附件')
    : `文档：${docIds.map(id => docFileName(id)).join(' ')}（回复 0 看摘要）`
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

/** 邮件正文（同样把票据号与选项放最前）。 */
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
    `- 桌面：直接回复 \`1\`，或输入 \`#${ticket.id} 1\``,
    `- 飞书：直接点击互动卡片按钮，或回复 \`#${ticket.id} 1 意见\``,
    `- 微信/其他 IM：回复 \`#${ticket.id} 1\`（可跟一句意见，会原样转给桌面会话）`,
    `- 看文档摘要：回复 \`0\` 或 \`#${ticket.id} doc\``,
    ...(summary === '' ? [] : ['', '## 摘要', '', summary]),
  ].join('\n')
}
