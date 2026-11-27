/**
 * Tab 2：工作流与异常熔断（Apple 极简分组 + 折叠高级选项）。
 *
 * @module dsh-flow/client/tabs/workflow-tab
 */
function WorkflowTab({ value, catalog, disabled, setField, t }) {
  const spec = value?.spec && typeof value.spec === 'object' ? value.spec : {}
  const behavior = value?.behavior && typeof value.behavior === 'object' ? value.behavior : {}
  const docsCfg = value?.docs && typeof value.docs === 'object' ? value.docs : {}
  const gateCfg = value?.gate && typeof value.gate === 'object' ? value.gate : {}
  const uiCfg = value?.ui && typeof value.ui === 'object' ? value.ui : {}
  const circuitCfg = value?.circuit && typeof value.circuit === 'object' ? value.circuit : {}

  const circuitOn = circuitCfg.enabled !== false

  const strategyOptions = [
    { value: 'im-first', label: t('strategy.imFirst') },
    { value: 'email-first', label: t('strategy.emailFirst') },
    { value: 'both', label: t('strategy.both') },
    { value: 'off', label: t('strategy.off') },
  ]

  return h('div', { className: 'dsh-flow-stack', role: 'tabpanel' },
    /* ---- 分组 1：开发流程 ---- */
    h(SectionGroup, { title: t('wf.secFlow') },
      h(SettingRow, { title: t('wf.level') },
        h(SegmentedControl, {
          value: docsCfg.level === 'S' || docsCfg.level === 'L' ? docsCfg.level : 'M',
          options: [
            { value: 'S', label: t('wf.levelS') },
            { value: 'M', label: t('wf.levelM') },
            { value: 'L', label: t('wf.levelL') },
          ],
          disabled,
          ariaLabel: t('wf.level'),
          onChange: next => { setField(['docs', 'level'], next) },
        })),
      h(SettingRow, { title: t('wf.autonomy') },
        h(SegmentedControl, {
          value: behavior.flowAutonomy === 'step-by-step' ? 'step-by-step' : 'one-gate',
          options: [
            { value: 'one-gate', label: t('wf.autonomyOneGate') },
            { value: 'step-by-step', label: t('wf.autonomyStep') },
          ],
          disabled,
          ariaLabel: t('wf.autonomy'),
          onChange: next => { setField(['behavior', 'flowAutonomy'], next) },
        })),
      h(SettingRow, { title: t('wf.writePolicy'), subtitle: t('wf.writePolicySub') },
        h(SegmentedControl, {
          value: docsCfg.writePolicy === 'ask' ? 'ask' : 'auto',
          options: [
            { value: 'auto', label: t('wf.writeAuto') },
            { value: 'ask', label: t('wf.writeAsk') },
          ],
          disabled,
          ariaLabel: t('wf.writePolicy'),
          onChange: next => { setField(['docs', 'writePolicy'], next) },
        })),
      h(SettingRow, { title: t('wf.specEnabled') },
        h(ToggleSwitch, {
          checked: spec.enabled !== false,
          disabled,
          ariaLabel: t('wf.specEnabled'),
          onChange: next => { setField(['spec', 'enabled'], next) },
        })),
      h(SettingRow, { title: t('wf.autoCompact') },
        h(ToggleSwitch, {
          checked: behavior.autoCompactOnGate !== false,
          disabled,
          ariaLabel: t('wf.autoCompact'),
          onChange: next => { setField(['behavior', 'autoCompactOnGate'], next) },
        }))),

    /* ---- 分组 2：异常熔断 ---- */
    h(SectionGroup, { title: t('wf.secBreaker') },
      h(SettingRow, { title: t('wf.circuitEnabled') },
        h(ToggleSwitch, {
          checked: circuitOn,
          disabled,
          ariaLabel: t('wf.circuitEnabled'),
          onChange: next => { setField(['circuit', 'enabled'], next) },
        })),
      circuitOn
        ? h(React.Fragment, null,
          h(SettingRow, { title: t('wf.threshold') },
            h(StepperField, {
              value: circuitCfg.threshold ?? 3,
              min: 1,
              max: 10,
              suffix: t('wf.timesSuffix'),
              disabled,
              onChange: next => { setField(['circuit', 'threshold'], next) },
            })),
          h(SettingRow, { title: t('wf.rescueModel'), wideControl: true },
            h(ModelSelectControl, {
              value: typeof circuitCfg.rescueModel === 'string' ? circuitCfg.rescueModel : '',
              catalog,
              disabled,
              t,
              ariaLabel: t('wf.rescueModel'),
              onChange: next => { setField(['circuit', 'rescueModel'], next) },
            })))
        : null),

    /* ---- 折叠：高级选项 ---- */
    h(DisclosureGroup, { title: t('wf.advanced') },
      h(SettingRow, { title: t('wf.docsEnabled') },
        h(ToggleSwitch, {
          checked: docsCfg.enabled !== false,
          disabled,
          ariaLabel: t('wf.docsEnabled'),
          onChange: next => { setField(['docs', 'enabled'], next) },
        })),
      h(SettingRow, { title: t('wf.enforce') },
        h(SegmentedControl, {
          value: docsCfg.enforce === 'warn' ? 'warn' : 'strict',
          options: [
            { value: 'strict', label: t('wf.enforceBlock') },
            { value: 'warn', label: t('wf.enforceWarn') },
          ],
          disabled,
          ariaLabel: t('wf.enforce'),
          onChange: next => { setField(['docs', 'enforce'], next) },
        })),
      h(SettingRow, { title: t('wf.docsDir'), wideControl: true },
        h(TextField, {
          value: typeof docsCfg.dir === 'string' ? docsCfg.dir : '.flow/docs',
          disabled,
          placeholder: '.flow/docs',
          onCommit: next => { setField(['docs', 'dir'], next.trim() || '.flow/docs') },
        })),
      h(SettingRow, { title: t('wf.specPath'), wideControl: true },
        h(TextField, {
          value: typeof spec.path === 'string' ? spec.path : '.flow/spec.md',
          disabled,
          placeholder: '.flow/spec.md',
          onCommit: next => { setField(['spec', 'path'], next.trim() || '.flow/spec.md') },
        })),
      h(SettingRow, { title: t('wf.specMaxChars'), wideControl: true },
        h(TextField, {
          value: String(typeof spec.maxChars === 'number' ? spec.maxChars : 600),
          disabled,
          onCommit: (next) => {
            const parsed = Number.parseInt(next, 10)
            if (Number.isFinite(parsed) && parsed >= 80) setField(['spec', 'maxChars'], parsed)
          },
        })),
      h(SettingRow, { title: t('wf.timeout'), wideControl: true },
        h(TextField, {
          value: String(typeof gateCfg.timeoutSeconds === 'number' ? gateCfg.timeoutSeconds : 1800),
          disabled,
          onCommit: (next) => {
            const parsed = Number.parseInt(next, 10)
            if (Number.isFinite(parsed) && parsed >= 0) setField(['gate', 'timeoutSeconds'], parsed)
          },
        })),
      h(SettingRow, { title: t('wf.escalate'), wideControl: true },
        h(CustomSelect, {
          value: ['im-first', 'email-first', 'both', 'off'].includes(gateCfg.escalate) ? gateCfg.escalate : 'both',
          options: strategyOptions,
          disabled,
          ariaLabel: t('wf.escalate'),
          onChange: next => { setField(['gate', 'escalate'], next) },
        })),
      h(SettingRow, { title: t('wf.persist') },
        h(ToggleSwitch, {
          checked: gateCfg.persist !== false,
          disabled,
          ariaLabel: t('wf.persist'),
          onChange: next => { setField(['gate', 'persist'], next) },
        })),
      h(SettingRow, { title: t('wf.uiProbe') },
        h(ToggleSwitch, {
          checked: uiCfg.skillProbe !== false,
          disabled,
          ariaLabel: t('wf.uiProbe'),
          onChange: next => { setField(['ui', 'skillProbe'], next) },
        })),
      h(SettingRow, { title: t('wf.idleSeconds'), wideControl: true },
        h(TextField, {
          value: String(circuitCfg.idleSeconds ?? 120),
          disabled,
          onCommit: (next) => {
            const parsed = Number.parseInt(next, 10)
            if (Number.isFinite(parsed) && parsed >= 0) setField(['circuit', 'idleSeconds'], parsed)
          },
        })),
      h(SettingRow, { title: t('wf.debugLog') },
        h(ToggleSwitch, {
          checked: circuitCfg.debugLog === true,
          disabled,
          ariaLabel: t('wf.debugLog'),
          onChange: next => { setField(['circuit', 'debugLog'], next) },
        }))))
}
