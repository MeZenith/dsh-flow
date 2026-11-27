/**
 * 公共消息文本与项目名解析工具。
 *
 * 独立于熔断与门禁模块，彻底消除 gate-router → circuit-breaker 的反向依赖；
 * 同步剥离 dsh-im 注入的全部四类标签（source / source_guidance / reply_to / context），
 * 修复手机端引用回复或开启上下文增强后指令无法识别的故障。
 *
 * @module dsh-flow/shared/message
 */
import { basename } from 'node:path'

/** 从一条 UserMessage 里抽纯文本。 */
export function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * 剥离 dsh-im 注入的全部 4 类前缀/上下文包裹块，只留用户真实文本。
 *
 * 覆盖：
 * - `<dsh_im_source>…</dsh_im_source>`
 * - `<dsh_im_source_guidance>…</dsh_im_source_guidance>`
 * - `<dsh_im_reply_to>…</dsh_im_reply_to>`
 * - `<dsh_im_context>…</dsh_im_context>`
 *
 * @param {string} text
 * @returns {string}
 */
export function stripImTags(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text
    .replace(/<(dsh_im_source|dsh_im_source_guidance|dsh_im_reply_to|dsh_im_context)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:dsh_im_source|dsh_im_source_guidance|dsh_im_reply_to|dsh_im_context)\b[\s\S]*$/i, ' ')
    .trim()
}

/** 向后兼容别名。 */
export const stripImSource = stripImTags

/**
 * 从消息数组里抽取“真正的用户正文”（跳过 dsh-im 拆分出来的 plugin:dsh-im 通知块）。
 *
 * @param {object[]} messages
 * @returns {string}
 */
export function userTextOfMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  const texts = []
  for (const message of list) {
    if (message?.source?.kind === 'plugin:dsh-im' || message?.source?.form === 'notice' || message?.source?.form === 'instructions') {
      continue
    }
    const cleaned = stripImTags(textOfMessage(message))
    if (cleaned !== '') texts.push(cleaned)
  }
  if (texts.length > 0) return texts.join('\n').trim()
  return stripImTags(list.map(textOfMessage).join('\n')).trim()
}

/** 从 cwd 提取可读项目名。 */
export function projectNameOfCwd(cwd, fallback = '未命名工作区') {
  const clean = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (clean === '') return fallback
  return basename(clean) || fallback
}

/**
 * 从插件上下文推断项目名；优先指定 sessionId，其次任一活跃非子代理会话，最后退回 process.cwd()。
 *
 * @param {object} ctx
 * @param {string} [preferredSessionId]
 * @returns {string}
 */
export function projectNameOfContext(ctx, preferredSessionId = '') {
  try {
    const list = typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : []
    if (preferredSessionId !== '') {
      const hit = list.find(agent => String(agent?.session?.id ?? '') === preferredSessionId)
      const hitCwd = hit?.session?.header?.cwd
      if (typeof hitCwd === 'string' && hitCwd !== '') return projectNameOfCwd(hitCwd)
    }
    const rootAgent = list.find(agent => agent?.session?.header?.origin !== 'subagent' && typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd !== '')
    if (rootAgent !== undefined) return projectNameOfCwd(rootAgent.session.header.cwd)
    for (const agent of list) {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return projectNameOfCwd(cwd)
    }
  } catch { /* 注册表不可读时退回 cwd */ }
  const cwd = typeof process.cwd === 'function' ? process.cwd() : ''
  return projectNameOfCwd(cwd, 'dsh-flow')
}
