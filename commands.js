/**
 * `/flow` 命令：模式切换的**人类入口**。
 *
 * 为什么走命令而不是自有 Remote：命令是原生通道（`SessionFace.command()` 已存在），
 * 且 `command/run` 是 log-only 事件 —— 既能让 `flowMode` 投影从日志派生，
 * 又不需要 Typert 构建期 codegen。代价是每次切换在对话里留一条命令行，
 * 与原生 `/permission` 芯片完全同构（后者同样走命令）。
 *
 * S2 起本命令不再自己实现切换事务：`switch-mode.js` 是命令与两个工具共用的唯一实现，
 * 避免两套逻辑漂移。这里只负责解析参数、调用事务、组织回执。
 *
 * @module dsh-flow/commands
 */
import {
  MODE_OFF, modeConfigOf, normalizeDocId, parseModeArg,
} from './modes.js'
import { applyModeSwitch } from './switch-mode.js'
import { inspectSpec } from './spec-anchor.js'
import { COMPACT_MESSAGES } from './compact-bridge.js'
import { checkDocs, digestOf, docTitle, ensureDocs } from './flow-docs.js'
import { levelDef } from './flow-level.js'

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'flow'

/** 命令定义 ID。 */
export const COMMAND_ID = 'dsh-flow'

/** 状态类参数的别名：只回报当前模式，不改变任何状态。 */
const STATUS_TOKENS = new Set(['', 'status', 'list', '?'])

/** 可选项提示串。 */
function choicesText() {
  return ['off', 'plan', 'plan-ultra', 'build', 'review', 'flow', 'spec', 'compact'].join(' / ')
}

/** 字节数转人类可读。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * 构造命令定义。
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   getConfig: () => object,
 *   readMode: (session: object) => string,
 *   bridge: { runNow: (agent: object, signal: AbortSignal) => Promise<object> },
 *   logger?: { warn: (msg: string) => void },
 * }} deps
 * @returns {object} 交给 `ctx.commands.register()` 的定义。
 */
export function createFlowCommand({ ctx, getConfig, readMode, bridge, logger, breaker, im, email, prompts, tickets, settler }) {
  /** 当前模式的回执文案。 */
  function statusText(agent, config) {
    const current = readMode(agent.session)
    const label = current === MODE_OFF ? '普通模式（off）' : modeConfigOf(config, current).label
    return `Flow 当前模式：${label}｜可选：${choicesText()}`
  }

  /** `/flow gate …`：门禁票据的桌面兜底入口。 */
  async function gateText(agent, arg) {
    if (tickets === undefined) return { kind: 'error', text: '门禁票据未装配（v0.5.0 未启用）。' }
    const sessionId = String(agent.session?.id ?? '')
    const cwd = String(agent.session?.header?.cwd ?? '')
    const parts = arg.split(/\s+/).filter(Boolean)
    const sub = (parts[1] ?? 'list').toLowerCase()

    if (sub === 'list' || sub === '?') {
      const rows = tickets.list({ sessionId })
      if (rows.length === 0) return { kind: 'success', text: '当前会话没有门禁票据。' }
      const lines = rows.slice(0, 12).map((item) => {
        const mark = item.hold === true ? '⏸hold' : item.state
        const opts = item.options.map((option, index) => `${index + 1}=${option.label}`).join(' ')
        return `#${item.id}｜${mark}｜${item.kind}｜${item.project}｜${opts}`
      })
      lines.push('', '用法：/flow gate answer <id> <1|2|3> [意见]｜/flow gate skip <id>｜/flow gate doc <id>｜/flow gate release <id>')
      return { kind: 'success', text: lines.join('\n') }
    }

    const id = String(parts[2] ?? '').replace(/^#/, '')
    const ticket = tickets.find(id, cwd)
    if (ticket === undefined) return { kind: 'error', text: `没找到票据 #${id || '(缺 id)'}。` }

    if (sub === 'doc') {
      const ids = Array.isArray(ticket.docIds) ? ticket.docIds : []
      if (ids.length === 0) return { kind: 'success', text: `#${ticket.id} 没有关联文档。` }
      const maxChars = Number(getConfig()?.gate?.docDigestChars)
      const { text } = digestOf({
        config: getConfig(),
        cwd: ticket.cwd,
        ids,
        maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 800,
      })
      return { kind: 'success', text: `#${ticket.id} 文档摘要：\n${text}` }
    }

    if (sub === 'release') {
      const released = tickets.releaseHold(sessionId)
      return released > 0
        ? { kind: 'success', text: `已解除 ${released} 张票据的 hold，仍等你决定（不会自动推进）。` }
        : { kind: 'success', text: '没有处于 hold 的票据。' }
    }

    // answer / skip：走结算器（授权与切模式都由它执行，命令不再自己写状态）
    const token = sub === 'skip' ? '2' : String(parts[3] ?? '1')
    const note = parts.slice(sub === 'skip' ? 3 : 4).join(' ')
    const index = Number(token) - 1
    const option = Array.isArray(ticket.options) ? ticket.options[index] : undefined
    if (option === undefined) {
      const map = ticket.options.map((item, i) => `${i + 1}=${item.label}`).join(' ')
      return { kind: 'error', text: `#${ticket.id} 没有第 ${token} 个选项。可用：${map}` }
    }
    if (settler === undefined) {
      return { kind: 'error', text: '结算器未装配，无法执行门禁决定。' }
    }
    const settled = await settler.settle(ticket.id, { action: option.action, by: 'cmd', note })
    if (settled.ok !== true && settled.already !== true) {
      return { kind: 'error', text: settled.reason ?? '结算失败' }
    }
    const effect = settled.effects?.scope === 'once' || settled.effects?.scope === 'session-docs'
      ? '（授权已生效）'
      : settled.effects?.mode?.applied === true ? `（已切到 ${settled.effects.mode.label ?? settled.effects.mode.mode}）` : ''
    // 门禁已改非阻塞：命令结算后没人再往前推，所以把决定写成模型能直接照办的块，
    // 而不是一句"已记录"就完事。
    return {
      kind: 'success',
      text: [
        `[Flow 门禁决定·桌面命令]`,
        `票据 #${ticket.id}｜选项：${option.label}（action=${option.action}）`,
        `附带指令（原样，来自用户）：${note === '' ? '（无）' : note}`,
        '要求：先落实附带指令，再按该选项对应的阶段动作推进；两者冲突时以附带指令为准，并说明你的取舍。',
        effect === '' ? '' : `状态：${effect.replace(/[（）]/g, '')}`,
      ].filter(line => line !== '').join('\n'),
    }
  }

  /** `/flow docs …`：编号文档的桌面入口。 */
  function docsText(agent, arg, config) {
    const cwd = String(agent.session?.header?.cwd ?? '')
    const parts = arg.split(/\s+/).filter(Boolean)
    const sub = (parts[1] ?? 'list').toLowerCase()
    const level = String(config?.docs?.level ?? 'M').toUpperCase()
    const ids = levelDef(level).docs

    if (sub === 'init') {
      const result = ensureDocs({ config, cwd, ids })
      return {
        kind: result.errors.length === 0 ? 'success' : 'error',
        text: [
          result.created.length === 0 ? '新建：无' : `新建：${result.created.join(' ')}`,
          result.skipped.length === 0 ? '已存在：无' : `已存在跳过：${result.skipped.join(' ')}`,
          result.errors.length === 0 ? '' : `失败：${result.errors.map(item => `${item.id}(${item.reason})`).join('；')}`,
        ].filter(Boolean).join('\n'),
      }
    }

    const wanted = parts[1] !== undefined && normalizeDocId(parts[1]) !== null ? [normalizeDocId(parts[1])] : ids
    const checked = checkDocs({ config, cwd, ids: wanted, level })
    const lines = checked.items.map(item => (item.ok
      ? `✓ ${item.id} ${docTitle(item.id)}（${item.bytes} B）`
      : `✗ ${item.id} ${docTitle(item.id)}：${item.reasons.join('；')}`))
    lines.push('', checked.ok ? `全部就绪（等级 ${level}）。` : `还缺 ${checked.failed.join(' ')}。`)
    return { kind: checked.ok ? 'success' : 'error', text: lines.join('\n') }
  }

  /** `/flow spec`：只看方案锚点状态，不读盘两次（inspectSpec 内部有缓存）。 */
  function specText(agent, config) {
    const spec = inspectSpec({ agent, config })
    if (!spec.enabled) {
      return `方案锚点已关闭（设置里 spec.enabled = false）。路径：${spec.display}`
    }
    if (!spec.exists) {
      return `方案锚点：${spec.display} 尚未创建。需要时由你自己建立该文件，插件不会自动创建。`
    }
    const mark = spec.fromMarkedBlock ? '来自 <!-- flow:summary --> 摘要块' : '取自正文前段'
    const preview = spec.summary.split('\n').slice(0, 6).join('\n')
    return [
      `方案锚点：${spec.display}（${formatBytes(spec.bytes)}），摘要${mark}：`,
      preview,
    ].join('\n')
  }

  /**
   * `/flow prompts list`：列出版本、五大模式来源与特种兵清单。
   *
   * @param {object} store 提示词仓库。
   * @returns {string}
   */
  function promptsText(store) {
    const info = store.info()
    const lines = []
    lines.push(`提示词目录：${info.root}`)
    lines.push(`版本：${info.version}${info.updatedAt !== '' ? `（${info.updatedAt}）` : ''}｜清单条目 ${info.fileCount} 个`)
    lines.push(`底座契约来源：${info.base.label}${info.base.exists ? '' : '（文件缺失，已回落兜底）'}`)
    lines.push('', '五大模式来源：')
    for (const item of info.modes) {
      lines.push(`- ${item.id}：${item.label}${item.exists ? '' : '（md 缺失，已回落）'}`)
    }
    lines.push('', '官方特种兵：')
    for (const item of info.official) {
      lines.push(`- ${item.name}：${item.title || '（无标题）'}${item.exists ? '' : '（缺失）'}`)
    }
    lines.push('', `私有特种兵（${info.custom.length} 个）：`)
    if (info.custom.length === 0) {
      lines.push(`- 暂无。把 .md 放进 ${info.customDir} 即可，一键更新不会碰它。`)
    } else {
      for (const item of info.custom) lines.push(`- ${item.name}：${item.title || '（无标题）'}`)
    }
    lines.push('', '更新：`/flow prompts update` 拉远端最新版（不覆盖私有目录，也不改你的手改覆盖）')
    return lines.join('\n')
  }

  return {
    definitionId: COMMAND_ID,
    name: COMMAND_NAME,
    description: '切换 Flow 工作流模式（off / plan / plan-ultra / build / review / flow），或用 spec / compact 查看方案锚点与手动压缩，prompts list|update 查看与更新提示词库，gate list|answer|skip|doc|release 处理门禁票据，docs list|check|init 管理编号文档，retry / escalate / resume 处理熔断，notify-test 自检通知链路',
    input: { hint: '<mode> | status | spec | compact | prompts list|update | gate list|answer|skip|doc|release | docs list|check|init | retry | escalate | resume | notify-test' },
    // 保留 args：`flowMode` 投影正是从 command/run 的 args 派生当前模式。
    recordInput: true,

    async handler({ agent, rawInput, signal }) {
      const config = getConfig()
      const arg = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
      const head = arg.split(/\s+/)[0] ?? ''

      // ---- v0.5.0：门禁票据与编号文档 ----
      if (head === 'gate') return await gateText(agent, arg)
      if (head === 'docs') return docsText(agent, arg, config)

      // ---- 只读：查看方案锚点 ----
      if (head === 'spec') return { kind: 'success', text: specText(agent, config) }

      // ---- 动作：手动压缩 ----
      if (head === 'compact') {
        if (typeof bridge?.runNow !== 'function') {
          return { kind: 'error', text: COMPACT_MESSAGES.unavailable }
        }
        // 命令不持有回合，天然处于 idle；`runNow` 内部仍会按错误码回报 busy。
        const outcome = await bridge.runNow(agent, signal)
        if (outcome.ok === true) {
          const result = outcome.result
          if (result === null || result === undefined) {
            return { kind: 'success', text: '没有可压缩的历史。' }
          }
          const shadowed = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
          const tokens = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0
          return {
            kind: 'success',
            text: `已压缩 ${shadowed} 条历史（约 ${tokens} tokens）。`,
            ...(typeof result.summarySeq === 'number' ? { sourceEventSeq: result.summarySeq } : {}),
          }
        }
        return { kind: 'error', text: outcome.text }
      }

      // ---- 动作：熔断抢救 ----
      if (head === 'retry' || head === 'escalate' || head === 'resume') {
        if (breaker === undefined) {
          return { kind: 'error', text: '熔断器未装配（S3 未启用）。' }
        }
        if (head === 'retry') {
          breaker.retry(agent)
          return { kind: 'success', text: '已清零连续报错计数，并用当前模型重新投递上一条要求。' }
        }
        if (head === 'escalate') {
          const switched = await breaker.escalate(agent, signal)
          return {
            kind: 'success',
            text: switched
              ? '已切到救场强模型，并带报错摘要重新投递上一条要求。'
              : '没有可用的救场强模型（未配置或不可解析），已按当前模型重新投递。',
          }
        }
        breaker.resume(agent)
        return { kind: 'success', text: '已解除熔断暂停状态，等待你的新指令。' }
      }

      // ---- 动作：提示词清单 / 一键更新（S4）----
      if (head === 'prompts') {
        if (prompts?.store === undefined) {
          return { kind: 'error', text: '提示词仓库未装配，无法处理 prompts 子命令。' }
        }
        const sub = arg.split(/\s+/)[1] ?? 'list'
        if (sub === 'update') {
          if (typeof prompts.update !== 'function') {
            return { kind: 'error', text: '更新器未装配。' }
          }
          const { result, text } = await prompts.update(signal)
          return { kind: result.ok === true ? 'success' : 'error', text }
        }
        return { kind: 'success', text: promptsText(prompts.store) }
      }

      // ---- 动作：通知链路自检 ----
      if (head === 'notify-test') {
        if (im === undefined || email === undefined) {
          return { kind: 'error', text: '通知渠道未装配（S3 未启用）。' }
        }
        const imResult = await im.test()
        const emailResult = await email.test()
        const lines = [
          `IM：${imResult.ok ? '成功' : '失败'} — ${imResult.detail}`,
          `邮箱：${emailResult.ok ? '成功' : '失败'} — ${emailResult.detail}`,
        ]
        const bots = await im.listBots()
        if (bots.length > 0) {
          lines.push('', '已配置机器人：')
          for (const bot of bots) {
            const targets = await im.listTargets(bot.botId)
            const names = targets.map(item => item.targetId).filter(Boolean).join('、')
            lines.push(`- ${bot.botId}${bot.channel ? `（${bot.channel}）` : ''}${names === '' ? '' : ` → ${names}`}`)
          }
        } else {
          lines.push('', 'dsh-im 未返回机器人列表：可在「IM机器人」设置页确认连接，或改用 Webhook。')
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      // ---- 只读：当前模式 ----
      if (STATUS_TOKENS.has(head)) {
        return { kind: 'success', text: statusText(agent, config) }
      }

      // ---- 切换 ----
      const target = parseModeArg(arg)
      if (target === null) {
        return {
          kind: 'error',
          text: `未知参数 "${arg}"。可选：${choicesText()}`,
        }
      }

      const applied = await applyModeSwitch({
        ctx,
        config,
        agent,
        modeId: target,
        signal,
        logger,
      })

      const detail = applied.notes.length === 0 ? '' : `（${applied.notes.join('｜')}）`
      const announce = config?.behavior?.announce !== false
      if (target === MODE_OFF) {
        return {
          kind: 'success',
          text: announce
            ? `已关闭 Flow 模式提示词${detail}（权限与模型保持不变）`
            : '已关闭 Flow 模式提示词（权限与模型保持不变）',
        }
      }
      return {
        kind: 'success',
        text: announce ? `Flow 模式：${applied.label}${detail}` : `Flow 模式：${applied.label}`,
      }
    },
  }
}
