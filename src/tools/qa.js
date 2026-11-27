/**
 * 工具 9：`flow_qa_handoff` — 双阶验收交接（06 → 07 简报 / 修复包 / 返工轮次 / qa 通知）。
 *
 * @module dsh-flow/tools/qa
 */
import { readDocText } from '../workflow/docs.js'
import {
  buildFixPackage, buildQaNotification, buildWhiteboxBrief, createReworkTracker, parseBlackbox, parseWhitebox,
} from '../workflow/qa-handoff.js'
import { outputOf, projectNameOf, rootGuard } from './common.js'

export const QA_HANDOFF_TOOL = 'flow_qa_handoff'

export function createQaHandoffTool({ getConfig, notifier, remoteHub, stateStore, reworkTracker }) {
  const rework = reworkTracker ?? createReworkTracker({ stateStore })

  return {
    name: QA_HANDOFF_TOOL,
    description: [
      '（双阶验收交接）把 06-blackbox-qa.md 的症状翻译成 07 的定因简报，或把 06+07 合成集中修复包；',
      '同时维护内部返工轮次（1–3 轮放行，第 4 轮硬拦并要求上报用户）。',
      'action=brief | package | round | notify | reset。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['brief', 'package', 'round', 'notify', 'reset'] },
        project: { type: 'string', description: '项目名（通知标题用），缺省取工作目录名。' },
      },
    },
    output: outputOf(QA_HANDOFF_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const agent = guard.agent
      const sessionId = String(agent.session?.id ?? '')
      const cwd = String(agent.session?.header?.cwd ?? '')
      const config = getConfig()
      const project = typeof args?.project === 'string' && args.project.trim() !== ''
        ? args.project.trim()
        : projectNameOf(cwd)
      const action = String(args?.action ?? '')

      if (action === 'round') {
        const state = rework.next(sessionId)
        if (state.blocked) {
          return {
            outcome: 'blocked',
            message: [
              `内部返工已到第 ${state.round} 轮，超过上限 ${state.max} 轮，硬拦。`,
              '请把「试过什么、报了哪些错、已排除什么、现在卡在哪」整理成一页交给用户裁决；',
              '不许再自行改代码，也不许把同一轮拆成两轮绕过计数。',
            ].join('\n'),
          }
        }
        return {
          outcome: 'ok',
          message: `第 ${state.round}/${state.max} 轮返工放行：改完只跑受影响路径的轻回归，然后重新交黑盒复验。`,
        }
      }
      if (action === 'reset') {
        rework.reset(sessionId)
        return { outcome: 'ok', message: '返工轮次已清零（请确保是用户裁决或新一轮任务，而不是为了绕过上限）。' }
      }

      const blackboxText = readDocText({ config, cwd, id: '06' })
      if (blackboxText.trim() === '') {
        return { outcome: 'blocked', message: '找不到 06-blackbox-qa.md：先让 qa-blackbox 产出报告，再来交接。' }
      }
      const whiteboxText = readDocText({ config, cwd, id: '07' })

      if (action === 'brief') {
        const parsed = parseBlackbox(blackboxText)
        const brief = buildWhiteboxBrief({
          project,
          bugs: parsed.bugs,
          manual: parsed.manual,
          source: '06-blackbox-qa.md',
        })
        return {
          outcome: 'ok',
          message: `已生成白盒任务简报（${parsed.bugs.length} 条 BUG / ${parsed.manual.length} 条人工点验）：\n\n${brief}`,
        }
      }

      if (action === 'package') {
        if (whiteboxText.trim() === '') {
          return { outcome: 'blocked', message: '找不到 07-whitebox-qa.md：先让 qa-whitebox 定因，再合并修复包。' }
        }
        const blackbox = parseBlackbox(blackboxText)
        const whitebox = parseWhitebox(whiteboxText)
        const pack = buildFixPackage({
          project,
          bugs: blackbox.bugs,
          roots: whitebox.roots,
          blackboxPath: '06-blackbox-qa.md',
          whiteboxPath: '07-whitebox-qa.md',
        })
        const state = rework.peek(sessionId)
        const head = state.allowed
          ? `修复包已生成（第 ${state.round}/${state.max} 轮之内，可继续）。`
          : `修复包已生成，但返工已用满 ${state.max} 轮：本轮修完必须上报用户裁决。`
        return {
          outcome: pack.missing.length > 0 ? 'partial' : 'ok',
          message: [
            head,
            `未定位：${pack.missing.length === 0 ? '无' : pack.missing.join(' ')}`,
            pack.blocked.length === 0 ? '🔴 Blocker：无' : `🔴 Blocker：${pack.blocked.join(' ')}`,
            '',
            pack.markdown,
          ].join('\n'),
        }
      }

      if (action === 'notify') {
        const payload = buildQaNotification({
          project,
          blackboxText,
          whiteboxText,
          blackboxName: '06-blackbox-qa.md',
          whiteboxName: '07-whitebox-qa.md',
        })
        const strategy = ['im-first', 'email-first', 'both', 'off'].includes(config?.notify?.qa)
          ? config.notify.qa
          : 'email-first'
        if (remoteHub !== undefined && payload.attachments.length > 0) {
          remoteHub.emit('docs:ready', { sessionId, project, cwd, attachments: payload.attachments })
        }
        let sent
        try {
          sent = await notifier?.sendNow?.('qa', {
            title: `Flow 验收报告 ${project}`,
            project,
            markdown: payload.markdown,
            attachments: payload.attachments,
            agent,
            session: agent.session,
            strategy,
          })
        } catch (error) {
          return { outcome: 'error', message: `qa 通知发送失败：${error instanceof Error ? error.message : String(error)}` }
        }
        const emailOk = sent?.email?.ok === true
        const imOk = sent?.im?.ok === true
        return {
          outcome: emailOk || imOk ? 'ok' : 'error',
          message: [
            `qa 通知：邮件${emailOk ? '✓' : '✗'} IM${imOk ? '✓' : '✗'}（策略 ${strategy}）`,
            `附件：${payload.attachments.map(item => item.filename).join('、') || '无'}`,
            emailOk ? '' : '邮件未发出时，正文里仍保留了 🔴 阻塞项与人工点验清单。',
          ].filter(line => line !== '').join('\n'),
        }
      }

      return { outcome: 'unavailable', message: `未知 action：「${action}」` }
    },
  }
}
