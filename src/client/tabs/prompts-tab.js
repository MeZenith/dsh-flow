/**
 * Tab 4：提示词库（底座契约 / 全局片段 / 子代理，Apple 极简分组风格）。
 *
 * @module dsh-flow/client/tabs/prompts-tab
 */
function PromptsTab({
  value, promptData, promptApiState, refreshPrompts, disabled, labelOf, setField, unsetField, t,
}) {
  const [libTab, setLibTab] = useState('base')
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterDraft, setRosterDraft] = useState('')
  const [rosterDirty, setRosterDirty] = useState(false)
  const [baseDraft, setBaseDraft] = useState('')
  const [expandedSets, setExpandedSets] = useState(() => new Set())
  const [expandedAgents, setExpandedAgents] = useState({})
  const [agentDrafts, setAgentDrafts] = useState({})
  const [dirtyAgents, setDirtyAgents] = useState(() => new Set())
  const dirtyAgentsRef = useRef(dirtyAgents)
  dirtyAgentsRef.current = dirtyAgents
  const [creating, setCreating] = useState(false)
  const [newAgentId, setNewAgentId] = useState('')
  const [newAgentSummary, setNewAgentSummary] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState('')
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState(null)

  const sets = Array.isArray(value.promptSets) ? value.promptSets : []
  const promptsCfg = value && typeof value.prompts === 'object' && value.prompts !== null ? value.prompts : {}

  useEffect(() => {
    const override = typeof value?.baseRules === 'string' ? value.baseRules : ''
    if (override !== '') { setBaseDraft(override); return }
    const fromFile = promptData?.base?.fileContent ?? ''
    setBaseDraft(fromFile !== '' ? fromFile : (promptData?.base?.content ?? ''))
  }, [value?.baseRules, promptData])

  // P2-3 修复：拆分为两个独立 effect，编辑子代理时绝不再冲掉未保存的花名册草稿。
  useEffect(() => {
    if (promptData === null || rosterDirty) return
    setRosterDraft(promptData.roster?.content ?? '')
  }, [promptData?.roster?.content, rosterDirty])

  useEffect(() => {
    if (promptData === null) return
    const list = Array.isArray(promptData.subagents) ? promptData.subagents : []
    const dirty = dirtyAgentsRef.current
    setAgentDrafts((prev) => {
      const next = {}
      for (const item of list) {
        next[item.id] = dirty.has(item.id) && typeof prev[item.id] === 'string'
          ? prev[item.id]
          : (item.content ?? '')
      }
      return next
    })
  }, [promptData])

  useEffect(() => {
    if (confirmDeleteId === '') return undefined
    const timer = setTimeout(() => { setConfirmDeleteId('') }, 3000)
    return () => { clearTimeout(timer) }
  }, [confirmDeleteId])

  const runBusy = async (key, task) => {
    setBusy(key)
    setFeedback(null)
    try {
      await task()
    } catch (error) {
      setFeedback({ kind: 'error', text: t('lib.failed').replace('{reason}', error instanceof Error ? error.message : String(error)) })
    } finally {
      setBusy('')
    }
  }

  const clearDirtyAgent = (id) => {
    setDirtyAgents((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const agentList = Array.isArray(promptData?.subagents) ? promptData.subagents : []
  const baseOverrideActive = typeof value?.baseRules === 'string' && value.baseRules !== ''

  const briefOf = (item) => {
    const id = String(item?.id ?? '')
    let text = String(item?.title ?? '').trim()
    if (id !== '' && text.toLowerCase().startsWith(id.toLowerCase())) text = text.slice(id.length)
    return text.replace(/^[\s|｜:：,，;；\-—]+/, '').trim()
  }

  const toggleSet = (setKey) => {
    setExpandedSets((prev) => {
      const next = new Set(prev)
      if (next.has(setKey)) next.delete(setKey)
      else next.add(setKey)
      return next
    })
  }

  const topBar = h('div', { className: 'dsh-flow-row', style: { justifyContent: 'space-between' } },
    h(SegmentedControl, {
      value: libTab,
      options: [
        { value: 'base', label: t('lib.tabBase') },
        { value: 'global', label: t('lib.tabGlobal') },
        { value: 'agents', label: t('lib.tabAgents') },
      ],
      ariaLabel: t('tab.prompts'),
      onChange: setLibTab,
    }),
    h('div', { className: 'dsh-flow-row' },
      promptData?.version
        ? h('span', { className: 'dsh-flow-hint' },
          t('lib.versionLine')
            .replace('{version}', promptData.version)
            .replace('{count}', String(promptData.fileCount ?? 0)))
        : null,
      h('button', {
        type: 'button',
        className: 'dsh-flow-btn',
        disabled: disabled || promptApiState === 'unavailable' || busy === 'update',
        onClick: () => {
          void runBusy('update', async () => {
            const payload = await apiCall('POST', '/api/dsh-flow/prompts/update')
            const result = payload.result ?? {}
            setDirtyAgents(new Set())
            setRosterDirty(false)
            setFeedback({
              kind: result.ok === false ? 'error' : 'ok',
              text: t('lib.updateDone')
                .replace('{updated}', String(Array.isArray(result.updated) ? result.updated.length : 0))
                .replace('{skipped}', String(Array.isArray(result.skipped) ? result.skipped.length : 0)),
            })
            refreshPrompts()
          })
        },
      }, busy === 'update' ? t('lib.updating') : t('lib.checkUpdate'))))

  /* ---- 视图 1：底座契约 ---- */
  const baseView = h(SectionGroup, {
    title: t('lib.tabBase'),
    action: h('div', { className: 'dsh-flow-row' },
      baseOverrideActive
        ? h('button', {
          type: 'button',
          className: 'dsh-flow-btn-link',
          disabled,
          onClick: () => {
            unsetField(['baseRules'])
            const fromFile = promptData?.base?.fileContent ?? ''
            if (fromFile !== '') setBaseDraft(fromFile)
            refreshPrompts()
            setFeedback({ kind: 'ok', text: t('lib.reset') })
          },
        }, t('common.reset'))
        : null,
      h('button', {
        type: 'button',
        className: 'dsh-flow-btn dsh-flow-btn-primary',
        disabled: disabled || busy === 'base',
        onClick: () => {
          void runBusy('base', async () => {
            setField(['baseRules'], baseDraft)
            setFeedback({ kind: 'ok', text: t('lib.saved') })
          })
        },
      }, busy === 'base' ? t('lib.saving') : t('common.save'))),
  },
  h('div', { className: 'dsh-flow-row-block' },
    h(TextField, {
      value: baseDraft,
      multiline: true,
      rows: 13,
      disabled,
      onDraftChange: setBaseDraft,
      onCommit: setBaseDraft,
    })))

  /* ---- 视图 2：全局片段 ---- */
  const globalView = h(SectionGroup, {
    title: t('lib.tabGlobal'),
    action: h('button', {
      type: 'button',
      className: 'dsh-flow-btn-link',
      disabled,
      onClick: () => {
        const id = newId()
        const indexKey = String(sets.length)
        setExpandedSets(prev => new Set(prev).add(id))
        setField(['promptSets', indexKey], { id, name: t('set.newName'), enabled: true, text: '', modes: [] })
      },
    }, `+ ${t('set.add')}`),
  },
  sets.length === 0
    ? h('div', { className: 'dsh-flow-empty' }, t('set.empty'))
    : sets.map((set, index) => {
      const indexKey = String(index)
      const stableId = typeof set?.id === 'string' && set.id !== '' ? set.id : `idx-${indexKey}`
      const isOpen = expandedSets.has(stableId)
      const picked = Array.isArray(set?.modes) ? set.modes : []
      const name = typeof set?.name === 'string' && set.name !== '' ? set.name : t('set.newName')

      return h('div', {
        key: stableId,
        style: index > 0 ? { borderTop: '1px solid var(--dsw-alias-border-l)' } : undefined,
      },
      h('div', { className: 'dsh-flow-setting-row' },
        h('div', {
          className: 'dsh-flow-row-meta',
          style: { cursor: 'pointer' },
          onClick: () => { toggleSet(stableId) },
        },
        h('span', { className: 'dsh-flow-row-title' }, name),
        h('span', { className: 'dsh-flow-row-sub' },
          picked.length === 0 ? t('set.modesNone') : picked.map(labelOf).join(' · '))),
        h('div', { className: 'dsh-flow-row-ctrl' },
          h(ToggleSwitch, {
            checked: set?.enabled !== false,
            disabled,
            ariaLabel: name,
            onChange: next => { setField(['promptSets', indexKey, 'enabled'], next) },
          }),
          h('button', {
            type: 'button',
            className: 'dsh-flow-iconbtn',
            onClick: () => { toggleSet(stableId) },
          }, CHEVRON(isOpen)),
          h('button', {
            type: 'button',
            className: 'dsh-flow-iconbtn',
            title: t('common.remove'),
            disabled,
            onClick: () => { unsetField(['promptSets', indexKey]) },
          }, '×'))),
      isOpen
        ? h('div', { className: 'dsh-flow-row-block', style: { borderTop: '1px solid var(--dsw-alias-border-l)' } },
          h(Labeled, { label: t('set.name') },
            h(TextField, {
              value: typeof set?.name === 'string' ? set.name : '',
              disabled,
              placeholder: t('set.namePlaceholder'),
              onCommit: next => { setField(['promptSets', indexKey, 'name'], next) },
            })),
          h(Labeled, { label: t('set.text') },
            h(TextField, {
              value: typeof set?.text === 'string' ? set.text : '',
              multiline: true,
              rows: 8,
              disabled,
              onCommit: next => { setField(['promptSets', indexKey, 'text'], next) },
            })),
          h(Labeled, { label: t('set.appliesTo') },
            h('div', { className: 'dsh-flow-pill-row' },
              MODE_IDS.map((modeId) => {
                const on = picked.includes(modeId)
                return h('button', {
                  key: modeId,
                  type: 'button',
                  className: 'dsh-flow-pill',
                  'data-active': on ? 'true' : 'false',
                  disabled,
                  onClick: () => {
                    const next = on ? picked.filter(entry => entry !== modeId) : [...picked, modeId]
                    setField(['promptSets', indexKey, 'modes'], next)
                  },
                }, labelOf(modeId))
              }))))
        : null)
    }))

  /* ---- 视图 3：子代理 ---- */
  const agentsView = h('div', { className: 'dsh-flow-stack' },
    h(SectionGroup, {
      title: t('lib.tabAgents'),
      action: h('button', {
        type: 'button',
        className: 'dsh-flow-btn-link',
        disabled: disabled || promptApiState === 'unavailable',
        onClick: () => { setCreating(v => !v) },
      }, creating ? t('common.cancel') : `+ ${t('lib.newAgent')}`),
    },
    creating
      ? h('div', { className: 'dsh-flow-row-block' },
        h('div', { className: 'dsh-flow-grid2' },
          h(Labeled, { label: t('lib.agentIdLabel') },
            h(TextField, {
              value: newAgentId,
              disabled,
              placeholder: t('lib.newAgentPlaceholder'),
              onDraftChange: setNewAgentId,
            })),
          h(Labeled, { label: t('lib.agentSummaryLabel') },
            h(TextField, {
              value: newAgentSummary,
              disabled,
              placeholder: t('lib.agentSummaryPlaceholder'),
              onDraftChange: setNewAgentSummary,
            }))),
        h('div', { className: 'dsh-flow-row', style: { justifyContent: 'flex-end' } },
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn dsh-flow-btn-primary',
            disabled: disabled || busy === 'create',
            onClick: () => {
              const id = newAgentId.trim()
              const summary = newAgentSummary.trim()
              if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
                setFeedback({ kind: 'error', text: t('lib.badId') })
                return
              }
              const heading = summary === '' ? `# ${id}` : `# ${id} | ${summary}`
              void runBusy('create', async () => {
                await apiCall('PUT', `/api/dsh-flow/subagents/${encodeURIComponent(id)}`, {
                  content: `${heading}\n\n## 身份\n\n你是执行子代理，向总控返回结构化回执。\n\n## 文件边界\n\n（填写可修改的范围）\n\n## 工作方法\n\n1. （填写步骤）\n\n## 输出格式\n\n（填写回执结构）\n`,
                })
                setFeedback({ kind: 'ok', text: t('lib.created').replace('{id}', id) })
                setNewAgentId('')
                setNewAgentSummary('')
                setCreating(false)
                setExpandedAgents(prev => ({ ...prev, [id]: true }))
                refreshPrompts()
              })
            },
          }, t('lib.create'))))
      : null,
    agentList.length === 0
      ? h('div', { className: 'dsh-flow-empty' }, t('lib.noAgents'))
      : agentList.map((item, idx) => {
        const isOpen = expandedAgents[item.id] === true
        const draft = typeof agentDrafts[item.id] === 'string' ? agentDrafts[item.id] : (item.content ?? '')
        const brief = briefOf(item)
        const badge = item.kind === 'custom'
          ? t('lib.customOnly')
          : (item.overridden ? t('lib.builtinCustom') : t('lib.builtinOnly'))

        return h('div', {
          key: item.id,
          style: (idx > 0 || creating) ? { borderTop: '1px solid var(--dsw-alias-border-l)' } : undefined,
        },
        h('button', {
          type: 'button',
          className: 'dsh-flow-disclosure-btn',
          'aria-expanded': isOpen ? 'true' : 'false',
          onClick: () => { setExpandedAgents(prev => ({ ...prev, [item.id]: prev[item.id] !== true })) },
        },
        h('div', { className: 'dsh-flow-row-meta' },
          h('span', { className: 'dsh-flow-row-title' }, item.id),
          brief ? h('span', { className: 'dsh-flow-row-sub' }, brief) : null),
        h('span', { className: 'dsh-flow-disclosure-right' },
          h('span', null, badge),
          CHEVRON(isOpen))),
        isOpen
          ? h('div', { className: 'dsh-flow-row-block', style: { borderTop: '1px solid var(--dsw-alias-border-l)' } },
            h(TextField, {
              value: draft,
              multiline: true,
              rows: 12,
              disabled,
              onDraftChange: (next) => {
                setDirtyAgents(prev => new Set(prev).add(item.id))
                setAgentDrafts(prev => ({ ...prev, [item.id]: next }))
              },
            }),
            h('div', { className: 'dsh-flow-row', style: { justifyContent: 'flex-end' } },
              item.kind === 'official'
                ? h('button', {
                  type: 'button',
                  className: 'dsh-flow-btn',
                  disabled: disabled || busy === `agent:${item.id}` || item.overridden !== true,
                  onClick: () => {
                    void runBusy(`agent:${item.id}`, async () => {
                      await apiCall('DELETE', `/api/dsh-flow/subagents/${encodeURIComponent(item.id)}`)
                      clearDirtyAgent(item.id)
                      setFeedback({ kind: 'ok', text: t('lib.reset') })
                      refreshPrompts()
                    })
                  },
                }, t('common.reset'))
                : h('button', {
                  type: 'button',
                  className: 'dsh-flow-btn dsh-flow-btn-danger',
                  disabled: disabled || busy === `agent:${item.id}`,
                  onClick: () => {
                    if (confirmDeleteId !== item.id) { setConfirmDeleteId(item.id); return }
                    setConfirmDeleteId('')
                    void runBusy(`agent:${item.id}`, async () => {
                      await apiCall('DELETE', `/api/dsh-flow/subagents/${encodeURIComponent(item.id)}`)
                      clearDirtyAgent(item.id)
                      setFeedback({ kind: 'ok', text: t('lib.deleted') })
                      setExpandedAgents(prev => ({ ...prev, [item.id]: false }))
                      refreshPrompts()
                    })
                  },
                }, confirmDeleteId === item.id ? t('lib.confirmDelete') : t('common.delete')),
              h('button', {
                type: 'button',
                className: 'dsh-flow-btn dsh-flow-btn-primary',
                disabled: disabled || busy === `agent:${item.id}`,
                onClick: () => {
                  const content = typeof agentDrafts[item.id] === 'string' ? agentDrafts[item.id] : draft
                  void runBusy(`agent:${item.id}`, async () => {
                    await apiCall('PUT', `/api/dsh-flow/subagents/${encodeURIComponent(item.id)}`, { content })
                    clearDirtyAgent(item.id)
                    setFeedback({ kind: 'ok', text: t('lib.saved') })
                    refreshPrompts()
                  })
                },
              }, busy === `agent:${item.id}` ? t('lib.saving') : t('common.save'))))
          : null)
      })),

    h(DisclosureGroup, {
      title: t('lib.rosterTitle'),
      summary: promptData?.roster?.hasCustom === true ? t('common.custom') : t('common.builtin'),
      open: rosterOpen,
      onToggle: setRosterOpen,
    },
    h('div', { className: 'dsh-flow-row-block' },
      h(TextField, {
        value: rosterDraft,
        multiline: true,
        rows: 10,
        disabled,
        onDraftChange: (next) => { setRosterDirty(true); setRosterDraft(next) },
        onCommit: (next) => { setRosterDraft(next) },
      }),
      h('div', { className: 'dsh-flow-row', style: { justifyContent: 'flex-end' } },
        h('button', {
          type: 'button',
          className: 'dsh-flow-btn',
          disabled: disabled || busy === 'roster',
          onClick: () => {
            void runBusy('roster', async () => {
              await apiCall('DELETE', '/api/dsh-flow/roster')
              setRosterDirty(false)
              setFeedback({ kind: 'ok', text: t('lib.reset') })
              refreshPrompts()
            })
          },
        }, t('common.reset')),
        h('button', {
          type: 'button',
          className: 'dsh-flow-btn dsh-flow-btn-primary',
          disabled: disabled || busy === 'roster',
          onClick: () => {
            void runBusy('roster', async () => {
              await apiCall('PUT', '/api/dsh-flow/roster', { content: rosterDraft })
              setRosterDirty(false)
              setFeedback({ kind: 'ok', text: t('lib.saved') })
              setRosterOpen(true)
              refreshPrompts()
            })
          },
        }, busy === 'roster' ? t('lib.saving') : t('common.save'))))))

  const sourceDisclosure = h(DisclosureGroup, { title: t('lib.sourceSettings') },
    h(SettingRow, { title: t('lib.sourceUrl'), wideControl: true },
      h(TextField, {
        value: typeof promptsCfg.sourceUrl === 'string' ? promptsCfg.sourceUrl : '',
        disabled,
        placeholder: t('lib.sourceUrlPlaceholder'),
        onCommit: next => { setField(['prompts', 'sourceUrl'], next.trim()) },
      })),
    h(SettingRow, { title: t('lib.allowMirror') },
      h(ToggleSwitch, {
        checked: promptsCfg.allowMirrorFallback !== false,
        disabled,
        ariaLabel: t('lib.allowMirror'),
        onChange: next => { setField(['prompts', 'allowMirrorFallback'], next) },
      })))

  return h('div', { className: 'dsh-flow-stack', role: 'tabpanel' },
    topBar,
    feedback === null ? null : h('div', {
      className: feedback.kind === 'error' ? 'dsh-flow-toast dsh-flow-toast-err' : 'dsh-flow-toast',
      role: feedback.kind === 'error' ? 'alert' : undefined,
    }, feedback.text),
    libTab === 'base' ? baseView : null,
    libTab === 'global' ? globalView : null,
    libTab === 'agents' ? agentsView : null,
    sourceDisclosure)
}
