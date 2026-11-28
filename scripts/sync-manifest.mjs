#!/usr/bin/env node
/**
 * 提示词清单同步与校验脚本：计算 `prompts/` 下全部官方文件的 sha256，生成或校验 `prompts/manifest.json`。
 *
 * 用法：
 * - `node scripts/sync-manifest.mjs`          重新计算并写入 `prompts/manifest.json`
 * - `node scripts/sync-manifest.mjs --check`  校验 `prompts/manifest.json` 与磁盘文件一致
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedPath } from '../src/prompts/updater.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROMPTS_DIR = join(ROOT, 'prompts')
const MANIFEST_PATH = join(PROMPTS_DIR, 'manifest.json')
const PKG_PATH = join(ROOT, 'package.json')

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function collectFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'custom') continue
      collectFiles(full, acc)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relative(PROMPTS_DIR, full).replace(/\\/g, '/')
    if (rel === 'manifest.json') continue
    if (!isAllowedPath(rel)) continue
    acc.push({ path: rel, full })
  }
  return acc
}

export function computeManifestEntries() {
  return collectFiles(PROMPTS_DIR)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, full }) => ({
      path,
      sha256: sha256(readFileSync(full, 'utf8')),
    }))
}

export function compatBoundsOf(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? '').trim().replace(/^v/i, ''))
  if (!match) return { minPluginVersion: '0.0.0', maxPluginVersion: '0.0.99' }
  return {
    minPluginVersion: `${match[1]}.${match[2]}.0`,
    maxPluginVersion: `${match[1]}.${match[2]}.99`,
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const checkMode = process.argv.includes('--check')
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  const computed = computeManifestEntries()
  const bounds = compatBoundsOf(pkg.version)

  if (checkMode) {
    const existing = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const ok = existing.version === pkg.version
      && existing.minPluginVersion === bounds.minPluginVersion
      && existing.maxPluginVersion === bounds.maxPluginVersion
      && Array.isArray(existing.files)
      && existing.files.length === computed.length
      && existing.files.every((item, idx) => item.path === computed[idx].path && item.sha256 === computed[idx].sha256)
    if (!ok) {
      console.error('prompts/manifest.json 与磁盘文件或 package.json 版本/兼容边界不一致，请运行 `npm run manifest:sync`')
      process.exit(1)
    }
    console.log(`OK: prompts/manifest.json (${existing.version}, ${computed.length} files) verified`)
  } else {
    const manifest = {
      version: pkg.version,
      ...bounds,
      updatedAt: new Date().toISOString(),
      files: computed,
    }
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`Synced prompts/manifest.json (v${manifest.version}, compat ${bounds.minPluginVersion}~${bounds.maxPluginVersion}, ${computed.length} files)`)
  }
}
