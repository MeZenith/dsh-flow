/**
 * Client 基础 UI 组件（Apple HIG 极简风格）：
 * PopoverPanel、CustomSelect、TextField、ToggleSwitch、SegmentedControl、
 * StepperField、SettingRow、SectionGroup、DisclosureGroup、ModelField。
 *
 * @module dsh-flow/client/components/primitives
 */
function placePanel(rect, height, width) {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight
  const w = Math.min(width, Math.max(160, vw - PANEL_MARGIN * 2))
  const left = Math.max(PANEL_MARGIN, Math.min(rect ? rect.left : PANEL_MARGIN, vw - w - PANEL_MARGIN))
  const hh = Math.max(80, height || 0)
  const below = rect ? vh - rect.bottom - PANEL_MARGIN : vh
  const above = rect ? rect.top - PANEL_MARGIN : 0
  const openUp = below < hh && above > below
  const rawTop = rect ? (openUp ? rect.top - hh - PANEL_GAP : rect.bottom + PANEL_GAP) : PANEL_MARGIN
  const top = Math.max(PANEL_MARGIN, Math.min(rawTop, Math.max(PANEL_MARGIN, vh - hh - PANEL_MARGIN)))
  return { left, top, width: w, maxHeight: hh }
}

function PopoverPanel({ anchor, estimate, width, className, role, label, children, onClose }) {
  const ref = useRef(null)
  const [position, setPosition] = useState(() => placePanel(anchor, estimate, width))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPosition(placePanel(anchor, el.offsetHeight, width))
  }, [anchor, width])

  useEffect(() => {
    const onPointerDown = (event) => {
      const panel = ref.current
      if (panel && panel.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    const onViewport = (event) => {
      const panel = ref.current
      if (
        panel !== null
        && event !== undefined
        && event.type === 'scroll'
        && typeof Node !== 'undefined'
        && event.target instanceof Node
        && panel.contains(event.target)
      ) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }, [onClose])

  return createPortal(
    h('div', {
      ref,
      className: className ?? 'dsh-flow-panel',
      role,
      'aria-label': label,
      style: position,
    }, children),
    document.body,
  )
}

const CHEVRON = (open) => h('span', {
  className: 'dsh-flow-chevron',
  'data-open': open ? 'true' : 'false',
  'aria-hidden': true,
}, h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none' },
  h('path', {
    d: 'M4 6.5 8 10.5 12 6.5',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }),
))

/** Apple 风格滑动开关（替代粗糙 Checkbox）。 */
function ToggleSwitch({ checked, disabled, onChange, ariaLabel }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked === true ? 'true' : 'false',
    'aria-label': ariaLabel,
    className: 'dsh-flow-switch',
    disabled,
    onClick: () => { if (!disabled) onChange(!(checked === true)) },
  }, h('span', { className: 'dsh-flow-switch-thumb', 'aria-hidden': true }))
}

/** Apple 风格分段控件（2–5 个互斥项一眼可见、一点即切）。 */
function SegmentedControl({ value, options, disabled, onChange, fullWidth, ariaLabel }) {
  return h('div', {
    className: fullWidth ? 'dsh-flow-seg dsh-flow-seg-full' : 'dsh-flow-seg',
    role: 'radiogroup',
    'aria-label': ariaLabel,
  }, options.map(opt => h('button', {
    key: opt.value,
    type: 'button',
    role: 'radio',
    'aria-checked': opt.value === value ? 'true' : 'false',
    'data-active': opt.value === value ? 'true' : 'false',
    className: 'dsh-flow-seg-btn',
    disabled: disabled || opt.disabled,
    onClick: () => { if (opt.value !== value) onChange(opt.value) },
  }, opt.dotState ? h('span', { className: 'dsh-flow-dot', 'data-state': opt.dotState }) : null, opt.label)))
}

/** Apple 风格步进器（适用于小范围整数，如熔断次数）。 */
function StepperField({ value, min = 1, max = 20, step = 1, suffix = '', disabled, onChange }) {
  const num = Number.isFinite(Number(value)) ? Number(value) : min
  const dec = () => { if (num - step >= min) onChange(num - step) }
  const inc = () => { if (num + step <= max) onChange(num + step) }
  return h('div', { className: 'dsh-flow-stepper' },
    h('button', {
      type: 'button',
      className: 'dsh-flow-stepper-btn',
      disabled: disabled || num <= min,
      'aria-label': '−',
      onClick: dec,
    }, '−'),
    h('span', { className: 'dsh-flow-stepper-val' }, `${num}${suffix}`),
    h('button', {
      type: 'button',
      className: 'dsh-flow-stepper-btn',
      disabled: disabled || num >= max,
      'aria-label': '+',
      onClick: inc,
    }, '+'))
}

/** Apple 设置分组外壳（可选标题 + 右侧附加操作）。 */
function SectionGroup({ title, action, children }) {
  return h('div', { className: 'dsh-flow-sec' },
    (title || action)
      ? h('div', { className: 'dsh-flow-sec-head' },
        h('span', { className: 'dsh-flow-sec-title' }, title || ''),
        action || null)
      : null,
    h('div', { className: 'dsh-flow-groupcard' }, children))
}

/** Apple 标准左右对齐设置行。 */
function SettingRow({ title, subtitle, wideControl, children }) {
  return h('div', { className: 'dsh-flow-setting-row' },
    h('div', { className: 'dsh-flow-row-meta' },
      h('span', { className: 'dsh-flow-row-title' }, title),
      subtitle ? h('span', { className: 'dsh-flow-row-sub' }, subtitle) : null),
    h('div', { className: wideControl ? 'dsh-flow-row-ctrl dsh-flow-row-ctrl-wide' : 'dsh-flow-row-ctrl' }, children))
}

/** Apple 风格折叠高级分区（默认收起，带右侧摘要标签）。 */
function DisclosureGroup({ title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return h('div', { className: 'dsh-flow-groupcard' },
    h('button', {
      type: 'button',
      className: 'dsh-flow-disclosure-btn',
      'aria-expanded': open ? 'true' : 'false',
      onClick: () => { setOpen(v => !v) },
    },
    h('span', null, title),
    h('span', { className: 'dsh-flow-disclosure-right' },
      summary ? h('span', null, summary) : null,
      CHEVRON(open))),
    open ? h('div', { className: 'dsh-flow-disclosure-body' }, children) : null)
}

function CustomSelect({ value, options, groups, placeholder, disabled, onChange, ariaLabel, emptyHint }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const triggerRef = useRef(null)

  const flat = useMemo(() => {
    const list = []
    for (const group of groups ?? []) list.push(...group.options)
    list.push(...(options ?? []))
    return list
  }, [groups, options])

  const selected = flat.find(entry => entry.value === value)
  const label = selected
    ? selected.label
    : (value === '' || value === undefined || value === null ? (placeholder ?? '') : String(value))

  const close = useCallback(() => { setOpen(false) }, [])
  const toggle = useCallback(() => {
    if (disabled) return
    setAnchor(triggerRef.current ? triggerRef.current.getBoundingClientRect() : null)
    setOpen(prev => !prev)
  }, [disabled])
  const choose = useCallback((next) => {
    setOpen(false)
    if (next === value) return
    onChange(next)
  }, [onChange, value])

  const renderOption = (entry) => h('button', {
    key: `o:${entry.value}`,
    type: 'button',
    role: 'option',
    'aria-selected': entry.value === value ? 'true' : 'false',
    'data-active': entry.value === value ? 'true' : 'false',
    className: 'dsh-flow-option',
    onClick: () => { choose(entry.value) },
  },
  h('span', { className: 'dsh-flow-option-body' },
    h('span', { className: 'dsh-flow-option-name' }, entry.label),
  ),
  entry.value === value ? h('span', { className: 'dsh-flow-option-mark', 'aria-hidden': true }, '✓') : null)

  const hasGroups = Array.isArray(groups) && groups.length > 0

  return h(React.Fragment, null,
    h('button', {
      ref: triggerRef,
      type: 'button',
      className: 'dsh-flow-selecttrigger',
      'aria-haspopup': 'listbox',
      'aria-expanded': open ? 'true' : 'false',
      'aria-label': ariaLabel,
      disabled,
      onClick: toggle,
    },
    h('span', { className: 'dsh-flow-selectvalue', 'data-placeholder': selected ? 'false' : 'true', title: label }, label),
    CHEVRON(open)),
    open && anchor
      ? h(PopoverPanel, {
        anchor,
        estimate: SELECT_PANEL_ESTIMATE,
        width: SELECT_PANEL_WIDTH,
        role: 'listbox',
        label: ariaLabel,
        onClose: close,
      },
      options && options.length > 0 ? options.map(renderOption) : null,
      options && options.length > 0 && hasGroups ? h('div', { className: 'dsh-flow-sep' }) : null,
      (groups ?? []).map(group => h(React.Fragment, { key: `g:${group.name}` },
        h('div', { className: 'dsh-flow-group' }, group.name),
        group.options.map(renderOption),
      )),
      !flat.length && emptyHint ? h('div', { className: 'dsh-flow-hint', style: { padding: '8px' } }, emptyHint) : null)
      : null,
  )
}

function TextField({ value, onCommit, onDraftChange, disabled, multiline, placeholder, rows, type, ignoreEmptyCommit }) {
  const [draft, setDraft] = useState(value ?? '')
  const committed = useRef(value ?? '')

  useEffect(() => {
    const incoming = value ?? ''
    if (incoming !== committed.current) {
      committed.current = incoming
      setDraft(incoming)
    }
  }, [value])

  const commit = () => {
    if (draft === committed.current) return
    if (ignoreEmptyCommit && String(draft).trim() === '') return
    committed.current = draft
    if (typeof onCommit === 'function') onCommit(draft)
  }

  const shared = {
    value: draft,
    disabled,
    placeholder,
    onChange: (event) => {
      const next = event.target.value
      setDraft(next)
      if (typeof onDraftChange === 'function') onDraftChange(next)
    },
    onBlur: commit,
    onKeyDown: (event) => {
      if (!multiline && event.key === 'Enter') event.currentTarget.blur()
    },
  }

  return multiline
    ? h('textarea', { ...shared, className: 'dsh-flow-textarea', rows: rows ?? 5 })
    : h('input', { ...shared, className: 'dsh-flow-input', type: type ?? 'text' })
}

/** 轻量模型选择器（用于左右对齐 SettingRow 内）。 */
function ModelSelectControl({ value, catalog, disabled, onChange, t, ariaLabel }) {
  const saved = typeof value === 'string' ? value : ''
  const ready = catalog && catalog.status === 'ready'

  const groups = useMemo(() => {
    if (!ready) return []
    const list = []
    for (const group of catalog.groups ?? []) {
      const models = Array.isArray(group?.models) ? group.models : []
      const options = models.map(model => ({
        value: `${group.id}::${model.id}`,
        label: model.name ?? model.id,
      }))
      if (options.length) list.push({ name: group.name ?? group.id, options })
    }
    return list
  }, [catalog, ready])

  const noneOption = useMemo(() => [{ value: '', label: t('model.none') }], [t])
  const options = useMemo(() => {
    if (saved === '') return noneOption
    const known = groups.some(group => group.options.some(option => option.value === saved))
    return known ? noneOption : [...noneOption, { value: saved, label: saved }]
  }, [groups, noneOption, saved])

  return h(CustomSelect, {
    value: saved,
    options,
    groups,
    disabled,
    onChange,
    ariaLabel: ariaLabel || t('mode.model'),
    emptyHint: t(`model.state.${catalog?.status ?? 'loading'}`) || t('model.state.unavailable'),
  })
}

function Labeled({ label, children }) {
  return h('div', { className: 'dsh-flow-field' },
    h('span', { className: 'dsh-flow-fieldlabel' }, label),
    children)
}
