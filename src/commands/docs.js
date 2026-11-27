/**
 * `/flow docs …` 与 `/flow spec` 子命令。
 *
 * v0.6.0 修复：读取当前会话真实等级 `levelOfSession`（含一票升降级记忆），不再只看静态配置。
 *
 * @module dsh-flow/commands/docs
 */
import { normalizeDocId } from '../config/constants.js'
import { inspectSpec } from '../modes/spec-anchor.js'
import { checkDocs, docTitle, ensureDocs } from '../workflow/docs.js'
import { levelDef, levelOfSession } from '../workflow/level.js'

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function handleDocsCommand({ agent, rawArg, config, stateStore }) {
  const cwd = String(agent.session?.header?.cwd ?? '')
  const sessionId = String(agent.session?.id ?? '')
  const parts = String(rawArg ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[1] ?? 'list').toLowerCase()
  const level = levelOfSession(config, sessionId, undefined, stateStore)
  const ids = levelDef(level).docs

  if (sub === 'init') {
    const result = ensureDocs({ config, cwd, ids })
    return {
      kind: result.errors.length === 0 ? 'success' : 'error',
      text: [
        result.created.length === 0 ? '新建：无' : `新建：${result.created.join(' ')}`,
        result.skipped.length === 0 ? '已存在：无' : `已存在跳过：${result.skipped.join(' ')}`,
        result.errors.length === 0 ? '' : `失败：${result.errors.map(item => `${item.id}(${item.reason})`).join('；')}`,
      ].filter(Boolean).join('\n'),
    }
  }

  const wanted = parts[1] !== undefined && normalizeDocId(parts[1]) !== null ? [normalizeDocId(parts[1])] : ids
  if (wanted.length === 0) {
    return { kind: 'success', text: `当前会话等级为 ${level}，无需编号文档。` }
  }
  const checked = checkDocs({ config, cwd, ids: wanted, level })
  const lines = checked.items.map(item => (item.ok
    ? `✓ ${item.id} ${docTitle(item.id)}（${item.bytes} B）`
    : `✗ ${item.id} ${docTitle(item.id)}：${item.reasons.join('；')}`))
  lines.push('', checked.ok ? `全部就绪（等级 ${level}）。` : `还缺 ${checked.failed.join(' ')}。`)
  return { kind: checked.ok ? 'success' : 'error', text: lines.join('\n') }
}

export function handleSpecCommand({ agent, config }) {
  const spec = inspectSpec({ agent, config })
  if (!spec.enabled) {
    return { kind: 'success', text: `方案锚点已关闭（设置里 spec.enabled = false）。路径：${spec.display}` }
  }
  if (!spec.exists) {
    return { kind: 'success', text: `方案锚点：${spec.display} 尚未创建。` }
  }
  const mark = spec.fromMarkedBlock ? '来自 <!-- flow:summary --> 摘要块' : '取自正文前段'
  const preview = spec.summary.split('\n').slice(0, 6).join('\n')
  return {
    kind: 'success',
    text: [`方案锚点：${spec.display}（${formatBytes(spec.bytes)}），摘要${mark}：`, preview].join('\n'),
  }
}
