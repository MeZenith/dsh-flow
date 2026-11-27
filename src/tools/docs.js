/**
 * 工具 3–6：编号文档骨架、校验、受控写入（D-01 默认直写）与按需投递。
 *
 * @module dsh-flow/tools/docs
 */
import { DOC_IDS, normalizeDocId } from '../config/constants.js'
import { levelDef, levelOfSession } from '../workflow/level.js'
import { checkDocs, ensureDocs, writeDoc } from '../workflow/docs.js'
import { deliverDoc, docIdsOf, outputOf, projectNameOf, rootGuard } from './common.js'

export const DOCS_INIT_TOOL = 'flow_docs_init'
export const DOCS_CHECK_TOOL = 'flow_docs_check'
export const DOCS_WRITE_TOOL = 'flow_docs_write'
export const SEND_DOC_TOOL = 'flow_send_doc'

export function createDocsTools({ getConfig, tickets, email, im, remoteHub, stateStore }) {
  const docsInitTool = {
    name: DOCS_INIT_TOOL,
    description: [
      '（文档骨架）在 .flow/docs 下按需要生成编号文档骨架（01–07），已存在的默认不覆盖。',
      '只写模板与元信息头，不含任何用户内容。生成后用 flow_docs_write 填正文，再用 flow_docs_check 自检。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '要生成的文档编号；缺省按当前等级生成整套。' },
        level: { type: 'string', enum: ['S', 'M', 'L'], description: '按哪个等级决定整套文档，缺省用会话等级。' },
        overwrite: { type: 'boolean', description: '是否覆盖已存在的文档（默认 false）。' },
      },
    },
    output: outputOf(DOCS_INIT_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      const sessionId = String(guard.agent.session?.id ?? '')
      const level = levelOfSession(config, sessionId, args?.level, stateStore)
      const ids = docIdsOf(args?.ids)
      const wanted = ids.length > 0 ? ids : levelDef(level).docs
      if (wanted.length === 0) {
        return { outcome: 'skipped', message: `等级 ${level} 不需要编号文档（S 级只做 1 轮交互确认）。` }
      }
      const result = ensureDocs({ config, cwd, ids: wanted, overwrite: args?.overwrite === true })
      const lines = [
        '文档目录：.flow/docs',
        result.created.length === 0 ? '新建：无' : `新建：${result.created.join(' ')}`,
        result.skipped.length === 0 ? '已存在跳过：无' : `已存在跳过：${result.skipped.join(' ')}`,
        result.errors.length === 0 ? '' : `失败：${result.errors.map(item => `${item.id}(${item.reason})`).join('；')}`,
        '下一步：flow_docs_write 写正文 → flow_docs_check 自检。',
      ].filter(line => line !== '')
      return { outcome: result.errors.length === 0 ? 'ok' : 'partial', message: lines.join('\n') }
    },
  }

  const docsCheckTool = {
    name: DOCS_CHECK_TOOL,
    description: '（文档自检）逐份校验文档是否存在、是否空壳、必填章节是否齐全，并给出整体结论。门禁前必须跑一次。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '要校验的编号；缺省按当前等级的全套文档。' },
        level: { type: 'string', enum: ['S', 'M', 'L'], description: '按哪个等级的严格度校验，缺省用会话等级。' },
      },
    },
    output: outputOf(DOCS_CHECK_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      const level = levelOfSession(config, String(guard.agent.session?.id ?? ''), args?.level, stateStore)
      const ids = docIdsOf(args?.ids)
      const wanted = ids.length > 0 ? ids : levelDef(level).docs
      if (wanted.length === 0) {
        return { outcome: 'skipped', message: `等级 ${level} 不需要编号文档。` }
      }
      const checked = checkDocs({ config, cwd, ids: wanted, level })
      const lines = checked.items.map(item => (item.ok
        ? `✓ ${item.id} ${item.title}（${item.bytes} B）`
        : `✗ ${item.id} ${item.title}：${item.reasons.join('；')}`))
      lines.push('', checked.ok ? `全部就绪（${level}）。` : `还缺 ${checked.failed.join(' ')}，补齐前门禁不放行。`)
      return { outcome: checked.ok ? 'ok' : 'blocked', message: lines.join('\n') }
    },
  }

  const docsWriteTool = {
    name: DOCS_WRITE_TOOL,
    description: [
      '（受控写文档）把正文写进 .flow/docs/<编号>-*.md、.flow/docs/preview/*.html 或 .flow/spec.md。',
      '路径白名单硬编码：只允许上述位置，业务代码永远写不到，因此只读规划会话也能直接安全落盘文档。',
      '默认 `docs.writePolicy=auto` 无需额外申请写授权，直接落盘后走阶段门禁交给用户审阅。',
      '若用户手动切回 `ask` 策略，未授权时返回 needs-permission，再走 `flow_stage_gate({kind:"permission"})`。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['content'],
      properties: {
        id: { type: 'string', enum: [...DOC_IDS], description: '文档编号（01–07）。' },
        target: { type: 'string', enum: ['doc', 'spec', 'preview'], description: '写入目标，默认 doc。' },
        name: { type: 'string', description: 'target=preview 时的文件名（小写字母/数字/短横线）。' },
        content: { type: 'string', description: '完整正文（markdown 或 html）。' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: '覆盖或追加，默认 overwrite。' },
        deliver: { type: 'string', enum: ['none', 'email', 'im', 'feishu', 'both'], description: '写完后是否立即投递，默认 none。' },
      },
    },
    output: outputOf(DOCS_WRITE_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const agent = guard.agent
      const sessionId = String(agent.session?.id ?? '')
      const cwd = String(agent.session?.header?.cwd ?? '')
      const target = args?.target === 'spec' || args?.target === 'preview' ? args.target : 'doc'
      const docId = normalizeDocId(args?.id)

      if (target === 'doc' && docId === null) {
        return { outcome: 'unavailable', message: 'target=doc 时必须给 id（01–07）。' }
      }

      const pendingHold = tickets?.holdOf?.(sessionId)
      if (pendingHold !== undefined && pendingHold !== null) {
        return {
          outcome: 'blocked',
          message: [
            `门禁 #${pendingHold.id} 处于待决挂起状态，不能写文档。`,
            `先让用户回复确认（桌面回 1/2/3、飞书点卡片按钮或 /flow gate answer ${pendingHold.id} 1），再继续。`,
          ].join('\n'),
        }
      }

      // D-01：默认策略为 'auto'（只读白名单 `.flow/docs/**` 与 `.flow/spec.md` 直接写盘）。
      const policy = config?.docs?.writePolicy === 'ask' ? 'ask' : 'auto'
      const allowed = tickets.canWrite(sessionId, {
        docId: target === 'doc' ? (docId ?? undefined) : undefined,
        policy,
        cwd,
      })
      if (allowed.ok !== true) {
        return {
          outcome: 'needs-permission',
          message: [
            `${allowed.reason}`,
            '下一步：调用 flow_stage_gate({ kind:"permission", docId:"<编号>", draftContent:"<正文>" }) 申请授权。',
          ].join('\n'),
        }
      }

      const written = writeDoc({
        config,
        cwd,
        target: target === 'doc' ? { kind: 'doc', id: docId } : { kind: target, name: args?.name },
        content: args?.content,
        mode: args?.mode === 'append' ? 'append' : 'overwrite',
      })
      if (written.ok !== true) return { outcome: 'error', message: `写入失败：${written.reason}` }

      if (allowed.scope === 'once') tickets.consumeOnce(sessionId)

      let deliveryNote = ''
      const deliver = args?.deliver
      if (deliver === 'email' || deliver === 'im' || deliver === 'feishu' || deliver === 'both') {
        const sent = await deliverDoc({
          config,
          cwd,
          project: projectNameOf(cwd),
          sessionId,
          docIds: docId === null ? [] : [docId],
          extras: target === 'preview' || target === 'spec' ? [written.path] : [],
          to: deliver,
          email,
          im,
          remoteHub,
        })
        const parts = []
        if (sent.email !== undefined) parts.push(`邮件${sent.email.ok === true ? '✓' : '✗'}`)
        if (sent.feishu !== undefined) parts.push(`飞书文件✓`)
        if (sent.im !== undefined) parts.push(`IM${sent.im.ok === true ? '✓' : '✗'}`)
        deliveryNote = parts.length === 0 ? '' : `\n投递：${parts.join(' · ')}`
      }

      return {
        outcome: 'ok',
        message: `已写入 ${written.path}（${written.bytes} B，授权 ${allowed.scope}）。${deliveryNote}`,
      }
    },
  }

  const sendDocTool = {
    name: SEND_DOC_TOOL,
    description: [
      '（按需投递文档）把已落盘的编号文档发给用户：',
      '`to=feishu` 通过飞书直连直接发送 `.md` 文件；`to=email` 走 SMTP 附件；`to=im` 发摘要；`both` 多通道同发。',
    ].join(''),
    parameters: {
      type: 'object',
      required: ['docIds'],
      properties: {
        docIds: { type: 'array', items: { type: 'string', enum: [...DOC_IDS] }, description: '要投递的文档编号。' },
        to: { type: 'string', enum: ['email', 'im', 'feishu', 'both'], description: '投递通道，默认 both。' },
        note: { type: 'string', maxLength: 300, description: '附言，会写进正文或摘要。' },
      },
    },
    output: outputOf(SEND_DOC_TOOL),
    async execute(args, exec) {
      const guard = rootGuard(exec)
      if (guard.error !== undefined) return { outcome: 'unavailable', message: guard.error }
      const config = getConfig()
      const cwd = String(guard.agent.session?.header?.cwd ?? '')
      const sessionId = String(guard.agent.session?.id ?? '')
      const ids = docIdsOf(args?.docIds)
      if (ids.length === 0) return { outcome: 'unavailable', message: '至少要给一个文档编号。' }
      const to = ['email', 'im', 'feishu', 'both'].includes(args?.to) ? args.to : 'both'
      const sent = await deliverDoc({
        config,
        cwd,
        project: projectNameOf(cwd),
        sessionId,
        docIds: ids,
        extras: [],
        to,
        note: typeof args?.note === 'string' ? args.note.trim() : '',
        email,
        im,
        remoteHub,
      })
      const parts = []
      if (sent.feishu !== undefined) parts.push(`飞书：已直发 ${sent.feishu.count} 份文件`)
      if (sent.email !== undefined) parts.push(`邮件：${sent.email.ok === true ? '已发出（带附件）' : `失败（${sent.email.reason ?? '未知'}）`}`)
      if (sent.im !== undefined) parts.push(`IM：${sent.im.ok === true ? '已发出（摘要）' : `失败（${sent.im.reason ?? '未知'}）`}`)
      if (Array.isArray(sent.skipped) && sent.skipped.length > 0) parts.push(`跳过：${sent.skipped.join('；')}`)
      const ok = sent.email?.ok === true || sent.im?.ok === true || sent.feishu?.ok === true
      return { outcome: ok ? 'ok' : 'error', message: parts.join('\n') || '未配置可用投递通道' }
    },
  }

  return [docsInitTool, docsCheckTool, docsWriteTool, sendDocTool]
}
