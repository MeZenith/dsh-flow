/**
 * 跨会话门禁遥控：在 `agent/pre-step` 里统一承接**桌面主会话**与 **IM 会话**的 `1/2/3` 回复。
 *
 * === 两类会话的分工 ===
 *
 * - **桌面主会话**（`sessionId === ticket.sessionId`）：用户就在这儿说话。
 *   第一步先撤掉催办定时器（人还在），命中 `#票据号 1|2|3 [意见]` / `0` 就结算，
 *   然后把"已结算选项 + 附带指令"重新注入本会话继续跑；**普通自然语言一律放行**，
 *   让模型正常对话，`hold` 不变（防止越权写盘），改完草稿重发门禁会顶替旧票。
 * - **IM 会话**（`sessionId !== ticket.sessionId`）：必须 `reject` 掐断 IM 自身推理，
 *   再结算、唤醒桌面、回一条 IM 确认。
 *
 * === 为什么必须 reject ===
 *
 * 实测踩坑：在微信回 `3`，消息落进了 IM 绑定会话本身，桌面门禁压根收不到。
 * 原因很直白 —— IM 回复本来就是"那个会话的一条用户消息"，没人拦就会正常开一轮推理。
 * 所以这里**必须返回 `{ kind:'reject' }`**：先把消息吃掉（inbox 已 claim，不会重复提案），
 * 再把决定投递给真正的目标会话，最后回一条 IM 确认。
 *
 * === 与熔断器的优先级 ===
 *
 * 同一个 `agent/pre-step` 上，`gate-router` 注册在 `circuit-breaker` 之前：
 * - 只有门禁票据 → router 接管；
 * - 只有熔断 → `next()` 交回熔断（保持原有 `1/2/3` 语义）；
 * - **两者都有** → 裸数字视为歧义，**不执行任何动作**，回一条指引要求带 `#票据号`，
 *   然后 reject（宁可让用户多打 6 个字符，也不能让「跳过验收」误触发成「熔断重试」）。
 *
 * @module dsh-flow/gate-router
 */
import { stripImSource, textOfMessage } from './circuit-breaker.js'
import { GATE_FINAL_STATES, normalizeDocId } from './modes.js'
import { digestOf, docFileName, readDocText } from './flow-docs.js'
import { formatImGate } from './gate-tickets.js'

/** 显式票据：`#t3f9 1 附带意见`。 */
const EXPLICIT_RE = /^#([a-z0-9]{2,12})\s+(1|2|3|0|doc)(?:\s+([\s\S]*))?$/i

/** 裸令牌：`1`、`2 修改意见`、`0`、`doc`。 */
const BARE_RE = /^(1|2|3|0|doc)(?:\s+([\s\S]*))?$/i

/** 斜杠命令：`/flow gate answer t3f9 1 附带意见`。 */
const SLASH_RE = /^\/flow\s+gate\s+(answer|skip|doc|docs)\s+#?([a-z0-9]{2,12})(?:\s+(\d))?(?:\s+([\s\S]*))?$/i

/** 把数字映射成票据里的选项动作。 */
function actionOfToken(ticket, token) {
  if (token === '0' || token === 'doc') return { action: 'doc' }
  const index = Number(token) - 1
  const option = Array.isArray(ticket.options) ? ticket.options[index] : undefined
  if (option === undefined) {
    return { error: `#${ticket.id} 没有第 ${token} 个选项（共 ${ticket.options.length} 个）` }
  }
  return { action: option.action, label: option.label }
}

/** 从消息数组里抽纯文本（复用熔断器的实现，保证 IM 包裹剥离口径一致）。 */
function textOfMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  return stripImSource(list.map(textOfMessage).join('\n').trim())
}

/**
 * 创建遥控路由器。
 *
 * @param {{
 *   ctx: object,
 *   tickets: ReturnType<typeof import('./gate-tickets.js').createGateTickets>,
 *   breaker?: { listTrips?: () => object[] },
 *   im?: { send?: Function },
 *   getConfig: () => object,
 *   resolveAgent: (sessionId: string) => object | undefined,
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createGateRouter({ tickets, breaker, im, getConfig, resolveAgent, settler, logger, diag = () => {} }) {
  const warn = (message) => {
    try { logger?.warn?.(message) } catch { /* 忽略日志通道异常 */ }
  }

  /** 回一条 IM 确认（失败只留痕，不重试刷屏）。 */
  async function reply(markdown, title = 'Flow 门禁') {
    if (typeof im?.send !== 'function') return
    try {
      const sent = await im.send({ title, markdown })
      diag(`gate reply im=${sent?.ok === true ? 'ok' : `fail(${sent?.reason ?? 'no-result'})`}`)
    } catch (error) {
      warn(`flow: 门禁回执发送失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 把一段纯文本注入目标会话（桌面决定、文档摘要共用同一条通道）。
   *
   * 注入失败必须**如实返回 false**：桌面侧的调用方会据此退回 `next()`，
   * 宁可让模型看到原消息，也不能 `reject` 掉之后什么都不发生（空回合）。
   */
  function injectText({ ticket, text, template }) {
    const target = resolveAgent(ticket.sessionId)
    if (target === undefined || target === null) {
      diag(`gate inject abort target missing session=${ticket.sessionId}`)
      return { ok: false, reason: '目标会话实例已失效（可能已重启）' }
    }
    if (template === undefined || template === null || typeof template !== 'object') {
      diag('gate inject abort no template message')
      return { ok: false, reason: '缺少可作为模板的入站消息' }
    }
    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? `gate-${globalThis.crypto.randomUUID()}`
      : `gate-${Date.now().toString(36)}`
    const message = { ...template, id, role: 'user', content: [{ type: 'text', text }] }
    try {
      if (typeof target.steer === 'function') target.steer(message)
      else target.followup(message)
      diag(`gate inject ok target=${ticket.sessionId} len=${text.length}`)
      return { ok: true }
    } catch (error) {
      // steer 在极端状态下会抛；退回 followup 再试一次。
      try {
        target.followup(message)
        diag(`gate inject via followup target=${ticket.sessionId}`)
        return { ok: true }
      } catch (second) {
        warn(`flow: 门禁消息注入失败 → ${second instanceof Error ? second.message : String(second)}`)
        diag(`gate inject fail ${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, reason: '注入失败' }
      }
    }
  }

  /** 把决定（含附带文字原文）投递给目标会话。 */
  function forwardDecision({ ticket, action, label, note, template, fromIm }) {
    const verbatim = note === '' ? '（无）' : note
    const text = [
      `[Flow 门禁决定${fromIm ? '·来自 IM' : '·你已在桌面确认'}]`,
      `票据 #${ticket.id}｜项目「${ticket.project}」`,
      `选项：${label}（action=${action}）`,
      '附带指令（原样，来自用户）：',
      verbatim,
      '要求：先落实附带指令，再按该选项对应的阶段动作推进；两者冲突时以附带指令为准，并说明你的取舍。',
    ].join('\n')
    return injectText({ ticket, text, template })
  }

  /**
   * 用户一旦在本会话开口，就把该会话所有还挂着的催办定时器全部撤掉。
   *
   * 非阻塞模式下催办是"人不理我"才发的；人在桌面敲字、或在微信回话，
   * 都说明人还在，先停表，别等他决定完再补一封多余的邮件。
   */
  function cancelPendingEscalations(sessionId) {
    const key = String(sessionId ?? '')
    if (key === '' || typeof tickets.cancelEscalation !== 'function') return 0
    let cancelled = 0
    for (const ticket of tickets.list({ sessionId: key })) {
      if (ticket.state !== 'open') continue
      if (tickets.cancelEscalation(ticket.id) === true) cancelled += 1
    }
    if (cancelled > 0) diag(`gate router stop-timer session=${key} count=${cancelled}`)
    return cancelled
  }

  /**
   * 回文档摘要（IM 只能发文字，所以按数量分条）。
   *
   * 磁盘优先；`.flow/docs/0X-*.md` 还没落盘时**回退到票据里的草稿** —— 这是写文档授权
   * 场景的关键：用户还没授权，文件本来就不该存在，但他在手机上必须能先看到内容。
   */
  function buildDigest(ticket) {
    const ids = Array.isArray(ticket.docIds) ? ticket.docIds.map(normalizeDocId).filter(Boolean) : []
    const draft = typeof ticket.draftContent === 'string' ? ticket.draftContent.trim() : ''
    if (ids.length === 0 && draft === '') {
      return `#${ticket.id} 没有关联文档，也没有草稿可看。`
    }
    const maxCharsRaw = Number(getConfig()?.gate?.docDigestChars)
    const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? Math.floor(maxCharsRaw) : 800
    const clip = (text) => (text.length > maxChars ? `${text.slice(0, maxChars)}…（已截断，完整见邮箱附件）` : text)
    const config = getConfig()
    const header = []
    const blocks = []
    const draftId = normalizeDocId(ticket.draftId) ?? ''
    const draftShown = draft !== ''

    // 草稿优先：只要票据带着待授权的新草稿，就先展示它。
    // 磁盘上那份可能是空骨架或上一版旧文（骨架恰好也是"存在但没内容"），先读它等于骗人。
    if (draftShown) {
      const name = draftId === '' ? 'draft.md' : docFileName(draftId).replace(/\.md$/i, '.draft.md')
      header.push(`${name}（未落盘草稿·待授权，优先展示）`)
      blocks.push(`【${name}｜未落盘草稿】\n${clip(draft)}`)
    }

    for (const id of ids) {
      // 同号文档已有新草稿时跳过磁盘版本，避免"草稿 + 旧骨架"两份内容互相打脸。
      if (draftShown && id === draftId) continue
      const onDisk = readDocText({ config, cwd: ticket.cwd, id })
      if (onDisk !== '') {
        const digested = digestOf({ config, cwd: ticket.cwd, ids: [id], maxChars })
        header.push(`${id} ${docFileName(id)}（已落盘）`)
        blocks.push(digested.text)
        continue
      }
      header.push(`${id} ${docFileName(id)}（尚未落盘）`)
      blocks.push(`【${id} ${docFileName(id)}】尚未落盘`)
    }

    return `[Flow 文档 #${ticket.id}]\n${header.join('\n')}\n——\n${blocks.join('\n\n')}`
  }

  /** IM 侧：把摘要按纯文字发出去。 */
  async function sendDigest(ticket) {
    await reply(buildDigest(ticket), 'Flow 文档')
  }

  /**
   * pre-step 拦截。
   *
   * @param {{ agent?: object, messages?: object[] }} payload
   * @param {() => Promise<object>} next
   * @returns {Promise<object>}
   */
  async function preStep(payload, next) {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return next()

    // 子代理不参与遥控：成员会话里的数字是它自己的指令，不许被吞。
    if (agent.session?.header?.origin === 'subagent') return next()

    const sessionId = String(agent.session?.id ?? '')
    const text = textOfMessages(payload.messages)
    if (text === '') return next()
    const line = text.split('\n')[0].trim()

    // **第一件事先停表**：用户在本会话开口（哪怕只是一句普通讨论）就说明人还在，
    // 立刻撤掉本会话所有待决票据的催办定时器，别等他决定完再补一封多余邮件。
    cancelPendingEscalations(sessionId)

    const slash = SLASH_RE.exec(line)
    const explicit = slash === null ? EXPLICIT_RE.exec(line) : null
    const bare = slash === null && explicit === null ? BARE_RE.exec(line) : null

    const cwd = String(agent.session?.header?.cwd ?? '')
    const gateCandidates = sessionId === ''
      ? []
      : listAllGateCandidates(cwd)
    const trips = typeof breaker?.listTrips === 'function' ? breaker.listTrips() : []

    // 门禁/熔断都没有待决项：这不是遥控，交回后续链路。
    if (gateCandidates.length === 0 && trips.length === 0) return next()

    // 只有熔断：保持原语义（`1/2/3` + `#项目名` 由 circuit-breaker 处理）。
    if (gateCandidates.length === 0) return next()

    let ticket
    let token
    let note = ''

    if (slash !== null) {
      ticket = tickets.find(slash[2], cwd)
      const verb = slash[1].toLowerCase()
      token = verb === 'doc' || verb === 'docs' ? 'doc' : (slash[3] ?? (verb === 'skip' ? '2' : '1'))
      note = String(slash[4] ?? '').trim()
    } else if (explicit !== null) {
      ticket = tickets.find(explicit[1], cwd)
      token = explicit[2].toLowerCase()
      note = String(explicit[3] ?? '').trim()
    } else if (bare !== null) {
      token = bare[1].toLowerCase()
      note = String(bare[2] ?? '').trim()
      if (gateCandidates.length + trips.length > 1) {
        // 歧义：什么都不做，只回指引。宁可多打几个字，也不许误触发。
        const lines = [
          gateCandidates.length === 0 ? '' : `门禁：${gateCandidates.map(item => `#${item.id}（${item.project}）`).join(' ')}`,
          trips.length === 0 ? '' : `熔断：${trips.map(item => `#${item.project}`).join(' ')}`,
        ].filter(Boolean)
        await reply(
          `[Flow] 现在有多条待决，裸数字有歧义，本次**未执行**任何动作。\n${lines.join('\n')}\n请带票据号回复，例如：\`#${gateCandidates[0]?.id ?? 't0000'} 1\`。`,
          'Flow 遥控',
        )
        diag(`gate router ambiguous gates=${gateCandidates.length} trips=${trips.length} token=${token}`)
        return { kind: 'reject' }
      }
      ticket = gateCandidates[0]
    } else {
      return next()
    }

    if (ticket === undefined) {
      await reply(`[Flow] 没找到票据 #${String(slash?.[2] ?? explicit?.[1] ?? '')}，可能已结算或不属于本机。`, 'Flow 遥控')
      return { kind: 'reject' }
    }

    // 桌面会话里裸令牌不接管，避免吞掉正常对话。
    const fromIm = ticket.sessionId !== sessionId
    const explicitHit = explicit !== null || slash !== null
    if (!fromIm && !explicitHit) return next()

    // 人还在：桌面在敲字、微信在回话，先把它那侧的催办停掉，别事后再补一封。
    cancelPendingEscalations(ticket.sessionId)

    if (GATE_FINAL_STATES.includes(ticket.state)) {
      // 桌面这边已结算就直接放行，别把用户的正常提问也吃掉。
      if (!fromIm) return next()
      await reply(`[Flow] 票据 #${ticket.id} 已经结算过（${ticket.state}），无需重复回复。`, 'Flow 遥控')
      return { kind: 'reject' }
    }

    const template = Array.isArray(payload.messages) ? payload.messages[0] : undefined

    if (token === 'doc' || token === '0') {
      const digest = buildDigest(ticket)
      if (fromIm) {
        await reply(digest, 'Flow 文档')
        return { kind: 'reject' }
      }
      const injected = injectText({
        ticket,
        template,
        text: `[Flow 文档 #${ticket.id}｜用户要看的摘要]\n${digest}\n\n请把上面的摘要**原样**展示给用户，然后等他继续。`,
      })
      return injected.ok === true ? { kind: 'reject' } : next()
    }

    const picked = actionOfToken(ticket, token)
    if (picked.error !== undefined) {
      if (!fromIm) return next()
      await reply(`[Flow] ${picked.error}。可用：\n${formatImGate(ticket, { digestChars: 80 })}`, 'Flow 遥控')
      return { kind: 'reject' }
    }

    // 结算：**副作用（授权 / 切模式）由结算器统一执行**，路由只负责把决定送到。
    const settled = await settler.settle(ticket.id, {
      action: picked.action,
      by: fromIm ? 'im' : 'desktop',
      note,
    })
    if (settled.ok !== true && settled.already !== true) {
      if (!fromIm) return next()
      await reply(`[Flow] ${settled.reason ?? '结算失败'}`, 'Flow 遥控')
      return { kind: 'reject' }
    }

    const forwarded = forwardDecision({
      ticket,
      action: picked.action,
      label: picked.label ?? picked.action,
      note,
      template,
      fromIm,
    })

    if (fromIm) {
      const effectText = describeEffects(settled.effects)
      await reply(
        [
          `[Flow 已收到 #${ticket.id}] ${picked.label ?? picked.action}`,
          effectText,
          forwarded.ok === true
            ? `已转给桌面会话「${ticket.project}」。`
            : `但转交失败：${forwarded.reason ?? '未知原因'}，请回电脑端处理。`,
          note === '' ? '' : `附带指令已原样转达：${note}`,
        ].filter(line => line !== '').join('\n'),
        'Flow 门禁',
      )
      diag(`gate router im ticket=${ticket.id} action=${picked.action} forwarded=${forwarded.ok === true}`)
      return { kind: 'reject' }
    }

    // 桌面：决定已落，把干净的指令重新注入本会话；注入失败就放行原消息，绝不制造空回合。
    diag(`gate router desktop ticket=${ticket.id} action=${picked.action} forwarded=${forwarded.ok === true}`)
    return forwarded.ok === true ? { kind: 'reject' } : next()
  }

  /** 把结算产生的副作用翻译成一句人话，回给手机端。 */
  function describeEffects(effects) {
    if (effects === undefined || effects === null) return ''
    const lines = []
    if (effects.scope === 'once') lines.push('已落权：仅本次允许写入。')
    else if (effects.scope === 'session-docs') lines.push('已落权：本会话可写 .flow/docs。')
    else if (effects.scope === 'deny') lines.push('已记录：拒绝写入文档。')
    if (effects.mode !== undefined) {
      lines.push(effects.mode.applied === true
        ? `已切到 ${effects.mode.label ?? effects.mode.mode}。`
        : `模式未切换：${effects.mode.reason ?? '未知原因'}。`)
    }
    return lines.join(' ')
  }

  /** 全部待决票据（跨会话：IM 会话要能指挥桌面会话，因此不按会话过滤）。 */
  function listAllGateCandidates() {
    return tickets.list().filter(item => (item.state === 'expired' ? item.hold === true : item.state === 'open'))
  }

  return { preStep, forwardDecision, injectText, buildDigest, sendDigest, reply, cancelPendingEscalations, listAllGateCandidates }
}
