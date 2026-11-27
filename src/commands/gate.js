/**
 * `/flow gate …` 子命令：列出票据、结算并唤醒会话、看文档/草稿摘要、精准解除 hold。
 *
 * v0.6.0 修复：
 * - 保留附带意见原始大小写与空格，不再整串 `.toLowerCase()`；
 * - `/flow gate answer` / `skip` 结算后主动调用 `gateRouter.forwardDecision` 唤醒桌面会话；
 * - `/flow gate release <id>` 仅解除指定票据的 hold；传 `all` 或不传 id 时才解除本会话全部 hold；
 * - `/flow gate doc <id>` 复用 `gateRouter.buildDigest(ticket)`，无磁盘文件时回退展示内存草稿。
 *
 * @module dsh-flow/commands/gate
 */
import { digestOf } from '../workflow/docs.js'

/**
 * 处理 `/flow gate …`。
 *
 * @param {{ agent: object, rawArg: string, getConfig: () => object, tickets?: object, settler?: object, gateRouter?: object }} deps
 */
export async function handleGateCommand({ agent, rawArg, getConfig, tickets, settler, gateRouter }) {
  if (tickets === undefined) return { kind: 'error', text: '门禁票据未装配。' }
  const sessionId = String(agent.session?.id ?? '')
  const cwd = String(agent.session?.header?.cwd ?? '')
  const parts = String(rawArg ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[1] ?? 'list').toLowerCase()

  if (sub === 'list' || sub === '?') {
    tickets.ensureLoaded?.(cwd)
    const rows = tickets.list({ sessionId })
    if (rows.length === 0) return { kind: 'success', text: '当前会话没有门禁票据。' }
    const lines = rows.slice(0, 12).map((item) => {
      const mark = item.hold === true ? '⏸hold' : item.state
      const opts = item.options.map((option, index) => `${index + 1}=${option.label}`).join(' ')
      return `#${item.id}｜${mark}｜${item.kind}｜${item.project}｜${opts}`
    })
    lines.push('', '用法：/flow gate answer <id> <1|2|3> [意见]｜/flow gate skip <id>｜/flow gate doc <id>｜/flow gate release [id|all]')
    return { kind: 'success', text: lines.join('\n') }
  }

  if (sub === 'release') {
    tickets.ensureLoaded?.(cwd)
    const targetId = String(parts[2] ?? '').replace(/^#/, '').trim()
    if (targetId === '' || targetId.toLowerCase() === 'all') {
      const released = tickets.releaseHold(sessionId)
      return released > 0
        ? { kind: 'success', text: `已解除当前会话 ${released} 张票据的 hold，仍等你决定（不会自动推进）。` }
        : { kind: 'success', text: '当前会话没有处于 hold 的票据。' }
    }
    const ok = typeof tickets.releaseTicket === 'function'
      ? tickets.releaseTicket(targetId)
      : false
    return ok
      ? { kind: 'success', text: `已解除票据 #${targetId} 的 hold，仍等你决定（不会自动推进）。` }
      : { kind: 'error', text: `票据 #${targetId} 不存在或未处于 hold 状态。` }
  }

  const id = String(parts[2] ?? '').replace(/^#/, '').trim()
  const ticket = tickets.find(id, cwd)
  if (ticket === undefined) return { kind: 'error', text: `没找到票据 #${id || '(缺 id)'}。` }

  if (sub === 'doc' || sub === 'docs') {
    if (typeof gateRouter?.buildDigest === 'function') {
      return { kind: 'success', text: gateRouter.buildDigest(ticket) }
    }
    const ids = Array.isArray(ticket.docIds) ? ticket.docIds : []
    if (ids.length === 0) return { kind: 'success', text: `#${ticket.id} 没有关联文档。` }
    const maxChars = Number(getConfig()?.gate?.docDigestChars)
    const { text } = digestOf({
      config: getConfig(),
      cwd: ticket.cwd,
      ids,
      maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 800,
    })
    return { kind: 'success', text: `#${ticket.id} 文档摘要：\n${text}` }
  }

  if (sub !== 'answer' && sub !== 'skip') {
    return { kind: 'error', text: `未知 gate 子命令 "${sub}"。可用：list / answer / skip / doc / release` }
  }

  const token = sub === 'skip' ? '2' : String(parts[3] ?? '1')
  // 保留原始大小写和完整附带意见。
  const note = parts.slice(sub === 'skip' ? 3 : 4).join(' ').trim()
  const index = Number(token) - 1
  const option = Array.isArray(ticket.options) ? ticket.options[index] : undefined
  if (option === undefined) {
    const map = ticket.options.map((item, i) => `${i + 1}=${item.label}`).join(' ')
    return { kind: 'error', text: `#${ticket.id} 没有第 ${token} 个选项。可用：${map}` }
  }
  if (settler === undefined) {
    return { kind: 'error', text: '结算器未装配，无法执行门禁决定。' }
  }

  gateRouter?.cancelPendingEscalations?.(ticket.sessionId)
  const settled = await settler.settle(ticket.id, { action: option.action, by: 'cmd', note })
  if (settled.already === true) {
    return { kind: 'success', text: `票据 #${ticket.id} 已由其他端结算过，无需重复处理。` }
  }
  if (settled.ok !== true) {
    return { kind: 'error', text: settled.reason ?? '结算失败' }
  }

  // 结算后主动唤醒对应会话继续执行（修复旧版只打命令回执、模型不续跑的问题）。
  const forwarded = gateRouter?.forwardDecision?.({
    ticket: settled.ticket ?? ticket,
    action: option.action,
    label: option.label,
    note,
    fromIm: false,
    by: 'cmd',
  })

  const effect = settled.effects?.scope === 'once' || settled.effects?.scope === 'session-docs'
    ? '授权已生效'
    : settled.effects?.mode?.applied === true
      ? `已切到 ${settled.effects.mode.label ?? settled.effects.mode.mode}`
      : ''

  return {
    kind: 'success',
    text: [
      '[Flow 门禁决定·桌面命令]',
      `票据 #${ticket.id}｜选项：${option.label}（action=${option.action}）`,
      `附带指令（原样，来自用户）：${note === '' ? '（无）' : note}`,
      effect === '' ? '' : `状态：${effect}`,
      forwarded?.ok === true ? '已自动通知当前会话继续执行。' : '',
    ].filter(line => line !== '').join('\n'),
  }
}
