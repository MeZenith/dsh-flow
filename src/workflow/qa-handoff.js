/**
 * 双阶验收的交接层：06 症状 → 07 简报 → 修复任务包，外加返工轮次硬上限。
 *
 * @module dsh-flow/workflow/qa-handoff
 */

/** 内部返工硬上限：允许 1–3 轮，第 4 轮必须上报用户。 */
export const MAX_REWORK_ROUNDS = 3

/** 把 markdown 表格拆成「表头 + 行」。 */
function tablesOf(text) {
  const tables = []
  const lines = String(text ?? '').split('\n')
  let current = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      if (current !== null && current.rows.length > 0) tables.push(current)
      current = null
      continue
    }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.every(cell => /^:?-{2,}:?$/.test(cell) || cell === '')) continue
    if (current === null) {
      current = { header: cells, rows: [] }
      continue
    }
    if (cells.length === current.header.length || cells.length >= 3) current.rows.push(cells)
  }
  if (current !== null && current.rows.length > 0) tables.push(current)
  return tables
}

/** 按表头关键字找列下标。 */
function columnOf(header, keywords) {
  return header.findIndex(cell => keywords.some(keyword => cell.includes(keyword)))
}

/** 解析 `06-blackbox-qa.md`。 */
export function parseBlackbox(text) {
  const source = String(text ?? '')
  const bugs = []
  const manual = []

  for (const table of tablesOf(source)) {
    const idAt = columnOf(table.header, ['编号', 'ID'])
    if (idAt === -1) continue
    const symptomAt = columnOf(table.header, ['症状'])
    const reproAt = columnOf(table.header, ['复现'])
    const impactAt = columnOf(table.header, ['影响'])
    const severityAt = columnOf(table.header, ['严重', '级别'])
    const whereAt = columnOf(table.header, ['点哪里', '位置'])
    const expectAt = columnOf(table.header, ['期望'])
    const whyAt = columnOf(table.header, ['为什么'])

    if (symptomAt !== -1) {
      for (const row of table.rows) {
        const id = row[idAt] ?? ''
        if (!/BUG-\d+/i.test(id)) continue
        bugs.push({
          id: id.match(/BUG-\d+/i)[0].toUpperCase(),
          symptom: row[symptomAt] ?? '',
          repro: reproAt === -1 ? '' : row[reproAt] ?? '',
          impact: impactAt === -1 ? '' : row[impactAt] ?? '',
          severity: severityAt === -1 ? '' : row[severityAt] ?? '',
        })
      }
      continue
    }

    if (whereAt !== -1) {
      for (const row of table.rows) {
        const id = row[idAt] ?? ''
        if (id === '' || /^-+$/.test(id)) continue
        manual.push({
          id,
          where: row[whereAt] ?? '',
          expect: expectAt === -1 ? '' : row[expectAt] ?? '',
          why: whyAt === -1 ? '' : row[whyAt] ?? '',
        })
      }
    }
  }

  const conclusionMatch = source.match(/##\s*6[^\n]*\n+([^\n#]+)/)
  return { bugs, manual, conclusion: conclusionMatch?.[1]?.trim() ?? '' }
}

/** 解析 `07-whitebox-qa.md` 的根因表。 */
export function parseWhitebox(text) {
  const source = String(text ?? '')
  const roots = []
  for (const table of tablesOf(source)) {
    const bugAt = columnOf(table.header, ['BUG', '缺陷'])
    const locAt = columnOf(table.header, ['文件:行号', '定位', '行号'])
    if (bugAt === -1 || locAt === -1) continue
    const chainAt = columnOf(table.header, ['触发链'])
    const fixAt = columnOf(table.header, ['最小改动', '修复'])
    const regressionAt = columnOf(table.header, ['回归点', '回归'])
    for (const row of table.rows) {
      const bug = row[bugAt] ?? ''
      const location = row[locAt] ?? ''
      if (bug === '' && location === '') continue
      roots.push({
        bug: /BUG-\d+/i.test(bug) ? bug.match(/BUG-\d+/i)[0].toUpperCase() : bug,
        location,
        chain: chainAt === -1 ? '' : row[chainAt] ?? '',
        fix: fixAt === -1 ? '' : row[fixAt] ?? '',
        regression: regressionAt === -1 ? '' : row[regressionAt] ?? '',
      })
    }
  }
  const sections = ['安全审计', '并发', '孤儿模块', '联动遗漏']
    .filter(title => source.includes(title))
  return { roots, sections }
}

/** 给白盒的取证要求：每条 BUG 一条，写明要交什么证据。 */
export function buildWhiteboxBrief({ project = '本项目', bugs = [], manual = [], source = '06-blackbox-qa.md' } = {}) {
  const lines = [
    `# 白盒定因任务简报（${project}）`,
    '',
    `- 输入报告：\`${source}\``,
    `- 待定因缺陷：${bugs.length} 条｜待人工点验：${manual.length} 条`,
    '',
    '## 一、必须逐条定因的缺陷',
    '',
    '| BUG | 症状 | 复现 | 严重度 | 要交的证据 |',
    '|---|---|---|---|---|',
  ]
  for (const bug of bugs) {
    lines.push(`| ${bug.id} | ${bug.symptom} | ${bug.repro} | ${bug.severity} | \`文件:行号\` + 代码摘录 + 触发链 + 置信度 |`)
  }
  if (bugs.length === 0) lines.push('| — | （06 未报缺陷） | — | — | 说明为何无缺陷，仍要跑四项审计 |')
  lines.push('', '## 二、取证要求（硬）', '', '- 每条 `BUG-xx` 必须给 `文件:行号`；查不到就写「未定位 + 下一步取证手段」，不许编原因。',
    '- 四项附加审计必须逐项给「有 / 无 / 不适用」：安全（越权/注入/路径穿越/密钥泄漏）、并发与定时器释放、孤儿模块、联动遗漏。',
    '- 最小修复要具体到文件 + 位置 + 改法；回归点写清重跑哪几条用例。', '')
  if (manual.length > 0) {
    lines.push('## 三、待人工点验（不计入白盒定因，但要确认是否有代码侧关联）', '')
    for (const item of manual) lines.push(`- ${item.id}：${item.where} → ${item.expect}（机器测不了：${item.why}）`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 合并 06 症状 + 07 根因，生成交给施工方的集中修复包。 */
export function buildFixPackage({
  project = '本项目', bugs = [], roots = [], blackboxPath = '06-blackbox-qa.md', whiteboxPath = '07-whitebox-qa.md',
} = {}) {
  const map = new Map(roots.map(root => [root.bug, root]))
  const missing = bugs.filter(bug => !map.has(bug.id)).map(bug => bug.id)
  const blocked = bugs.filter(bug => /🔴|Blocker/i.test(bug.severity)).map(bug => bug.id)

  const lines = [
    `# 集中修复任务包（${project}）`,
    '',
    `- 症状来源：\`${blackboxPath}\`｜根因来源：\`${whiteboxPath}\``,
    `- 缺陷 ${bugs.length} 条｜已定位 ${bugs.length - missing.length} 条｜未定位 ${missing.length} 条`,
    blocked.length === 0 ? '- 🔴 Blocker：无' : `- 🔴 Blocker：${blocked.join(' ')}（优先修）`,
    '',
    '| BUG | 严重度 | 症状 | 定位 | 最小改动 | 回归点 |',
    '|---|---|---|---|---|---|',
  ]
  for (const bug of bugs) {
    const root = map.get(bug.id)
    lines.push(`| ${bug.id} | ${bug.severity} | ${bug.symptom} | ${root?.location || '未定位'} | ${root?.fix || '待补'} | ${root?.regression || `重跑 ${bug.id} 复现步骤`} |`)
  }
  lines.push('', '## 施工要求', '',
    '1. 只改上表「最小改动」涉及的代码；白名单外需求写进「越界联动上报清单」交大队长。',
    '2. 未定位的条目先按 07 的取证手段补证据，不许猜着改。',
    '3. 修完只跑「回归点」列的用例做轻回归，全量跑交给黑盒复验。',
    '')
  return { markdown: lines.join('\n'), missing, blocked }
}

/**
 * 返工轮次表：1–3 轮放行，第 4 轮硬拦（支持可选持久化 stateStore）。
 *
 * @param {{ max?: number, stateStore?: object }} [options]
 */
export function createReworkTracker({ max = MAX_REWORK_ROUNDS, stateStore } = {}) {
  const rounds = new Map()

  function read(key) {
    if (rounds.has(key)) return rounds.get(key)
    const persisted = stateStore?.getRework?.(key)
    if (typeof persisted === 'number' && persisted > 0) {
      rounds.set(key, persisted)
      return persisted
    }
    return 0
  }

  function peek(sessionId) {
    const current = read(String(sessionId ?? ''))
    return { round: current, allowed: current < max, max }
  }

  function next(sessionId) {
    const key = String(sessionId ?? '')
    const current = read(key) + 1
    rounds.set(key, current)
    stateStore?.setRework?.(key, current)
    const blocked = current > max
    return { round: current, allowed: !blocked, max, blocked }
  }

  function reset(sessionId) {
    const key = String(sessionId ?? '')
    rounds.delete(key)
    stateStore?.resetRework?.(key)
  }

  return { peek, next, reset, max }
}

/** 组 qa 通知：正文置顶 🔴 阻塞项与待人工点验清单，附件带 06/07 两份报告。 */
export function buildQaNotification({
  project = '本项目',
  blackboxText = '',
  whiteboxText = '',
  blackboxName = '06-blackbox-qa.md',
  whiteboxName = '07-whitebox-qa.md',
} = {}) {
  const blackbox = parseBlackbox(blackboxText)
  const whitebox = parseWhitebox(whiteboxText === '' ? '{}' : whiteboxText)
  const blockers = blackbox.bugs.filter(bug => /🔴|Blocker/i.test(bug.severity))

  const lines = [
    `## Flow 验收报告（${project}）`,
    '',
    `- 缺陷：${blackbox.bugs.length} 条（🔴 ${blockers.length}）｜待人工点验：${blackbox.manual.length} 项`,
    `- 白盒根因：${whitebox.roots.length} 条`,
    '',
    '## 🔴 阻塞项（优先处理）',
    '',
  ]
  if (blockers.length === 0) lines.push('- 无 Blocker')
  else for (const bug of blockers) lines.push(`- ${bug.id}：${bug.symptom}（复现：${bug.repro || '见附件'}）`)

  lines.push('', '## 待人工点验清单', '')
  if (blackbox.manual.length === 0) lines.push('- 无（或黑盒未列出，需确认原因）')
  else for (const item of blackbox.manual) lines.push(`- ${item.id}：${item.where} → ${item.expect}`)

  lines.push('', '## 附件', '', `- ${blackboxName}`, `- ${whiteboxName}`, '',
    '正文只放阻塞项与人工点验；完整表格见附件。')

  const attachments = []
  if (blackboxText.trim() !== '') {
    attachments.push({ filename: blackboxName, content: Buffer.from(blackboxText, 'utf8'), contentType: 'text/markdown; charset=UTF-8' })
  }
  if (whiteboxText.trim() !== '') {
    attachments.push({ filename: whiteboxName, content: Buffer.from(whiteboxText, 'utf8'), contentType: 'text/markdown; charset=UTF-8' })
  }
  return { markdown: lines.join('\n'), attachments }
}
