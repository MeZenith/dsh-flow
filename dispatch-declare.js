/**
 * 派单声明：探测宿主能力 + 校验「模式×特种兵」分工与文件白名单。
 *
 * === 它解决的两个真实问题 ===
 *
 * 1. **静默不派单**：Flow 总控嘴上说"我来拆"，实际一个子代理都没派。所以进入施工前
 *    必须先留下 `[调度声明]` 一行，门禁据此拦截 M/L 级（S 级单线程合法）。
 * 2. **越界改文件**：两个并发子代理的写域相交，谁先写谁后写全凭运气。
 *    这里在派单**之前**就把重叠挡掉，并把共享入口（`index.js` / `config.js` / `package.json` …）
 *    列为"只能大队长串行接线"，不参与并发分工。
 *
 * 探测一律"有就报、没有就说没有"：不硬编码 `flow-readonly` 这类可能不存在的预设名。
 *
 * @module dsh-flow/dispatch-declare
 */

/** 派单工具候选（按可靠性排序）。 */
export const DISPATCH_CANDIDATES = Object.freeze(['dsh_team_spawn', 'subagent', 'subagent_fork'])

/**
 * 共享入口：谁都要碰，**禁止**划给并发子代理。
 *
 * 这些文件一改就影响全局（插件装配、打包、提示词同步），并发写入必然互相覆盖。
 */
export const SHARED_ENTRIES = Object.freeze([
  'index.js',
  'config.js',
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

/** 把 glob 编译成正则（只支持 `*` 与 `**`，够用且不引入依赖）。 */
function globToRegex(glob) {
  const escaped = glob
    .split('')
    .map(char => ('\\^$+.()|{}[]'.includes(char) ? `\\${char}` : char))
    .join('')
  const body = escaped
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
  return new RegExp(`^${body}$`)
}

/** 取出 glob 里最长的字面前缀（用于判断两个模式是否有交集）。 */
function literalPrefix(glob) {
  const at = glob.search(/[*?[]/)
  const head = at === -1 ? glob : glob.slice(0, at)
  return head.replace(/\/+$/, '')
}

/**
 * 两段路径/glob 是否相交。
 *
 * 判定顺序：完全相等 → 父子前缀 → 通配展开后的前缀互相匹配。
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
  const hasGlob = /[*?[]/.test(a) || /[*?[]/.test(b)
  if (!hasGlob) return false
  const prefixA = literalPrefix(a)
  const prefixB = literalPrefix(b)
  if (prefixA !== '' && prefixB !== '' && (prefixA === prefixB || prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`))) {
    return true
  }
  try {
    if (globToRegex(a).test(prefixB) || globToRegex(b).test(prefixA)) return true
  } catch { /* 非法 glob：按不相交处理，由调用方另行报错 */ }
  return false
}

/** 该路径是否属于共享入口（含其子路径，例如 `prompts/manifest.json` 的父目录）。 */
export function isSharedEntry(path) {
  const target = normalizePath(path)
  if (target === '') return true
  return SHARED_ENTRIES.some(entry => target === entry || target.startsWith(`${entry}/`) || entry.startsWith(`${target}/`))
}

/**
 * 探测宿主能力。
 *
 * @param {{ get?: (name: string) => any, tools?: { get?: (name: string) => any } }} ctx 插件作用域。
 * @returns {Promise<{
 *   tools: string[],
 *   readOnly: { mode: 'preset'|'fallback'|'none', names: string[] },
 *   agentPresets: { names: string[], source: string },
 * }>}
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
      // 宿主真实接口：`agentPresets.list(): Promise<Array<{ id, name?, description?, order?, broken? }>>`
      // （`packages/preset/agent-preset-registry/src/index.ts:193`）。挂载失败的预设带 `broken`，
      // 派单时不能推荐它，否则成员一启动就报「never started」。
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
  } catch { /* 服务不存在或接口不兼容：保持 unavailable，绝不抛错 */ }

  return { tools, readOnly, agentPresets }
}

/**
 * 校验分工表：完整性、共享入口、白名单重叠。
 *
 * @param {{ assignments?: { who?: string, duty?: string, files?: string[] }[] }} input
 * @returns {{ ok: boolean, groups: { who: string, duty: string, files: string[] }[], errors: string[], conflict?: { left: object, right: object } }}
 */
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

/**
 * 标准声明行（格式固定，门禁与自检都按这一行匹配）。
 *
 * @param {{ tools: string[], readOnly: { mode: string }, groups: unknown[] }} input
 * @returns {string}
 */
export function formatDeclarationLine({ tools, readOnly, groups }) {
  const tool = tools.length > 0 ? tools[0] : 'none'
  const files = groups.reduce((sum, group) => sum + (group.files?.length ?? 0), 0)
  return `[调度声明] 派单工具=${tool}｜只读能力=${readOnly.mode}｜模式×特种兵=${groups.length}组｜白名单=${files}段`
}

/**
 * 判断这次门禁是否需要"先声明后进施工"。
 *
 * 三条进入施工的路径都要覆盖，不能因为换成 `nextMode:'flow'` 就放空：
 * 1. `nextMode:'build'` — 直接切 Build；
 * 2. `nextMode:'review'` — 从规划直接进审查（等于进施工）；
 * 3. `nextMode:'flow'` + `docIds` 含 `05` 或显式 `toStage:'build'` — Flow 总控推进到施工期。
 *
 * S 级单线程施工不拦截。
 *
 * @param {{ level?: string, kind?: string, nextMode?: string, fromStage?: string, docIds?: string[], toStage?: string }} input
 * @returns {boolean}
 */
export function requiresDeclaration({ level, kind = 'stage', nextMode = '', fromStage = '', docIds = [], toStage = '' } = {}) {
  if (String(level ?? '').toUpperCase() === 'S') return false
  if (kind !== 'stage') return false
  if (fromStage !== 'plan' && fromStage !== 'plan-ultra') return false
  // 只拦"进入施工"：直接切 Build、显式声明 toStage:'build'，或 Flow 总控拿 05 定稿进施工。
  // `review` 不拦 —— 施工期已声明过一次，进入验收不该强迫重填施工白名单。
  if (nextMode === 'build' || toStage === 'build') return true
  if (nextMode === 'flow') return (Array.isArray(docIds) ? docIds : []).includes('05')
  return false
}

/**
 * 一次完整的声明评估（工具与自检共用）。
 *
 * @param {{ ctx: object, assignments: object[], note?: string }} input
 * @returns {Promise<{ ok: boolean, errors: string[], conflict?: object, groups: object[], probe: object, line?: string, details: string[] }>}
 */
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

/** 会话级声明仓库（门禁据此拦截）。 */
export function createDispatchStore() {
  const bySession = new Map()
  return {
    remember(sessionId, data) {
      bySession.set(String(sessionId ?? ''), { ...data, at: Date.now() })
    },
    get(sessionId) {
      return bySession.get(String(sessionId ?? ''))
    },
    clear(sessionId) {
      bySession.delete(String(sessionId ?? ''))
    },
    get size() {
      return bySession.size
    },
  }
}
