/**
 * 诊断日志工具：默认关闭，仅配置 `circuit.debugLog` 或 `DSH_FLOW_DEBUG=1` 时写盘。
 *
 * @module dsh-flow/shared/diag
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function debugLogOn(getConfig) {
  const env = String(process.env.DSH_FLOW_DEBUG ?? '').trim()
  if (env === '1' || env.toLowerCase() === 'true') return true
  try {
    return getConfig?.()?.circuit?.debugLog === true
  } catch {
    return false
  }
}

export function createDiagSink(logger, getConfig) {
  let file
  let resolved = false

  function resolveFile() {
    if (resolved) return file
    resolved = true
    try {
      const dir = join(homedir(), '.dsh', 'logs')
      mkdirSync(dir, { recursive: true })
      file = join(dir, 'dsh-flow-diag.log')
    } catch {
      file = undefined
    }
    return file
  }

  return (message) => {
    if (!debugLogOn(getConfig)) return
    const line = `${new Date().toISOString()} [flow:diag] ${message}`
    try { logger?.info?.(line) } catch { /* 忽略日志通道异常 */ }
    const target = resolveFile()
    if (target !== undefined) {
      try { appendFileSync(target, `${line}\n`, 'utf8') } catch { /* 磁盘不可写时静默 */ }
    }
  }
}

export function markSinkReady(getConfig) {
  try {
    const file = join(homedir(), '.dsh', 'logs', 'dsh-flow-diag.log')
    if (!existsSync(file)) return
    const enabled = debugLogOn(getConfig)
    appendFileSync(file, `${new Date().toISOString()} [flow:diag] sink ready enabled=${enabled}\n`, 'utf8')
  } catch { /* 诊断失败不影响主流程 */ }
}
