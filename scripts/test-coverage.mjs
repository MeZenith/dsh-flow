#!/usr/bin/env node
/**
 * 零依赖覆盖率门禁脚本（Node 22+ 原生 `--experimental-test-coverage`）。
 *
 * 收集 `test/` 下全部 `*.test.mjs` 并运行测试 + 覆盖率统计，
 * 若任一测试失败或全局覆盖率低于基线门槛（Line >= 70%, Branch >= 53%, Funcs >= 62%）则返回退出码 1。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const THRESHOLDS = Object.freeze({ line: 70, branch: 53, funcs: 62 })

function collectTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTestFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

const testFiles = collectTestFiles(join(ROOT, 'test')).sort()
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-exclude=vendor/**',
    '--test-coverage-exclude=test/**',
    '--test-coverage-exclude=scripts/**',
    ...testFiles,
  ],
  { cwd: ROOT, encoding: 'utf8' },
)

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const stripAnsi = text => String(text ?? '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
const combined = stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
// Node 22 非 TTY TAP 输出以 `# all files` 开头，Node 24 以 `ℹ all files` 开头
const match = /^\s*(?:ℹ|#)\s*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m.exec(combined)

if (!match) {
  console.error('覆盖率门禁失败：未在输出中解析到 `all files` 覆盖率汇总行')
  process.exit(1)
}

const linePct = Number(match[1])
const branchPct = Number(match[2])
const funcsPct = Number(match[3])

const failures = []
if (linePct < THRESHOLDS.line) failures.push(`line ${linePct}% < ${THRESHOLDS.line}%`)
if (branchPct < THRESHOLDS.branch) failures.push(`branch ${branchPct}% < ${THRESHOLDS.branch}%`)
if (funcsPct < THRESHOLDS.funcs) failures.push(`funcs ${funcsPct}% < ${THRESHOLDS.funcs}%`)

if (failures.length > 0) {
  console.error(`覆盖率门禁未通过：${failures.join(', ')}`)
  process.exit(1)
}

console.log(`OK: coverage gate passed (line ${linePct}% >= ${THRESHOLDS.line}%, branch ${branchPct}% >= ${THRESHOLDS.branch}%, funcs ${funcsPct}% >= ${THRESHOLDS.funcs}%)`)
