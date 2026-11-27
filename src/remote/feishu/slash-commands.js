/**
 * 飞书原生 `/` 快捷指令面板注册器（`/open-apis/application/v7/app_slash_commands`）。
 *
 * 注册成功后，用户在飞书聊天输入框键入 `/` 或点击输入框指令入口，键盘上方会自动弹出
 * 原生指令菜单，点选即以普通文本发出，直接命中 `router.js`。
 *
 * @module dsh-flow/remote/feishu/slash-commands
 */

export const SLASH_COMMAND_SCOPES = Object.freeze([
  'application:app_slash_command:read',
  'application:app_slash_command:write',
])

const SLASH_ENDPOINT = '/open-apis/application/v7/app_slash_commands'
const MISSING_SCOPE_CODES = new Set(['99991640', '99991672', '99991663'])

/** Flow 指挥官高频指令清单（按期望在飞书面板从上到下显示的顺序排列）。 */
export const FLOW_SLASH_COMMANDS = Object.freeze([
  { command: 'm', icon: 'folder_outlined', zh: '切换桌面项目与在线会话', en: 'Switch desktop project or session' },
  { command: 'mode', icon: 'skill_outlined', zh: '切换模式（Flow / Plan / Build / Review）', en: 'Switch Flow mode' },
  { command: 'p', icon: 'flag_outlined', zh: '查看待审批门禁与熔断告警', en: 'View pending gates and alerts' },
  { command: 'stop', icon: 'clear_outlined', zh: '停止当前正在运行的 AI 回合', en: 'Stop the active turn' },
  { command: 'help', icon: 'promptword_outlined', zh: '打开使用指南与指令大全', en: 'Open quick-start guide' },
  { command: 'id', icon: 'ai-agent_outlined', zh: '查看我的 open_id 与会话 ID', en: 'Show my open_id and chat_id' },
])

function extractCode(errorOrBody) {
  const raw = errorOrBody?.code ?? errorOrBody?.response?.data?.code
  return raw === undefined || raw === null ? '' : String(raw)
}

function isMissingPermission(errorOrBody) {
  const code = extractCode(errorOrBody)
  if (MISSING_SCOPE_CODES.has(code)) return true
  const msg = String(errorOrBody?.msg ?? errorOrBody?.message ?? errorOrBody?.response?.data?.msg ?? '')
  return /permission|scope|99991672|99991640/i.test(msg)
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

/**
 * 幂等同步飞书原生 `/` 指令菜单。
 *
 * - 已有全部指令时零写操作直接返回 `already_synced`；
 * - 若应用尚未开通 `application:app_slash_command:read/write` 权限，返回 `missing_permission`（不抛异常）；
 * - 飞书面板按创建时间倒序展示，因此在补建多条指令时按逆序创建。
 *
 * @param {{ apiClient: object, manifest?: readonly object[], delayMs?: number, logger?: { info?: Function, warn?: Function } }} opts
 */
export async function syncFeishuSlashCommands({
  apiClient,
  manifest = FLOW_SLASH_COMMANDS,
  delayMs = 1100,
  logger,
}) {
  if (!apiClient || typeof apiClient.request !== 'function') {
    return { ok: false, status: 'unavailable', reason: '飞书客户端未连接' }
  }

  let existing = []
  try {
    const res = await apiClient.request({ method: 'GET', url: SLASH_ENDPOINT })
    if (res?.code !== undefined && res.code !== 0) {
      if (isMissingPermission(res)) {
        return {
          ok: false,
          status: 'missing_permission',
          reason: '当前飞书应用尚未开通「斜杠指令菜单」权限，请点「扫码补权」一键开通。',
        }
      }
      return { ok: false, status: 'error', reason: `读取飞书指令失败（code=${res.code}：${res.msg ?? ''}）` }
    }
    existing = Array.isArray(res?.data?.items) ? res.data.items : []
  } catch (error) {
    if (isMissingPermission(error)) {
      return {
        ok: false,
        status: 'missing_permission',
        reason: '当前飞书应用尚未开通「斜杠指令菜单」权限，请点「扫码补权」一键开通。',
      }
    }
    return {
      ok: false,
      status: 'error',
      reason: `读取飞书指令异常：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const existingNames = new Set(existing.map(item => String(item?.command ?? '').trim().toLowerCase()).filter(Boolean))
  const missing = manifest.filter(item => !existingNames.has(item.command.toLowerCase()))

  if (missing.length === 0) {
    return { ok: true, status: 'already_synced', created: 0, total: manifest.length }
  }

  // 逆序创建，让首项 `/m` 在飞书最新优先排序下排在最上方
  const ordered = [...missing].reverse()
  let created = 0
  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i]
    try {
      const res = await apiClient.request({
        method: 'POST',
        url: SLASH_ENDPOINT,
        data: {
          command: entry.command,
          description: {
            default_value: entry.zh,
            i18n: { zh_cn: entry.zh, en_us: entry.en },
            icon: { icon_key: entry.icon || 'ai-agent_outlined' },
          },
        },
      })
      if (res?.code !== undefined && res.code !== 0) {
        if (isMissingPermission(res)) {
          return {
            ok: false,
            status: 'missing_permission',
            created,
            reason: '缺少写入飞书 `/` 指令权限，请点「扫码补权」一键开通。',
          }
        }
        return {
          ok: false,
          status: 'error',
          created,
          reason: `注册 /${entry.command} 失败（code=${res.code}：${res.msg ?? ''}）`,
        }
      }
      created += 1
      if (i < ordered.length - 1 && delayMs > 0) await sleep(delayMs)
    } catch (error) {
      if (isMissingPermission(error)) {
        return {
          ok: false,
          status: 'missing_permission',
          created,
          reason: '缺少写入飞书 `/` 指令权限，请点「扫码补权」一键开通。',
        }
      }
      return {
        ok: false,
        status: 'error',
        created,
        reason: `注册 /${entry.command} 异常：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  logger?.info?.(`flow: 已同步 ${created} 条飞书原生 / 快捷指令`)
  return { ok: true, status: 'synced', created, total: manifest.length }
}
