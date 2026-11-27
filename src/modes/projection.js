/**
 * `flowMode` 会话投影：把 `/flow <mode>` 命令与工具结果的日志折叠成前端可读的当前模式。
 *
 * v0.6.0 修复：
 * - `wire.view` 改用 `WeakMap` 缓存（按 state 引用映射），多会话并发时不再互相冲掉单槽缓存；
 * - 兼容所有注册的 Flow 工具及结算器走 `/flow <mode>` 命令通道产生的 `command/run` 事件。
 *
 * @module dsh-flow/modes/projection
 */
import { FLOW_TOOL_NAMES, MODE_CHOICES, MODE_OFF } from '../config/constants.js'
import { parseModeArg } from './registry.js'

export const PROJECTION_KEY = 'flowMode'

export function initialModeState() {
  return { mode: MODE_OFF, at: 0 }
}

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

function atOf(event, state) {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : state.at
}

function applyToolResult(state, event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return state
  const meta = data.meta
  if (meta === null || typeof meta !== 'object') return state
  if (!FLOW_TOOL_NAMES.includes(meta.flowTool)) return state

  const mode = parseModeArg(typeof meta.flowMode === 'string' ? meta.flowMode : '')
  if (mode === null || state.mode === mode) return state
  return { mode, at: atOf(event, state) }
}

export function applyModeEvent(state, event) {
  if (event === null || typeof event !== 'object') return state

  if (event.type === 'command/run') {
    const data = event.data
    if (data === null || typeof data !== 'object') return state
    if (data.name !== 'flow') return state

    const mode = parseModeArg(typeof data.args === 'string' ? data.args : '')
    if (mode === null || state.mode === mode) return state
    return { mode, at: atOf(event, state) }
  }

  if (event.type === 'tool/result') return applyToolResult(state, event)

  return state
}

export function createModeProjection() {
  const viewCache = new WeakMap()

  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: { parse: parseState },
    init: initialModeState,
    apply: applyModeEvent,
    wire: {
      viewSchema: { parse: parseState },
      view(state) {
        if (state !== null && typeof state === 'object') {
          const hit = viewCache.get(state)
          if (hit !== undefined) return hit
          const view = { mode: state.mode }
          viewCache.set(state, view)
          return view
        }
        return { mode: MODE_OFF }
      },
      summary: false,
    },
  }
}

export function modeOfSession(handle, session) {
  try {
    const state = handle.stateOf(session)
    const mode = state?.mode
    return typeof mode === 'string' && MODE_CHOICES.includes(mode) ? mode : MODE_OFF
  } catch {
    return MODE_OFF
  }
}
