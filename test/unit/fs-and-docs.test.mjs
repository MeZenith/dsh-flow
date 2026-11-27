import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertInsideRoot, normalizeRelDir, writeAtomic } from '../../src/shared/fs-safe.js'
import { attachmentsOf, checkDoc, docsNote, ensureDocs, resolveTarget, templateOf, writeDoc } from '../../src/workflow/docs.js'
import { gateRequiredDocs, levelDef } from '../../src/workflow/level.js'
import { pathsOverlap, requiresDeclaration, validateAssignments } from '../../src/workflow/dispatch.js'
import { buildFixPackage, buildWhiteboxBrief, createReworkTracker, parseBlackbox, parseWhitebox } from '../../src/workflow/qa-handoff.js'
import { createFlowStateStore } from '../../src/shared/state-store.js'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-unit-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('fs-safe: normalizeRelDir cleans ./ and rejects traversal', () => {
  assert.equal(normalizeRelDir('./.flow/docs/', '.flow/docs'), '.flow/docs')
  assert.equal(normalizeRelDir('../outside', '.flow/docs'), '.flow/docs')
  assert.equal(normalizeRelDir('/etc/passwd', '.flow/docs'), '.flow/docs')
})

test('fs-safe: assertInsideRoot blocks path traversal and symlink escapes', () => withTempDir((root) => {
  const work = join(root, 'work')
  const outside = join(root, 'outside')
  mkdirSync(work, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')

  assert.equal(assertInsideRoot(work, join(work, '.flow/docs/01.md')).ok, true)
  assert.equal(assertInsideRoot(work, join(work, '../outside/secret.txt')).ok, false)

  const linkDir = join(work, 'escape-link')
  let symlinkCreated = false
  try {
    symlinkSync(outside, linkDir, 'junction')
    symlinkCreated = true
  } catch { /* 无权限创建软链的环境跳过软链子断言 */ }
  if (symlinkCreated) {
    assert.equal(assertInsideRoot(work, join(linkDir, 'new-file.md')).ok, false)
    assert.equal(assertInsideRoot(work, join(linkDir, 'secret.txt')).ok, false)
  }
}))

test('fs-safe: concurrent writeAtomic leaves no stray .tmp files and valid content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-atomic-'))
  try {
    const target = join(dir, 'state.json')
    await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => {
      writeAtomic(target, JSON.stringify({ n: i }))
    })))
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(typeof parsed.n, 'number')
    const leftovers = readdirSync(dir).filter(name => name.endsWith('.tmp'))
    assert.equal(leftovers.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workflow/docs: 7 templates readable, docsNote <= 5 lines, whitelist & extra attachment safe', () => withTempDir((cwd) => {
  const config = { docs: { enabled: true, dir: '.flow/docs', level: 'M' } }
  for (const id of ['01', '02', '03', '04', '05', '06', '07']) {
    assert.ok(templateOf(id).length > 100)
  }
  const note = docsNote({ config, cwd, level: 'M' })
  assert.ok(note.split('\n').length <= 5)

  assert.equal(resolveTarget({ config, cwd, target: { kind: 'preview', name: '../evil' } }).ok, false)
  assert.equal(resolveTarget({ config, cwd, target: { kind: 'preview', name: 'home-card' } }).ok, true)

  const init = ensureDocs({ config, cwd, ids: ['01', '03'] })
  assert.deepEqual(init.created, ['01', '03'])

  const content = [
    '# 03 技术方案与环境体检',
    ...Array.from({ length: 7 }, (_, i) => `\n## ${i + 1}. 第 ${i + 1} 节\n\n${`详细方案内容与实测记录第 ${i + 1} 节。`.repeat(4)}`),
  ].join('\n')
  const written = writeDoc({ config, cwd, target: { kind: 'doc', id: '03' }, content })
  assert.equal(written.ok, true)
  const check1 = checkDoc({ config, cwd, id: '03', level: 'M' })
  assert.equal(check1.ok, true)

  const att = attachmentsOf({ config, cwd, ids: ['03'], extra: ['../secret.txt'] })
  assert.equal(att.attachments.length, 1)
  assert.ok(att.skipped.some(msg => msg.includes('跑出了工作区') && msg.includes('已拒绝')))
}))

test('workflow/level B-07: acceptance gate with explicit 06 requires only 06, default requires 06+07', () => {
  assert.deepEqual(gateRequiredDocs({ level: 'M', kind: 'acceptance', explicit: ['06'] }), ['06'])
  assert.deepEqual(gateRequiredDocs({ level: 'M', kind: 'acceptance', explicit: [] }), ['06', '07'])
  assert.deepEqual(levelDef('S').docs, [])
  assert.deepEqual(levelDef('M').docs, ['01', '03', '05', '06', '07'])
  assert.deepEqual(levelDef('L').docs, ['01', '02', '03', '04', '05', '06', '07'])
})

test('workflow/dispatch: pathsOverlap distinguishes extensions and catches real overlaps & shared entries', () => {
  assert.equal(pathsOverlap('src/*.js', 'src/*.ts'), false)
  assert.equal(pathsOverlap('src/**/*.js', 'src/**/*.ts'), false)
  assert.equal(pathsOverlap('src/*.js', 'src/sub/a.js'), false)
  assert.equal(pathsOverlap('src/*.js', 'src/a.js'), true)
  assert.equal(pathsOverlap('src/**', 'src/a/b.ts'), true)
  assert.equal(pathsOverlap('src/modes', 'src/modes/registry.js'), true)
  assert.equal(pathsOverlap('src/a', 'src/ab'), false)

  const sharedCheck = validateAssignments({ assignments: [{ who: 'w1', files: ['src/plugin.js'] }] })
  assert.equal(sharedCheck.ok, false)

  const cleanCheck = validateAssignments({
    assignments: [
      { who: 'w1', files: ['src/modes/*.js'] },
      { who: 'w2', files: ['src/modes/*.ts'] },
    ],
  })
  assert.equal(cleanCheck.ok, true)

  assert.equal(requiresDeclaration({ level: 'S', kind: 'stage', fromStage: 'plan', nextMode: 'build' }), false)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan', nextMode: 'build' }), true)
  assert.equal(requiresDeclaration({ level: 'M', kind: 'stage', fromStage: 'plan', nextMode: 'flow', docIds: ['05'] }), true)
})

test('workflow/qa-handoff: blackbox/whitebox parsing & rework tracker 3-round cap with stateStore', () => withTempDir((dir) => {
  const store = createFlowStateStore({ filePath: join(dir, 'state.json'), persist: true })
  const tracker = createReworkTracker({ stateStore: store })
  assert.equal(tracker.next('s1').allowed, true)
  assert.equal(tracker.next('s1').allowed, true)
  assert.equal(tracker.next('s1').allowed, true)
  assert.equal(tracker.next('s1').blocked, true)

  // 重新实例化验证持久化恢复
  const store2 = createFlowStateStore({ filePath: join(dir, 'state.json'), persist: true })
  const tracker2 = createReworkTracker({ stateStore: store2 })
  assert.equal(tracker2.peek('s1').round, 4)
  tracker2.reset('s1')
  assert.equal(tracker2.peek('s1').round, 0)

  const bb = parseBlackbox('| 编号 | 症状 | 复现 | 影响 | 严重度 |\n|---|---|---|---|---|\n| BUG-01 | 按钮无响应 | 点保存 | 高 | 🔴 Blocker |')
  assert.equal(bb.bugs.length, 1)
  const wb = parseWhitebox('| BUG | 文件:行号 | 触发链 | 最小改动 | 回归点 |\n|---|---|---|---|---|\n| BUG-01 | src/a.js:10 | click->noop | bind handler | click save |')
  const brief = buildWhiteboxBrief({ bugs: bb.bugs })
  assert.ok(brief.includes('BUG-01'))
  const pack = buildFixPackage({ bugs: bb.bugs, roots: wb.roots })
  assert.deepEqual(pack.missing, [])
  assert.deepEqual(pack.blocked, ['BUG-01'])
  assert.ok(existsSync(join(dir, 'state.json')))
}))
