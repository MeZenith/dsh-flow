/**
 * Flow 工具公共辅助：根会话守卫、原生提问适配、输出格式、文档投递。
 *
 * @module dsh-flow/tools/common
 */
import { basename } from 'node:path'
import { normalizeDocId } from '../config/constants.js'
import { modeConfigOf } from '../modes/registry.js'
import { attachmentsOf, digestOf, docTitle } from '../workflow/docs.js'

const MAX_TIMEOUT_SECONDS = 86_400

/** 面向上层调用方的固定文案。 */
export const TOOL_MESSAGES = Object.freeze({
  noAgent: '这个工具必须在某个会话回合内调用（当前没有 agent 上下文）。',
  subagent: '子代理不能向用户发起审批：请把待确认的问题与结论交回父会话，由父会话调用本工具。',
  noQuestions: '当前组合没有 userQuestions 服务，无法弹出原生提问框。',
  noProvider: '当前没有可用的提问应答方（可能未连接 Web 或绑定的同步私聊）。',
  aborted: '提问已被取消，用户没有做出选择。',
  cancelled: '用户已关闭提问卡片（未做选择）。关闭不等于拒绝；需要继续请重新发起门禁。',
  notLive: '发起提问的会话已不是当前活动实例，无法等待用户答复。',
  replyQueued: '上一条答复还在等待投递，请稍后再问。',
  badIntent: '提问参数不符合原生意图校验，已放弃本次弹窗。',
  unknownAnswer: '用户的选择无法识别，请重新询问。',
  declined: '用户选择暂不执行，保持当前状态。',
  approved: '用户已同意切换。',
  revise: '用户要求继续调整当前阶段，本次不切换模式。',
  paused: '用户选择先暂停并由本人接管，本次不切换模式也不继续推进。',
  hold: [
    '【严格停手】门禁已超时，票据已登记并已发一次催办。',
    '现在**不要**推进任何阶段、**不要**改代码、**不要**继续写文档。',
    '你只回一句「已登记 #<票据号>，等你决定」，然后结束本回合。',
    '只有用户明确回复「跳过继续 / 同意 / 暂停」之后，才允许继续。',
  ].join('\n'),
})

/** 校验当前执行者是不是可提问的根会话。 */
export function rootGuard(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return { error: TOOL_MESSAGES.noAgent }
  if (agent.session?.header?.origin === 'subagent') return { error: TOOL_MESSAGES.subagent }
  return { agent }
}

/** 解析 `userQuestions` 服务（全局 → preset 隔离域 → agent 作用域，三级回落）。 */
export function resolveQuestions({ ctx, getUserQuestions, agent }) {
  let service
  try {
    service = typeof getUserQuestions === 'function' ? getUserQuestions() : ctx?.get?.('userQuestions')
  } catch {
    service = undefined
  }
  if (service !== undefined && typeof service.ask === 'function') return service
  try {
    const presets = ctx?.get?.('agentPresets')
    const fromPreset = typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'userQuestions') : undefined
    if (typeof fromPreset?.ask === 'function') return fromPreset
  } catch { /* 继续回落 */ }
  try {
    const local = agent?.ctx?.get?.('userQuestions')
    if (typeof local?.ask === 'function') return local
  } catch { /* 忽略 */ }
  return undefined
}

/** 把提问异常折算成结构化结果。 */
export function describeAskError(error) {
  const code = error !== null && typeof error === 'object' ? String(error.code ?? error.name ?? '') : ''
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ASK_ABORTED':
    case 'ASK_CANCELLED':
    case 'CANCELLED':
      return { via: 'aborted', text: TOOL_MESSAGES.cancelled }
    case 'ASK_TIMED_OUT': return { via: 'timeout' }
    case 'DELEGATED_CALLER': return { via: 'error', text: TOOL_MESSAGES.subagent }
    case 'CALLER_NOT_LIVE': return { via: 'error', text: TOOL_MESSAGES.notLive }
    case 'NO_PROVIDER': return { via: 'error', text: TOOL_MESSAGES.noProvider }
    case 'REPLY_QUEUED': return { via: 'error', text: TOOL_MESSAGES.replyQueued }
    case 'BAD_INTENT': return { via: 'error', text: TOOL_MESSAGES.badIntent }
    default: {
      if (/cancel(led)?\b|dismiss|closed by (the )?user|用户取消/i.test(message)) {
        return { via: 'aborted', text: TOOL_MESSAGES.cancelled }
      }
      if (/no provider|no answerer/i.test(message)) return { via: 'error', text: TOOL_MESSAGES.noProvider }
      return { via: 'error', text: `提问失败（${message}）` }
    }
  }
}

/** 发起一次同步原生提问。 */
export async function askQuestion({ ctx, getUserQuestions, questions, agent, signal }) {
  const service = resolveQuestions({ ctx, getUserQuestions, agent })
  if (service === undefined || typeof service.ask !== 'function') {
    return { via: 'error', text: TOOL_MESSAGES.noQuestions }
  }
  let value
  try {
    value = await service.ask({ questions, agent, signal })
  } catch (error) {
    return describeAskError(error)
  }
  const items = Array.isArray(value?.answers) ? value.answers : []
  const item = items.find(entry => entry?.id === questions[0]?.id) ?? items[0]
  const selected = Array.isArray(item?.selected) && item.selected.length > 0 ? item.selected[0] : undefined
  const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
  if (selected === undefined && custom === '') {
    return { via: 'error', text: TOOL_MESSAGES.unknownAnswer }
  }
  return { via: 'desktop', selected, custom }
}

/** 统一构造工具输出定义：模型可见文本 + 投影可见 meta。 */
export function outputOf(toolName) {
  return {
    schema: {
      type: 'object',
      required: ['outcome', 'message'],
      properties: {
        outcome: { type: 'string' },
        mode: { type: 'string' },
        compactScheduled: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      const text = typeof value?.message === 'string' ? value.message : ''
      return [{ type: 'text', text: text === '' ? '（无返回）' : text }]
    },
    presentationMeta(args, value) {
      const mode = typeof value?.mode === 'string' && value.mode !== '' ? value.mode : null
      return { flowTool: toolName, flowMode: mode }
    },
  }
}

export function projectNameOf(cwd) {
  const clean = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (clean === '') return '未命名工作区'
  return basename(clean) || '未命名工作区'
}

export function docIdsOf(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalizeDocId).filter(Boolean))].sort()
}

export function extrasOf(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item ?? '').trim())
    .filter(item => item !== '')
    .slice(0, 8)
}

export function timeoutOf(args, config) {
  const raw = Number(args?.timeoutSeconds)
  if (Number.isFinite(raw)) return Math.max(0, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(raw)))
  const fallback = Number(config?.gate?.timeoutSeconds)
  if (Number.isFinite(fallback)) return Math.max(0, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(fallback)))
  return 1800
}

export function targetLabelOf(config, nextMode) {
  if (nextMode === 'off') return '普通模式'
  if (nextMode === 'flow') return 'Flow 的下一阶段'
  return modeConfigOf(config, nextMode).label
}

export async function sendGateEmail(email, { project, markdown, attachments, event = 'gate' }) {
  if (typeof email?.send !== 'function') return { ok: false, via: 'email', reason: '邮箱渠道未装配' }
  try {
    return await email.send({ event, project, text: markdown, attachments })
  } catch (error) {
    return { ok: false, via: 'email', reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function sendIm(im, { title, markdown, sessionId, skipFeishu = false }) {
  if (typeof im?.send !== 'function') return { ok: false, via: 'im', reason: 'IM 渠道未装配' }
  try {
    return await im.send({ title, markdown, sessionId, skipFeishu })
  } catch (error) {
    return { ok: false, via: 'im', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 投递文档：支持 email（附件）、feishu（直接发文件+卡片）、im（摘要）或 both。 */
export async function deliverDoc({ config, cwd, project, sessionId, docIds, extras, to, note = '', email, im, remoteHub }) {
  const limit = Number(config?.email?.attachLimitBytes)
  const { attachments, skipped } = attachmentsOf({
    config,
    cwd,
    ids: docIds,
    extra: extras,
    limitBytes: Number.isFinite(limit) && limit > 0 ? limit : 2 * 1024 * 1024,
  })
  const maxChars = Number(config?.gate?.docDigestChars)
  const { text: digest } = digestOf({
    config,
    cwd,
    ids: docIds,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 800,
  })
  const result = { email: undefined, im: undefined, feishu: undefined, skipped }

  if (to === 'email' || to === 'both') {
    const markdown = [
      '## Flow 文档投递',
      '',
      `- 项目：${project}`,
      `- 文档：${docIds.map(id => `${id} ${docTitle(id)}`).join('、') || extras.join('、') || '附件'}`,
      note === '' ? '' : `- 附言：${note}`,
      '',
      '完整正文见附件。',
    ].filter(line => line !== '').join('\n')
    result.email = await sendGateEmail(email, { project, markdown, attachments, event: 'doc' })
  }

  if (to === 'feishu' || to === 'im' || to === 'both') {
    if (remoteHub !== undefined && attachments.length > 0) {
      remoteHub.emit('docs:ready', { sessionId, project, cwd, docIds, attachments, note })
      result.feishu = { ok: true, via: 'remoteHub', count: attachments.length }
    }
  }

  if (to === 'im' || to === 'both') {
    const header = `[Flow 文档] ${project}\n${docIds.map(id => `${id} ${docTitle(id)}`).join('、') || extras.join('、')}`
    const tail = result.email === undefined
      ? '（IM 摘要；如已连直连飞书，完整文件已直发）'
      : '（完整文档已发至邮箱附件）'
    result.im = await sendIm(im, {
      title: 'Flow 文档',
      sessionId,
      markdown: `${header}\n——\n${digest}\n——\n${tail}${note === '' ? '' : `\n附言：${note}`}`,
    })
  }

  return result
}
