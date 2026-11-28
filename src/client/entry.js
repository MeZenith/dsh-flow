/**
 * Client 设置页主容器与 DSH 槽位注册入口（Apple 极简顶栏 + 分段主导航）。
 *
 * @module dsh-flow/client/entry
 */
function FlowSettingsCard(props) {
  const { appCtx, t } = props
  const forms = appCtx.get('configForms')
  const form = props.form ?? (forms && typeof forms.get === 'function' ? forms.get(CONFIG_NS) : undefined)
  const snapshot = useConfigSnapshot(form)

  const [tab, setTab] = useState('modes')
  const [feishuState, setFeishuState] = useState('disconnected')
  const [catalog, setCatalog] = useState({ status: 'loading', groups: [], failures: [] })
  const [error, setError] = useState(null)
  const [overrides, setOverrides] = useState({})
  const [promptData, setPromptData] = useState(null)
  const [promptApiState, setPromptApiState] = useState('loading')
  const [reloadToken, setReloadToken] = useState(0)

  const refreshPrompts = useCallback(() => { setReloadToken(token => token + 1) }, [])

  useEffect(() => {
    let alive = true
    let retryTimer = null
    const pull = (canRetry) => {
      apiCall('GET', '/api/dsh-flow/feishu/status')
        .then((res) => {
          if (!alive) return
          const st = res?.data?.state
          if (st) setFeishuState(st)
          if (canRetry && st !== 'connected') {
            retryTimer = setTimeout(() => pull(false), 2500)
          }
        })
        .catch(() => {
          if (alive && canRetry) retryTimer = setTimeout(() => pull(false), 2500)
        })
    }
    pull(true)
    return () => {
      alive = false
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/api/dsh-flow/prompts', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((payload) => {
        if (!alive) return
        if (payload?.ok !== true) { setPromptApiState('unavailable'); return }
        setPromptData(payload.data)
        setPromptApiState('ready')
      })
      .catch(() => { if (alive) setPromptApiState('unavailable') })
    return () => { alive = false }
  }, [reloadToken])

  useEffect(() => {
    let alive = true
    let remote
    try { remote = appCtx.get('remote')?.session } catch { remote = undefined }
    if (!remote || typeof remote.modelCatalog !== 'function') {
      setCatalog({ status: 'unavailable', groups: [], failures: [] })
      return undefined
    }
    Promise.resolve()
      .then(() => remote.modelCatalog())
      .then((result) => {
        if (!alive) return
        const payload = payloadOf(result)
        if (!payload) {
          setCatalog({ status: 'error', groups: [], failures: [], reason: errorOf(result, '') })
          return
        }
        setCatalog({
          status: 'ready',
          groups: Array.isArray(payload.groups) ? payload.groups : [],
          failures: Array.isArray(payload.failures) ? payload.failures : [],
        })
      })
      .catch((cause) => {
        if (!alive) return
        setCatalog({ status: 'error', groups: [], failures: [], reason: cause instanceof Error ? cause.message : String(cause) })
      })
    return () => { alive = false }
  }, [appCtx])

  const seqByKeyRef = useRef(new Map())

  const dropOverride = useCallback((key) => {
    setOverrides((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const mutate = useCallback(async (ops, key, seq) => {
    if (!form || typeof form.mutate !== 'function') {
      setError(t('error.noForm'))
      if (key !== undefined && (seq === undefined || seqByKeyRef.current.get(key) === seq)) dropOverride(key)
      return
    }
    setError(null)
    try {
      const accepted = await form.mutate(ops)
      if (accepted === false) setError(t('error.rejected'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // P2-3 修复：仅当本次请求仍为该 key 的最新请求时才清理乐观覆盖值，防连点回弹闪烁。
      if (key !== undefined && (seq === undefined || seqByKeyRef.current.get(key) === seq)) {
        dropOverride(key)
      }
    }
  }, [form, t, dropOverride])

  const setField = useCallback((path, next) => {
    const key = pathKey(path)
    const seq = (seqByKeyRef.current.get(key) ?? 0) + 1
    seqByKeyRef.current.set(key, seq)
    setOverrides(prev => ({ ...prev, [key]: next }))
    void mutate([{ op: 'set', path, value: next }], key, seq)
  }, [mutate])

  const unsetField = useCallback((path) => {
    const key = pathKey(path)
    const seq = (seqByKeyRef.current.get(key) ?? 0) + 1
    seqByKeyRef.current.set(key, seq)
    dropOverride(key)
    void mutate([{ op: 'unset', path }], key, seq)
  }, [mutate, dropOverride])

  if (!form || snapshot === null) {
    return h('div', { className: 'dsh-flow-card' },
      h('div', { className: 'dsh-flow-head' },
        h('span', { className: 'dsh-flow-title' }, t('settings.title'))),
      h('div', { className: 'dsh-flow-empty' }, t('settings.unavailable')))
  }

  const value = withOverrides((snapshot && snapshot.value) || {}, overrides)
  const writable = !snapshot || snapshot.writable !== false
  const saving = snapshot ? snapshot.status !== 'ready' : false
  const disabled = !writable
  const modes = value && typeof value.modes === 'object' && value.modes !== null ? value.modes : {}

  const labelOf = (modeId) => {
    const configured = modes[modeId]
    return typeof configured?.label === 'string' && configured.label !== ''
      ? configured.label
      : MODE_FALLBACK[modeId].label
  }

  const tabOptions = TABS.map(id => ({
    value: id,
    label: t(`tab.${id}`),
    dotState: id === 'remote' && feishuState === 'connected' ? 'connected' : undefined,
  }))

  return h('div', { className: 'dsh-flow-card' },
    h('div', { className: 'dsh-flow-head' },
      h('div', { className: 'dsh-flow-head-left' },
        h('span', { className: 'dsh-flow-title' }, t('settings.title')),
        !writable ? h('span', { className: 'dsh-flow-badge' }, t('settings.readonly')) : null),
      saving ? h('span', { className: 'dsh-flow-saving' }, t('settings.saving')) : null),
    error ? h('div', { className: 'dsh-flow-toast dsh-flow-toast-err', role: 'alert' }, error) : null,
    h(SegmentedControl, {
      value: tab,
      options: tabOptions,
      fullWidth: true,
      ariaLabel: t('settings.title'),
      onChange: setTab,
    }),
    tab === 'modes' ? h(ModesTab, { modes, promptData, catalog, disabled, labelOf, setField, unsetField, t }) : null,
    tab === 'workflow' ? h(WorkflowTab, { value, catalog, disabled, setField, t }) : null,
    tab === 'remote' ? h(RemoteTab, { value, disabled, setField, t, onFeishuState: setFeishuState }) : null,
    tab === 'prompts' ? h(PromptsTab, {
      value, promptData, promptApiState, refreshPrompts, disabled, labelOf, setField, unsetField, t,
    }) : null)
}

exports.inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session']
exports.name = 'flow-client'

function apply(ctx) {
  ensureStyles()

  ctx.effect(() => ctx.locale.register(CONFIG_NS, { zh, en }), 'flow: client dictionaries')
  const t = ctx.locale.bind(CONFIG_NS)

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'flow-mode',
    order: 20,
    locale: CONFIG_NS,
    inject: () => ({ appCtx: ctx }),
  }, FlowModeChip))

  ctx.inject(['configForms'], (formsCtx) => {
    const forms = formsCtx.configForms
    formsCtx.effect(() => forms.whileServed([CONFIG_NS], served => (
      served.has(CONFIG_NS)
        ? formsCtx.slots.inject('settings.section', () => formsCtx.slots.register({
          name: 'settings.section',
          id: 'dsh-flow',
          order: 22,
          label: () => t('settings.nav'),
          locale: CONFIG_NS,
          inject: () => ({ appCtx: ctx, form: forms.get(CONFIG_NS) }),
        }, FlowSettingsCard))
        : () => undefined
    )), 'flow: settings section')
  })
}

exports.apply = apply
