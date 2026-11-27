/**
 * Tab 1：五大模式设置（Apple 极简分组列表风格）。
 *
 * @module dsh-flow/client/tabs/modes-tab
 */
function ModesTab({ modes, promptData, catalog, disabled, labelOf, setField, unsetField, t }) {
  const [activeMode, setActiveMode] = useState(MODE_IDS[0])

  const activeCfg = modes[activeMode]
  const activeDesc = typeof activeCfg?.description === 'string' && activeCfg.description !== ''
    ? activeCfg.description
    : MODE_FALLBACK[activeMode].description

  const hasCustomPrompt = typeof activeCfg?.prompt === 'string' && activeCfg.prompt !== ''
  const modePromptValue = hasCustomPrompt
    ? activeCfg.prompt
    : (Array.isArray(promptData?.modes)
      ? (promptData.modes.find(item => item.id === activeMode)?.content ?? '')
      : '')

  const modeOptions = MODE_IDS.map(id => ({ value: id, label: labelOf(id) }))
  const permOptions = PERMISSION_IDS.map(id => ({ value: id, label: t(`permission.${id}`) }))

  return h('div', { className: 'dsh-flow-stack', role: 'tabpanel' },
    h('div', { className: 'dsh-flow-sec' },
      h(SegmentedControl, {
        value: activeMode,
        options: modeOptions,
        fullWidth: true,
        ariaLabel: t('tab.modes'),
        onChange: setActiveMode,
      }),
      h('span', { className: 'dsh-flow-mode-summary' }, activeDesc)),

    h(SectionGroup, { title: t('mode.secBasic') },
      h(SettingRow, { title: t('mode.model'), wideControl: true },
        h(ModelSelectControl, {
          value: typeof activeCfg?.model === 'string' ? activeCfg.model : '',
          catalog,
          disabled,
          t,
          ariaLabel: t('mode.model'),
          onChange: next => { setField(['modes', activeMode, 'model'], next) },
        })),
      h(SettingRow, { title: t('mode.permission') },
        h(SegmentedControl, {
          value: PERMISSION_IDS.includes(activeCfg?.permission) ? activeCfg.permission : 'keep',
          options: permOptions,
          disabled,
          ariaLabel: t('mode.permission'),
          onChange: next => { setField(['modes', activeMode, 'permission'], next) },
        }))),

    h(DisclosureGroup, {
      key: `prompt-${activeMode}`,
      title: t('mode.prompt'),
      summary: hasCustomPrompt ? t('common.custom') : t('common.builtin'),
    },
    h('div', { className: 'dsh-flow-row-block' },
      h(TextField, {
        value: modePromptValue,
        multiline: true,
        rows: 12,
        disabled,
        onCommit: next => { setField(['modes', activeMode, 'prompt'], next) },
      }),
      hasCustomPrompt
        ? h('div', { className: 'dsh-flow-row', style: { justifyContent: 'flex-end' } },
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn',
            disabled,
            onClick: () => { unsetField(['modes', activeMode, 'prompt']) },
          }, t('common.reset')))
        : null)))
}
