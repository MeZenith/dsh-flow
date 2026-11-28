/**
 * Client 常量、配置路径工具与公共 Hooks（由 scripts/build-client.mjs 拼装进 client.js）。
 *
 * @module dsh-flow/client/constants
 */
const MODE_OFF = 'off'
const MODE_IDS = ['plan', 'plan-ultra', 'build', 'review', 'flow']
const MODE_FALLBACK = {
  plan: { label: 'Plan', description: '读码调研与方案规划' },
  'plan-ultra': { label: 'Plan Ultra', description: '复杂需求多视角深度规划' },
  build: { label: 'Build', description: '按方案专注实现代码' },
  review: { label: 'Review', description: '独立审查改动与验收' },
  flow: { label: 'Flow', description: '全自动总控，按阶段推进' },
}
const PERMISSION_IDS = ['keep', 'read-only', 'workspace-write', 'danger-full-access']
const CONFIG_NS = 'flow'
const STYLE_ID = 'dsh-flow-apple-styles'

const CHIP_MENU_WIDTH = 264
const CHIP_MENU_ESTIMATE = 6 * 44
const SELECT_PANEL_WIDTH = 260
const SELECT_PANEL_ESTIMATE = 240
const PANEL_GAP = 6
const PANEL_MARGIN = 8
const TABS = ['modes', 'workflow', 'remote', 'prompts']

function ensureStyles() {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

function newId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* best-effort: 部分受限运行环境禁用 crypto.randomUUID，回落时间戳随机串 */ }
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readModeMeta(snapshot) {
  const modes = snapshot && typeof snapshot === 'object' ? snapshot.modes : undefined
  const meta = {}
  for (const id of MODE_IDS) {
    const fallback = MODE_FALLBACK[id]
    const configured = modes && typeof modes === 'object' ? modes[id] : undefined
    meta[id] = {
      label: typeof configured?.label === 'string' && configured.label !== '' ? configured.label : fallback.label,
      description: typeof configured?.description === 'string' && configured.description !== ''
        ? configured.description
        : fallback.description,
    }
  }
  return meta
}

function useConfigSnapshot(form) {
  const [snapshot, setSnapshot] = useState(() => {
    try { return form ? form.getSnapshot() : null } catch { return null }
  })

  useEffect(() => {
    if (!form) { setSnapshot(null); return undefined }
    let alive = true
    const publish = () => {
      if (!alive) return
      try { setSnapshot(form.getSnapshot()) } catch { /* 保留上一帧 */ }
    }
    publish()
    let off
    try { off = form.subscribe(publish) } catch { off = undefined }
    return () => {
      alive = false
      try { if (typeof off === 'function') off() } catch { /* dispose-path: 卸载阶段订阅句柄可能已由表单销毁 */ }
    }
  }, [form])

  return snapshot
}

function sessionFaceOf(appCtx, sessionId) {
  try {
    const sessions = appCtx.get('sessions')
    return sessions?.binding?.(sessionId)?.session
  } catch {
    return undefined
  }
}

function payloadOf(result) {
  if (result && typeof result === 'object' && 'ok' in result) {
    return result.ok === false ? undefined : result.value
  }
  return result
}

function errorOf(result, fallback) {
  const error = result && typeof result === 'object' ? result.error : undefined
  const message = error && typeof error.message === 'string' ? error.message : undefined
  return message ?? fallback
}

function pathKey(path) {
  return path.join('\u0000')
}

function readPathOf(source, path) {
  let cursor = source
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

function writePathOf(source, path, next) {
  const base = source !== null && typeof source === 'object' ? source : {}
  const [head, ...rest] = path
  const child = rest.length === 0 ? next : writePathOf(base[head], rest, next)
  return { ...base, [head]: child }
}

function withOverrides(base, table) {
  const keys = Object.keys(table)
  if (keys.length === 0) return base
  let merged = base
  for (const key of keys) {
    const path = key.split('\u0000')
    const optimistic = table[key]
    if (Object.is(readPathOf(base, path), optimistic)) continue
    merged = writePathOf(merged, path, optimistic)
  }
  return merged
}

async function apiCall(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined
      ? { accept: 'application/json' }
      : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch { payload = null }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.reason ?? payload?.error ?? `HTTP ${response.status}`)
  }
  return payload
}
