import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function createFakeCordis({ version = '0.2.2-rc.4', rootDir } = {}) {
  const listeners = new Map()
  const effects = []
  const tools = new Map()
  const commands = new Map()
  const routes = []
  const sections = []
  const contexts = []
  const projections = []
  const logs = { info: [], warn: [], error: [] }
  const agents = []
  const services = new Map()

  const pluginTeardowns = []

  const addListener = (event, fn) => {
    let list = listeners.get(event)
    if (!list) { list = []; listeners.set(event, list) }
    list.push(fn)
    return () => {
      const cur = listeners.get(event)
      if (!cur) return
      const idx = cur.indexOf(fn)
      if (idx !== -1) cur.splice(idx, 1)
      if (cur.length === 0) listeners.delete(event)
    }
  }

  const baseCtx = {
    version,
    logger: {
      info: msg => logs.info.push(String(msg)),
      warn: msg => logs.warn.push(String(msg)),
      error: msg => logs.error.push(String(msg)),
    },
    systemPrompt: {
      getSectionOrder: () => 100,
      section: (sec) => {
        sections.push(sec)
        return () => {
          const i = sections.indexOf(sec)
          if (i !== -1) sections.splice(i, 1)
        }
      },
      context: (def) => {
        contexts.push(def)
        return () => {
          const i = contexts.indexOf(def)
          if (i !== -1) contexts.splice(i, 1)
        }
      },
    },
    commands: {
      register: (def) => {
        commands.set(def.name, def)
        return () => { commands.delete(def.name) }
      },
      execute: async (agent, line) => {
        return { kind: 'success', text: `executed:${line}` }
      },
    },
    sessionProjections: {
      register: async (proj) => {
        const entry = { proj, disposed: false, dispose: () => { entry.disposed = true } }
        projections.push(entry)
        return entry
      },
    },
    agents: {
      list: () => [...agents],
      get: sid => agents.find(a => a?.session?.id === sid),
      withInitiator: (_a, fn) => fn(),
    },
    tools: {
      register: (def) => {
        tools.set(def.name, def)
        return () => { tools.delete(def.name) }
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const i = routes.indexOf(route)
          if (i !== -1) routes.splice(i, 1)
        }
      },
    },
    get: name => services.get(name) ?? baseCtx[name],
    on: (event, fn) => {
      const off = addListener(event, fn)
      effects.push(off)
      return off
    },
    effect: (fn) => {
      const clean = fn()
      if (typeof clean === 'function') effects.push(clean)
      return () => { if (typeof clean === 'function') clean() }
    },
    inject: (deps, cb) => {
      const hasMissing = deps.some(d => baseCtx.get(d) === undefined)
      if (hasMissing) return Promise.resolve()
      const res = cb(baseCtx)
      return Promise.resolve(res).then((ret) => {
        if (typeof ret === 'function') pluginTeardowns.push(ret)
        return ret
      })
    },
  }

  services.set('systemPrompt', baseCtx.systemPrompt)
  services.set('commands', baseCtx.commands)
  services.set('sessionProjections', baseCtx.sessionProjections)
  services.set('agents', baseCtx.agents)
  services.set('tools', baseCtx.tools)
  services.set('webServer', baseCtx.webServer)

  function createFakeAgent(sessionId, cwd = rootDir) {
    const agentEffects = []
    const agentListeners = new Map()
    const agent = {
      id: `ag-${sessionId}`,
      status: 'idle',
      session: { id: sessionId, header: { cwd, origin: 'root' } },
      ctx: {
        get: name => services.get(name) ?? baseCtx[name],
        systemPrompt: baseCtx.systemPrompt,
        effect: (fn) => {
          const clean = fn()
          if (typeof clean === 'function') agentEffects.push(clean)
          return () => { if (typeof clean === 'function') clean() }
        },
        on: (event, fn) => {
          let list = agentListeners.get(event)
          if (!list) { list = []; agentListeners.set(event, list) }
          list.push(fn)
          return () => {
            const cur = agentListeners.get(event)
            if (!cur) return
            const idx = cur.indexOf(fn)
            if (idx !== -1) cur.splice(idx, 1)
            if (cur.length === 0) agentListeners.delete(event)
          }
        },
      },
      followup() {},
      cancel() {},
      agentEffects,
      agentListeners,
    }
    return agent
  }

  async function emit(event, ...args) {
    const list = [...(listeners.get(event) ?? [])]
    for (const fn of list) {
      await fn(...args)
    }
  }

  async function disposeAll() {
    for (const fn of [...pluginTeardowns].reverse()) {
      await fn()
    }
    for (const clean of [...effects].reverse()) {
      clean()
    }
  }

  return {
    ctx: baseCtx,
    logs,
    tools,
    commands,
    routes,
    sections,
    contexts,
    projections,
    listeners,
    agents,
    createFakeAgent,
    emit,
    disposeAll,
  }
}

test('Fake Cordis lifecycle: apply() mounts tools/commands/routes/hooks and teardown leaves zero leaks', async () => {
  const { apply, Config } = await import('../../index.js')
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-flow-lifecycle-'))
  const fake = createFakeCordis({ version: '0.2.2-rc.4', rootDir })
  const cfg = Config({
    team: { enabled: false },
    feishu: { enabled: false },
    gate: { persist: false },
  })

  try {
    apply(fake.ctx, cfg)
    // 等待异步 sessionProjections.register 完成挂载
    await new Promise(r => setTimeout(r, 40))

    assert.equal(fake.projections.length, 1)
    assert.equal(fake.sections.length, 1, '必须挂载全局底座 systemPrompt section')
    assert.equal(fake.tools.size, 9, '必须注册全部 9 个 flow_* 工具')
    assert.ok(fake.commands.has('flow'))
    assert.ok(fake.commands.has('flow-notice'))
    assert.ok(fake.routes.length >= 15, '必须注册本地回环 HTTP API 路由')
    for (const ev of ['agent/status', 'agent/inbox/claimed', 'agent/assistant-stream', 'session/event', 'approval/request', 'tools/post-execute', 'agent/created', 'agent/disposed']) {
      assert.ok((fake.listeners.get(ev)?.length ?? 0) >= 1, `缺少事件监听: ${ev}`)
    }

    // 模拟宿主新建 agent 再销毁 agent：附着并清理每会话上下文/钩子
    const agent = fake.createFakeAgent('sess-lc-1', rootDir)
    fake.agents.push(agent)
    await fake.emit('agent/created', { agent })
    assert.equal(fake.contexts.length, 3, '必须为新 Agent 挂载 3 个动态 prompt context')
    assert.ok(agent.agentEffects.length >= 3)
    assert.equal(agent.agentListeners.get('agent/pre-step')?.length, 2)

    await fake.emit('agent/disposed', { agent })
    assert.equal(fake.contexts.length, 0, 'Agent 销毁后必须卸掉全部 3 个动态 prompt context')
    assert.equal(agent.agentListeners.get('agent/pre-step')?.length ?? 0, 0)

    // 测试 /flow-notice 无告警响应
    const noticeRes = fake.commands.get('flow-notice').handler({ agent })
    assert.equal(noticeRes.kind, 'error')

    // 触发全插件卸载：不得残留工具、命令、路由、监听或未释放投影
    await fake.disposeAll()
    assert.equal(fake.logs.error.length, 0, `卸载/生命周期过程中不应有 error 日志: ${fake.logs.error.join('; ')}`)
    assert.equal(fake.tools.size, 0, '卸载后不能残留工具')
    assert.equal(fake.commands.size, 0, '卸载后不能残留命令')
    assert.equal(fake.routes.length, 0, '卸载后不能残留 HTTP 路由')
    assert.equal(fake.sections.length, 0, '卸载后不能残留 systemPrompt section')
    assert.equal(fake.contexts.length, 0, '卸载后不能残留 agent prompt context')
    assert.equal(fake.listeners.size, 0, '卸载后不能残留事件监听')
    assert.equal(fake.projections[0].disposed, true, '卸载后投影 handle 必须被释放')
  } finally {
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('apply() warns cleanly when DSH host version falls outside >=0.2.0 <0.3.0 compatibility range', async () => {
  const { apply, Config } = await import('../../index.js')
  const fake = createFakeCordis({ version: '0.3.0' })
  apply(fake.ctx, Config({ team: { enabled: false }, feishu: { enabled: false }, gate: { persist: false } }))
  await new Promise(r => setTimeout(r, 30))
  assert.ok(fake.logs.warn.some(line => line.includes('0.3.0') && line.includes('兼容范围')))
  await fake.disposeAll()
})
