/**
 * `/flow` 运维与远程子命令：`compact`、`retry|escalate|resume`、`notify-test`、`feishu`、`help`。
 *
 * @module dsh-flow/commands/ops
 */
import { COMPACT_MESSAGES } from '../modes/compact-bridge.js'

export async function handleCompactCommand({ agent, signal, bridge }) {
  if (typeof bridge?.runNow !== 'function') {
    return { kind: 'error', text: COMPACT_MESSAGES.unavailable }
  }
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

export async function handleBreakerCommand({ head, agent, signal, breaker }) {
  if (breaker === undefined) {
    return { kind: 'error', text: '熔断器未装配。' }
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

export async function handleNotifyTestCommand({ im, email, feishu }) {
  if (im === undefined || email === undefined) {
    return { kind: 'error', text: '通知渠道未装配。' }
  }
  const lines = []
  if (feishu !== undefined) {
    const st = await feishu.status()
    if (st.connected) {
      const fRes = await feishu.sendTestCard()
      lines.push(`飞书直连：${fRes.ok ? '成功' : '失败'} — ${fRes.ok ? fRes.detail : fRes.reason}`)
    } else {
      lines.push(`飞书直连：未连接（状态 ${st.state}${st.lastError ? `：${st.lastError}` : ''}）`)
    }
  }
  const imResult = await im.test()
  const emailResult = await email.test()
  lines.push(
    `IM 通道：${imResult.ok ? '成功' : '失败'} — ${imResult.detail}`,
    `邮箱通道：${emailResult.ok ? '成功' : '失败'} — ${emailResult.detail}`,
  )
  return { kind: 'success', text: lines.join('\n') }
}

export async function handleFeishuCommand({ rawArg, feishu }) {
  if (feishu === undefined) {
    return { kind: 'error', text: '飞书直连模块未装配。' }
  }
  const sub = (String(rawArg ?? '').trim().split(/\s+/)[1] ?? 'status').toLowerCase()
  if (sub === 'connect' || sub === 'reconnect') {
    const res = await feishu.connect()
    return res.ok
      ? { kind: 'success', text: `飞书长连接已建立（appId=${res.appId}，域=${res.domain}）。` }
      : { kind: 'error', text: `飞书连接失败：${res.reason}` }
  }
  if (sub === 'disconnect') {
    await feishu.disconnect()
    return { kind: 'success', text: '已断开飞书长连接。' }
  }
  if (sub === 'test') {
    const res = await feishu.sendTestCard()
    return res.ok
      ? { kind: 'success', text: res.detail }
      : { kind: 'error', text: `发送飞书测试卡片失败：${res.reason}` }
  }
  const st = await feishu.status()
  return {
    kind: 'success',
    text: [
      `飞书直连状态：${st.connected ? '🟢 已连接' : st.state}`,
      `- 机器人：${st.localAlias || st.botName || '未命名'}（App ID：${st.appId || '未绑定'}，域：${st.domain}）`,
      `- 白名单用户数：${st.allowedCount}｜默认推送会话：${st.defaultChatId || '未捕获（在飞书给机器人发消息即自动记录）'}`,
      st.lastError ? `- 最近错误：${st.lastError}` : '',
      '可用子命令：/flow feishu status | connect | disconnect | test',
    ].filter(Boolean).join('\n'),
  }
}

export function handleHelpCommand() {
  return {
    kind: 'success',
    text: [
      'Flow 工作流与远程指挥命令一览：',
      '- `/flow` 或 `/flow status` — 查看当前模式、任务等级、门禁与飞书状态',
      '- `/flow off | plan | plan-ultra | build | review | flow` — 切换工作流模式',
      '- `/flow gate list | answer <id> <1|2|3> [意见] | skip <id> | doc <id> | release [id|all]` — 管理门禁票据',
      '- `/flow docs [list|init|<编号>]` — 查看或初始化编号文档骨架',
      '- `/flow spec` — 查看 `.flow/spec.md` 方案锚点摘要',
      '- `/flow prompts list | update` — 查看提示词来源或一键更新官方提示词',
      '- `/flow feishu status | connect | disconnect | test` — 管理直连飞书指挥官',
      '- `/flow retry | escalate | resume` — 熔断抢救（原模型重试 / 切救场强模型 / 解除暂停）',
      '- `/flow compact` — 手动触发上下文压缩',
      '- `/flow notify-test` — 一键自检飞书 / IM / 邮箱通知链路',
    ].join('\n'),
  }
}
