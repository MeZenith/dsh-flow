/**
 * Flow 工作流与提示词管家 — Host 半。
 *
 * 职责边界（S2）：
 *   - 五大模式 + 关闭态的状态机（真相 = 会话日志里 `/flow <mode>` 命令与工具结果的折叠）
 *   - 分层提示词注入：永不变底座 section + 每 Agent 一个动态模式 context + 方案锚点便利贴
 *   - 模式切换时一次性应用默认模型与权限档位（命令与工具共用同一事务）
 *   - `.flow/spec.md` 锚点保活（走 `required` runtime context，压缩后自动重挂）
 *   - 开局四选一路由与阶段强门禁两个工具（全局静态注册，永不增删）
 *
 * 明确不做（留给后续）：真实焦点级桌面活跃心跳（需 Typert Remote codegen）。
 *
 * @module dsh-flow
 */
import { Config, plainConfigOf } from './config.js'
import { createFlowCommand } from './commands.js'
import { createCompactBridge } from './compact-bridge.js'
import { createModeProjection, modeOfSession } from './mode-projection.js'
import { attachAgentModeContext, attachAgentSpecContext, installBaseSection } from './prompt-bridge.js'
import { createPromptStore } from './prompt-store.js'
import { createPromptApi, API_PREFIX } from './prompt-api.js'
import { DEFAULT_SOURCE_URL, formatUpdateResult, updatePrompts } from './prompt-updater.js'
import { applyModeSwitch } from './switch-mode.js'
import { createFlowTools } from './tools.js'
import { MODE_OFF } from './modes.js'
import { createActivityTracker } from './activity.js'
import { createCircuitBreaker } from './circuit-breaker.js'
import { createEmailChannel } from './notify-email.js'
import { createImChannel } from './notify-im.js'
import { createNotifier } from './notify.js'
import { createTeamWatcher } from './team-sse.js'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 诊断日志是否开启：配置开关优先，其次环境变量 `DSH_FLOW_DEBUG=1` 临时打开。
 *
 * @param {() => object} getConfig
 * @returns {boolean}
 */
function debugLogOn(getConfig) {
  const env = String(process.env.DSH_FLOW_DEBUG ?? '').trim()
  if (env === '1' || env.toLowerCase() === 'true') return true
  return getConfig?.()?.circuit?.debugLog === true
}

/**
 * 诊断日志出口：同时写宿主日志与自管文件。
 *
 * 宿主的 `~/.dsh/logs/startup-*.log` 是**启动快照**，运行期日志只到终端；
 * 为了让排障有稳定可贴的文件，这里额外追加到 `~/.dsh/logs/dsh-flow-diag.log`。
 *
 * 默认关闭：开关不为真时直接返回，连日志目录都不创建。
 *
 * @param {{ info?: Function }} logger
 * @param {() => object} getConfig
 * @returns {(message: string) => void}
 */
function createDiagSink(logger, getConfig) {
  let file
  let resolved = false

  /** 首次真正需要写盘时才建目录，避免关掉开关还留个空文件。 */
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
    try {
      logger?.info?.(line)
    } catch { /* 忽略日志通道异常 */ }
    const target = resolveFile()
    if (target !== undefined) {
      try {
        appendFileSync(target, `${line}\n`, 'utf8')
      } catch { /* 磁盘不可写时静默 */ }
    }
  }
}

/**
 * 在诊断文件里打一行装载基线（只在文件已存在时写，避免给关掉开关的用户凭空建文件）。
 *
 * 用途：一眼看出本次装载时开关的实际取值，也能立刻发现是否有旧的插件实例还在写日志。
 *
 * @param {() => object} getConfig
 */
function markSinkReady(getConfig) {
  try {
    const file = join(homedir(), '.dsh', 'logs', 'dsh-flow-diag.log')
    if (!existsSync(file)) return
    const enabled = debugLogOn(getConfig)
    appendFileSync(file, `${new Date().toISOString()} [flow:diag] sink ready enabled=${enabled}\n`, 'utf8')
  } catch { /* 诊断失败不影响主流程 */ }
}
export { Config }

/**
 * 推断"项目名"，用于通知标题与邮件主题。
 *
 * 优先取任一活跃会话工作目录的末段；没有活跃会话时退回进程 cwd 的末段。
 *
 * @param {object} ctx 插件作用域。
 * @returns {string}
 */
function projectNameOf(ctx) {
  try {
    for (const agent of ctx.agents.list()) {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') {
        const parts = cwd.split(/[\\/]/).filter(Boolean)
        if (parts.length > 0) return parts[parts.length - 1]
      }
    }
  } catch { /* 注册表不可读时退回 cwd */ }
  const parts = (typeof process.cwd === 'function' ? process.cwd() : '').split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : 'dsh-flow'
}

/**
 * 注意：本文件**只能**用命名导出（apply / inject / Config / name）。
 *
 * 加载器 `Loader.unwrapExports()` 的实现是 `exports.default ?? exports`：
 * 一旦声明 `export default apply`，插件就变成那个裸函数，`apply.Config` /
 * `apply.inject` / `apply.name` 全部丢失 —— 宿主会报 `Config: absent`，
 * 设置页与 `ctx.settings.describe()` 都会整条跳过。官方 host-plugin.md 也要求
 * 两种导出形态"do not mix them"。此坑已在 0.2.2-rc.4 实测复现，勿再加 default。
 */

/** 插件诊断名。 */
export const name = 'flow'

/** 硬依赖：缺任一服务则该插件不激活（而不是半残运行）。
 *
 * `userQuestions` 与 `compaction` **故意不在这里**：它们是可选能力，
 * 缺了只应让对应功能降级（工具返回 `unavailable`、命令回报"服务不可用"），
 * 而不该让整个插件（含 S1 的模式切换与提示词注入）跟着不加载。
 *
 * Cordis 的 `inject` 没有 optional 声明（`vendor/cordis/lib/types/registry.d.ts:13-15`
 * 的对象形式是 intercept config），所以可选依赖用 `holdOptional()` 单独维护：
 * 它对每个服务开一个 `ctx.inject([name], …)` 子作用域，服务**加载后**才回调，
 * 拿到真实实例并在 fiber 卸载时自动清空。
 */
export const inject = ['systemPrompt', 'commands', 'sessionProjections', 'agents', 'tools']

/**
 * 可选服务的动态持有者。
 *
 * 为什么不用"调用时 `ctx.get()`"了事：`compaction` 的实现
 * （`@deepseek-ai/dsh-compaction-basic`）在 web-app 里被宿主平面禁用、
 * 改由 agent preset 树挂载（`bundle/web-app/cordis.patch.yml:575-582`），
 * 所以宿主平面可能永远看不到它 —— 只靠 `ctx.get` 会稳定拿到 undefined。
 * 这里先订阅"服务可用"事件拿住真实实例；真正解析时还要先问 agent 自己的作用域
 * （见 `compact-bridge.js` 的 `resolve()`）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ownerCtx
 * @param {string} name 服务键名。
 * @returns {{ get: () => object | undefined }}
 */
function holdOptional(ownerCtx, name) {
  const holder = { current: undefined }
  const ready = ownerCtx.inject([name], (sub) => {
    holder.current = typeof sub.get === 'function' ? sub.get(name) : sub[name]
    return () => { holder.current = undefined }
  })
  // 该子作用域可能一直等不到服务；吞掉 reject，避免变成未处理拒绝。
  void Promise.resolve(ready).catch(() => { holder.current = undefined })
  return {
    get() {
      if (holder.current !== undefined) return holder.current
      try {
        return ownerCtx.get(name)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * 插件主体。
 *
 * 所有注册都在 `ctx.inject(...)` 的异步回调里完成：投影注册是异步的，
 * 必须等它拿到 ready handle 之后才能对外提供读取能力（否则首个装配会读到未就绪的投影）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 已由 Config 校验并填好默认值的配置。
 */
export function apply(ctx, config) {
  /**
   * 可变状态。配置字段都声明了 `.volatile()`，所以编辑配置**不会**重启插件：
   * 这里持有的是同一份 volatile 容器，每次读取都用 `plainConfigOf()` 现取现值。
   */
  const state = { config, handle: null }

  /** agentId → 拆除该 Agent 上下文注册的函数；插件卸载时统一清理。 */
  const agentDisposers = new Map()

  const bootstrap = ctx.inject(inject, async (scoped) => {
    // ---- 1. 投影必须先就绪 ----
    const handle = await scoped.sessionProjections.register(createModeProjection())
    state.handle = handle

    const getConfig = () => plainConfigOf(state.config)
    const readMode = session => (state.handle === null ? MODE_OFF : modeOfSession(state.handle, session))
    const logger = {
      warn: message => scoped.logger.warn(message),
      info: message => scoped.logger.info(message),
    }
    const diag = createDiagSink(logger, getConfig)
    // S4：提示词仓库（三层回落 + mtime 热加载 + 子代理覆盖层）。
    const promptStore = createPromptStore({ getConfig, logger: scoped.logger })

    /** 一键更新：命令行与本地接口共用同一实现。 */
    const runPromptUpdate = async (signal) => {
      const config = getConfig()
      const sourceUrl = config?.prompts?.sourceUrl || DEFAULT_SOURCE_URL
      const allowMirrorFallback = config?.prompts?.allowMirrorFallback !== false
      const result = await updatePrompts({ sourceUrl, root: promptStore.root, signal, logger, allowMirrorFallback })
      promptStore.invalidate()
      return { result, text: formatUpdateResult(result) }
    }
    markSinkReady(getConfig)

    // ---- 2. 可选服务：compaction / userQuestions 用子作用域动态持有 ----
    const compactionHolder = holdOptional(scoped, 'compaction')
    const questionsHolder = holdOptional(scoped, 'userQuestions')

    const bridge = createCompactBridge({
      ctx: scoped,
      getHostCompaction: () => compactionHolder.get(),
      logger,
    })
    scoped.effect(() => () => bridge.dispose(), 'flow: compact bridge')
    // 回合空闲后执行登记的压缩；未登记时该监听器不做任何事。
    scoped.on('agent/status', payload => { bridge.onStatus(payload) })

    // ---- 2b. S3：活跃度 / 双渠道通知 / 熔断 / 团队 SSE ----
    const activity = createActivityTracker({ ctx: scoped })
    scoped.effect(() => () => activity.dispose(), 'flow: activity')

    const imChannel = createImChannel({ ctx: scoped, getConfig, logger })
    const emailChannel = createEmailChannel({ getConfig, logger })
    const notifier = createNotifier({
      getConfig,
      activity,
      im: imChannel,
      email: emailChannel,
      logger,
    })
    scoped.effect(() => () => notifier.dispose(), 'flow: notifier')

    const breaker = createCircuitBreaker({ ctx: scoped, getConfig, notifier, logger, readMode, im: imChannel, diagSink: diag })
    scoped.effect(() => () => breaker.dispose(), 'flow: circuit breaker')

    // 计数放在 `await next()` 之后：不干扰工具结果提交，也不在 waterfall 内急刹。
    scoped.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      breaker.observe(exec, result)
      return decision
    })
    // `agent/pre-step` 的注册下沉到每个 Agent 自己的 ctx（见下方 attach）：
    // 事件在 Cordis 里沿 fiber 链向上派发，只有挂在 Agent 自己子树上的监听器
    // 才能保证 IM 绑定会话、preset 隔离域里的会话也一定经过熔断拦截。

    const teamWatcher = createTeamWatcher({
      getConfig,
      logger,
      onAlert: (payload) => {
        notifier.schedule('team', {
          title: 'Flow 团队异常',
          project: projectNameOf(scoped),
          markdown: [
            '## 团队异常 / 审批',
            '',
            `- 类型：${payload.type}`,
            `- 摘要：${payload.summary}`,
          ].join('\n'),
        })
      },
      onComplete: (payload) => {
        notifier.schedule('archive', {
          title: 'Flow 团队完结',
          project: projectNameOf(scoped),
          markdown: ['## 团队任务完结', '', `- ${payload.summary}`].join('\n'),
        })
      },
    })
    teamWatcher.start()
    scoped.effect(() => () => teamWatcher.stop(), 'flow: team sse')

    // ---- 3. 命令与工具共用的切换事务 ----
    const switchMode = (agent, modeId, signal) => applyModeSwitch({
      ctx: scoped,
      config: getConfig(),
      agent,
      modeId,
      signal,
      logger,
    })

    // ---- 4. 永不变的底座契约（全局 section，固定最小 order）----
    scoped.effect(
      () => installBaseSection(scoped, { getConfig, store: promptStore }),
      'flow: base section',
    )

    // ---- 5. 每个 Agent：模式 context + 方案锚点便利贴 ----
    const attach = (agent) => {
      const id = agent.id
      if (agentDisposers.has(id)) return
      const getMode = () => readMode(agent.session)

      // 双所有者：注册在 agent.ctx 上（Agent 释放即清），同时把拆函数也记在插件侧。
      const disposeMode = agent.ctx.effect(
        () => attachAgentModeContext(agent.ctx, { getConfig, getMode, store: promptStore }),
        'flow: mode context',
      )
      const disposeSpec = agent.ctx.effect(
        () => attachAgentSpecContext(agent.ctx, { agent, getConfig, getMode }),
        'flow: spec context',
      )
      // 熔断拦截必须在 Agent 自己的作用域上注册，IM 会话与 preset 隔离域里的会话
      // 才会同样经过这里（否则微信发来的 1/2/3 会绕过 preStep）。
      const disposePreStep = agent.ctx.on(
        'agent/pre-step',
        (payload, next) => breaker.preStep(payload, next),
      )
      diag(`attach agent=${id} session=${agent.session?.id ?? '(无 sessionId)'} → 已挂 agent/pre-step`)
      agentDisposers.set(id, () => {
        try { disposePreStep() } catch { /* Agent 已释放 */ }
        try { disposeSpec() } catch { /* Agent 已释放 */ }
        try { disposeMode() } catch { /* Agent 已释放 */ }
      })
    }

    scoped.on('agent/created', ({ agent }) => { attach(agent) }, { prepend: true })
    for (const agent of scoped.agents.list()) attach(agent)

    // ---- 6. 工具：全局静态注册一次，永不随模式增删 ----
    // 注册在插件级 ctx 上 = 全局可见；绝不能注册到 agent.ctx，
    // 也不能在切模式时 register/unregister（那会让 toolsChanged 打穿 prefix cache）。
    for (const definition of createFlowTools({
      ctx: scoped,
      getConfig,
      switchMode,
      bridge,
      logger,
      getUserQuestions: () => questionsHolder.get(),
      notifier,
    })) {
      scoped.effect(
        () => scoped.tools.register(definition),
        `flow: tool ${definition.name}`,
      )
    }

    // ---- 7. `/flow` 命令：人类侧的模式切换入口 ----
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
        prompts: {
          store: promptStore,
          update: runPromptUpdate,
        },
      })),
      'flow: command',
    )

    // ---- 7c. 本地回环接口：设置页读写提示词（宿主无 webServer 时静默跳过）----
    ctx.inject(['webServer'], (httpCtx) => {
      try {
        const api = createPromptApi({ store: promptStore, update: runPromptUpdate })
        for (const route of api.routes()) {
          httpCtx.effect(
            () => httpCtx.webServer.register(route),
            `flow: ${route.path}`,
          )
        }
        logger.info(`flow: 已挂载提示词接口 ${API_PREFIX}`)
      } catch (error) {
        logger.warn(`flow: 提示词接口挂载失败 → ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // ---- 7b. 内部命令：把熔断告警渲染成一条可见命令行（0 token、不进模型上下文）----
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

    // ---- 8. 插件卸载时补齐 Agent 侧清理 ----
    scoped.effect(
      () => () => {
        for (const dispose of [...agentDisposers.values()]) {
          try { dispose() } catch { /* 忽略已释放的 Agent */ }
        }
        agentDisposers.clear()
      },
      'flow: agent disposers',
    )

    return async () => {
      state.handle = null
    }
  })

  // 装配失败要在日志里可见，而不是变成静默未激活。
  void Promise.resolve(bootstrap).catch((error) => {
    ctx.logger.error(`flow: 初始化失败 — ${error instanceof Error ? error.message : String(error)}`)
  })
}
