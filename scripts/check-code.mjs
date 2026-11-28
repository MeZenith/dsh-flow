#!/usr/bin/env node
/**
 * 零依赖静态校验脚本：
 * 1. 对 `index.js`、`client.js`、`src/`、`scripts/`、`test/` 全量执行 `node --check` 语法检查；
 * 2. 检查 `src/` 下是否遗留 `console.log(` 调试语句；
 * 3. 校验 `package.json` 的 `engines.node`、`engines.dsh` 与 `Apache-2.0` 协议元数据一致性。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function collectJsFiles(relPath, out = []) {
  const full = join(ROOT, relPath)
  const st = statSync(full)
  if (st.isFile()) {
    if (/\.(?:js|mjs)$/.test(relPath)) out.push(full)
    return out
  }
  if (!st.isDirectory()) return out
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const childRel = join(relPath, entry.name)
    if (entry.isDirectory()) {
      collectJsFiles(childRel, out)
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      out.push(join(ROOT, childRel))
    }
  }
  return out
}

const files = [
  ...collectJsFiles('index.js'),
  ...collectJsFiles('client.js'),
  ...collectJsFiles('src'),
  ...collectJsFiles('scripts'),
  ...collectJsFiles('test'),
]

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

// 检查 src/ 下的调试 console.log( 调用（忽略单行注释）
const srcFiles = collectJsFiles('src')
const consoleViolations = []
for (const file of srcFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (/\bconsole\.log\s*\(/.test(line)) {
      consoleViolations.push(`${rel}:${i + 1}: ${trimmed}`)
    }
  }
}
if (consoleViolations.length > 0) {
  console.error('静态检查失败：src/ 中不允许残留 console.log：\n' + consoleViolations.join('\n'))
  process.exit(1)
}

// 校验 package.json 引擎与协议契约
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (!pkg.engines?.node || !pkg.engines?.dsh) {
  console.error('静态检查失败：package.json 必须同时声明 engines.node 与 engines.dsh')
  process.exit(1)
}
const licenseText = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
if (pkg.license !== 'Apache-2.0' || !licenseText.includes('Apache License') || !licenseText.includes('Version 2.0')) {
  console.error('静态检查失败：package.json.license 与 LICENSE 头部未保持 Apache-2.0 一致')
  process.exit(1)
}

console.log(`OK: checked ${files.length} JS/MJS files, engines (${pkg.engines.node} / dsh ${pkg.engines.dsh}), license (${pkg.license})`)
