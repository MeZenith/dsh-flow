/**
 * 飞书扫码自助建应用（`lark.registerApp`）与手动凭证校验。
 *
 * - 支持在扫码建应用前自定义机器人名称、简介和头像（1–6 张公网 URL）；
 * - 扫码完成后把 `appSecret` 写入宿主加密凭据库（`ctx.credentials`，缺省退回内存/配置），
 *   绝不在日志中打印明文 secret；
 * - 支持手动填写 AppID / AppSecret 并通过 `/open-apis/bot/v3/info` 拉取机器人真实名称与头像验证连通性。
 *
 * @module dsh-flow/remote/feishu/onboarding
 */
import { ensureNoProxyForFeishu, loadFeishuSdk } from './sdk-loader.js'
import { buildAppPreset, openPlatformAppUrl } from './presets.js'
import { encodeQrDataUrl } from './qr-svg.js'
import { SLASH_COMMAND_SCOPES } from './slash-commands.js'

/** 飞书扫码建应用所需的最小权限、事件与卡片回调集（含文件上传、CardKit 流式卡片与原生 / 指令菜单）。 */
export const FEISHU_REQUIRED_SCOPES = Object.freeze([
  'im:message',
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:resource',
  'im:chat:readonly',
  'contact:user.base:readonly',
  'cardkit:card:write',
  ...SLASH_COMMAND_SCOPES,
])

export const FEISHU_REQUIRED_EVENTS = Object.freeze([
  'im.message.receive_v1',
])

export const FEISHU_REQUIRED_CALLBACKS = Object.freeze([
  'card.action.trigger',
])

/** 扫码建应用 `lark.registerApp` 要求传入裸主机名（内部自行拼 `https://`），不可传 `lark.Domain` 数字枚举！ */
export function registrationHostOf(domain = 'feishu') {
  return domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn'
}

/** 格式化飞书网络/证书异常为可读提示。 */
export function formatOnboardingError(error) {
  const raw = error instanceof Error
    ? error.message
    : (typeof error?.description === 'string' && error.description !== '' ? error.description : String(error ?? ''))
  const code = String(error?.code ?? '')
  if (code === 'CERT_HAS_EXPIRED' || /certificate has expired/i.test(raw)) {
    return 'TLS 证书校验失败（certificate has expired）：请检查本机系统时间是否准确，或确认本机代理未拦截 accounts.feishu.cn。'
  }
  if (code === 'expired_token') {
    return '二维码已过期，请重新点击扫码生成新的二维码。'
  }
  if (code === 'access_denied') {
    return '已在手机端取消授权，可随时重新扫码创建。'
  }
  return raw || '扫码建应用失败，请重试'
}

/** DSH `ctx.credentials` 严格要求 CredentialRef 符合 POSIX 变量名 `/^[A-Za-z_][A-Za-z0-9_]*$/`。 */
export const FEISHU_SECRET_CRED_REF = 'DSH_FLOW_FEISHU_APP_SECRET'

/**
 * 读取/保存 AppSecret（优先宿主 `ctx.credentials` 的 `resolve/set/unset`，不可用时走配置/内存回退并记告警）。
 *
 * @param {{ getCredentials?: () => object | undefined, getConfig: () => object, logger?: { warn?: Function } }} deps
 */
export function createFeishuSecretStore({ getCredentials, getConfig, logger }) {
  let memorySecret = ''
  let storageMode = 'none' // 'credentials' | 'config' | 'memory' | 'none'
  let fallbackWarned = false

  function warnFallback(reason) {
    if (fallbackWarned) return
    fallbackWarned = true
    logger?.warn?.(`flow: 飞书 AppSecret 正在使用降级存储（${reason}）；建议在支持 ctx.credentials 的 DSH 环境下运行以获得加密存储。`)
  }

  async function save(secret) {
    const clean = String(secret ?? '').trim()
    memorySecret = clean
    if (clean === '') {
      storageMode = 'none'
      return { stored: 'empty' }
    }
    try {
      const creds = getCredentials?.()
      if (creds !== undefined && typeof creds.set === 'function') {
        await creds.set(FEISHU_SECRET_CRED_REF, clean)
        storageMode = 'credentials'
        return { stored: 'credentials' }
      }
    } catch { /* 宿主凭据服务不可用时回退内存/配置并记一次性告警 */ }
    storageMode = 'memory'
    warnFallback('宿主 ctx.credentials 不可用，仅暂存于进程内存')
    return { stored: 'memory' }
  }

  async function load(overrideSecret) {
    if (typeof overrideSecret === 'string' && overrideSecret.trim() !== '') {
      return overrideSecret.trim()
    }
    // P1-8 修复：优先使用本进程最新保存的密钥与宿主安全凭据库，避免旧配置里的过期 appSecret 覆盖扫码新密钥。
    if (memorySecret !== '') return memorySecret
    try {
      const creds = getCredentials?.()
      if (creds !== undefined) {
        if (typeof creds.resolve === 'function') {
          const resolved = await creds.resolve(FEISHU_SECRET_CRED_REF)
          const val = typeof resolved === 'string' ? resolved : resolved?.value
          if (typeof val === 'string' && val.trim() !== '') {
            memorySecret = val.trim()
            storageMode = 'credentials'
            return memorySecret
          }
        } else if (typeof creds.get === 'function') {
          const val = await creds.get(FEISHU_SECRET_CRED_REF)
          if (typeof val === 'string' && val.trim() !== '') {
            memorySecret = val.trim()
            storageMode = 'credentials'
            return memorySecret
          }
        }
      }
    } catch { /* 回落配置中的 appSecret */ }
    const fromConfig = String(getConfig?.()?.feishu?.appSecret ?? '').trim()
    if (fromConfig !== '') {
      storageMode = 'config'
      warnFallback('当前从明文配置读取 appSecret')
      return fromConfig
    }
    return ''
  }

  async function clear() {
    memorySecret = ''
    storageMode = 'none'
    try {
      const creds = getCredentials?.()
      if (creds !== undefined) {
        if (typeof creds.unset === 'function') {
          await creds.unset(FEISHU_SECRET_CRED_REF)
        } else if (typeof creds.delete === 'function') {
          await creds.delete(FEISHU_SECRET_CRED_REF)
        }
      }
    } catch { /* dispose-path */ }
  }

  function storageInfo() {
    return {
      mode: storageMode,
      isFallback: storageMode === 'config' || storageMode === 'memory',
    }
  }

  return { save, load, clear, storageInfo }
}

/**
 * 校验一组 AppID / AppSecret 并获取机器人已发布信息（名称、头像、open_id）。
 */
export async function verifyFeishuCredentials({ appId, appSecret, domain = 'feishu' }) {
  const cleanId = String(appId ?? '').trim()
  const cleanSecret = String(appSecret ?? '').trim()
  if (cleanId === '' || cleanSecret === '') {
    return { ok: false, reason: '请填写完整的 App ID 和 App Secret' }
  }
  const loaded = await loadFeishuSdk()
  if (!loaded.ok) return { ok: false, reason: loaded.reason }

  ensureNoProxyForFeishu(domain)
  const { lark } = loaded
  const sdkDomain = domain === 'lark' ? (lark.Domain?.Lark ?? 'https://open.larksuite.com') : (lark.Domain?.Feishu ?? 'https://open.feishu.cn')

  try {
    const client = new lark.Client({
      appId: cleanId,
      appSecret: cleanSecret,
      domain: sdkDomain,
      disableTokenCache: false,
    })
    const res = await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })
    const code = res?.code ?? 0
    if (code !== 0) {
      return { ok: false, reason: `飞书校验失败（code=${code}：${res?.msg ?? '凭证无效或未开启机器人能力'}）` }
    }
    const bot = res?.bot ?? res?.data?.bot ?? {}
    return {
      ok: true,
      appId: cleanId,
      domain,
      botName: String(bot.app_name ?? ''),
      botAvatarUrl: String(bot.avatar_url ?? ''),
      botOpenId: String(bot.open_id ?? ''),
      openPlatformUrl: openPlatformAppUrl(cleanId, domain),
    }
  } catch (error) {
    return { ok: false, reason: `飞书接口校验异常：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 创建扫码建应用状态机（同时只允许一个扫码流程在飞）。
 *
 * @param {{
 *   secretStore: ReturnType<typeof createFeishuSecretStore>,
 *   onCompleted?: (result: { appId: string, appSecret: string, domain: string, ownerOpenId: string, botName: string, botAvatarUrl: string }) => Promise<void> | void,
 *   logger?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createFeishuOnboarding({ secretStore, onCompleted, logger }) {
  let controller = null
  let state = {
    phase: 'idle', // idle | starting | qr_ready | scanned | completed | failed | cancelled
    domain: 'feishu',
    qrUrl: '',
    qrText: '',
    qrSvgDataUrl: '',
    expiresAt: 0,
    statusText: '',
    appId: '',
    ownerOpenId: '',
    botName: '',
    botAvatarUrl: '',
    openPlatformUrl: '',
    error: '',
    updatedAt: 0,
  }

  function snapshot() {
    return { ...state }
  }

  function updateState(patch) {
    state = { ...state, ...patch, updatedAt: Date.now() }
  }

  function cancel() {
    if (controller !== null) {
      try { controller.abort() } catch { /* 忽略 */ }
      controller = null
    }
    if (state.phase === 'starting' || state.phase === 'qr_ready' || state.phase === 'scanned') {
      updateState({ phase: 'cancelled', statusText: '已取消扫码建应用' })
    }
  }

  /**
   * 启动扫码创建飞书机器人应用，或对已有应用扫码一键补权（传 `upgradeAppId`）。
   *
   * @param {{ domain?: 'feishu'|'lark', botName?: string, botDescription?: string, botAvatarUrl?: string, upgradeAppId?: string }} input
   */
  async function start({ domain = 'feishu', botName, botDescription, botAvatarUrl, upgradeAppId } = {}) {
    cancel()
    const cleanUpgradeId = String(upgradeAppId ?? '').trim()
    const isUpgrade = cleanUpgradeId !== ''

    const preset = isUpgrade
      ? { ok: true, appPreset: null }
      : buildAppPreset({
        name: botName,
        description: botDescription,
        avatarUrl: botAvatarUrl,
      })
    if (!preset.ok) {
      updateState({ phase: 'failed', error: preset.reason, statusText: preset.reason })
      return { ok: false, reason: preset.reason, data: snapshot() }
    }

    const loaded = await loadFeishuSdk()
    if (!loaded.ok) {
      updateState({ phase: 'failed', error: loaded.reason, statusText: loaded.reason })
      return { ok: false, reason: loaded.reason, data: snapshot() }
    }
    const { lark } = loaded
    if (typeof lark.registerApp !== 'function') {
      const reason = '当前 @larksuiteoapi/node-sdk 版本不支持扫码建应用（需要 v1.73.0+），请升级依赖或改用手动填写 App ID / App Secret。'
      updateState({ phase: 'failed', error: reason, statusText: reason })
      return { ok: false, reason, data: snapshot() }
    }

    ensureNoProxyForFeishu(domain)
    const cleanDomain = domain === 'lark' ? 'lark' : 'feishu'
    const regHost = registrationHostOf(cleanDomain)

    controller = new AbortController()
    const currentController = controller
    updateState({
      phase: 'starting',
      domain: cleanDomain,
      qrUrl: '',
      qrText: '',
      qrSvgDataUrl: '',
      expiresAt: 0,
      statusText: isUpgrade ? '正在生成权限升级二维码…' : '正在向飞书开放平台申请创建二维码…',
      appId: cleanUpgradeId,
      ownerOpenId: '',
      botName: preset.appPreset?.name ?? String(botName ?? '').trim(),
      botAvatarUrl: preset.appPreset?.avatar?.[0] ?? '',
      openPlatformUrl: '',
      error: '',
    })

    // 后台等待用户扫码完成，不等整条 Promise 结束就尽快在二维码就绪后返回给前端。
    let resolveQrReady
    const qrReadyPromise = new Promise((resolve) => { resolveQrReady = resolve })
    let qrSettled = false
    const notifyQr = (res) => {
      if (qrSettled) return
      qrSettled = true
      resolveQrReady(res)
    }

    void (async () => {
      try {
        const regOpts = {
          domain: regHost,
          larkDomain: 'accounts.larksuite.com',
          source: 'dsh-flow',
          addons: {
            preset: false,
            scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] },
            events: { items: { tenant: [...FEISHU_REQUIRED_EVENTS] } },
            callbacks: { items: [...FEISHU_REQUIRED_CALLBACKS] },
          },
          signal: currentController.signal,
          onQRCodeReady(info) {
            if (currentController.signal.aborted) return
            const url = String(info?.url ?? info?.qrCodeUrl ?? info?.verification_uri_complete ?? '')
            const qrText = String(info?.qrCode ?? info?.qrAscii ?? '')
            let qrSvgDataUrl = ''
            if (url !== '') {
              try { qrSvgDataUrl = encodeQrDataUrl(url) } catch { qrSvgDataUrl = '' }
            }
            const expireSec = Number(info?.expireIn ?? info?.expiresIn ?? 300)
            updateState({
              phase: 'qr_ready',
              qrUrl: url,
              qrText,
              qrSvgDataUrl,
              expiresAt: Date.now() + (Number.isFinite(expireSec) && expireSec > 0 ? expireSec * 1000 : 300_000),
              statusText: isUpgrade
                ? '请用手机飞书扫码确认补齐权限（含 / 指令菜单、流式卡片与文件上传）'
                : '请用手机飞书扫码，并在手机上点「确认创建」',
            })
            notifyQr({ ok: true })
          },
          onStatusChange(info) {
            if (currentController.signal.aborted) return
            const status = String(info?.status ?? info?.state ?? '').toLowerCase()
            const msg = String(info?.message ?? info?.description ?? '')
            if (status.includes('scan') || status.includes('confirm')) {
              updateState({ phase: 'scanned', statusText: msg || '已扫码，请在手机飞书上确认…' })
            } else if (status === 'domain_switched') {
              ensureNoProxyForFeishu('lark')
              updateState({ domain: 'lark', statusText: '检测到国际版 Lark 账号，已自动切换区域继续等待确认…' })
            } else if (msg !== '') {
              updateState({ statusText: msg })
            }
          },
        }
        if (isUpgrade) {
          regOpts.appId = cleanUpgradeId
        } else if (preset.appPreset) {
          regOpts.appPreset = preset.appPreset
        }

        const created = await lark.registerApp(regOpts)

        if (currentController.signal.aborted) return
        const appId = String(created?.client_id ?? created?.app_id ?? created?.appId ?? cleanUpgradeId).trim()
        const appSecret = String(created?.client_secret ?? created?.app_secret ?? created?.appSecret ?? '').trim()
        const ownerOpenId = String(
          created?.user_info?.open_id
          ?? created?.open_id
          ?? created?.user_open_id
          ?? created?.userOpenId
          ?? '',
        ).trim()
        if (appId === '' || appSecret === '') {
          throw new Error('飞书建应用未返回有效的 client_id / client_secret')
        }

        await secretStore.save(appSecret)
        const finalDomain = state.domain === 'lark' ? 'lark' : cleanDomain
        const platformUrl = openPlatformAppUrl(appId, finalDomain)
        updateState({
          phase: 'completed',
          domain: finalDomain,
          appId,
          ownerOpenId,
          openPlatformUrl: platformUrl,
          statusText: isUpgrade
            ? `权限升级完成（${appId}），正在重连并同步 / 快捷菜单…`
            : `应用创建成功（${appId}），正在自动建立 WebSocket 长连接…`,
          error: '',
        })
        notifyQr({ ok: true })
        logger?.info?.(`flow: 飞书扫码${isUpgrade ? '补权' : '建应用'}完成 appId=${appId} domain=${finalDomain}`)

        try {
          await onCompleted?.({
            appId,
            appSecret,
            domain: finalDomain,
            ownerOpenId,
            botName: preset.appPreset?.name ?? String(botName ?? '').trim(),
            botAvatarUrl: preset.appPreset?.avatar?.[0] ?? '',
            isUpgrade,
          })
        } catch (cbError) {
          logger?.warn?.(`flow: 飞书扫码完成后自动连接失败 → ${cbError instanceof Error ? cbError.message : String(cbError)}`)
        }
      } catch (error) {
        if (currentController.signal.aborted) {
          notifyQr({ ok: false, reason: '已取消' })
          return
        }
        const message = formatOnboardingError(error)
        updateState({ phase: 'failed', error: message, statusText: message })
        notifyQr({ ok: false, reason: message })
      } finally {
        if (controller === currentController) controller = null
      }
    })()

    // 最多等 8 秒拿到二维码，超时也返回当前状态由前端继续轮询。
    const waitResult = await Promise.race([
      qrReadyPromise,
      new Promise(resolve => {
        const t = setTimeout(() => resolve({ ok: true, pending: true }), 8_000)
        if (typeof t.unref === 'function') t.unref()
      }),
    ])

    return {
      ok: waitResult.ok !== false,
      reason: waitResult.reason,
      data: snapshot(),
    }
  }

  return { start, cancel, status: snapshot }
}
