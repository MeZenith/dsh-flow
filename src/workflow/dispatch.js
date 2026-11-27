/**
 * 派单声明：探测宿主能力 + 校验「模式×特种兵」分工与文件白名单。
 *
 * v0.6.0 改进：
 * - 修复 `pathsOverlap('src/*.js', 'src/*.ts')` 等同前缀不同后缀 glob 的误报（改用按段交集算法）；
 * - 共享入口表补充 `src/plugin.js`、`src/config/schema.js` 与 `client.js`；
 * - 支持可选持久化 `stateStore`，避免重启丢调度声明。
 *
 * @module dsh-flow/workflow/dispatch
 */

/** 派单工具候选（按可靠性排序）。 */
export const DISPATCH_CANDIDATES = Object.freeze(['dsh_team_spawn', 'subagent', 'subagent_fork'])

/**
 * 共享入口：谁都要碰，禁止划给并发子代理（由大队长串行接线）。
 */
export const SHARED_ENTRIES = Object.freeze([
  'index.js',
  'client.js',
  'config.js',
  'src/plugin.js',
  'src/config/schema.js',
  'package.json',
  'prompts/manifest.json',
  '.gitignore',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
])

/** 归一化路径：反斜杠转正斜杠、去掉开头的 `./`、去掉结尾 `/`。 */
export function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/** 单段 glob 编译为正则。 */
function segmentToRegex(segment) {
  const escaped = segment
    .split('')
    .map(char => ('\\^$+.()|{}[]'.includes(char) ? `\\${char}` : char))
    .join('')
  const body = escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${body}$`)
}

/** 判断两个单段模式（不含 `/`）是否能匹配到同一个文件名。 */
function segmentsOverlap(a, b) {
  if (a === b) return true
  const globA = /[*?[]/.test(a)
  const globB = /[*?[]/.test(b)
  if (!globA && !globB) return false
  if (globA && !globB) {
    try { return segmentToRegex(a).test(b) } catch { return false }
  }
  if (!globA && globB) {
    try { return segmentToRegex(b).test(a) } catch { return false }
  }
  // 两者都含通配符：同时检查固定前缀与固定后缀是否兼容（解决 `*.js` vs `*.ts` 误报）。
  const preA = a.slice(0, a.search(/[*?[]/))
  const preB = b.slice(0, b.search(/[*?[]/))
  if (preA !== '' && preB !== '' && !preA.startsWith(preB) && !preB.startsWith(preA)) {
    return false
  }
  const revA = a.split('').reverse().join('')
  const revB = b.split('').reverse().join('')
  const sufLenA = revA.search(/[*?[\]]/)
  const sufLenB = revB.search(/[*?[\]]/)
  const sufA = sufLenA === -1 ? a : a.slice(a.length - sufLenA)
  const sufB = sufLenB === -1 ? b : b.slice(b.length - sufLenB)
  if (sufA !== '' && sufB !== '' && !sufA.endsWith(sufB) && !sufB.endsWith(sufA)) {
    return false
  }
  return true
}

/**
 * 两段路径/glob 是否相交。
 *
 * 按路径段做记忆化交集判定：
 * - `src/a` 与 `src/a/b.js` → true（父子目录）；
 * - `src/*.js` 与 `src/a.js` → true；
 * - `src/*.js` 与 `src/*.ts` → false（后缀互斥）；
 * - `src/**` 与 `src/a/b.js` → true；
 * - `src/**\/*.js` 与 `src/**\/*.ts` → false。
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function pathsOverlap(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  if (a === '' || b === '') return true
  if (a === b) return true
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true

  const segsA = a.split('/').filter(Boolean)
  const segsB = b.split('/').filter(Boolean)
  const memo = new Map()

  function canContainSubpath(segs) {
    const last = segs[segs.length - 1] ?? ''
    if (last === '**') return true
    // 不含扩展名点号的末段按目录前缀看待（如 `src/modes`、`src/*`）。
    return !last.includes('.')
  }

  function match(i, j) {
    if (i === segsA.length && j === segsB.length) return true
    if (i === segsA.length) return canContainSubpath(segsA)
    if (j === segsB.length) return canContainSubpath(segsB)

    const key = `${i}:${j}`
    if (memo.has(key)) return memo.get(key)

    let ok = false
    const sa = segsA[i]
    const sb = segsB[j]
    if (sa === '**' && sb === '**') {
      ok = match(i + 1, j) || match(i, j + 1) || match(i + 1, j + 1)
    } else if (sa === '**') {
      ok = match(i + 1, j) || match(i, j + 1)
    } else if (sb === '**') {
      ok = match(i, j + 1) || match(i + 1, j)
    } else if (segmentsOverlap(sa, sb)) {
      ok = match(i + 1, j + 1)
    }
    memo.set(key, ok)
    return ok
  }

  return match(0, 0)
}

/** 该路径是否属于共享入口（含父子路径与通配重叠）。 */
export function isSharedEntry(path) {
  const target = normalizePath(path)
  if (target === '') return true
  return SHARED_ENTRIES.some(entry => target === entry || target.startsWith(`${entry}/`) || entry.startsWith(`${target}/`))
}

/**
 * 探测宿主能力。
 *
 * @param {{ get?: (name: string) => any, tools?: { get?: (name: string) => any } }} ctx
 */
export async function probeDispatchCapabilities(ctx) {
  const tools = []
  for (const name of DISPATCH_CANDIDATES) {
    try {
      if (ctx?.tools?.get?.(name) !== undefined) tools.push(name)
    } catch { /* 注册表不可读：按不可用处理 */ }
  }

  let presetNames = []
  let presetService
  try {
    presetService = ctx?.get?.('permissionPresets')
    if (Array.isArray(presetService?.names)) presetNames = presetService.names
  } catch { presetService = undefined }
  const readOnly = presetService === undefined
    ? { mode: 'none', names: [] }
    : { mode: presetNames.includes('read-only') ? 'preset' : 'fallback', names: presetNames }

  const agentPresets = { names: [], broken: [], source: 'unavailable' }
  try {
    const service = ctx?.get?.('agentPresets')
    if (service !== undefined) {
      let rows = []
      if (typeof service.list === 'function') {
        rows = await service.list()
      } else if (typeof service.catalog === 'function') {
        const catalog = await service.catalog()
        rows = Array.isArray(catalog) ? catalog : catalog?.presets ?? []
      } else if (Array.isArray(service.names)) {
        rows = service.names
      }
      const list = Array.isArray(rows) ? rows : []
      const usable = []
      const broken = []
      for (const row of list) {
        if (typeof row === 'string') { usable.push(row); continue }
        const id = row?.id ?? row?.name
        if (typeof id !== 'string' || id === '') continue
        if (row?.broken !== undefined) broken.push(id)
        else usable.push(id)
      }
      agentPresets.names = usable
      agentPresets.broken = broken
      agentPresets.source = list.length > 0 ? 'host' : 'empty'
    }
  } catch { /* 服务不存在或接口不兼容：保持 unavailable */ }

  return { tools, readOnly, agentPresets }
}

/** 校验分工表：完整性、共享入口、白名单重叠。 */
export function validateAssignments({ assignments } = {}) {
  const raw = Array.isArray(assignments) ? assignments : []
  const errors = []
  const groups = raw.map(item => ({
    who: String(item?.who ?? '').trim(),
    duty: String(item?.duty ?? '').trim(),
    files: (Array.isArray(item?.files) ? item.files : []).map(file => normalizePath(file)).filter(Boolean),
  }))

  if (groups.length === 0) errors.push('至少给一组分工（assignments 不能为空）')
  for (const group of groups) {
    if (group.who === '') errors.push('每组必须有 who（子代理角色名）')
    if (group.files.length === 0) errors.push(`「${group.who || '(未命名)'}」必须至少给一个 files 路径`)
  }

  const sharedHits = []
  for (const group of groups) {
    for (const file of group.files) {
      if (isSharedEntry(file)) sharedHits.push(`${group.who || '(未命名)'} → ${file}`)
    }
  }
  if (sharedHits.length > 0) {
    errors.push(`共享入口禁止划给并发子代理（由大队长串行接线）：${sharedHits.join('；')}`)
  }

  let conflict
  outer: for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      for (const left of groups[i].files) {
        for (const right of groups[j].files) {
          if (pathsOverlap(left, right)) {
            conflict = {
              left: { who: groups[i].who, path: left },
              right: { who: groups[j].who, path: right },
            }
            break outer
          }
        }
      }
    }
  }
  if (conflict !== undefined) {
    errors.push(`白名单重叠：${conflict.left.who} 的 ${conflict.left.path} 与 ${conflict.right.who} 的 ${conflict.right.path} 相交`)
  }

  return { ok: errors.length === 0, groups, errors, conflict }
}

/** 标准声明行（格式固定，门禁与自检都按这一行匹配）。 */
export function formatDeclarationLine({ tools, readOnly, groups }) {
  const tool = tools.length > 0 ? tools[0] : 'none'
  const files = groups.reduce((sum, group) => sum + (group.files?.length ?? 0), 0)
  return `[调度声明] 派单工具=${tool}｜只读能力=${readOnly.mode}｜模式×特种兵=${groups.length}组｜白名单=${files}段`
}

/** 判断这次门禁是否需要"先声明后进施工"。 */
export function requiresDeclaration({ level, kind = 'stage', nextMode = '', fromStage = '', docIds = [], toStage = '' } = {}) {
  if (String(level ?? '').toUpperCase() === 'S') return false
  if (kind !== 'stage') return false
  if (fromStage !== 'plan' && fromStage !== 'plan-ultra') return false
  if (nextMode === 'build' || toStage === 'build') return true
  if (nextMode === 'flow') return (Array.isArray(docIds) ? docIds : []).includes('05')
  return false
}

/** 一次完整的声明评估（工具与自检共用）。 */
export async function evaluateDeclaration({ ctx, assignments, note = '' }) {
  const checked = validateAssignments({ assignments })
  if (checked.ok !== true) {
    return { ok: false, errors: checked.errors, conflict: checked.conflict, groups: checked.groups, probe: undefined, details: [] }
  }
  const probe = await probeDispatchCapabilities(ctx)
  const line = formatDeclarationLine({ tools: probe.tools, readOnly: probe.readOnly, groups: checked.groups })
  const details = [
    line,
    `agentPreset 探测：${probe.agentPresets.names.length > 0 ? probe.agentPresets.names.join(' / ') : `未探测到（${probe.agentPresets.source}）→ 派单时省略该参数`}`,
    ...checked.groups.map((group, index) => `- 组 ${index + 1}：${group.who}${group.duty === '' ? '' : `（${group.duty}）`} → ${group.files.join('、')}`),
  ]
  if (probe.tools.length === 0) details.push('降级结论：无派单工具 → 本轮单线程施工，未派子代理（回执必须写明）。')
  if (probe.readOnly.mode !== 'preset') {
    details.push('降级结论：无 read-only preset → 不得派"只读审计员"；只读审计改为单兵自查，并在回执记「未做独立审计」。')
  }
  if (note !== '') details.push(`备注：${note}`)
  return { ok: true, errors: [], groups: checked.groups, probe, line, details }
}

/** 会话级声明仓库（支持可选持久化 stateStore）。 */
export function createDispatchStore({ stateStore } = {}) {
  const bySession = new Map()
  return {
    remember(sessionId, data) {
      const key = String(sessionId ?? '')
      const record = { ...data, at: Date.now() }
      bySession.set(key, record)
      stateStore?.setDispatch?.(key, record)
    },
    get(sessionId) {
      const key = String(sessionId ?? '')
      const local = bySession.get(key)
      if (local !== undefined) return local
      const persisted = stateStore?.getDispatch?.(key)
      if (persisted !== undefined) {
        bySession.set(key, persisted)
        return persisted
      }
      return undefined
    },
    clear(sessionId) {
      const key = String(sessionId ?? '')
      bySession.delete(key)
      stateStore?.clearDispatch?.(key)
    },
    get size() {
      return bySession.size
    },
  }
}
