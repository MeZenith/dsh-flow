/**
 * `/flow prompts list|update` 子命令。
 *
 * @module dsh-flow/commands/prompts
 */

export function formatPromptsList(store) {
  const info = store.info()
  const lines = []
  lines.push(`提示词目录：${info.root}`)
  lines.push(`版本：${info.version}${info.updatedAt !== '' ? `（${info.updatedAt}）` : ''}｜清单条目 ${info.fileCount} 个`)
  lines.push(`底座契约来源：${info.base.label}${info.base.exists ? '' : '（文件缺失，已回落兜底）'}`)
  lines.push('', '五大模式来源：')
  for (const item of info.modes) {
    lines.push(`- ${item.id}：${item.label}${item.exists ? '' : '（md 缺失，已回落）'}`)
  }
  lines.push('', '官方特种兵：')
  for (const item of info.official) {
    const suffix = item.overridden ? '（已自定义覆盖）' : (item.exists ? '' : '（缺失）')
    lines.push(`- ${item.name}：${item.title || '（无标题）'}${suffix}`)
  }
  lines.push('', `私有特种兵（${info.custom.length} 个）：`)
  if (info.custom.length === 0) {
    lines.push(`- 暂无。把 .md 放进 ${info.customDir} 即可，一键更新不会碰它。`)
  } else {
    for (const item of info.custom) lines.push(`- ${item.name}：${item.title || '（无标题）'}`)
  }
  lines.push('', '更新：`/flow prompts update` 拉远端最新版（不覆盖私有目录，也不改你的手改覆盖）')
  return lines.join('\n')
}

export async function handlePromptsCommand({ rawArg, signal, prompts }) {
  if (prompts?.store === undefined) {
    return { kind: 'error', text: '提示词仓库未装配，无法处理 prompts 子命令。' }
  }
  const sub = (String(rawArg ?? '').trim().split(/\s+/)[1] ?? 'list').toLowerCase()
  if (sub === 'update') {
    if (typeof prompts.update !== 'function') {
      return { kind: 'error', text: '更新器未装配。' }
    }
    const { result, text } = await prompts.update(signal)
    return { kind: result.ok === true ? 'success' : 'error', text }
  }
  return { kind: 'success', text: formatPromptsList(prompts.store) }
}
