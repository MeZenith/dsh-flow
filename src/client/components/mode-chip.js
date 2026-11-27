/**
 * 聊天输入区左侧模式切换芯片（conversation.input.left）。
 *
 * @module dsh-flow/client/components/mode-chip
 */
function ModeMenu({ anchor, meta, current, busy, error, onPick, onClose, t }) {
  const entries = [{ id: MODE_OFF, label: t('off.label'), description: t('off.desc') }]
    .concat(MODE_IDS.map(id => ({ id, label: meta[id].label, description: meta[id].description })))

  return h(PopoverPanel, {
    anchor,
    estimate: CHIP_MENU_ESTIMATE,
    width: CHIP_MENU_WIDTH,
    role: 'listbox',
    label: t('menu.aria'),
    onClose,
  },
  entries.map(entry => h('button', {
    key: entry.id,
    type: 'button',
    role: 'option',
    'aria-selected': entry.id === current ? 'true' : 'false',
    'data-active': entry.id === current ? 'true' : 'false',
    className: 'dsh-flow-option',
    disabled: busy,
    onClick: () => { onPick(entry.id) },
  },
  h('span', { className: 'dsh-flow-option-body' },
    h('span', { className: 'dsh-flow-option-name' }, entry.label),
    entry.description ? h('span', { className: 'dsh-flow-option-desc' }, entry.description) : null,
  ),
  entry.id === current ? h('span', { className: 'dsh-flow-option-mark', 'aria-hidden': true }, '✓') : null)),
  error ? h('div', { className: 'dsh-flow-panel-error', role: 'alert' }, error) : null)
}

function FlowModeChip(props) {
  const { appCtx, sessionId, useProjection, t } = props
  const flow = useProjection('flowMode')
  const current = flow && typeof flow.mode === 'string' ? flow.mode : MODE_OFF

  const forms = appCtx.get('configForms')
  const form = forms && typeof forms.get === 'function' ? forms.get(CONFIG_NS) : undefined
  const snapshot = useConfigSnapshot(form)
  const meta = useMemo(() => readModeMeta(snapshot && snapshot.value), [snapshot])

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [anchor, setAnchor] = useState(null)
  const buttonRef = useRef(null)

  const currentLabel = current === MODE_OFF ? t('off.label') : (meta[current]?.label ?? current)
  const title = current === MODE_OFF ? t('off.desc') : (meta[current]?.description ?? '')

  const close = useCallback(() => { setOpen(false); setError(null) }, [])
  const toggle = useCallback(() => {
    if (busy) return
    setAnchor(buttonRef.current ? buttonRef.current.getBoundingClientRect() : null)
    setError(null)
    setOpen(value => !value)
  }, [busy])

  const pick = useCallback(async (id) => {
    const face = sessionFaceOf(appCtx, sessionId)
    if (!face || typeof face.command !== 'function') {
      setError(t('error.session'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await face.command(`/flow ${id}`)
      if (result && result.ok === false) {
        setError(errorOf(result, t('error.switch')))
        return
      }
      if (result && result.ok === true && result.value && result.value.matched === false) {
        setError(t('error.missingCommand'))
        return
      }
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [appCtx, sessionId, t])

  return h(React.Fragment, null,
    h('button', {
      ref: buttonRef,
      type: 'button',
      className: 'dsh-flow-chip',
      'aria-haspopup': 'listbox',
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': t('chip.aria', { name: currentLabel }),
      title,
      disabled: busy,
      onClick: toggle,
    },
    h('span', { className: 'dsh-flow-chip-label' }, currentLabel),
    CHEVRON(open)),
    open && anchor ? h(ModeMenu, { anchor, meta, current, busy, error, onPick: pick, onClose: close, t }) : null)
}
