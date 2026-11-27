/**
 * `compactNow` 桥：跨 preset 隔离域解析原生压缩能力，在回合空闲后带重试触发。
 *
 * @module dsh-flow/modes/compact-bridge
 */
const RETRY_DELAYS = Object.freeze([250, 750, 1500])

export const COMPACT_MESSAGES = Object.freeze({
  busy: '当前回合或后台压缩还没结束，稍后再试。',
  cancelled: '压缩已取消。',
  changed: '准备压缩的历史在替换前发生了变化，这次尝试已记入会话日志。',
  summary: '没能生成有用的摘要，这次尝试已记入会话日志。',
  commit: '压缩没能干净收尾，部分历史可能已变化；建议先检查会话状态再重试。',
  persistence: '压缩完成，但会话没能保存。',
  unavailable: '当前会话的 preset 与宿主平面都没有 compaction 实现，无法执行压缩。',
  unknown: '压缩失败，原因见日志。',
})

export const COMPACT_OK = '已压缩历史。'

function isImplementation(value) {
  return value !== null && typeof value === 'object' && typeof value.compactNow === 'function'
}

function safeGet(read) {
  try { return read() } catch { return undefined }
}

export function createCompactBridge({ ctx, getHostCompaction, logger }) {
  const waiting = new Set()
  const timers = new Set()
  let disposed = false

  function resolve(agent) {
    const presets = safeGet(() => ctx.get('agentPresets'))
    if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function') {
      const fromPreset = safeGet(() => presets.serviceFor(agent, 'compaction'))
      if (isImplementation(fromPreset)) return fromPreset
    }
    const local = safeGet(() => agent?.ctx?.get?.('compaction'))
    if (isImplementation(local)) return local
    const injected = typeof getHostCompaction === 'function' ? safeGet(getHostCompaction) : undefined
    if (isImplementation(injected)) return injected
    const direct = safeGet(() => ctx.get('compaction'))
    if (isImplementation(direct)) return direct
    return undefined
  }

  function presetIdOf(agent) {
    const presets = safeGet(() => ctx.get('agentPresets'))
    if (presets === undefined || presets === null || typeof presets.composedPreset !== 'function') return undefined
    return safeGet(() => presets.composedPreset(agent?.ctx))
  }

  async function runNow(agent, signal) {
    const compaction = resolve(agent)
    if (compaction === undefined) {
      const presetId = presetIdOf(agent)
      logger?.warn?.(`flow: 未找到 compaction 实现（preset=${presetId ?? '未绑定'}）`)
      return { ok: false, code: 'unavailable', text: COMPACT_MESSAGES.unavailable }
    }
    try {
      const result = await compaction.compactNow(agent, signal)
      if (result === null || result === undefined) {
        return { ok: true, code: 'empty', text: '没有可压缩的历史。', result: null }
      }
      return { ok: true, code: 'compacted', text: COMPACT_OK, result }
    } catch (error) {
      if (signal?.aborted === true) {
        return { ok: false, code: 'cancelled', text: COMPACT_MESSAGES.cancelled }
      }
      const name = error !== null && typeof error === 'object' ? error.name : ''
      const rawCode = error !== null && typeof error === 'object' ? error.code : ''
      const code = typeof rawCode === 'string' ? rawCode : ''
      if (name === 'ManualCompactionError' && Object.prototype.hasOwnProperty.call(COMPACT_MESSAGES, code)) {
        return { ok: false, code, text: COMPACT_MESSAGES[code] }
      }
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown', text: `${COMPACT_MESSAGES.unknown}（${detail}）` }
    }
  }

  function later(delayMs, run) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (disposed) return
      run()
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
    timers.add(timer)
  }

  function attempt(agent, index) {
    if (disposed) return
    const controller = new AbortController()
    void runNow(agent, controller.signal).then((outcome) => {
      if (disposed) return
      if (outcome.ok) {
        logger?.info?.(`flow: 阶段切换后自动压缩完成（${outcome.code}）`)
        return
      }
      if (outcome.code === 'busy' && index < RETRY_DELAYS.length) {
        later(RETRY_DELAYS[index], () => { attempt(agent, index + 1) })
        return
      }
      if (outcome.code !== 'unavailable') {
        logger?.warn?.(`flow: 阶段切换后自动压缩未完成 — ${outcome.text}`)
      }
    })
  }

  function schedule(agent) {
    if (disposed || agent === null || typeof agent !== 'object') return false
    if (waiting.has(agent)) return false
    waiting.add(agent)
    return true
  }

  function isScheduled(agent) {
    return waiting.has(agent)
  }

  function onStatus(payload) {
    if (disposed) return
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    if (payload?.status !== 'idle') return
    if (!waiting.has(agent)) return
    waiting.delete(agent)
    void Promise.resolve().then(() => { attempt(agent, 0) })
  }

  function available(agent) {
    return resolve(agent) !== undefined
  }

  function dispose() {
    disposed = true
    waiting.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  return { schedule, isScheduled, runNow, onStatus, available, dispose }
}
