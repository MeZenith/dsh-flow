/**
 * Tab 3：飞书远程指挥（Apple 极简配对体验 + 渐进披露）。
 *
 * 交互设计：
 * - 未连接态：单张极简配对卡片（起名 + 6 枚头像点选 + 区域 + 居中「扫码创建并连接」主按钮）；
 * - 扫码态：居中白底矢量 SVG 二维码 + 3 步实时进度指示（飞书扫码 → 手机确认 → 自动连接）；
 * - 已连接态：顶部机器人状态 Hero + 清晰「接下来」行动指引 + 4 项推送滑动开关 + 访问安全；
 * - 邮箱归档、事件分流、Team 联动与旧版 dsh-im 全部收纳进底部折叠区，零干扰。
 *
 * @module dsh-flow/client/tabs/remote-tab
 */
const FALLBACK_AVATAR_PRESETS = [
  { id: 'commander', label: '指挥官', emoji: '🚀', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f680.png' },
  { id: 'robot', label: '智能助手', emoji: '🤖', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f916.png' },
  { id: 'compass', label: '领航罗盘', emoji: '🧭', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f9ed.png' },
  { id: 'lightning', label: '极速开发', emoji: '⚡', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/26a1.png' },
  { id: 'shield', label: '质量守卫', emoji: '🛡️', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f6e1.png' },
  { id: 'cat', label: '代码猫猫', emoji: '🐱', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f431.png' },
]

function RemoteTab({ value, disabled, setField, t, onFeishuState }) {
  const feishuCfg = value?.feishu && typeof value.feishu === 'object' ? value.feishu : {}
  const imCfg = value?.im && typeof value.im === 'object' ? value.im : {}
  const imWebhook = imCfg.webhook && typeof imCfg.webhook === 'object' ? imCfg.webhook : {}
  const mailCfg = value?.email && typeof value.email === 'object' ? value.email : {}
  const notifyCfg = value?.notify && typeof value.notify === 'object' ? value.notify : {}
  const teamCfg = value?.team && typeof value.team === 'object' ? value.team : {}

  const [feishuStatus, setFeishuStatus] = useState(null)
  const [presets, setPresets] = useState(FALLBACK_AVATAR_PRESETS)
  const [onboard, setOnboard] = useState(null)
  const [manualMode, setManualMode] = useState(false)
  const [botNameDraft, setBotNameDraft] = useState(() => (typeof feishuCfg.botName === 'string' && feishuCfg.botName !== '' ? feishuCfg.botName : 'Flow 指挥官'))
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [testReport, setTestReport] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (typeof feishuCfg.botName === 'string' && feishuCfg.botName !== '') {
      setBotNameDraft(feishuCfg.botName)
    }
  }, [feishuCfg.botName])

  const refreshFeishuStatus = useCallback(() => {
    apiCall('GET', '/api/dsh-flow/feishu/status')
      .then((res) => {
        if (res?.data) {
          setFeishuStatus(res.data)
          onFeishuState?.(res.data.state ?? 'disconnected')
          if (res.data.onboarding) setOnboard(res.data.onboarding)
        }
      })
      .catch(() => {})
  }, [onFeishuState])

  useEffect(() => {
    refreshFeishuStatus()
    apiCall('GET', '/api/dsh-flow/feishu/presets')
      .then((res) => {
        if (Array.isArray(res?.data?.avatars) && res.data.avatars.length > 0) setPresets(res.data.avatars)
      })
      .catch(() => {})
  }, [refreshFeishuStatus])

  const isOnboardingActive = onboard && (
    onboard.phase === 'starting' || onboard.phase === 'qr_ready' || onboard.phase === 'scanned'
  )

  useEffect(() => {
    if (!isOnboardingActive) return undefined
    const timer = setInterval(() => {
      apiCall('GET', '/api/dsh-flow/feishu/onboard/status')
        .then((res) => {
          const data = res?.data
          if (!data) return
          setOnboard(data)
          if (data.phase === 'completed') {
            if (data.appId) setField(['feishu', 'appId'], data.appId)
            setField(['feishu', 'enabled'], true)
            if (data.ownerOpenId) {
              const prev = Array.isArray(feishuCfg.allowedOpenIds) ? feishuCfg.allowedOpenIds : []
              if (!prev.includes(data.ownerOpenId)) setField(['feishu', 'allowedOpenIds'], [...prev, data.ownerOpenId])
            }
            setFeedback({ kind: 'ok', text: `已连接 ${data.appId}` })
            refreshFeishuStatus()
          } else if (data.phase === 'failed') {
            setFeedback({ kind: 'error', text: data.error || data.statusText || '扫码建应用失败' })
          }
        })
        .catch(() => {})
    }, 2000)
    return () => { clearInterval(timer) }
  }, [isOnboardingActive, feishuCfg.allowedOpenIds, setField, refreshFeishuStatus])

  const runAction = async (key, fn) => {
    setBusy(key)
    setFeedback(null)
    try {
      await fn()
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  const startQrFlow = () => {
    setManualMode(false)
    const effectiveName = botNameDraft.trim() || feishuCfg.botName || 'Flow 指挥官'
    void runAction('qr', async () => {
      const res = await apiCall('POST', '/api/dsh-flow/feishu/onboard/start', {
        domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
        botName: effectiveName,
        botDescription: feishuCfg.botDescription || '',
        botAvatarUrl: feishuCfg.botAvatarUrl || presets[0]?.url || '',
      })
      setOnboard(res.data)
    })
  }

  const startUpgradeFlow = () => {
    setManualMode(false)
    void runAction('upgrade', async () => {
      const res = await apiCall('POST', '/api/dsh-flow/feishu/onboard/upgrade', {
        appId: feishuStatus?.appId || feishuCfg.appId || '',
        domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
      })
      setOnboard(res.data)
    })
  }

  const handleLocalAvatarFile = (event) => {
    const file = event.target?.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (dataUrl === '') return
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 96
          canvas.height = 96
          const ctx2d = canvas.getContext('2d')
          ctx2d.drawImage(img, 0, 0, 96, 96)
          setField(['feishu', 'localAvatar'], canvas.toDataURL('image/png'))
        } catch {
          if (dataUrl.length <= 160_000) setField(['feishu', 'localAvatar'], dataUrl)
        }
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  const connState = feishuStatus?.state ?? 'disconnected'
  const isConnected = connState === 'connected'
  const appId = String(feishuStatus?.appId || feishuCfg.appId || '').trim()
  const hasApp = isConnected || appId !== ''

  const statusText = connState === 'connected'
    ? t('feishu.statusConnected')
    : connState === 'connecting'
      ? t('feishu.statusConnecting')
      : connState === 'error'
        ? t('feishu.statusError')
        : t('feishu.statusDisconnected')

  const previewName = feishuCfg.localAlias || feishuStatus?.botName || botNameDraft.trim() || feishuCfg.botName || 'Flow 指挥官'
  const activeAvatarUrl = feishuCfg.botAvatarUrl || presets[0]?.url || ''
  const previewAvatar = feishuCfg.localAvatar || activeAvatarUrl || feishuStatus?.botAvatarUrl || ''
  const allowedList = Array.isArray(feishuCfg.allowedOpenIds) ? feishuCfg.allowedOpenIds : []
  const allowedLine = allowedList.join(', ')
  const hasTarget = allowedList.length > 0 || String(feishuCfg.defaultChatId || feishuStatus?.defaultChatId || '').trim() !== ''

  const regionOptions = [
    { value: 'feishu', label: t('feishu.regionFeishu') },
    { value: 'lark', label: t('feishu.regionLark') },
  ]
  const strategyOptions = [
    { value: 'im-first', label: t('strategy.imFirst') },
    { value: 'email-first', label: t('strategy.emailFirst') },
    { value: 'both', label: t('strategy.both') },
    { value: 'off', label: t('strategy.off') },
  ]
  const providerOptions = [
    { value: 'qq', label: t('provider.qq') },
    { value: 'netease', label: t('provider.netease') },
    { value: 'gmail', label: t('provider.gmail') },
    { value: 'custom', label: t('provider.custom') },
  ]
  const webhookKinds = [
    { value: 'feishu', label: t('webhook.feishu') },
    { value: 'dingtalk', label: t('webhook.dingtalk') },
    { value: 'wecom', label: t('webhook.wecom') },
    { value: 'bark', label: t('webhook.bark') },
    { value: 'pushplus', label: t('webhook.pushplus') },
    { value: 'custom', label: t('webhook.custom') },
  ]

  const emailEnabled = mailCfg.enabled === true
  const imEnabled = imCfg.enabled === true
  const isCustomSmtp = (mailCfg.provider ?? 'qq') === 'custom'
  const channelsSummary = emailEnabled && imEnabled
    ? t('feishu.channelsSummaryBoth')
    : emailEnabled
      ? t('feishu.channelsSummaryEmail')
      : imEnabled
        ? t('feishu.channelsSummaryIm')
        : t('feishu.channelsSummaryNone')

  /* ---- 扫码步骤进度条 ---- */
  const qrStepIndex = onboard?.phase === 'scanned' ? 1 : (onboard?.phase === 'completed' ? 2 : 0)
  const qrStage = h('div', { className: 'dsh-flow-qr-stage' },
    onboard?.qrSvgDataUrl
      ? h('div', { className: 'dsh-flow-qr-frame' },
        h('img', { src: onboard.qrSvgDataUrl, alt: 'Feishu QR Code' }))
      : h('div', { className: 'dsh-flow-qr-frame' },
        h('span', { className: 'dsh-flow-hint' }, t('feishu.qrStarting'))),
    h('div', { className: 'dsh-flow-steps' },
      [t('feishu.stepScan'), t('feishu.stepConfirm'), t('feishu.stepReady')].map((label, idx) => h(React.Fragment, { key: label },
        idx > 0 ? h('span', { className: 'dsh-flow-step-arrow', 'aria-hidden': true }, '→') : null,
        h('span', {
          className: 'dsh-flow-step',
          'data-active': idx === qrStepIndex ? 'true' : 'false',
          'data-done': idx < qrStepIndex ? 'true' : 'false',
        },
        h('span', { className: 'dsh-flow-step-num' }, idx < qrStepIndex ? '✓' : String(idx + 1)),
        h('span', null, label))))),
    h('div', { className: 'dsh-flow-row' },
      onboard?.qrUrl
        ? h('a', {
          className: 'dsh-flow-btn-link',
          href: onboard.qrUrl,
          target: '_blank',
          rel: 'noreferrer',
        }, t('feishu.qrOpenBrowser'))
        : null,
      h('button', {
        type: 'button',
        className: 'dsh-flow-btn-link',
        style: { color: 'var(--dsw-alias-label-tertiary)' },
        onClick: () => {
          void apiCall('POST', '/api/dsh-flow/feishu/onboard/cancel').finally(() => { setOnboard(null) })
        },
      }, t('common.cancel'))))

  /* ---- 顶部 Hero 卡片（根据未连接 / 扫码中 / 已连接三态自适应） ---- */
  const heroCard = h('div', { className: 'dsh-flow-hero' },
    h('div', { className: 'dsh-flow-hero-top' },
      previewAvatar
        ? h('img', { className: 'dsh-flow-avatar', src: previewAvatar, alt: previewName })
        : h('div', { className: 'dsh-flow-avatar' }, '🚀'),
      h('div', { className: 'dsh-flow-hero-info' },
        h('div', { className: 'dsh-flow-hero-name-row' },
          h('span', { className: 'dsh-flow-hero-name' }, previewName),
          h('span', { className: 'dsh-flow-badge' },
            h('span', { className: 'dsh-flow-dot', 'data-state': connState }),
            statusText)),
        h('span', { className: 'dsh-flow-hero-meta' },
          appId
            ? `${appId} · ${feishuCfg.domain === 'lark' ? 'Lark' : '飞书'}`
            : t('feishu.heroIdleSub'))),
      isConnected
        ? h('button', {
          type: 'button',
          className: 'dsh-flow-btn',
          disabled: busy === 'disconnect',
          onClick: () => {
            void runAction('disconnect', async () => {
              await apiCall('POST', '/api/dsh-flow/feishu/disconnect')
              refreshFeishuStatus()
            })
          },
        }, t('feishu.disconnect'))
        : (appId !== '' && !isOnboardingActive
          ? h('button', {
            type: 'button',
            className: 'dsh-flow-btn dsh-flow-btn-primary',
            disabled: disabled || busy === 'connect',
            onClick: () => {
              void runAction('connect', async () => {
                const res = await apiCall('POST', '/api/dsh-flow/feishu/connect', {
                  appId,
                  domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
                })
                setFeedback({ kind: 'ok', text: `已连接 ${res.appId}` })
                refreshFeishuStatus()
              })
            },
          }, t('feishu.connect'))
          : null)),

    /* 态 1：扫码进行中 */
    isOnboardingActive ? qrStage : null,

    /* 态 2：未连接 — 极简配对流程 */
    !isConnected && !isOnboardingActive && !manualMode
      ? h(React.Fragment, null,
        h('div', { className: 'dsh-flow-setting-row', style: { borderTop: '1px solid var(--dsw-alias-border-l)' } },
          h('div', { className: 'dsh-flow-row-meta' },
            h('span', { className: 'dsh-flow-row-title' }, t('feishu.botName'))),
          h('div', { className: 'dsh-flow-row-ctrl dsh-flow-row-ctrl-wide' },
            h(TextField, {
              value: botNameDraft,
              disabled,
              placeholder: t('feishu.botNamePlaceholder'),
              onDraftChange: setBotNameDraft,
              onCommit: next => {
                const clean = next.trim() || 'Flow 指挥官'
                setBotNameDraft(clean)
                setField(['feishu', 'botName'], clean)
              },
            }))),
        h('div', { className: 'dsh-flow-setting-row' },
          h('div', { className: 'dsh-flow-row-meta' },
            h('span', { className: 'dsh-flow-row-title' }, t('feishu.avatar'))),
          h('div', { className: 'dsh-flow-row-ctrl' },
            h('div', { className: 'dsh-flow-avatar-strip' },
              presets.map(preset => h('button', {
                key: preset.id,
                type: 'button',
                className: 'dsh-flow-avatar-dot',
                'data-active': activeAvatarUrl === preset.url ? 'true' : 'false',
                title: preset.label,
                disabled,
                onClick: () => { setField(['feishu', 'botAvatarUrl'], preset.url) },
              }, h('img', { src: preset.url, alt: preset.label })))))),
        h('div', { className: 'dsh-flow-setting-row' },
          h('div', { className: 'dsh-flow-row-meta' },
            h('span', { className: 'dsh-flow-row-title' }, t('feishu.region'))),
          h('div', { className: 'dsh-flow-row-ctrl' },
            h(SegmentedControl, {
              value: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
              options: regionOptions,
              disabled,
              ariaLabel: t('feishu.region'),
              onChange: next => { setField(['feishu', 'domain'], next) },
            }))),
        h('div', { className: 'dsh-flow-cta-area' },
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn dsh-flow-btn-primary dsh-flow-btn-lg',
            disabled: disabled || busy === 'qr',
            onClick: startQrFlow,
          }, busy === 'qr' ? t('feishu.qrStarting') : t('feishu.qrStart')),
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn-link',
            onClick: () => { setManualMode(true) },
          }, t('feishu.manualLink'))))
      : null,

    /* 态 2b：手动凭证输入 */
    !isConnected && !isOnboardingActive && manualMode
      ? h(React.Fragment, null,
        h('div', { className: 'dsh-flow-setting-row', style: { borderTop: '1px solid var(--dsw-alias-border-l)' } },
          h('div', { className: 'dsh-flow-row-meta' }, h('span', { className: 'dsh-flow-row-title' }, t('feishu.appId'))),
          h('div', { className: 'dsh-flow-row-ctrl dsh-flow-row-ctrl-wide' },
            h(TextField, {
              value: typeof feishuCfg.appId === 'string' ? feishuCfg.appId : '',
              disabled,
              placeholder: 'cli_xxxxxxxxxx',
              onCommit: next => { setField(['feishu', 'appId'], next.trim()) },
            }))),
        h('div', { className: 'dsh-flow-setting-row' },
          h('div', { className: 'dsh-flow-row-meta' }, h('span', { className: 'dsh-flow-row-title' }, t('feishu.appSecret'))),
          h('div', { className: 'dsh-flow-row-ctrl dsh-flow-row-ctrl-wide' },
            h(TextField, {
              value: '',
              type: 'password',
              ignoreEmptyCommit: true,
              disabled,
              placeholder: t('feishu.appSecretPlaceholder'),
              onCommit: next => { setField(['feishu', 'appSecret'], next.trim()) },
            }))),
        h('div', { className: 'dsh-flow-setting-row' },
          h('div', { className: 'dsh-flow-row-meta' }, h('span', { className: 'dsh-flow-row-title' }, t('feishu.region'))),
          h('div', { className: 'dsh-flow-row-ctrl' },
            h(SegmentedControl, {
              value: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
              options: regionOptions,
              disabled,
              ariaLabel: t('feishu.region'),
              onChange: next => { setField(['feishu', 'domain'], next) },
            }))),
        h('div', { className: 'dsh-flow-cta-area' },
          h('div', { className: 'dsh-flow-row' },
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn',
              disabled: busy === 'verify',
              onClick: () => {
                void runAction('verify', async () => {
                  const res = await apiCall('POST', '/api/dsh-flow/feishu/verify', {
                    appId: feishuCfg.appId || '',
                    domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
                  })
                  setFeedback({ kind: 'ok', text: `凭证有效：${res.botName || '已就绪'}` })
                  refreshFeishuStatus()
                })
              },
            }, t('feishu.verify')),
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn dsh-flow-btn-primary',
              disabled: disabled || busy === 'connect',
              onClick: () => {
                void runAction('connect', async () => {
                  setField(['feishu', 'enabled'], true)
                  const res = await apiCall('POST', '/api/dsh-flow/feishu/connect', {
                    appId: feishuCfg.appId || '',
                    domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
                  })
                  setFeedback({ kind: 'ok', text: `已连接 ${res.appId}` })
                  refreshFeishuStatus()
                })
              },
            }, t('feishu.connect'))),
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn-link',
            onClick: () => { setManualMode(false) },
          }, t('feishu.manualHide'))))
      : null,

    /* 态 3：已连接 — 清晰「接下来做什么」行动条 */
    isConnected && !isOnboardingActive
      ? h('div', { className: 'dsh-flow-nextbar' },
        hasTarget
          ? h('div', { className: 'dsh-flow-next-item' },
            h('span', null, t('feishu.nextReady'), ' ', h('code', null, '/m'), ' ', t('feishu.nextReadyMid'), ' ', h('code', null, '/p'), ' ', t('feishu.nextReadyEnd')))
          : h('div', { className: 'dsh-flow-next-list' },
            h('div', { className: 'dsh-flow-next-item' },
              h('span', { className: 'dsh-flow-step-num' }, '1'),
              h('span', null, t('feishu.nextPair1').replace('{name}', previewName), ' ', h('code', null, '/id'), ' ', t('feishu.nextPair1End'))),
            h('div', { className: 'dsh-flow-next-item' },
              h('span', { className: 'dsh-flow-step-num' }, '2'),
              h('span', null, t('feishu.nextPair2'), ' ', h('code', null, '/m'), ' ', t('feishu.nextPair2End')))),
        h('div', { className: 'dsh-flow-row' },
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn dsh-flow-btn-primary',
            disabled: busy === 'welcome',
            onClick: () => {
              void runAction('welcome', async () => {
                const res = await apiCall('POST', '/api/dsh-flow/feishu/welcome', {})
                setFeedback({ kind: 'ok', text: res.detail || '已发送使用指南卡片到飞书' })
              })
            },
          }, t('feishu.sendGuide')),
          feishuStatus?.slashMenu?.status === 'missing_permission'
            ? h('button', {
              type: 'button',
              className: 'dsh-flow-btn dsh-flow-btn-primary',
              disabled: disabled || busy === 'upgrade',
              onClick: startUpgradeFlow,
            }, t('feishu.upgradePerm'))
            : (feishuStatus?.slashMenu?.status === 'synced' || feishuStatus?.slashMenu?.status === 'already_synced'
              ? h('span', { className: 'dsh-flow-badge' },
                h('span', { className: 'dsh-flow-dot', 'data-state': 'connected' }),
                t('feishu.slashReady'))
              : h('button', {
                type: 'button',
                className: 'dsh-flow-btn',
                disabled: busy === 'slash',
                onClick: () => {
                  void runAction('slash', async () => {
                    const res = await apiCall('POST', '/api/dsh-flow/feishu/slash/sync', {})
                    setFeedback({ kind: 'ok', text: res.created > 0 ? `已注册 ${res.created} 条 / 快捷指令` : '飞书 / 快捷菜单已同步' })
                    refreshFeishuStatus()
                  })
                },
              }, t('feishu.syncSlash'))),
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn',
            disabled: busy === 'testCard',
            onClick: () => {
              void runAction('testCard', async () => {
                const res = await apiCall('POST', '/api/dsh-flow/feishu/test', {})
                setFeedback({ kind: 'ok', text: res.detail || '测试卡片已发送' })
              })
            },
          }, t('feishu.testCard')),
          feishuStatus?.openPlatformUrl
            ? h('a', {
              className: 'dsh-flow-btn',
              href: feishuStatus.openPlatformUrl,
              target: '_blank',
              rel: 'noreferrer',
            }, t('feishu.openPlatform'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn',
            disabled: disabled || busy === 'connect',
            onClick: () => {
              void runAction('connect', async () => {
                await apiCall('POST', '/api/dsh-flow/feishu/connect', {
                  appId,
                  domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
                })
                setFeedback({ kind: 'ok', text: '已重新连接' })
                refreshFeishuStatus()
              })
            },
          }, t('feishu.reconnect'))))
      : null)

  /* ---- 推送与访问控制（已连接或已有 App 时直接展开，首次配对前隐藏保持极简） ---- */
  const pushAndSecurity = hasApp
    ? h(React.Fragment, null,
      h(SectionGroup, { title: t('feishu.secPush') },
        h(SettingRow, { title: t('feishu.pushOnGate') },
          h(ToggleSwitch, {
            checked: feishuCfg.pushOnGate !== false,
            disabled,
            ariaLabel: t('feishu.pushOnGate'),
            onChange: next => { setField(['feishu', 'pushOnGate'], next) },
          })),
        h(SettingRow, { title: t('feishu.pushOnBrake') },
          h(ToggleSwitch, {
            checked: feishuCfg.pushOnBrake !== false,
            disabled,
            ariaLabel: t('feishu.pushOnBrake'),
            onChange: next => { setField(['feishu', 'pushOnBrake'], next) },
          })),
        h(SettingRow, { title: t('feishu.pushOnApproval') },
          h(ToggleSwitch, {
            checked: feishuCfg.pushOnApproval !== false,
            disabled,
            ariaLabel: t('feishu.pushOnApproval'),
            onChange: next => { setField(['feishu', 'pushOnApproval'], next) },
          })),
        h(SettingRow, { title: t('feishu.pushOnComplete') },
          h(ToggleSwitch, {
            checked: feishuCfg.pushOnComplete !== false,
            disabled,
            ariaLabel: t('feishu.pushOnComplete'),
            onChange: next => { setField(['feishu', 'pushOnComplete'], next) },
          })),
        h(SettingRow, { title: t('feishu.sendDocFiles') },
          h(ToggleSwitch, {
            checked: feishuCfg.sendDocFiles !== false,
            disabled,
            ariaLabel: t('feishu.sendDocFiles'),
            onChange: next => { setField(['feishu', 'sendDocFiles'], next) },
          })),
        h(SettingRow, { title: t('feishu.syncDesktopReplies'), subtitle: t('feishu.syncDesktopRepliesSub') },
          h(ToggleSwitch, {
            checked: feishuCfg.syncDesktopReplies === true,
            disabled,
            ariaLabel: t('feishu.syncDesktopReplies'),
            onChange: next => { setField(['feishu', 'syncDesktopReplies'], next) },
          }))),

      h(SectionGroup, { title: t('feishu.secSecurity') },
        h(SettingRow, { title: t('feishu.allowedUsers'), wideControl: true },
          h(TextField, {
            value: allowedLine,
            disabled,
            placeholder: t('feishu.allowedUsersPlaceholder'),
            onCommit: (next) => {
              const ids = next.split(/[\s,，;；]+/).map(s => s.trim()).filter(Boolean)
              setField(['feishu', 'allowedOpenIds'], [...new Set(ids)])
            },
          })),
        h(SettingRow, { title: t('feishu.defaultChatId'), wideControl: true },
          h(TextField, {
            value: typeof feishuCfg.defaultChatId === 'string' ? feishuCfg.defaultChatId : '',
            disabled,
            placeholder: t('feishu.defaultChatIdPlaceholder'),
            onCommit: next => { setField(['feishu', 'defaultChatId'], next.trim()) },
          }))),

      h(DisclosureGroup, {
        title: t('feishu.guideTitle'),
        summary: t('feishu.guideSummary'),
      },
      h('div', { className: 'dsh-flow-row-block' },
        h('div', { className: 'dsh-flow-next-list' },
          h('div', { className: 'dsh-flow-next-item' }, h('code', null, '/m'), h('span', null, '选择或切换桌面项目与会话')),
          h('div', { className: 'dsh-flow-next-item' }, h('code', null, '/mode'), h('span', null, '弹出模式卡片（Flow / Plan / Build / Review）')),
          h('div', { className: 'dsh-flow-next-item' }, h('code', null, '/p'), h('span', null, '拉取当前所有待审批门禁与熔断卡片')),
          h('div', { className: 'dsh-flow-next-item' }, h('code', null, '/stop'), h('span', null, '立即停止当前正在回答的回合')),
          h('div', { className: 'dsh-flow-next-item' }, h('code', null, '@项目名 指令'), h('span', null, '一步切入指定项目并下达任务')),
          h('div', { className: 'dsh-flow-next-item' }, h('code', null, '/help'), h('span', null, '随时重发完整互动引导卡片'))))),

      h(DisclosureGroup, { title: t('feishu.moreIdentity') },
        h(SettingRow, { title: t('feishu.enabled') },
          h(ToggleSwitch, {
            checked: feishuCfg.enabled === true,
            disabled,
            ariaLabel: t('feishu.enabled'),
            onChange: next => { setField(['feishu', 'enabled'], next) },
          })),
        h(SettingRow, { title: t('feishu.localAlias'), wideControl: true },
          h(TextField, {
            value: typeof feishuCfg.localAlias === 'string' ? feishuCfg.localAlias : '',
            disabled,
            placeholder: t('feishu.localAliasPlaceholder'),
            onCommit: next => { setField(['feishu', 'localAlias'], next.trim()) },
          })),
        h(SettingRow, { title: t('feishu.botDesc'), wideControl: true },
          h(TextField, {
            value: typeof feishuCfg.botDescription === 'string' ? feishuCfg.botDescription : '',
            disabled,
            placeholder: t('feishu.botDescPlaceholder'),
            onCommit: next => { setField(['feishu', 'botDescription'], next.trim()) },
          })),
        h(SettingRow, { title: t('feishu.avatarUrl'), wideControl: true },
          h(TextField, {
            value: typeof feishuCfg.botAvatarUrl === 'string' ? feishuCfg.botAvatarUrl : '',
            disabled,
            placeholder: t('feishu.avatarUrlPlaceholder'),
            onCommit: next => { setField(['feishu', 'botAvatarUrl'], next.trim()) },
          })),
        h(SettingRow, { title: t('feishu.localAvatar') },
          h('div', { className: 'dsh-flow-row' },
            h('input', {
              ref: fileInputRef,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif',
              style: { display: 'none' },
              onChange: handleLocalAvatarFile,
            }),
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn',
              disabled,
              onClick: () => { fileInputRef.current?.click() },
            }, t('feishu.uploadAvatar')),
            feishuCfg.localAvatar
              ? h('button', {
                type: 'button',
                className: 'dsh-flow-btn',
                disabled,
                onClick: () => { setField(['feishu', 'localAvatar'], '') },
              }, t('feishu.clearAvatar'))
              : null)),
        h(SettingRow, { title: t('feishu.appId'), wideControl: true },
          h(TextField, {
            value: typeof feishuCfg.appId === 'string' ? feishuCfg.appId : '',
            disabled,
            placeholder: 'cli_xxxxxxxxxx',
            onCommit: next => { setField(['feishu', 'appId'], next.trim()) },
          })),
        h(SettingRow, { title: t('feishu.appSecret'), wideControl: true },
          h(TextField, {
            value: '',
            type: 'password',
            ignoreEmptyCommit: true,
            disabled,
            placeholder: t('feishu.appSecretPlaceholder'),
            onCommit: next => { setField(['feishu', 'appSecret'], next.trim()) },
          })),
        h('div', { className: 'dsh-flow-setting-row' },
          h('div', { className: 'dsh-flow-row' },
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn-link',
              disabled: disabled || busy === 'upgrade' || isOnboardingActive,
              onClick: startUpgradeFlow,
            }, t('feishu.upgradePerm')),
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn-link',
              disabled: disabled || busy === 'qr' || isOnboardingActive,
              onClick: startQrFlow,
            }, t('feishu.rebindQr'))),
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn',
            disabled: busy === 'verify',
            onClick: () => {
              void runAction('verify', async () => {
                const res = await apiCall('POST', '/api/dsh-flow/feishu/verify', {
                  appId: feishuCfg.appId || '',
                  domain: feishuCfg.domain === 'lark' ? 'lark' : 'feishu',
                })
                setFeedback({ kind: 'ok', text: `凭证有效：${res.botName || '已就绪'}` })
                refreshFeishuStatus()
              })
            },
          }, t('feishu.verify')))))
    : null

  /* ---- 折叠：邮箱归档与更多通道（完全收起，零首屏噪音） ---- */
  const moreChannels = h(DisclosureGroup, {
    title: t('feishu.moreChannels'),
    summary: channelsSummary,
  },
  h(SettingRow, { title: t('notify.emailEnabled') },
    h(ToggleSwitch, {
      checked: emailEnabled,
      disabled,
      ariaLabel: t('notify.emailEnabled'),
      onChange: next => { setField(['email', 'enabled'], next) },
    })),
  emailEnabled
    ? h(React.Fragment, null,
      h(SettingRow, { title: t('notify.provider') },
        h(SegmentedControl, {
          value: mailCfg.provider ?? 'qq',
          options: providerOptions,
          disabled,
          ariaLabel: t('notify.provider'),
          onChange: next => { setField(['email', 'provider'], next) },
        })),
      h(SettingRow, { title: t('notify.account'), wideControl: true },
        h(TextField, {
          value: typeof mailCfg.account === 'string' ? mailCfg.account : '',
          disabled,
          placeholder: 'you@qq.com',
          onCommit: next => { setField(['email', 'account'], next.trim()) },
        })),
      h(SettingRow, { title: t('notify.secret'), wideControl: true },
        h(TextField, {
          value: '',
          type: 'password',
          ignoreEmptyCommit: true,
          disabled,
          placeholder: t('notify.secretPlaceholder'),
          onCommit: next => { setField(['email', 'secret'], next) },
        })),
      h(SettingRow, { title: t('notify.to'), wideControl: true },
        h(TextField, {
          value: typeof mailCfg.to === 'string' ? mailCfg.to : '',
          disabled,
          placeholder: t('notify.toPlaceholder'),
          onCommit: next => { setField(['email', 'to'], next.trim()) },
        })),
      h(SettingRow, { title: t('notify.forceArchive') },
        h(ToggleSwitch, {
          checked: mailCfg.forceArchive === true,
          disabled,
          ariaLabel: t('notify.forceArchive'),
          onChange: next => { setField(['email', 'forceArchive'], next) },
        })),
      isCustomSmtp
        ? h(React.Fragment, null,
          h(SettingRow, { title: t('notify.host'), wideControl: true },
            h(TextField, {
              value: typeof mailCfg.host === 'string' ? mailCfg.host : '',
              disabled,
              placeholder: 'smtp.example.com',
              onCommit: next => { setField(['email', 'host'], next.trim()) },
            })),
          h(SettingRow, { title: t('notify.port'), wideControl: true },
            h(TextField, {
              value: String(mailCfg.port ?? 465),
              disabled,
              onCommit: (next) => {
                const parsed = Number.parseInt(next, 10)
                if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) setField(['email', 'port'], parsed)
              },
            })),
          h(SettingRow, { title: t('notify.security') },
            h(SegmentedControl, {
              value: mailCfg.security ?? 'ssl',
              options: [
                { value: 'ssl', label: t('security.ssl') },
                { value: 'starttls', label: t('security.starttls') },
              ],
              disabled,
              ariaLabel: t('notify.security'),
              onChange: next => { setField(['email', 'security'], next) },
            })))
        : null)
    : null,

  h(SettingRow, { title: t('notify.teamEnabled') },
    h(ToggleSwitch, {
      checked: teamCfg.enabled !== false,
      disabled,
      ariaLabel: t('notify.teamEnabled'),
      onChange: next => { setField(['team', 'enabled'], next) },
    })),
  teamCfg.enabled !== false
    ? h(SettingRow, { title: t('notify.teamUrl'), wideControl: true },
      h(TextField, {
        value: typeof teamCfg.baseUrl === 'string' ? teamCfg.baseUrl : 'http://127.0.0.1:4317',
        disabled,
        onCommit: next => { setField(['team', 'baseUrl'], next.trim()) },
      }))
    : null,

  h(SettingRow, { title: t('notify.imEnabled') },
    h(ToggleSwitch, {
      checked: imEnabled,
      disabled,
      ariaLabel: t('notify.imEnabled'),
      onChange: next => { setField(['im', 'enabled'], next) },
    })),
  imEnabled
    ? h(React.Fragment, null,
      h(SettingRow, { title: t('notify.botId'), wideControl: true },
        h(TextField, {
          value: typeof imCfg.botId === 'string' ? imCfg.botId : '',
          disabled,
          onCommit: next => { setField(['im', 'botId'], next.trim()) },
        })),
      h(SettingRow, { title: t('notify.targetId'), wideControl: true },
        h(TextField, {
          value: typeof imCfg.targetId === 'string' ? imCfg.targetId : '',
          disabled,
          onCommit: next => { setField(['im', 'targetId'], next.trim()) },
        })),
      h(SettingRow, { title: t('notify.webhookEnabled') },
        h(ToggleSwitch, {
          checked: imWebhook.enabled === true,
          disabled,
          ariaLabel: t('notify.webhookEnabled'),
          onChange: next => { setField(['im', 'webhook', 'enabled'], next) },
        })),
      imWebhook.enabled === true
        ? h(React.Fragment, null,
          h(SettingRow, { title: t('notify.webhookKind'), wideControl: true },
            h(CustomSelect, {
              value: imWebhook.kind ?? 'feishu',
              options: webhookKinds,
              disabled,
              ariaLabel: t('notify.webhookKind'),
              onChange: next => { setField(['im', 'webhook', 'kind'], next) },
            })),
          h(SettingRow, { title: t('notify.webhookUrl'), wideControl: true },
            h(TextField, {
              value: typeof imWebhook.url === 'string' ? imWebhook.url : '',
              disabled,
              onCommit: next => { setField(['im', 'webhook', 'url'], next.trim()) },
            })))
        : null)
    : null,

  ['brake', 'gate', 'archive', 'qa', 'team'].map((evt) => {
    const defVal = evt === 'archive' || evt === 'qa' ? 'email-first' : 'im-first'
    return h(SettingRow, { key: evt, title: `${t('notify.routing')} · ${t(evt)}`, wideControl: true },
      h(CustomSelect, {
        value: notifyCfg[evt] ?? defVal,
        options: strategyOptions,
        disabled,
        ariaLabel: t(evt),
        onChange: next => { setField(['notify', evt], next) },
      }))
  }),

  h('div', { className: 'dsh-flow-row-block' },
    h('div', { className: 'dsh-flow-row', style: { justifyContent: 'space-between' } },
      h('span', { className: 'dsh-flow-hint' },
        testReport
          ? [
            testReport.feishu ? `飞书 ${testReport.feishu.ok ? '✓' : '✗'}` : '',
            testReport.email ? `邮箱 ${testReport.email.ok ? '✓' : '✗'}` : '',
            testReport.im ? `IM ${testReport.im.ok ? '✓' : '✗'}` : '',
          ].filter(Boolean).join(' · ')
          : ''),
      h('button', {
        type: 'button',
        className: 'dsh-flow-btn',
        disabled: busy === 'testAll',
        onClick: () => {
          void runAction('testAll', async () => {
            const res = await apiCall('POST', '/api/dsh-flow/notify/test', { channel: 'all' })
            setTestReport(res.result ?? {})
          })
        },
      }, busy === 'testAll' ? t('notify.testing') : t('notify.testAll')))))

  const effectiveFeedback = feedback ?? (
    connState === 'error' && feishuStatus?.lastError
      ? { kind: 'error', text: feishuStatus.lastError }
      : null
  )

  return h('div', { className: 'dsh-flow-stack', role: 'tabpanel' },
    heroCard,
    effectiveFeedback
      ? h('div', {
        className: effectiveFeedback.kind === 'error' ? 'dsh-flow-toast dsh-flow-toast-err' : 'dsh-flow-toast',
        role: effectiveFeedback.kind === 'error' ? 'alert' : undefined,
      }, effectiveFeedback.text)
      : null,
    pushAndSecurity,
    moreChannels)
}
