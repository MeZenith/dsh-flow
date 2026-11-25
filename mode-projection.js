/**
 * `flowMode` 会话投影：把 `/flow <mode>` 命令的日志折叠成前端可读的当前模式。
 *
 * 为什么从 `command/run` 派生而不是自造事件：`Session.append()` 无法给事件打
 * `ignorable: true`，自造类型会让会话重新打开失败；而 `command/run` 是既有事件、
 * log-only（不进模型上下文、不包 turn），且携带 `args`。详见 docs/flow-api-research.md。
 *
 * 关键实现细节：
 * 1. `apply()` 对无关事件必须返回**同一个引用**，否则每个事件都会触发下游比较与重绘。
 * 2. `wire.view()` 是对象返回值，必须按 state 引用缓存，否则 `Object.is` 永远不相等，
 *    客户端会被每个事件刷一次（session-projection 的发布门就是 `Object.is`）。
 * 3. `stateSchema` / `viewSchema` 在运行时只被调用 `.parse()`，因此这里给的是
 *    结构兼容的容错解析器，不引入 zod 依赖；**永不抛错**，坏数据一律回落默认值。
 *
 * @module dsh-flow/mode-projection
 */
import { MODE_CHOICES, MODE_OFF, parseModeArg } from './modes.js'

/** 投影 key；Client 侧以同一字符串调用 `useProjection('flowMode')`。 */
export const PROJECTION_KEY = 'flowMode'

/** 空日志的初始态。 */
export function initialModeState() {
  return { mode: MODE_OFF, at: 0 }
}

/** 容错解析：任何畸形输入都退化为 off，绝不抛错。 */
function parseState(value) {
  if (value !== null && typeof value === 'object') {
    const mode = value.mode
    if (typeof mode === 'string' && MODE_CHOICES.includes(mode)) {
      const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0
      return { mode, at }
    }
  }
  return initialModeState()
}

/**
 * 一个事件的模式折叠。无关事件返回原引用。
 * @param {{ mode: string, at: number }} state
 * @param {object} event 已提交的 session 事件。
 * @returns {{ mode: string, at: number }}
 */
export function applyModeEvent(state, event) {
  if (event === null || typeof event !== 'object') return state
  if (event.type !== 'command/run') return state
  const data = event.data
  if (data === null || typeof data !== 'object') return state
  if (data.name !== 'flow') return state

  // 只认合法模式；`status` / `list` / 拼写错误一律忽略（不改变当前模式）。
  const mode = parseModeArg(typeof data.args === 'string' ? data.args : '')
  if (mode === null) return state
  if (state.mode === mode) return state

  const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : state.at
  return { mode, at }
}

/**
 * 构造投影定义。`view` 按 state 引用缓存，保证未变化时引用稳定。
 * @returns {object} 可直接交给 `ctx.sessionProjections.register()` 的定义。
 */
export function createModeProjection() {
  let cachedState = null
  let cachedView = null

  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: { parse: parseState },
    init: initialModeState,
    apply: applyModeEvent,
    wire: {
      viewSchema: { parse: parseState },
      view(state) {
        if (state === cachedState) return cachedView
        cachedState = state
        cachedView = { mode: state.mode }
        return cachedView
      },
      // 不进 Session 摘要：避免每一行会话列表都背上本插件的数据。
      summary: false,
    },
  }
}

/**
 * 读取某个会话的当前模式，任何异常都退化为 off。
 * @param {{ stateOf(session: object): { mode: string } }} handle 投影句柄。
 * @param {object} session
 * @returns {string}
 */
export function modeOfSession(handle, session) {
  try {
    const state = handle.stateOf(session)
    const mode = state?.mode
    return typeof mode === 'string' && MODE_CHOICES.includes(mode) ? mode : MODE_OFF
  } catch {
    return MODE_OFF
  }
}
