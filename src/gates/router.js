/**
 * 跨会话门禁遥控：在 `agent/pre-step` 里统一承接桌面主会话与 IM 会话的门禁回复。
 *
 * v0.6.0 修复：
 * - B-05：支持桌面主会话直接回复裸 `1/2/3/0`（当本会话仅有 1 张未决门禁票且未熔断时），
 *   不再出现「界面承诺可回 1 但发了 1 没反应」；
 * - 完整保留多行附带意见，不再只截取首行；
 * - 严格要求数字后必须为空白或结尾，绝不误吞 `"1个问题"`、`"2条建议"` 等自然语言；
 * - `listAllGateCandidates(cwd)` 会调用 `tickets.ensureLoaded(cwd)`，避免重启后跨会话找不到旧票；
 * - 桌面同会话 `reject` 后优先使用 `followup` 启动新回合，确保不会死等；
 * - 复用 `src/shared/message.js` 的 `userTextOfMessages`，剥离全部 4 种 `dsh-im` 包裹标签。
 *
 * @module dsh-flow/gates/router
 */
import { userTextOfMessages } from '../shared/message.js'
import { GATE_FINAL_STATES, normalizeDocId } from '../config/constants.js'
import { digestOf, docFileName, readDocText } from '../workflow/docs.js'
import { formatImGate } from './tickets.js'

/** 显式票据：`#t3f9 1 附带意见`（支持多行意见）。 */
const EXPLICIT_RE = /^#([a-z0-9]{2,12})[ \t]+(1|2|3|0|doc)(?:\s+([\s\S]*))?$/i

/** 裸令牌：`1`、`2 修改意见`、`0`、`doc`（数字后必须跟空白或结尾，绝不误吞 `"1个问题"`）。 */
const BARE_RE = /^(1|2|3|0|doc)(?:\s+([\s\S]*))?$/i

/** 斜杠命令：`/flow gate answer t3f9 1 附带意见`。 */
const SLASH_RE = /^\/flow[ \t]+gate[ \t]+(answer|skip|doc|docs)[ \t]+#?([a-z0-9]{2,12})(?:[ \t]+(\d))?(?:\s+([\s\S]*))?$/i

function actionOfToken(ticket, token) {
  if (token === '0' || token === 'doc') return { action: 'doc' }
  const index = Number(token) - 1
  const option = Array.isArray(ticket.options) ? ticket.options[index] : undefined
  if (option === undefined) {
    return { error: `#${ticket.id} 没有第 ${token} 个选项（共 ${ticket.options.length} 个）` }
  }
  return { action: option.action, label: option.label }
}

/**
 * 创建遥控路由器。
 *
 * @param {{
 *   tickets: ReturnType<typeof import('./tickets.js').createGateTickets>,
 *   breaker?: { listTrips?: () => object[], isLocked?: (agent: object) => boolean },
 *   im?: { send?: Function },
 *   getConfig: () => object,
 *   resolveAgent: (sessionId: string) => object | undefined,
 *   settler: { settle: Function },
 *   logger?: { warn?: Function, info?: Function },
 *   diag?: (message: string) => void,
 * }} deps
 */
export function createGateRouter({ tickets, breaker, im, getConfig, resolveAgent, settler, logger, diag = () => {} }) {
  const warn = (message) => {
    try { logger?.warn?.(message) } catch { /* best-effort: 宿主 logger 异常时不阻断门禁路由 */ }
  }

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
   * 把纯文本注入目标会话。
   * - `preferFollowup=true`（同会话刚 reject 当前步，或外部飞书卡片回调唤醒空闲会话）：优先 `followup`；
   * - 否则优先 `steer`，异常时回退 `followup`。
   */
  function injectText({ ticket, text, template, preferFollowup = false }) {
    const target = resolveAgent(ticket.sessionId)
    if (target === undefined || target === null) {
      diag(`gate inject abort target missing session=${ticket.sessionId}`)
      return { ok: false, reason: '目标会话实例已失效（可能已重启）' }
    }
    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? `gate-${globalThis.crypto.randomUUID()}`
      : `gate-${Date.now().toString(36)}`
    const rawTemplate = template !== undefined && template !== null && typeof template === 'object'
      ? { ...template }
      : {}
    // P1-4 修复：DSH 宿主 `UserMessage.source` 必须为带字符串 `kind` 的对象。
    const normalizedSource = rawTemplate.source !== null
      && typeof rawTemplate.source === 'object'
      && typeof rawTemplate.source.kind === 'string'
      ? { ...rawTemplate.source }
      : { kind: 'user' }
    const message = { ...rawTemplate, id, role: 'user', source: normalizedSource, content: [{ type: 'text', text }] }

    const first = preferFollowup ? 'followup' : 'steer'
    const second = preferFollowup ? 'steer' : 'followup'
    try {
      if (typeof target[first] === 'function') {
        target[first](message)
      } else if (typeof target[second] === 'function') {
        target[second](message)
      } else {
        return { ok: false, reason: '目标会话不支持消息注入' }
      }
      diag(`gate inject ok target=${ticket.sessionId} via=${first} len=${text.length}`)
      return { ok: true }
    } catch (error) {
      try {
        if (typeof target[second] === 'function') {
          target[second](message)
          diag(`gate inject via ${second} target=${ticket.sessionId}`)
          return { ok: true }
        }
      } catch (secondError) {
        warn(`flow: 门禁消息注入失败 → ${secondError instanceof Error ? secondError.message : String(secondError)}`)
      }
      diag(`gate inject fail ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, reason: '注入失败' }
    }
  }

  /** 把决定（含附带文字原文）投递给目标会话。 */
  function forwardDecision({ ticket, action, label, note, template, fromIm, by }) {
    const verbatim = note === '' ? '（无）' : note
    const sourceTag = by === 'feishu'
      ? '·来自飞书卡片'
      : by === 'cmd'
        ? '·来自桌面命令'
        : fromIm ? '·来自 IM' : '·你已在桌面确认'
    const text = [
      `[Flow 门禁决定${sourceTag}]`,
      `票据 #${ticket.id}｜项目「${ticket.project}」`,
      `选项：${label}（action=${action}）`,
      '附带指令（原样，来自用户）：',
      verbatim,
      '要求：先落实附带指令，再按该选项对应的阶段动作推进；两者冲突时以附带指令为准，并说明你的取舍。',
    ].join('\n')
    return injectText({ ticket, text, template, preferFollowup: !fromIm || by === 'feishu' || by === 'cmd' })
  }

  /** 用户一旦在本会话开口，立刻撤掉该会话所有挂着的催办定时器。 */
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

  /** 构造文档/草稿摘要（草稿优先于磁盘旧骨架）。 */
  function buildDigest(ticket) {
    const ids = Array.isArray(ticket.docIds) ? ticket.docIds.map(normalizeDocId).filter(Boolean) : []
    const draft = typeof ticket.draftContent === 'string' ? ticket.draftContent.trim() : ''
    if (ids.length === 0 && draft === '') {
      return `#${ticket.id} 没有关联文档，也没有草稿可看。`
    }
    const maxCharsRaw = Number(getConfig()?.gate?.docDigestChars)
    const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? Math.floor(maxCharsRaw) : 800
    const clip = (text) => (text.length > maxChars ? `${text.slice(0, maxChars)}…（已截断，完整见桌面/飞书文件或邮箱附件）` : text)
    const config = getConfig()
    const header = []
    const blocks = []
    const draftId = normalizeDocId(ticket.draftId) ?? ''
    const draftShown = draft !== ''

    if (draftShown) {
      const name = draftId === '' ? 'draft.md' : docFileName(draftId).replace(/\.md$/i, '.draft.md')
      header.push(`${name}（未落盘草稿·待授权，优先展示）`)
      blocks.push(`【${name}｜未落盘草稿】\n${clip(draft)}`)
    }

    for (const id of ids) {
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

  async function sendDigest(ticket) {
    await reply(buildDigest(ticket), 'Flow 文档')
  }

  /** 全部待决票据（加载 cwd 持久化状态，避免重启后丢失）。 */
  function listAllGateCandidates(cwd) {
    if (typeof cwd === 'string' && cwd !== '') tickets.ensureLoaded?.(cwd)
    return tickets.list().filter(item => (item.state === 'expired' ? item.hold === true : item.state === 'open'))
  }

  async function preStep(payload, next) {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return next()
    if (agent.session?.header?.origin === 'subagent') return next()

    const sessionId = String(agent.session?.id ?? '')
    const text = userTextOfMessages(payload.messages)
    if (text === '') return next()

    cancelPendingEscalations(sessionId)

    const slash = SLASH_RE.exec(text)
    const explicit = slash === null ? EXPLICIT_RE.exec(text) : null
    const bare = slash === null && explicit === null ? BARE_RE.exec(text) : null

    const cwd = String(agent.session?.header?.cwd ?? '')
    const gateCandidates = sessionId === '' ? [] : listAllGateCandidates(cwd)
    const trips = typeof breaker?.listTrips === 'function' ? breaker.listTrips() : []

    if (gateCandidates.length === 0 && trips.length === 0) return next()
    if (gateCandidates.length === 0) return next()

    let ticket
    let token
    let note = ''
    const ownCandidates = gateCandidates.filter(item => item.sessionId === sessionId)

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

      // B-05 修复：桌面主会话如果只有本会话的 1 张待决票且本会话未处于熔断，直接允许裸回 1/2/3/0！
      const selfLocked = breaker?.isLocked?.(agent) === true
      if (ownCandidates.length === 1 && !selfLocked) {
        ticket = ownCandidates[0]
      } else if (ownCandidates.length === 0) {
        // 跨会话（IM 会话）遥控：只有全局唯一待决且无熔断歧义时才允许裸数字
        if (gateCandidates.length + trips.length > 1) {
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
        // 本会话同时有多张待决票或既熔断又有门禁：放行或要求带票据号，避免误操作。
        return next()
      }
    } else {
      return next()
    }

    if (ticket === undefined) {
      const explicitId = String(slash?.[2] ?? explicit?.[1] ?? '')
      if (ownCandidates.length === 0) {
        await reply(`[Flow] 没找到票据 #${explicitId}，可能已结算或不属于本机。`, 'Flow 遥控')
        return { kind: 'reject' }
      }
      return next()
    }

    const fromIm = ticket.sessionId !== sessionId
    cancelPendingEscalations(ticket.sessionId)

    if (GATE_FINAL_STATES.includes(ticket.state)) {
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
        preferFollowup: true,
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

    const settled = await settler.settle(ticket.id, {
      action: picked.action,
      by: fromIm ? 'im' : 'desktop',
      note,
    })
    if (settled.already === true) {
      if (fromIm) {
        await reply(`[Flow] 票据 #${ticket.id} 已由其他端结算过，无需重复操作。`, 'Flow 遥控')
      }
      diag(`gate router duplicate-skip ticket=${ticket.id} fromIm=${fromIm}`)
      return { kind: 'reject' }
    }
    if (settled.ok !== true) {
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
      by: fromIm ? 'im' : 'desktop',
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

    diag(`gate router desktop ticket=${ticket.id} action=${picked.action} forwarded=${forwarded.ok === true}`)
    return forwarded.ok === true ? { kind: 'reject' } : next()
  }

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

  return {
    preStep,
    forwardDecision,
    injectText,
    buildDigest,
    sendDigest,
    reply,
    cancelPendingEscalations,
    listAllGateCandidates,
    describeEffects,
  }
}
