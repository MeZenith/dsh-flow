/**
 * Flow 工作流与提示词管家 — Host 半。
 *
 * 职责边界（S1）：
 *   - 五大模式 + 关闭态的状态机（真相 = `/flow <mode>` 命令的会话日志）
 *   - 分层提示词注入：永不变底座 section + 每 Agent 一个动态 context
 *   - 模式切换时一次性应用默认模型与权限档位
 *
 * S1 明确不做：`.flow/spec.md` 锚点、Flow 开局 4 选 1 闸门、报错熔断、
 * team-control SSE、邮件通知。这些留给 S2 / S3。
 *
 * @module dsh-flow
 */
import { Config, plainConfigOf } from './config.js'
import { createFlowCommand } from './commands.js'
import { createModeProjection, modeOfSession } from './mode-projection.js'
import { attachAgentModeContext, installBaseSection } from './prompt-bridge.js'

export { Config }

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

/** 硬依赖：缺任一服务则该插件不激活（而不是半残运行）。 */
export const inject = ['systemPrompt', 'commands', 'sessionProjections', 'agents']

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

  /** sessionId → 拆除该 Agent 上下文注册的函数；插件卸载时统一清理。 */
  const agentDisposers = new Map()

  const bootstrap = ctx.inject(
    ['systemPrompt', 'commands', 'sessionProjections', 'agents'],
    async (scoped) => {
      // ---- 1. 投影必须先就绪 ----
      const handle = await scoped.sessionProjections.register(createModeProjection())
      state.handle = handle
      const getConfig = () => plainConfigOf(state.config)
      const readMode = (session) => (state.handle === null ? 'off' : modeOfSession(state.handle, session))

      // ---- 2. 永不变的底座契约（全局 section，固定最小 order）----
      scoped.effect(
        () => installBaseSection(scoped, getConfig),
        'flow: base section',
      )

      // ---- 3. 每个 Agent 一个动态模式 context ----
      const attach = (agent) => {
        const id = agent.id
        if (agentDisposers.has(id)) return
        // 双所有者：注册在 agent.ctx 上（Agent 释放即清），同时把拆函数也记在插件侧。
        const dispose = agent.ctx.effect(
          () => attachAgentModeContext(agent.ctx, {
            getConfig,
            getMode: () => (state.handle === null ? 'off' : modeOfSession(state.handle, agent.session)),
          }),
          'flow: mode context',
        )
        agentDisposers.set(id, () => {
          try { dispose() } catch { /* Agent 已释放 */ }
        })
      }

      scoped.on('agent/created', ({ agent }) => { attach(agent) }, { prepend: true })
      for (const agent of scoped.agents.list()) attach(agent)

      // ---- 4. `/flow` 命令：模式切换的唯一写入口 ----
      scoped.effect(
        () => scoped.commands.register(createFlowCommand({
          ctx: scoped,
          getConfig,
          readMode,
          logger: { warn: message => scoped.logger.warn(message) },
        })),
        'flow: command',
      )

      // ---- 5. 插件卸载时补齐 Agent 侧清理 ----
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
    },
  )

  // 装配失败要在日志里可见，而不是变成静默未激活。
  void Promise.resolve(bootstrap).catch((error) => {
    ctx.logger.error(`flow: 初始化失败 — ${error instanceof Error ? error.message : String(error)}`)
  })
}
