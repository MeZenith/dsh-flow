/**
 * Flow 工作流、提示词管家与直连飞书指挥官 — Host 主装配模块。
 *
 * v0.6.0 架构亮点：
 * - 分层清晰：`shared` / `config` / `modes` / `workflow` / `prompts` / `gates` / `resilience` / `notify` / `remote` / `tools` / `commands`；
 * - 全部 P0/P1 Bug 修复（B-01 ~ B-12 + M-01 ~ M-12）；
 * - 传输无关 `RemoteHub` + 直连飞书指挥官（支持自定义名称/头像扫码建应用、互动卡片、文件直发、多项目切换）；
 * - `agent/disposed` 全量回收内存，杜绝长运行泄漏。
 *
 * @module dsh-flow/plugin
 */
import { Config, plainConfigOf } from './config/schema.js'
import { MODE_OFF } from './config/constants.js'
import { modeConfigOf } from './modes/registry.js'
import { createDiagSink, markSinkReady } from './shared/diag.js'
import { projectNameOfContext, projectNameOfCwd } from './shared/message.js'
import { createFlowStateStore } from './shared/state-store.js'
import { createModeProjection, modeOfSession } from './modes/projection.js'
import { createCompactBridge } from './modes/compact-bridge.js'
import { applyModeSwitch } from './modes/switcher.js'
import { createUiSkillProbe } from './workflow/ui-skill.js'
import { createDispatchStore } from './workflow/dispatch.js'
import { createReworkTracker } from './workflow/qa-handoff.js'
import { createPromptStore } from './prompts/store.js'
import { DEFAULT_SOURCE_URL, formatUpdateResult, updatePrompts } from './prompts/updater.js'
import { attachAgentDocsContext, attachAgentModeContext, attachAgentSpecContext, installBaseSection } from './prompts/bridge.js'
import { API_PREFIX, createPromptApi } from './prompts/api.js'
import { createGateTickets } from './gates/tickets.js'
import { createGateSettler } from './gates/settler.js'
import { createGateRouter } from './gates/router.js'
import { createActivityTracker } from './resilience/activity.js'
import { createCircuitBreaker } from './resilience/circuit-breaker.js'
import { createTeamWatcher } from './resilience/team-sse.js'
import { createEmailChannel } from './notify/email.js'
import { createImChannel } from './notify/im.js'
import { createNotifier } from './notify/dispatcher.js'
import { createHarnessBridge } from './remote/harness-bridge.js'
import { createRemoteHub } from './remote/hub.js'
import { createFeishuCommander } from './remote/feishu/index.js'
import { createFlowTools } from './tools/index.js'
import { createFlowCommand } from './commands/index.js'

export { Config }

/** 插件诊断名。 */
export const name = 'flow'

/** 硬依赖：缺任一服务则插件不激活；可选服务均用 holdOptional 动态持有。 */
export const inject = ['systemPrompt', 'commands', 'sessionProjections', 'agents', 'tools']

/** 可选服务的动态持有者（支持异步挂载与自动释放）。 */
function holdOptional(ownerCtx, serviceName) {
  const holder = { current: undefined }
  const ready = ownerCtx.inject([serviceName], (sub) => {
    holder.current = typeof sub.get === 'function' ? sub.get(serviceName) : sub[serviceName]
    return () => { holder.current = undefined }
  })
  void Promise.resolve(ready).catch(() => { holder.current = undefined })
  return {
    get() {
      if (holder.current !== undefined) return holder.current
      try {
        return ownerCtx.get(serviceName)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * 插件主入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const nodeMajor = Number(String(process.versions?.node ?? '').split('.')[0])
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    ctx?.logger?.error?.(
      `flow: dsh-flow requires Node.js >= 22 (current: ${process.versions?.node ?? 'unknown'}). `
      + `需要 Node.js >= 22 运行环境（当前版本：${process.versions?.node ?? '未知'}），插件已跳过加载。`,
    )
    return
  }

  const hostVersion = String(ctx?.version ?? ctx?.root?.version ?? '').trim()
  if (hostVersion !== '' && !/^v?0\.2(?:\.|-|$)/i.test(hostVersion)) {
    ctx?.logger?.warn?.(
      `flow: 检测到 DSH 宿主版本 ${hostVersion} 超出已验证兼容范围 (>=0.2.0 <0.3.0)，如遇 API 异常请更新插件或查阅 README 兼容说明。`,
    )
  }

  const state = { config, handle: null }
  const agentDisposers = new Map()

  const bootstrap = ctx.inject(inject, async (scoped) => {
    // 1. 投影优先就绪
    const handle = await scoped.sessionProjections.register(createModeProjection())
    state.handle = handle

    const getConfig = () => plainConfigOf(state.config)
    const readMode = session => (state.handle === null ? MODE_OFF : modeOfSession(state.handle, session))
    const logger = {
      warn: message => scoped.logger.warn(message),
      info: message => scoped.logger.info(message),
    }
    const diag = createDiagSink(logger, getConfig)
    markSinkReady(getConfig)

    // 统一持久化状态仓库（保存在插件包外，升级不丢状态）
    const stateStore = createFlowStateStore({ logger })

    // 提示词仓库与更新器
    const promptStore = createPromptStore({ getConfig, logger: scoped.logger })
    const runPromptUpdate = async (signal) => {
      const cfg = getConfig()
      const sourceUrl = cfg?.prompts?.sourceUrl || DEFAULT_SOURCE_URL
      const allowMirrorFallback = cfg?.prompts?.allowMirrorFallback !== false
      const result = await updatePrompts({ sourceUrl, root: promptStore.root, signal, logger, allowMirrorFallback })
      promptStore.invalidate()
      return { result, text: formatUpdateResult(result) }
    }

    // 2. 动态持有可选宿主服务
    const compactionHolder = holdOptional(scoped, 'compaction')
    const questionsHolder = holdOptional(scoped, 'userQuestions')
    const dshImHolder = holdOptional(scoped, 'dshIm')
    const credentialsHolder = holdOptional(scoped, 'credentials')
    const sessionControllerHolder = holdOptional(scoped, 'sessionController')
    const workspaceRegistryHolder = holdOptional(scoped, 'workspaceRegistry')
    const workspaceControllerHolder = holdOptional(scoped, 'workspaceController')

    // 3. 模式切换事务（命令与工具共用）
    const switchMode = (agent, modeId, signal) => applyModeSwitch({
      ctx: scoped,
      config: getConfig(),
      agent,
      modeId,
      signal,
      logger,
    })

    /** B-03 / P0-1 修复：按真实 DSH 宿主签名 `execute(agent, line, attachments, signal)` 执行 `/flow <modeId>`。 */
    const syncModeCommand = async (agent, modeId) => {
      if (typeof scoped?.commands?.execute !== 'function') return { ok: false }
      try {
        const signal = new AbortController().signal
        const res = await scoped.commands.execute(agent, `/flow ${modeId}`, [], signal)
        const kind = res?.result?.kind ?? res?.kind
        if (!res || kind === 'error') {
          return { ok: false, reason: res?.result?.text ?? res?.text }
        }
        const label = modeId === MODE_OFF ? '普通模式' : modeConfigOf(getConfig(), modeId).label
        return { ok: true, label, notes: [] }
      } catch {
        return { ok: false }
      }
    }

    const resolveAgent = (sessionId) => {
      const key = String(sessionId ?? '')
      if (key === '') return undefined
      try {
        const direct = scoped.agents.get(key)
        if (direct !== undefined && direct !== null) return direct
      } catch { /* 回退遍历 */ }
      try {
        return scoped.agents.list().find(agent => String(agent?.session?.id ?? '') === key)
      } catch {
        return undefined
      }
    }

    // 4. 压缩桥 + 活跃度 + 通知渠道（延迟闭包读取 breaker，避免熔断期间自动压缩撞车）
    let breaker
    const bridge = createCompactBridge({
      ctx: scoped,
      getHostCompaction: () => compactionHolder.get(),
      isLocked: (agent) => breaker?.isLocked?.(agent) === true,
      logger,
    })
    scoped.effect(() => () => bridge.dispose(), 'flow: compact bridge')
    scoped.on('agent/status', payload => { bridge.onStatus(payload) })

    const activity = createActivityTracker({ ctx: scoped })
    scoped.effect(() => () => activity.dispose(), 'flow: activity')

    // feishuRef 在下方初始化，先用闭包延迟访问
    let feishuCommander
    const imChannel = createImChannel({
      ctx: scoped,
      getConfig,
      getDshIm: () => dshImHolder.get(),
      getFeishu: () => feishuCommander,
      logger,
    })
    const emailChannel = createEmailChannel({ getConfig, logger })
    const notifier = createNotifier({
      getConfig,
      activity,
      im: imChannel,
      email: emailChannel,
      logger,
    })
    scoped.effect(() => () => notifier.dispose(), 'flow: notifier')

    // remoteHub 在熔断/结算器初始化后挂接，采用延迟闭包解耦循环依赖
    let remoteHub

    // 5. 熔断器 + 门禁票据 + 结算器 + 遥控路由
    breaker = createCircuitBreaker({
      ctx: scoped,
      getConfig,
      notifier,
      logger,
      readMode,
      im: imChannel,
      onBrake: (payload) => remoteHub?.emit?.('brake:tripped', payload),
      onUnlocked: (payload) => remoteHub?.emit?.('brake:unlocked', payload),
      diagSink: diag,
    })
    scoped.effect(() => () => breaker.dispose(), 'flow: circuit breaker')

    const tickets = createGateTickets({
      getConfig,
      logger: scoped.logger,
      diag,
      onEvent: (type, ticket) => {
        if (type === 'expired') remoteHub?.emit?.('gate:expired', { ticket })
      },
      // P1-10 修复：重启恢复的 open 票据到达超时时间后同样发送一次催办。
      onRecoverOpen: async (ticket) => {
        const cfg = getConfig()
        const strategy = ['im-first', 'email-first', 'both', 'off'].includes(cfg?.gate?.escalate)
          ? cfg.gate.escalate
          : 'both'
        if (strategy === 'off') return
        const targetAgent = resolveAgent(ticket.sessionId)
        await notifier.sendNow('gate-timeout', {
          title: `Flow 门禁超时 #${ticket.id}`,
          project: ticket.project,
          markdown: [
            `## Flow 门禁超时 #${ticket.id}`,
            '',
            `- 项目：${ticket.project}`,
            `- 阶段：${ticket.fromStage} → ${ticket.nextMode}`,
            `- 结论：${String(ticket.summary ?? '').slice(0, 800)}`,
            '',
            '**已严格停手，等你决定**。桌面回 `1/2/3`、飞书点卡片按钮或回复 `#票据号 1/2/3 [意见]` 即可。',
          ].join('\n'),
          agent: targetAgent,
          session: targetAgent?.session,
          strategy,
        })
      },
    })
    scoped.effect(() => () => tickets.dispose(), 'flow: gate tickets')

    const settler = createGateSettler({
      getConfig,
      switchMode,
      syncModeCommand,
      bridge,
      notifier,
      tickets,
      resolveAgent,
      onSettled: ({ ticket, action, by, note, effects }) => {
        const opt = Array.isArray(ticket?.options) ? ticket.options.find(item => item.action === action) : undefined
        remoteHub?.emit?.('gate:settled', { ticket, action, label: opt?.label ?? action, by, note, effects })
      },
      logger,
      diag,
    })

    const gateRouter = createGateRouter({
      tickets,
      breaker,
      im: imChannel,
      getConfig,
      resolveAgent,
      settler,
      logger,
      diag,
    })

    // 6. 远程控制中枢（RemoteHub）+ 直连飞书指挥官
    const harnessBridge = createHarnessBridge({
      ctx: scoped,
      readMode,
      resolveAgent,
      switchMode,
      syncModeCommand,
      tickets,
      breaker,
      stateStore,
      getSessionController: () => sessionControllerHolder.get(),
      getWorkspaceRegistry: () => workspaceRegistryHolder.get(),
      getWorkspaceController: () => workspaceControllerHolder.get(),
      logger,
    })

    remoteHub = createRemoteHub({
      bridge: harnessBridge,
      tickets,
      settler,
      gateRouter,
      breaker,
      getConfig,
      logger,
    })

    feishuCommander = createFeishuCommander({
      hub: remoteHub,
      getConfig,
      getCredentials: () => credentialsHolder.get(),
      stateStore,
      logger,
      diag,
    })
    feishuCommander.autoStart()
    scoped.effect(() => () => { void feishuCommander.dispose() }, 'flow: feishu commander')

    // 6b. 挂接 DSH 原生回合流、会话事件与竞争式工具审批到飞书指挥官
    scoped.on('agent/inbox/claimed', ({ agent, message, turn } = {}) => {
      const sid = String(agent?.session?.id ?? '')
      if (sid === '') return
      feishuCommander.onInboxClaimed({
        sessionId: sid,
        messageId: String(message?.id ?? ''),
        turn,
      })
    }, { global: true })

    scoped.on('agent/assistant-stream', ({ agent, frame } = {}) => {
      const session = agent?.session
      const sid = String(session?.id ?? '')
      if (sid === '' || session?.header?.origin === 'subagent') return
      feishuCommander.onAssistantStream({
        sessionId: sid,
        frame,
        project: projectNameOfCwd(String(session?.header?.cwd ?? '')),
        mode: readMode(session),
      })
    }, { global: true })

    scoped.on('session/event', (session, event) => {
      const sid = String(session?.id ?? '')
      if (sid === '' || session?.header?.origin === 'subagent') return
      feishuCommander.onSessionEvent({
        sessionId: sid,
        event,
        project: projectNameOfCwd(String(session?.header?.cwd ?? '')),
        mode: readMode(session),
      })
    }, { global: true })

    scoped.on('approval/request', (request, next) => (
      feishuCommander.handleApprovalRequest(request, next)
    ), { global: true, prepend: true })

    // 7. UI Skill 探测 + 团队 SSE 监控
    const uiSkills = createUiSkillProbe({
      getSkills: () => {
        try { return scoped.get('skills') } catch { return undefined }
      },
      getConfig,
      logger: scoped.logger,
      diag,
    })
    scoped.effect(() => () => uiSkills.invalidate(), 'flow: ui skill probe')

    scoped.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      breaker.observe(exec, result)
      return decision
    })

    const teamWatcher = createTeamWatcher({
      getConfig,
      logger,
      onAlert: (payload) => {
        notifier.schedule('team', {
          title: 'Flow 团队异常',
          project: projectNameOfContext(scoped),
          markdown: ['## 团队异常 / 审批', '', `- 类型：${payload.type}`, `- 摘要：${payload.summary}`].join('\n'),
        })
      },
      onComplete: (payload) => {
        notifier.schedule('archive', {
          title: 'Flow 团队完结',
          project: projectNameOfContext(scoped),
          markdown: ['## 团队任务完结', '', `- ${payload.summary}`].join('\n'),
        })
      },
    })
    teamWatcher.start()
    scoped.effect(() => () => teamWatcher.stop(), 'flow: team sse')

    // 8. 全局永不变底座 section
    scoped.effect(
      () => installBaseSection(scoped, { getConfig, store: promptStore }),
      'flow: base section',
    )

    // 9. 每个 Agent 挂接 3 个动态 context + 门禁/熔断 pre-step
    const attach = (agent) => {
      const id = agent.id
      if (agentDisposers.has(id)) return
      const getMode = () => readMode(agent.session)
      const cwd = String(agent.session?.header?.cwd ?? '')
      if (cwd !== '') {
        stateStore.rememberWorkspace(cwd)
        uiSkills.warm(cwd)
      }

      // B-04 修复：传入 agent 与 stateStore，使 buildModeText 能拿到真实 sessionId 对应的任务等级。
      const disposeMode = agent.ctx.effect(
        () => attachAgentModeContext(agent.ctx, { agent, getConfig, getMode, store: promptStore, stateStore }),
        'flow: mode context',
      )
      const disposeSpec = agent.ctx.effect(
        () => attachAgentSpecContext(agent.ctx, { agent, getConfig, getMode }),
        'flow: spec context',
      )
      const disposeDocs = agent.ctx.effect(
        () => attachAgentDocsContext(agent.ctx, { agent, getConfig, getMode, stateStore }),
        'flow: docs context',
      )

      const isSubagent = agent.session?.header?.origin === 'subagent'
      const disposeGateRoute = isSubagent
        ? undefined
        : agent.ctx.on('agent/pre-step', (payload, next) => gateRouter.preStep(payload, next))
      const disposePreStep = isSubagent
        ? undefined
        : agent.ctx.on('agent/pre-step', (payload, next) => breaker.preStep(payload, next))
      diag(`attach agent=${id} session=${agent.session?.id ?? '(无 sessionId)'} origin=${agent.session?.header?.origin ?? 'root'}`)

      agentDisposers.set(id, () => {
        try { disposePreStep?.() } catch { /* 已释放 */ }
        try { disposeGateRoute?.() } catch { /* 已释放 */ }
        try { disposeDocs() } catch { /* 已释放 */ }
        try { disposeSpec() } catch { /* 已释放 */ }
        try { disposeMode() } catch { /* 已释放 */ }
      })
    }

    const dispatchStore = createDispatchStore({ stateStore })
    const reworkTracker = createReworkTracker({ stateStore })

    scoped.on('agent/created', ({ agent }) => { attach(agent) }, { prepend: true })
    // M-12 / P1-9 修复：会话销毁时全量回收内存 Map、等待压缩队列与子代理状态，杜绝长运行泄漏。
    scoped.on('agent/disposed', ({ agent }) => {
      const id = agent?.id
      if (id !== undefined && agentDisposers.has(id)) {
        try { agentDisposers.get(id)?.() } catch { /* dispose-path: 会话销毁清理阶段单步回收失败不阻塞其余资源释放 */ }
        agentDisposers.delete(id)
      }
      bridge.forget(agent)
      const sid = String(agent?.session?.id ?? '')
      if (sid !== '') {
        activity.forget(sid)
        breaker.forget(sid)
        dispatchStore.forget(sid)
        reworkTracker.forget(sid)
        stateStore.forgetSession(sid)
        feishuCommander.forgetSession(sid)
      }
    })
    for (const agent of scoped.agents.list()) attach(agent)

    // 10. 全局静态注册全部 9 个工具
    for (const definition of createFlowTools({
      ctx: scoped,
      getConfig,
      switchMode,
      logger,
      getUserQuestions: () => questionsHolder.get(),
      notifier,
      im: imChannel,
      email: emailChannel,
      tickets,
      uiSkills,
      remoteHub,
      stateStore,
      dispatchStore,
      reworkTracker,
    })) {
      scoped.effect(
        () => scoped.tools.register(definition),
        `flow: tool ${definition.name}`,
      )
    }

    // 11. 注册 `/flow` 与内部 `/flow-notice` 命令
    scoped.effect(
      () => scoped.commands.register(createFlowCommand({
        ctx: scoped,
        getConfig,
        readMode,
        bridge,
        logger,
        breaker,
        im: imChannel,
        email: emailChannel,
        tickets,
        settler,
        gateRouter,
        feishu: feishuCommander,
        stateStore,
        prompts: { store: promptStore, update: runPromptUpdate },
      })),
      'flow: command',
    )

    scoped.effect(
      () => scoped.commands.register({
        definitionId: 'flow-notice',
        name: 'flow-notice',
        description: '内部使用：渲染 Flow 熔断告警',
        recordInput: false,
        handler({ agent }) {
          const text = breaker.alertTextOf(agent)
          return text === ''
            ? { kind: 'error', text: '当前没有待显示的熔断告警。' }
            : { kind: 'success', text }
        },
      }),
      'flow: notice command',
    )

    // 12. 本地回环 HTTP API（挂在 scoped 下，重载时自动释放避免重复注册路由，P1-9 修复）
    scoped.inject(['webServer'], (httpCtx) => {
      try {
        const api = createPromptApi({
          store: promptStore,
          update: runPromptUpdate,
          feishu: feishuCommander,
          testNotify: async (channel) => {
            const out = {}
            if (channel === 'all' || channel === 'feishu') out.feishu = await feishuCommander.sendTestCard()
            if (channel === 'all' || channel === 'im') out.im = await imChannel.test()
            if (channel === 'all' || channel === 'email') out.email = await emailChannel.test()
            return out
          },
        })
        for (const route of api.routes()) {
          httpCtx.effect(
            () => httpCtx.webServer.register(route),
            `flow: ${route.path}`,
          )
        }
        logger.info(`flow: 已挂载本地控制接口 ${API_PREFIX}`)
      } catch (error) {
        logger.warn(`flow: 本地控制接口挂载失败 → ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // 13. 插件卸载兜底清理
    scoped.effect(
      () => () => {
        for (const dispose of [...agentDisposers.values()]) {
          try { dispose() } catch { /* dispose-path: 卸载阶段遍历清理会话钩子 */ }
        }
        agentDisposers.clear()
      },
      'flow: agent disposers',
    )

    return async () => {
      const current = state.handle
      state.handle = null
      try { await current?.dispose?.() } catch { /* dispose-path: 热重载退出旧飞书实例时防止卸载中断 */ }
    }
  })

  void Promise.resolve(bootstrap).catch((error) => {
    ctx.logger.error(`flow: 初始化失败 — ${error instanceof Error ? error.message : String(error)}`)
  })
}
