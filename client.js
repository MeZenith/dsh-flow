window.__ModuleLoader__.load({
  id: 'dsh-flow',
  factory: (require) => {
    /**
     * Flow 工作流与提示词管家 — Client 半（自包含单文件）。
     *
     * 为什么所有东西都塞在一个文件里：Client 插件由 `clientModules` 按包路径
     * 直接 serve 单个 bundle，工厂里拿到的 `require` 只认识平台种子表
     * （react / react-dom / zod / @deepseek-ai/cordis 等），**不能**相对 import 兄弟模块。
     * 因此样式用幂等注入的 <style>，字典直接内联，模式元数据与 Host 各持一份等价副本。
     *
     * 只允许 `require('react')` 与 `require('react-dom')`；不碰任何
     * `@deepseek-ai/dsh-client-*` 包（它们随时会变，且会顶掉 slot 渲染）。
     *
     * 交互约定：所有弹层都走同一个 `PopoverPanel`（portal 到 body、自动上下翻转、
     * 点击外部与 Escape 关闭）。原生 <select> 一律不用 —— 它的 <option> 展开面板
     * 由操作系统绘制，在 Windows 暗色主题下会回退成白底，覆写样式也管不到。
     */
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React
    const { createPortal } = ReactDOM

    /* ================================================================ *
     * 常量（与 Host 侧 modes.js 等价；Client 不能 import 它）
     * ================================================================ */

    const MODE_OFF = 'off'
    const MODE_IDS = ['plan', 'plan-ultra', 'build', 'review', 'flow']
    const MODE_FALLBACK = {
      plan: { label: 'Plan', description: '日常快速读码与方案规划' },
      'plan-ultra': { label: 'Plan Ultra', description: '复杂需求深度多视角规划' },
      build: { label: 'Build', description: '专注按方案编写与修改代码' },
      review: { label: 'Review', description: '独立审查 git diff 与验收' },
      flow: { label: 'Flow', description: '全能总控入口，按阶段推进' },
    }
    const OFF_META = { label: '普通模式', description: '关闭模式提示词，不修改权限与模型' }
    const PERMISSION_IDS = ['read-only', 'workspace-write', 'danger-full-access', 'keep']
    const CONFIG_NS = 'flow'
    const STYLE_ID = 'dsh-flow-s1-styles'

    const CHIP_MAX_WIDTH = 220
    const CHIP_MENU_WIDTH = 264
    /** 模式菜单的粗略高度，仅用于首次定位；真正的定位在 layout 阶段按实测高度重算。 */
    const CHIP_MENU_ESTIMATE = 6 * 44
    const SELECT_PANEL_WIDTH = 260
    const SELECT_PANEL_ESTIMATE = 240
    const PANEL_GAP = 6
    const PANEL_MARGIN = 8

    /* ================================================================ *
     * 样式：幂等注入。token 只用 --dsw-*，不写字面色值。
     *   `.dsh-flow-chip` 逐条照搬 PermissionSelect.module.css 的 .trigger，
     *   保证与「开发权限」芯片同高（28px）、同圆角、同 hover、同禁用态。
     * ================================================================ */

    const CSS = `
/* ---------- 聊天输入区芯片（对齐原生 PermissionSelect.trigger） ---------- */
.dsh-flow-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: ${CHIP_MAX_WIDTH}px;
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-flow-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-flow-chip:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-flow-chip:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-flow-chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-flow-chevron {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
  transition: transform 120ms ease;
}
.dsh-flow-chevron[data-open="true"] { transform: rotate(180deg); }

/* ---------- 通用弹层（芯片菜单与自定义下拉共用） ---------- */
.dsh-flow-panel {
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
}
.dsh-flow-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-flow-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-flow-option[data-active="true"] { color: var(--dsw-alias-state-business-primary); }
.dsh-flow-option:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-flow-option-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dsh-flow-option-name { font-weight: 500; }
.dsh-flow-option-desc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
  white-space: normal;
}
.dsh-flow-option-mark {
  flex: 0 0 auto;
  color: var(--dsw-alias-state-business-primary);
  line-height: 18px;
}
.dsh-flow-group {
  padding: 6px 8px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: default;
}
.dsh-flow-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l);
}
.dsh-flow-panel-error {
  margin: 4px 6px 2px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 16px;
  white-space: normal;
}

/* ---------- 自绘下拉触发按钮（与输入框同一套外观） ---------- */
.dsh-flow-selecttrigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-flow-selecttrigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-flow-selecttrigger:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-flow-selecttrigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-flow-selectvalue {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-flow-selectvalue[data-placeholder="true"] { color: var(--dsw-alias-label-tertiary); }

/* ---------- 设置页骨架 ---------- */
.dsh-flow-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-flow-head { display: flex; flex-direction: column; gap: 2px; }
.dsh-flow-title { font-size: 15px; font-weight: 600; }
.dsh-flow-sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

/* 分段 Tab：一条横向胶囊，选中项用主题色描边与文字 */
.dsh-flow-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
}
.dsh-flow-tab {
  flex: 1;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) {
  .dsh-flow-tab:hover:not([data-active="true"]) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-flow-tab[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
  font-weight: 500;
}
.dsh-flow-tab:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.dsh-flow-panelbody { display: flex; flex-direction: column; gap: 12px; }

/* 模式小胶囊（次级 Tab 与可点选标签共用） */
.dsh-flow-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-flow-pill {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 24px;
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) {
  .dsh-flow-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-flow-pill[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}
.dsh-flow-pill:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-flow-pill:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
/* 只读小标签（收起态展示"已生效模式"） */
.dsh-flow-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

/* 单模式编辑卡：整页只有这一层边框 */
.dsh-flow-modecard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
}
.dsh-flow-modehead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.dsh-flow-modename { font-size: 14px; font-weight: 600; }
.dsh-flow-modedesc { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

.dsh-flow-grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 640px) {
  .dsh-flow-grid2 { grid-template-columns: 1fr; }
}

.dsh-flow-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-flow-fieldhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-flow-fieldlabel { color: var(--dsw-alias-label-secondary); font-size: 12px; }

.dsh-flow-input, .dsh-flow-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dsh-flow-textarea { min-height: 220px; resize: vertical; line-height: 18px; }
/* 默认态就要看得见边框，否则在一堆文字里定位不到输入区。 */
.dsh-flow-input,
.dsh-flow-textarea {
  /* 主题变量可能缺定义，缺了整条 border 会作废；回退到次级文字色兜底，
     并用 !important 压住宿主全局 input 重置。 */
  border: 1px solid var(--dsw-alias-border-l, var(--dsw-alias-label-dimmed, currentColor)) !important;
  box-sizing: border-box;
}
.dsh-flow-input:hover:not(:disabled),
.dsh-flow-textarea:hover:not(:disabled) {
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary, currentColor)) !important;
}
.dsh-flow-input:disabled, .dsh-flow-textarea:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}
.dsh-flow-input:focus-visible, .dsh-flow-textarea:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.dsh-flow-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) {
  .dsh-flow-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-flow-btn:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-flow-btn:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-flow-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-flow-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-flow-iconbtn:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}
.dsh-flow-iconbtn:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }

.dsh-flow-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dsh-flow-togglelabel { color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-flow-notice {
  padding: 9px 11px;
  border: 1px solid var(--dsw-alias-border-l);
  border-left-width: 3px;
  border-left-color: var(--dsw-alias-state-business-primary);
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-flow-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
.dsh-flow-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsh-flow-empty {
  padding: 12px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-flow-list { display: flex; flex-direction: column; gap: 8px; }

/* 可折叠提示词条目：只有一层边框 */
.dsh-flow-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l);
  border-radius: var(--dsw-radius-sm);
}
.dsh-flow-itemrow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-flow-itemname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.dsh-flow-itemtags { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; flex: 1; }
.dsh-flow-itemactions { display: flex; align-items: center; gap: 2px; flex: none; }
.dsh-flow-checkbox {
  flex: none;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ================================================================ *
     * 小工具
     * ================================================================ */

    /** 稳定 id：优先 crypto.randomUUID，退化到时间戳 + 随机后缀。 */
    function newId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch { /* 忽略不可用的 crypto */ }
      return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    /** 从 configForms 快照里读出模式显示名与说明，缺失时回落内置副本。 */
    function readModeMeta(snapshot) {
      const modes = snapshot && typeof snapshot === 'object' ? snapshot.modes : undefined
      const meta = {}
      for (const id of MODE_IDS) {
        const fallback = MODE_FALLBACK[id]
        const configured = modes && typeof modes === 'object' ? modes[id] : undefined
        meta[id] = {
          label: typeof configured?.label === 'string' && configured.label !== ''
            ? configured.label
            : fallback.label,
          description: typeof configured?.description === 'string' && configured.description !== ''
            ? configured.description
            : fallback.description,
        }
      }
      return meta
    }

    /** 订阅一个 ConfigForm；没有表单时返回 null，由调用方走降级渲染。 */
    function useConfigSnapshot(form) {
      const [snapshot, setSnapshot] = useState(() => {
        try { return form ? form.getSnapshot() : null } catch { return null }
      })

      useEffect(() => {
        if (!form) { setSnapshot(null); return undefined }
        let alive = true
        const publish = () => {
          if (!alive) return
          try { setSnapshot(form.getSnapshot()) } catch { /* 断连中，保留上一帧 */ }
        }
        publish()
        let off
        try { off = form.subscribe(publish) } catch { off = undefined }
        return () => {
          alive = false
          try { if (typeof off === 'function') off() } catch { /* 忽略 */ }
        }
      }, [form])

      return snapshot
    }

    /** 取当前会话的 SessionFace（可能尚未物化）。 */
    function sessionFaceOf(appCtx, sessionId) {
      try {
        const sessions = appCtx.get('sessions')
        return sessions?.binding?.(sessionId)?.session
      } catch {
        return undefined
      }
    }

    /** 从 `RemoteResult` 里取载荷：兼容 `{ok, value}` 与直接返回两种形状。 */
    function payloadOf(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        return result.ok === false ? undefined : result.value
      }
      return result
    }

    /** 从 `RemoteResult` 里取错误文案。 */
    function errorOf(result, fallback) {
      const error = result && typeof result === 'object' ? result.error : undefined
      const message = error && typeof error.message === 'string' ? error.message : undefined
      return message ?? fallback
    }

    /* ================================================================ *
     * 通用弹层：定位 + 关闭行为
     * ================================================================ */

    /**
     * 由锚点矩形算弹层坐标：优先向下，空间不足则向上翻，最后夹在视口内。
     * @param {DOMRect | null} rect 触发元素矩形。
     * @param {number} height 实测高度（首次渲染用估算值兜底）。
     * @param {number} width 期望宽度。
     */
    function placePanel(rect, height, width) {
      const vw = typeof window === 'undefined' ? 1024 : window.innerWidth
      const vh = typeof window === 'undefined' ? 768 : window.innerHeight
      const w = Math.min(width, Math.max(160, vw - PANEL_MARGIN * 2))
      const left = Math.max(PANEL_MARGIN, Math.min(rect ? rect.left : PANEL_MARGIN, vw - w - PANEL_MARGIN))
      const h = Math.max(80, height || 0)
      const below = rect ? vh - rect.bottom - PANEL_MARGIN : vh
      const above = rect ? rect.top - PANEL_MARGIN : 0
      // 下方放不下、且上方更宽裕时才上翻，避免轻微遮挡就跳上去。
      const openUp = below < h && above > below
      const rawTop = rect
        ? (openUp ? rect.top - h - PANEL_GAP : rect.bottom + PANEL_GAP)
        : PANEL_MARGIN
      const top = Math.max(PANEL_MARGIN, Math.min(rawTop, Math.max(PANEL_MARGIN, vh - h - PANEL_MARGIN)))
      return { left, top, width: w, maxHeight: h }
    }

    /**
     * portal 到 body 的通用弹层。
     *
     * 定位分两步：首帧用 `estimate` 同步算出完整坐标（绝不用 0,0 当占位 ——
     * 那会在 portal 挂载的瞬间画一帧到左上角），随后在 layout 阶段按实测高度修正，
     * 因为 layout 效果在绘制之前跑完，用户看不到中间态。
     */
    function PopoverPanel({
      anchor, estimate, width, className, role, label, children, onClose,
    }) {
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
        // 只在"面板之外"发生滚动或尺寸变化时关闭。
        // 关键：下拉列表自身是可滚动的，滚它的时候事件目标是面板内部节点，
        // 必须放行，否则滚轮/拖滚动条会把自己的下拉关掉。
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

    /* ================================================================ *
     * 聊天输入区的模式芯片（conversation.input.left）
     * ================================================================ */

    function ModeMenu({ anchor, meta, current, busy, error, onPick, onClose, t }) {
      const entries = [{ id: MODE_OFF, label: OFF_META.label, description: OFF_META.description }]
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
      entry.id === current ? h('span', { className: 'dsh-flow-option-mark', 'aria-hidden': true }, '✓') : null,
      )),
      error ? h('div', { className: 'dsh-flow-panel-error', role: 'alert' }, error) : null,
      )
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

      const currentLabel = current === MODE_OFF ? OFF_META.label : meta[current]?.label ?? current
      const title = current === MODE_OFF ? OFF_META.description : meta[current]?.description ?? ''

      const close = useCallback(() => { setOpen(false); setError(null) }, [])

      const toggle = useCallback(() => {
        if (busy) return
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : null
        setAnchor(rect)
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
        h('span', {
          className: 'dsh-flow-chevron',
          'data-open': open ? 'true' : 'false',
          'aria-hidden': true,
        }, h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none' },
          h('path', {
            d: 'M4 6.5 8 10.5 12 6.5',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )),
        ),
        open && anchor
          ? h(ModeMenu, { anchor, meta, current, busy, error, onPick: pick, onClose: close, t })
          : null,
      )
    }

    /* ================================================================ *
     * 自绘下拉：彻底替代原生 <select>
     *
     * 为什么不用 <select>：它的展开面板由操作系统绘制，`<option>` 不接受背景色，
     * Windows 暗色主题下会回退成白底 + 浅色字。这里用与芯片同一个 PopoverPanel
     * 自绘，主题 token 完全可控。
     * ================================================================ */

    const CHEVRON = (open) => h('span', {
      className: 'dsh-flow-chevron',
      'data-open': open ? 'true' : 'false',
      'aria-hidden': true,
    }, h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none' },
      h('path', {
        d: 'M4 6.5 8 10.5 12 6.5',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    ))

    function CustomSelect({
      value, options, groups, placeholder, disabled, onChange, ariaLabel, emptyHint,
    }) {
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
        : (value === '' || value === undefined || value === null
          ? (placeholder ?? '')
          : String(value))

      const close = useCallback(() => { setOpen(false) }, [])

      const toggle = useCallback(() => {
        if (disabled) return
        const rect = triggerRef.current ? triggerRef.current.getBoundingClientRect() : null
        setAnchor(rect)
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
      entry.value === value
        ? h('span', { className: 'dsh-flow-option-mark', 'aria-hidden': true }, '✓')
        : null,
      )

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
        h('span', {
          className: 'dsh-flow-selectvalue',
          'data-placeholder': selected ? 'false' : 'true',
          title: label,
        }, label),
        CHEVRON(open),
        ),
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
          !flat.length && emptyHint ? h('div', { className: 'dsh-flow-hint', style: { padding: '8px' } }, emptyHint) : null,
          )
          : null,
      )
    }

    /* ================================================================ *
     * 表单控件
     * ================================================================ */

    /** 输入框：本地草稿 + 失焦提交，避免每敲一个字写一次配置。 */
    function TextField({ value, onCommit, disabled, multiline, placeholder, rows, type }) {
      const [draft, setDraft] = useState(value)
      const committed = useRef(value)

      useEffect(() => {
        if (value !== committed.current) {
          committed.current = value
          setDraft(value)
        }
      }, [value])

      const commit = () => {
        if (draft === committed.current) return
        committed.current = draft
        onCommit(draft)
      }

      const shared = {
        value: draft,
        disabled,
        placeholder,
        onChange: event => { setDraft(event.target.value) },
        onBlur: commit,
        onKeyDown: (event) => {
          if (!multiline && event.key === 'Enter') { event.currentTarget.blur() }
        },
      }

      return multiline
        ? h('textarea', { ...shared, className: 'dsh-flow-textarea', rows: rows ?? 5 })
        : h('input', { ...shared, className: 'dsh-flow-input', type: type ?? 'text', placeholder })
    }

    /** 权限档位下拉。 */
    function PermissionField({ value, disabled, onChange, t }) {
      const options = useMemo(
        () => PERMISSION_IDS.map(id => ({ value: id, label: t(`permission.${id}`) })),
        [t],
      )
      return h(CustomSelect, {
        value: PERMISSION_IDS.includes(value) ? value : 'keep',
        options,
        disabled,
        onChange,
        ariaLabel: t('mode.permission'),
      })
    }

    /**
     * 默认模型下拉：首项"不自动切换" + 按 provider 分组。
     *
     * 关键点：`catalog` 尚未就绪（loading/error/unavailable）时，只要字段已有保存值，
     * 就把这个保存值补进选项并显示在按钮上 —— 否则用户会看到"不自动切换"，
     * 误以为配置丢了。
     */
    /* ================================================================ *
     * 乐观更新辅助（纯函数，供设置卡片使用）
     * ================================================================ */

    /** 把路径数组编成可作对象键的稳定字符串。 */
    function pathKey(path) {
      return path.join('\u0000')
    }

    /** 按路径读值，中途任一层缺失即返回 undefined。 */
    function readPathOf(source, path) {
      let cursor = source
      for (const key of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[key]
      }
      return cursor
    }

    /** 按路径写值：只沿路径浅拷贝，绝不就地修改快照对象。 */
    function writePathOf(source, path, next) {
      const base = source !== null && typeof source === 'object' ? source : {}
      const [head, ...rest] = path
      const child = rest.length === 0 ? next : writePathOf(base[head], rest, next)
      return { ...base, [head]: child }
    }

    /**
     * 把乐观覆盖叠到快照值上。
     *
     * 快照已经追上某条覆盖时直接以快照为准：即使覆盖还没被撤掉，
     * 显示也不会有偏差，避免"覆盖残留导致脏读"。
     */
    function withOverrides(base, table) {
      const keys = Object.keys(table)
      if (keys.length === 0) return base
      let merged = base
      for (const key of keys) {
        const path = key.split('\u0000')
        const optimistic = table[key]
        if (Object.is(readPathOf(base, path), optimistic)) continue
        merged = writePathOf(merged, path, optimistic)
      }
      return merged
    }

    function ModelField({ value, catalog, disabled, onChange, t }) {
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
        if (known) return noneOption
        // 保存值不在目录里（目录没加载完 / 失败 / 已被移除）→ 原样列出，保证按钮显示真实值。
        return [...noneOption, { value: saved, label: saved }]
      }, [groups, noneOption, saved])

      const hintKey = ready
        ? (catalog.failures && catalog.failures.length > 0 ? 'model.failures' : '')
        : `model.state.${catalog?.status ?? 'loading'}`

      return h('div', { className: 'dsh-flow-field' },
        h('span', { className: 'dsh-flow-fieldlabel' }, t('mode.model')),
        h(CustomSelect, {
          value: saved,
          options,
          groups,
          disabled,
          onChange,
          ariaLabel: t('mode.model'),
          emptyHint: t('model.state.unavailable'),
        }),
        hintKey
          ? h('span', { className: 'dsh-flow-hint' }, t(hintKey, {
            names: (catalog?.failures ?? []).map(f => f?.name ?? f?.id ?? '?').join('、'),
          }))
          : null,
      )
    }

    /* ================================================================ *
     * 设置页
     * ================================================================ */

    const TABS = ['modes', 'prompts', 'gate', 'base', 'notify']

    function FlowSettingsCard(props) {
      const { appCtx, t } = props
      const forms = appCtx.get('configForms')
      const form = props.form ?? (forms && typeof forms.get === 'function' ? forms.get(CONFIG_NS) : undefined)
      const snapshot = useConfigSnapshot(form)

      const [tab, setTab] = useState('modes')
      const [activeMode, setActiveMode] = useState(MODE_IDS[0])
      const [expanded, setExpanded] = useState(() => new Set())
      const [catalog, setCatalog] = useState({ status: 'loading', groups: [], failures: [] })
      const [error, setError] = useState(null)
      /**
       * 乐观覆盖表：`'circuit\u0000enabled' → true`。
       *
       * 点击后立刻在本地生效并异步写盘，写盘结束（成功或失败）即撤掉对应覆盖，
       * 之后由 `snapshot` 接管显示。这样连续点选不会被上一笔写盘卡住。
       */
      const [overrides, setOverrides] = useState({})

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
            setCatalog({
              status: 'error',
              groups: [],
              failures: [],
              reason: cause instanceof Error ? cause.message : String(cause),
            })
          })
        return () => { alive = false }
      }, [appCtx])

      /**
       * 尽力从 dsh-im 的投递 RPC 拉取机器人 / 目标列表，供设置页渲染下拉。
       *
       * 拉不到（未装 dsh-im、RPC 通道不存在、机器人在离线状态）时状态置为
       * `unavailable`，界面自动降级成文本框，不阻塞任何设置。
       */
      const [imCatalog, setImCatalog] = useState({ status: 'idle', bots: [], targets: [] })
      const imBotId = (() => {
        const im = snapshot && snapshot.value && typeof snapshot.value.im === 'object' ? snapshot.value.im : null
        return im && typeof im.botId === 'string' ? im.botId.trim() : ''
      })()

      useEffect(() => {
        let alive = true
        let connection
        try { connection = appCtx.get('connection') } catch { connection = undefined }
        if (!connection || typeof connection.rpc?.call !== 'function') {
          setImCatalog({ status: 'unavailable', bots: [], targets: [] })
          return undefined
        }
        const signal = new AbortController().signal
        const call = (endpoint, payload) => connection.rpc.call('/dsh-im-delivery', endpoint, payload, signal)
        const rowsOf = (value, key) => {
          const source = value && typeof value === 'object' ? value : {}
          const nested = source.value && typeof source.value === 'object' ? source.value : {}
          const list = nested[key] ?? source[key]
          return Array.isArray(list) ? list : []
        }

        void Promise.resolve()
          .then(async () => {
            let bots = []
            try { bots = rowsOf(await call('bot.list', {}), 'bots') } catch { bots = [] }
            let targets = []
            if (imBotId !== '') {
              try { targets = rowsOf(await call('target.list', { botId: imBotId }), 'targets') } catch { targets = [] }
            }
            if (!alive) return
            setImCatalog({
              status: bots.length === 0 && targets.length === 0 ? 'unavailable' : 'ready',
              bots,
              targets,
            })
          })
          .catch(() => {
            if (alive) setImCatalog({ status: 'unavailable', bots: [], targets: [] })
          })
        return () => { alive = false }
      }, [appCtx, imBotId])

      /** 撤掉一条乐观覆盖（写盘结束后调用）。 */
      const dropOverride = useCallback((key) => {
        setOverrides((prev) => {
          if (!(key in prev)) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }, [])

      const mutate = useCallback(async (ops, key) => {
        if (!form || typeof form.mutate !== 'function') {
          setError(t('error.noForm'))
          if (key !== undefined) dropOverride(key)
          return
        }
        setError(null)
        try {
          const accepted = await form.mutate(ops)
          if (accepted === false) setError(t('error.rejected'))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          // 无论成功失败都撤覆盖：成功时快照已追上，失败时回到真实值（等同回滚）。
          if (key !== undefined) dropOverride(key)
        }
      }, [form, t, dropOverride])

      if (!form || snapshot === null) {
        return h('div', { className: 'dsh-flow-card' },
          h('div', { className: 'dsh-flow-head' },
            h('span', { className: 'dsh-flow-title' }, t('settings.title')),
          ),
          h('div', { className: 'dsh-flow-empty' }, t('settings.unavailable')),
        )
      }

      // 叠加乐观覆盖后再渲染；保存期间**不**整体禁用，只锁只读配置源。
      const value = withOverrides((snapshot && snapshot.value) || {}, overrides)
      const writable = !snapshot || snapshot.writable !== false
      const saving = snapshot ? snapshot.status !== 'ready' : false
      const disabled = !writable

      const sets = Array.isArray(value.promptSets) ? value.promptSets : []
      const modes = value && typeof value.modes === 'object' && value.modes !== null ? value.modes : {}

      /**
       * 模式显示名统一从这里取：优先配置里可改的 label，回落内置副本。
       * 三处（模式胶囊 / 收起态标签 / 展开态开关）共用，改名后不会各说各话。
       */
      const labelOf = (modeId) => {
        const configured = modes[modeId]
        return typeof configured?.label === 'string' && configured.label !== ''
          ? configured.label
          : MODE_FALLBACK[modeId].label
      }

      /** 写一个字段：先乐观生效，再异步落盘。 */
      const setField = (path, next) => {
        const key = pathKey(path)
        setOverrides(prev => ({ ...prev, [key]: next }))
        void mutate([{ op: 'set', path, value: next }], key)
      }
      const unsetField = (path) => { void mutate([{ op: 'unset', path }]) }

      /* ---------------- 顶部三栏分段 Tab ---------------- */

      const tabDefs = [
        { id: 'modes', label: t('tab.modes') },
        { id: 'prompts', label: t('tab.prompts') },
        { id: 'gate', label: t('tab.gate') },
        { id: 'base', label: t('tab.base') },
        { id: 'notify', label: t('tab.notify') },
      ]

      const tabBar = h('div', { className: 'dsh-flow-tabs', role: 'tablist' },
        tabDefs.map(def => h('button', {
          key: def.id,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === def.id ? 'true' : 'false',
          'data-active': tab === def.id ? 'true' : 'false',
          className: 'dsh-flow-tab',
          onClick: () => { setTab(def.id) },
        }, def.label)),
      )

      /* ---------------- Tab 1：五大模式 ---------------- */

      const modePills = h('div', { className: 'dsh-flow-pills' },
        MODE_IDS.map((modeId) => {
          return h('button', {
            key: modeId,
            type: 'button',
            'data-active': activeMode === modeId ? 'true' : 'false',
            'aria-pressed': activeMode === modeId ? 'true' : 'false',
            className: 'dsh-flow-pill',
            onClick: () => { setActiveMode(modeId) },
          }, labelOf(modeId))
        }),
      )

      const activeCfg = modes[activeMode]
      const activeLabel = labelOf(activeMode)
      const activeDesc = typeof activeCfg?.description === 'string' && activeCfg.description !== ''
        ? activeCfg.description
        : MODE_FALLBACK[activeMode].description

      const modeCard = h('div', { className: 'dsh-flow-modecard' },
        h('div', { className: 'dsh-flow-modehead' },
          h('span', { className: 'dsh-flow-modename' }, activeLabel),
          h('span', { className: 'dsh-flow-modedesc' }, activeDesc),
        ),
        h('div', { className: 'dsh-flow-grid2' },
          h(ModelField, {
            value: typeof activeCfg?.model === 'string' ? activeCfg.model : '',
            catalog,
            disabled,
            t,
            onChange: next => { setField(['modes', activeMode, 'model'], next) },
          }),
          h('div', { className: 'dsh-flow-field' },
            h('span', { className: 'dsh-flow-fieldlabel' }, t('mode.permission')),
            h(PermissionField, {
              value: typeof activeCfg?.permission === 'string' ? activeCfg.permission : 'keep',
              disabled,
              t,
              onChange: next => { setField(['modes', activeMode, 'permission'], next) },
            }),
          ),
        ),
        h('div', { className: 'dsh-flow-field' },
          h('div', { className: 'dsh-flow-fieldhead' },
            h('span', { className: 'dsh-flow-fieldlabel' }, t('mode.prompt')),
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn',
              disabled,
              onClick: () => { unsetField(['modes', activeMode, 'prompt']) },
            }, t('common.reset')),
          ),
          h(TextField, {
            value: typeof activeCfg?.prompt === 'string' ? activeCfg.prompt : '',
            multiline: true,
            rows: 14,
            disabled,
            onCommit: next => { setField(['modes', activeMode, 'prompt'], next) },
          }),
        ),
        h('div', { className: 'dsh-flow-hint' }, t('settings.sectionBHint')),
      )

      /* ---------------- Tab 2：全局提示词（可折叠） ---------------- */

      const toggleExpanded = (key) => {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      const promptItems = sets.map((set, index) => {
        const key = String(index)
        const isOpen = expanded.has(key)
        const picked = Array.isArray(set?.modes) ? set.modes : []
        const name = typeof set?.name === 'string' && set.name !== '' ? set.name : t('set.newName')

        const pillToggles = h('div', { className: 'dsh-flow-pills' },
          MODE_IDS.map((modeId) => {
            const on = picked.includes(modeId)
            return h('button', {
              key: modeId,
              type: 'button',
              'data-active': on ? 'true' : 'false',
              'aria-pressed': on ? 'true' : 'false',
              className: 'dsh-flow-pill',
              disabled,
              onClick: () => {
                const next = on
                  ? picked.filter(entry => entry !== modeId)
                  : [...picked, modeId]
                setField(['promptSets', key, 'modes'], next)
              },
            }, labelOf(modeId))
          }),
        )

        return h('div', { className: 'dsh-flow-item', key: set?.id || key },          // 收起/展开都有的首行
          h('div', { className: 'dsh-flow-itemrow' },
            h('input', {
              type: 'checkbox',
              className: 'dsh-flow-checkbox',
              checked: set?.enabled !== false,
              disabled,
              'aria-label': t('set.enabled'),
              onChange: event => { setField(['promptSets', key, 'enabled'], event.target.checked) },
            }),
            h('span', { className: 'dsh-flow-itemname', title: name }, name),
            h('div', { className: 'dsh-flow-itemtags' },
              picked.length === 0
                ? h('span', { className: 'dsh-flow-tag' }, t('set.modesNone'))
                : picked.map(modeId => h('span', { key: modeId, className: 'dsh-flow-tag' },
                  labelOf(modeId))),
            ),
            h('div', { className: 'dsh-flow-itemactions' },
              h('button', {
                type: 'button',
                className: 'dsh-flow-iconbtn',
                'aria-expanded': isOpen ? 'true' : 'false',
                'aria-label': isOpen ? t('set.collapse') : t('set.expand'),
                title: isOpen ? t('set.collapse') : t('set.expand'),
                onClick: () => { toggleExpanded(key) },
              }, isOpen ? '▴' : '▾'),
              h('button', {
                type: 'button',
                className: 'dsh-flow-iconbtn',
                'aria-label': t('common.remove'),
                title: t('common.remove'),
                disabled,
                onClick: () => { unsetField(['promptSets', key]) },
              }, '×'),
            ),
          ),
          // 展开区
          isOpen
            ? h(React.Fragment, null,
              h('div', { className: 'dsh-flow-field' },
                h('span', { className: 'dsh-flow-fieldlabel' }, t('set.name')),
                h(TextField, {
                  value: typeof set?.name === 'string' ? set.name : '',
                  disabled,
                  placeholder: t('set.namePlaceholder'),
                  onCommit: next => { setField(['promptSets', key, 'name'], next) },
                }),
              ),
              h('div', { className: 'dsh-flow-field' },
                h('span', { className: 'dsh-flow-fieldlabel' }, t('set.text')),
                h(TextField, {
                  value: typeof set?.text === 'string' ? set.text : '',
                  multiline: true,
                  rows: 13,
                  disabled,
                  onCommit: next => { setField(['promptSets', key, 'text'], next) },
                }),
              ),
              h('div', { className: 'dsh-flow-field' },
                h('span', { className: 'dsh-flow-fieldlabel' }, t('set.appliesTo')),
                pillToggles,
              ),
            )
            : null,
        )
      })

      const promptsPanel = h('div', { className: 'dsh-flow-panelbody' },
        h('div', { className: 'dsh-flow-fieldhead' },
          h('span', { className: 'dsh-flow-hint' }, t('settings.sectionAHint')),
          h('button', {
            type: 'button',
            className: 'dsh-flow-btn',
            disabled,
            onClick: () => {
              const key = String(sets.length)
              // 新增后立刻展开这一条，省得用户再点一次。
              setExpanded((prev) => new Set(prev).add(key))
              setField(['promptSets', key], {
                id: newId(), name: t('set.newName'), enabled: true, text: '', modes: [],
              })
            },
          }, t('set.add')),
        ),
        sets.length === 0
          ? h('div', { className: 'dsh-flow-empty' }, t('set.empty'))
          : h('div', { className: 'dsh-flow-list' }, promptItems),
      )

      /* ---------------- Tab 3：底座契约 ---------------- */

      const basePanel = h('div', { className: 'dsh-flow-panelbody' },
        h('div', { className: 'dsh-flow-field' },
          h('div', { className: 'dsh-flow-fieldhead' },
            h('span', { className: 'dsh-flow-fieldlabel' }, t('base.title')),
            h('button', {
              type: 'button',
              className: 'dsh-flow-btn',
              disabled,
              onClick: () => { unsetField(['baseRules']) },
            }, t('common.reset')),
          ),
          h(TextField, {
            value: typeof value.baseRules === 'string' ? value.baseRules : '',
            multiline: true,
            rows: 14,
            disabled,
            onCommit: next => { setField(['baseRules'], next) },
          }),
          h('span', { className: 'dsh-flow-hint' }, t('base.hint')),
        ),
      )

      /* ---------------- Tab 3：工作流与门禁 ---------------- */

      const gateSpec = value && typeof value.spec === 'object' && value.spec !== null ? value.spec : {}
      const gateBehavior = value && typeof value.behavior === 'object' && value.behavior !== null ? value.behavior : {}

      /** 复选行：原生 checkbox 已由 `.dsh-flow-checkbox` 对齐主题色，无需自绘。 */
      const checkboxRow = input => h('label', { className: 'dsh-flow-toggle' },
        h('input', {
          type: 'checkbox',
          className: 'dsh-flow-checkbox',
          checked: input.checked,
          disabled,
          onChange: event => { input.onChange(event.target.checked) },
        }),
        h('span', { className: 'dsh-flow-togglelabel' }, input.label),
      )

      const gatePanel = h('div', { className: 'dsh-flow-panelbody', role: 'tabpanel' },
        h('div', { className: 'dsh-flow-field' },
          checkboxRow({
            label: t('gate.specEnabled'),
            checked: gateSpec.enabled !== false,
            onChange: next => { setField(['spec', 'enabled'], next) },
          }),
          h('span', { className: 'dsh-flow-hint' }, t('gate.specEnabledHint')),
        ),
        h('div', { className: 'dsh-flow-grid2' },
          h('div', { className: 'dsh-flow-field' },
            h('span', { className: 'dsh-flow-fieldlabel' }, t('gate.specPath')),
            h(TextField, {
              value: typeof gateSpec.path === 'string' ? gateSpec.path : '',
              disabled,
              placeholder: '.flow/spec.md',
              onCommit: next => { setField(['spec', 'path'], next.trim()) },
            }),
          ),
          h('div', { className: 'dsh-flow-field' },
            h('span', { className: 'dsh-flow-fieldlabel' }, t('gate.specMaxChars')),
            h(TextField, {
              value: String(typeof gateSpec.maxChars === 'number' ? gateSpec.maxChars : 600),
              disabled,
              onCommit: (next) => {
                const parsed = Number.parseInt(next, 10)
                if (Number.isFinite(parsed) && parsed >= 80) setField(['spec', 'maxChars'], parsed)
              },
            }),
          ),
        ),
        h('div', { className: 'dsh-flow-field' },
          checkboxRow({
            label: t('gate.autoCompact'),
            checked: gateBehavior.autoCompactOnGate !== false,
            onChange: next => { setField(['behavior', 'autoCompactOnGate'], next) },
          }),
          h('span', { className: 'dsh-flow-hint' }, t('gate.autoCompactHint')),
        ),
        h('div', { className: 'dsh-flow-notice' }, t('gate.remoteHint')),
      )

      /* ---------------- Tab 5：熔断与通知 ---------------- */

      const circuitCfg = value && typeof value.circuit === 'object' && value.circuit !== null ? value.circuit : {}
      const teamCfg = value && typeof value.team === 'object' && value.team !== null ? value.team : {}
      const imCfg = value && typeof value.im === 'object' && value.im !== null ? value.im : {}
      const mailCfg = value && typeof value.email === 'object' && value.email !== null ? value.email : {}
      const notifyCfg = value && typeof value.notify === 'object' && value.notify !== null ? value.notify : {}
      const imWebhook = imCfg.webhook && typeof imCfg.webhook === 'object' ? imCfg.webhook : {}

      const cardTitle = key => h('span', { className: 'dsh-flow-sub' }, t(key))

      /** 带标签的字段单元：标签用浅色说明文字，控件紧随其下。 */
      const labeled = (labelKey, control, hintKey) => h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
      },
      h('span', { className: 'dsh-flow-sub' }, t(labelKey)),
      control,
      hintKey === undefined ? null : h('span', { className: 'dsh-flow-hint' }, t(hintKey)),
      )

      const spacer = () => h('div', { style: { height: '1px' } })

      const numberField = (path, current, hintKey) => labeled(path[1], h(TextField, {
        value: String(current ?? ''),
        disabled,
        onCommit: (next) => {
          const parsed = Number(next)
          if (Number.isFinite(parsed)) setField(path, parsed)
        },
      }), hintKey)

      const selectField = (path, current, options, hintKey) => labeled(path[1], h(CustomSelect, {
        value: current,
        options,
        disabled,
        onChange: next => { setField(path, next) },
        ariaLabel: t(path[1]),
      }), hintKey)

      const providerOptions = [
        { value: 'qq', label: 'QQ 邮箱' },
        { value: 'netease', label: '网易邮箱' },
        { value: 'gmail', label: 'Google Gmail' },
        { value: 'custom', label: '自定义 SMTP' },
      ]
      const strategyOptions = [
        { value: 'im-first', label: t('strategy.imFirst') },
        { value: 'email-first', label: t('strategy.emailFirst') },
        { value: 'both', label: t('strategy.both') },
        { value: 'off', label: t('strategy.off') },
      ]
      const webhookKinds = [
        { value: 'feishu', label: '飞书' },
        { value: 'dingtalk', label: '钉钉' },
        { value: 'wecom', label: '企业微信' },
        { value: 'bark', label: 'Bark' },
        { value: 'pushplus', label: 'PushPlus' },
        { value: 'custom', label: '自定义 JSON' },
      ]
      const isCustomSmtp = (mailCfg.provider ?? 'qq') === 'custom'

      /* ---- 卡片 1：熔断与空闲 ---- */
      const circuitCard = h('div', { className: 'dsh-flow-modecard' },
        cardTitle('notify.cardCircuit'),
        checkboxRow({
          label: t('notify.circuitEnabled'),
          checked: circuitCfg.enabled !== false,
          onChange: next => { setField(['circuit', 'enabled'], next) },
        }),
        h('span', { className: 'dsh-flow-hint' }, t('notify.circuitHint')),
        h('div', { className: 'dsh-flow-grid2' },
          numberField(['circuit', 'threshold'], circuitCfg.threshold ?? 3, 'notify.thresholdHint'),
          numberField(['circuit', 'idleSeconds'], circuitCfg.idleSeconds ?? 120, 'notify.idleHint'),
        ),
        labeled('rescueModel', h(ModelField, {
          value: typeof circuitCfg.rescueModel === 'string' ? circuitCfg.rescueModel : '',
          catalog,
          disabled,
          onChange: next => { setField(['circuit', 'rescueModel'], next) },
          t,
        }), 'notify.rescueModelHint'),
      )

      /* ---- 卡片 2：IM 渠道与 Webhook ---- */
      const imEnabled = imCfg.enabled !== false
      const botChoices = (imCatalog.bots || [])
        .map(item => ({
          value: String(item?.botId ?? ''),
          label: item?.channel ? `${item.botId} · ${item.channel}` : String(item?.botId ?? ''),
        }))
        .filter(choice => choice.value !== '')
      const targetChoices = (imCatalog.targets || [])
        .map(item => ({
          value: String(item?.targetId ?? ''),
          label: item?.name ? `${item.targetId} · ${item.name}` : String(item?.targetId ?? ''),
        }))
        .filter(choice => choice.value !== '')

      const botControl = botChoices.length > 0
        ? h(CustomSelect, {
          value: typeof imCfg.botId === 'string' ? imCfg.botId : '',
          options: botChoices,
          disabled,
          onChange: next => { setField(['im', 'botId'], next) },
          ariaLabel: t('botId'),
        })
        : h(TextField, {
          value: typeof imCfg.botId === 'string' ? imCfg.botId : '',
          disabled,
          onCommit: next => { setField(['im', 'botId'], next) },
        })
      const targetControl = targetChoices.length > 0
        ? h(CustomSelect, {
          value: typeof imCfg.targetId === 'string' ? imCfg.targetId : '',
          options: targetChoices,
          disabled,
          onChange: next => { setField(['im', 'targetId'], next) },
          ariaLabel: t('targetId'),
        })
        : h(TextField, {
          value: typeof imCfg.targetId === 'string' ? imCfg.targetId : '',
          disabled,
          onCommit: next => { setField(['im', 'targetId'], next) },
        })

      const imCard = h('div', { className: 'dsh-flow-modecard' },
        cardTitle('notify.cardIm'),
        checkboxRow({
          label: t('notify.imEnabled'),
          checked: imEnabled,
          onChange: next => { setField(['im', 'enabled'], next) },
        }),
        h('span', { className: 'dsh-flow-hint' },
          imEnabled && imCatalog.status === 'unavailable' ? t('notify.imFallback') : t('notify.imHint')),
        imEnabled ? h('div', null,
          h('div', { className: 'dsh-flow-grid2' },
            labeled('botId', botControl, 'notify.botIdHint'),
            labeled('targetId', targetControl, 'notify.targetIdHint'),
          ),
          spacer(),
          checkboxRow({
            label: t('notify.webhookEnabled'),
            checked: imWebhook.enabled === true,
            onChange: next => { setField(['im', 'webhook', 'enabled'], next) },
          }),
          imWebhook.enabled === true
            ? h('div', { className: 'dsh-flow-grid2' },
              labeled('kind', h(CustomSelect, {
                value: imWebhook.kind ?? 'feishu',
                options: webhookKinds,
                disabled,
                onChange: next => { setField(['im', 'webhook', 'kind'], next) },
                ariaLabel: t('kind'),
              })),
              labeled('webhookUrl', h(TextField, {
                value: typeof imWebhook.url === 'string' ? imWebhook.url : '',
                disabled,
                onCommit: next => { setField(['im', 'webhook', 'url'], next) },
              })),
            )
            : h('span', { className: 'dsh-flow-hint' }, t('notify.webhookHint')),
        ) : null,
      )

      /* ---- 卡片 3：SMTP 邮箱 ---- */
      const emailEnabled = mailCfg.enabled === true
      const emailCard = h('div', { className: 'dsh-flow-modecard' },
        cardTitle('notify.cardEmail'),
        checkboxRow({
          label: t('notify.emailEnabled'),
          checked: emailEnabled,
          onChange: next => { setField(['email', 'enabled'], next) },
        }),
        h('span', { className: 'dsh-flow-hint' }, t('notify.emailHint')),
        emailEnabled ? h('div', null,
          h('div', { className: 'dsh-flow-grid2' },
            labeled('provider', h(CustomSelect, {
              value: mailCfg.provider ?? 'qq',
              options: providerOptions,
              disabled,
              onChange: next => { setField(['email', 'provider'], next) },
              ariaLabel: t('provider'),
            }), 'notify.providerHint'),
            labeled('fromName', h(TextField, {
              value: typeof mailCfg.fromName === 'string' ? mailCfg.fromName : '',
              disabled,
              onCommit: next => { setField(['email', 'fromName'], next) },
            })),
            labeled('account', h(TextField, {
              value: typeof mailCfg.account === 'string' ? mailCfg.account : '',
              disabled,
              onCommit: next => { setField(['email', 'account'], next) },
            }), 'notify.accountHint'),
            labeled('secret', h(TextField, {
              value: '',
              type: 'password',
              disabled,
              onCommit: next => { setField(['email', 'secret'], next) },
            }), 'notify.secretHint'),
            labeled('to', h(TextField, {
              value: typeof mailCfg.to === 'string' ? mailCfg.to : '',
              disabled,
              onCommit: next => { setField(['email', 'to'], next) },
            }), 'notify.toHint'),
            labeled('attachLimitBytes', h(TextField, {
              value: String(mailCfg.attachLimitBytes ?? 2097152),
              disabled,
              onCommit: (next) => {
                const parsed = Number(next)
                if (Number.isFinite(parsed) && parsed > 0) setField(['email', 'attachLimitBytes'], parsed)
              },
            }), 'notify.attachHint'),
            isCustomSmtp ? labeled('host', h(TextField, {
              value: typeof mailCfg.host === 'string' ? mailCfg.host : '',
              disabled,
              onCommit: next => { setField(['email', 'host'], next) },
            })) : null,
            isCustomSmtp ? numberField(['email', 'port'], mailCfg.port ?? 465, 'notify.portHint') : null,
            isCustomSmtp ? labeled('security', h(CustomSelect, {
              value: mailCfg.security ?? 'ssl',
              options: [
                { value: 'ssl', label: 'SSL/TLS（465）' },
                { value: 'starttls', label: 'STARTTLS（587）' },
              ],
              disabled,
              onChange: next => { setField(['email', 'security'], next) },
              ariaLabel: t('security'),
            })) : null,
          ),
          checkboxRow({
            label: t('notify.forceArchive'),
            checked: mailCfg.forceArchive === true,
            onChange: next => { setField(['email', 'forceArchive'], next) },
          }),
          h('span', { className: 'dsh-flow-hint' }, t('notify.forceArchiveHint')),
        ) : null,
      )

      /* ---- 卡片 4：事件分流 + Team 联动 ---- */
      const flowCard = h('div', { className: 'dsh-flow-modecard' },
        cardTitle('notify.cardFlow'),
        h('div', { className: 'dsh-flow-grid2' },
          selectField(['notify', 'brake'], notifyCfg.brake ?? 'im-first', strategyOptions),
          selectField(['notify', 'gate'], notifyCfg.gate ?? 'im-first', strategyOptions),
          selectField(['notify', 'team'], notifyCfg.team ?? 'im-first', strategyOptions),
          selectField(['notify', 'archive'], notifyCfg.archive ?? 'email-first', strategyOptions),
        ),
        checkboxRow({
          label: t('notify.teamEnabled'),
          checked: teamCfg.enabled !== false,
          onChange: next => { setField(['team', 'enabled'], next) },
        }),
        teamCfg.enabled !== false
          ? labeled('teamUrl', h(TextField, {
            value: typeof teamCfg.baseUrl === 'string' ? teamCfg.baseUrl : '',
            disabled,
            onCommit: next => { setField(['team', 'baseUrl'], next) },
          }), 'notify.teamUrlHint')
          : null,
        h('div', { className: 'dsh-flow-notice' }, t('notify.testHint')),
      )

      const notifyPanel = h('div', { role: 'tabpanel', style: { display: 'grid', gap: '12px' } },
        circuitCard,
        imCard,
        emailCard,
        flowCard,
      )

      /* ---------------- 组装 ---------------- */

      return h('div', { className: 'dsh-flow-card' },
        h('div', { className: 'dsh-flow-head' },
          h('span', { className: 'dsh-flow-title' }, t('settings.title')),
          h('span', { className: 'dsh-flow-sub' }, t('settings.subtitle')),
          saving ? h('span', { className: 'dsh-flow-hint' }, t('settings.saving')) : null,
        ),
        error ? h('div', { className: 'dsh-flow-error', role: 'alert' }, error) : null,
        writable ? null : h('div', { className: 'dsh-flow-hint' }, t('settings.readonly')),
        tabBar,
        tab === 'modes' ? h('div', { className: 'dsh-flow-panelbody', role: 'tabpanel' },
          modePills,
          modeCard,
        ) : null,
        tab === 'prompts' ? promptsPanel : null,
        tab === 'gate' ? gatePanel : null,
        tab === 'base' ? basePanel : null,
        tab === 'notify' ? notifyPanel : null,
      )
    }

    /* ================================================================ *
     * 字典
     * ================================================================ */

    const zh = {
      'chip.aria': '切换 Flow 工作流模式，当前 {name}',
      'menu.aria': 'Flow 模式列表',
      'error.session': '这个会话还没准备好，稍后再试。',
      'error.switch': '切换失败，请重试。',
      'error.missingCommand': '宿主没有注册 /flow 命令，请确认插件已启用。',
      'error.noForm': '配置表单不可用，无法写入。',
      'error.rejected': '宿主拒绝了这次修改。',
      'settings.title': 'Flow 工作流',
      'settings.nav': 'Flow 工作流',
      'settings.subtitle': '分层提示词与五大模式',
      'settings.unavailable': '配置尚未就绪，稍后再打开这一页。',
      'settings.readonly': '当前配置只读（由更高优先级的组合层提供）。',
      'settings.sectionAHint': '每套提示词可勾选生效模式；勾选的模式会把它追加到该模式的专属提示词之前。',
      'settings.sectionBHint': '默认模型只在切换模式的那一刻应用一次；之后你在对话框里手动换模型都生效。',
      'tab.modes': '五大模式',
      'tab.prompts': '全局提示词',
      'tab.gate': '工作流与门禁',
      'tab.base': '底座契约',
      'tab.notify': '熔断与通知',
      'settings.saving': '保存中…',
      'notify.cardCircuit': '熔断与空闲设置',
      'notify.cardIm': 'IM 渠道与 Webhook',
      'notify.cardEmail': 'SMTP 邮箱渠道',
      'notify.cardFlow': '事件分流与 Team 联动',
      'notify.imFallback': 'dsh-im 未提供机器人列表接口：请到「IM机器人」设置页复制 botId 与 targetId 填入，或执行 /flow notify-test 查看当前通道是否可用。',
      'strategy.imFirst': 'IM 优先，失败回退邮箱',
      'strategy.emailFirst': '邮箱优先，失败回退 IM',
      'strategy.both': '双渠道同发',
      'strategy.off': '关闭',
      'notify.circuitEnabled': '启用连续报错熔断',
      'notify.circuitHint': '同一会话内工具连续失败达到阈值即急刹并锁定，成功后计数清零。',
      'notify.thresholdHint': '连续失败达到该次数触发熔断（默认 3）。',
      'notify.rescueModel': '救场强模型',
      'notify.rescueModelHint': '格式 provider::model，例如 deepseek::deepseek-chat；留空则回复 2 时只重投不换模型。',
      'notify.idleHint': '桌面空闲秒数：距你最后一次发消息超过该值才发提醒（0 表示立刻发）。',
      'notify.teamEnabled': '联动 dsh-team-control',
      'notify.teamHint': '后台订阅团队事件流，服务未启动时会静默退避重连，不影响主流程。',
      'notify.teamUrl': 'team-control 地址',
      'notify.teamUrlHint': '默认 http://127.0.0.1:4317。',
      'notify.imEnabled': '启用 IM 渠道',
      'notify.imHint': '优先使用 dsh-im 已连接的机器人；只发送 Markdown 文本，附件统一走邮箱。',
      'notify.botId': '机器人 botId',
      'notify.botIdHint': '在「IM机器人」设置页复制，或执行 /flow notify-test 查看已配置机器人。',
      'notify.targetId': '投递目标 targetId',
      'notify.targetIdHint': '在「IM机器人」设置页的目标列表里复制。',
      'notify.webhookEnabled': '启用自定义 Webhook 兜底',
      'notify.webhookHint': 'IM 不可用时用它兜底，覆盖飞书 / 钉钉 / 企微 / Bark / PushPlus。',
      'notify.webhookUrl': 'Webhook 地址',
      'notify.emailEnabled': '启用邮箱渠道',
      'notify.emailHint': '邮件是附件通路：熔断日志、方案定稿、团队报告都会作为附件发出。',
      'notify.providerHint': '选预设后只需填账号与授权码；仅「自定义 SMTP」需要手填域名端口。',
      'notify.fromName': '发件人名称',
      'notify.account': '邮箱账号',
      'notify.accountHint': '例如 you@qq.com。',
      'notify.secret': '授权码 / 应用专用密码',
      'notify.secretHint': '请填写邮箱 SMTP 授权码 / Gmail 应用专用密码，而非登录密码。',
      'notify.secretPlaceholder': '留空则不修改已保存的授权码',
      'notify.to': '收件邮箱',
      'notify.toHint': '留空时默认发给你自己的邮箱账号。',
      'notify.host': 'SMTP 主机',
      'notify.portHint': 'SSL 一般 465，STARTTLS 一般 587。',
      'notify.attachHint': '单个附件字节上限，默认 2097152（2 MB），超限改成截断说明。',
      'notify.forceArchive': '定稿/完结始终归档发送',
      'notify.forceArchiveHint': '打开后无视桌面空闲状态立刻发归档邮件。',
      'notify.testHint': '自检方式：在输入框执行 /flow notify-test，会当场回报 IM 与邮箱的成败原因（含 SMTP 实际通路）。',
      'threshold': '连续失败阈值',
      'idleSeconds': '桌面空闲秒数',
      'rescueModel': '救场强模型',
      'teamUrl': 'team-control 地址',
      'botId': '机器人 botId',
      'targetId': '投递目标 targetId',
      'webhookUrl': 'Webhook 地址',
      'fromName': '发件人名称',
      'account': '邮箱账号',
      'secret': '授权码',
      'to': '收件邮箱',
      'host': 'SMTP 主机',
      'port': '端口',
      'attachLimitBytes': '附件上限（字节）',
      'provider': '邮箱服务商预设',
      'security': '加密方式',
      'kind': 'Webhook 类型',
      'brake': '熔断告警策略',
      'gate': '待拍板提醒策略',
      'team': '团队异常策略',
      'archive': '定稿/完结策略',
      'base.title': '底座契约',
      'base.hint': '固定注入在系统提示词最前部，不随模式变化；改动会影响所有模式。',
      'gate.specEnabled': '启用 .flow/spec.md 方案锚点保活',
      'gate.specEnabledHint': '开启后，方案摘要会作为必带上下文注入，压缩后由宿主自动重挂；插件只读该文件，不会自动创建。',
      'gate.specPath': '方案文件路径',
      'gate.specMaxChars': '摘要字符上限',
      'gate.autoCompact': '阶段确认通过后自动压缩上下文',
      'gate.autoCompactHint': '仅在你点「同意」、模式切换完成且本回合结束后触发一次原生压缩；遇到忙碌会自动重试。',
      'gate.remoteHint': '远程审批提示：Flow 的开局四选一与阶段确认均走 DSH 原生提问框；若需通过 dsh-im 透传到微信 / 飞书，请确保当前会话已绑定开启双向同步的私聊。',
      'set.add': '新增提示词',
      'set.newName': '未命名提示词',
      'set.name': '名称',
      'set.namePlaceholder': '给这套提示词起个名字',
      'set.text': '正文',
      'set.enabled': '启用',
      'set.appliesTo': '生效模式',
      'set.modesNone': '未指定模式',
      'set.expand': '展开',
      'set.collapse': '收起',
      'set.empty': '还没有任何全局提示词。',
      'mode.model': '默认模型',
      'mode.permission': '切换时权限',
      'mode.prompt': '模式专属提示词',
      'model.none': '不自动切换（保持当前模型）',
      'model.failures': '以下 provider 读取失败：{names}',
      'model.state.loading': '正在读取模型列表…',
      'model.state.error': '模型列表读取失败；已保存的模型仍会显示并生效。',
      'model.state.unavailable': '当前连接不提供模型列表。',
      'model.state.ready': '',
      'permission.read-only': '只读',
      'permission.workspace-write': '工作区修改',
      'permission.danger-full-access': '完全权限',
      'permission.keep': '不修改',
      'common.remove': '删除',
      'common.reset': '恢复默认',
    }

    const en = {
      'chip.aria': 'Switch Flow workflow mode, current {name}',
      'menu.aria': 'Flow mode list',
      'error.session': 'This session is not ready yet. Try again shortly.',
      'error.switch': 'Switch failed. Try again.',
      'error.missingCommand': 'The host has no /flow command. Check that the plugin is enabled.',
      'error.noForm': 'The config form is unavailable.',
      'error.rejected': 'The host refused this change.',
      'settings.title': 'Flow workflow',
      'settings.nav': 'Flow workflow',
      'settings.subtitle': 'Layered prompts and five modes',
      'settings.unavailable': 'Configuration is not ready yet.',
      'settings.readonly': 'This configuration is read-only (provided by a higher composition layer).',
      'settings.sectionAHint': 'Tick the modes each prompt applies to; ticked prompts precede the mode prompt.',
      'settings.sectionBHint': 'The default model is applied once, at switch time. Later manual model changes always win.',
      'tab.modes': 'Five modes',
      'tab.prompts': 'Global prompts',
      'tab.gate': 'Workflow & gates',
      'tab.base': 'Base contract',
      'tab.notify': 'Breaker & notify',
      'settings.saving': 'Saving…',
      'notify.cardCircuit': 'Breaker & idle',
      'notify.cardIm': 'IM channel & webhook',
      'notify.cardEmail': 'SMTP email channel',
      'notify.cardFlow': 'Event routing & team link',
      'notify.imFallback': 'dsh-im exposes no bot-list endpoint: copy botId and targetId from the IM bot settings page, or run /flow notify-test to check which channel works.',
      'strategy.imFirst': 'IM first, fall back to email',
      'strategy.emailFirst': 'Email first, fall back to IM',
      'strategy.both': 'Send to both',
      'strategy.off': 'Off',
      'notify.circuitEnabled': 'Enable consecutive-failure breaker',
      'notify.circuitHint': 'Trips when tool failures in one session reach the threshold; any success resets the count.',
      'notify.thresholdHint': 'Consecutive failures that trip the breaker (default 3).',
      'notify.rescueModel': 'Rescue model',
      'notify.rescueModelHint': 'Format provider::model, e.g. deepseek::deepseek-chat. Empty means reply 2 re-sends without switching.',
      'notify.idleHint': 'Desktop idle seconds: notify only after this long since your last message (0 = immediately).',
      'notify.teamEnabled': 'Link dsh-team-control',
      'notify.teamHint': 'Subscribes to the team event stream in the background; silent backoff when the service is down.',
      'notify.teamUrl': 'team-control base URL',
      'notify.teamUrlHint': 'Defaults to http://127.0.0.1:4317.',
      'notify.imEnabled': 'Enable IM channel',
      'notify.imHint': 'Uses connected dsh-im bots. Markdown text only; attachments go through email.',
      'notify.botId': 'Bot id',
      'notify.botIdHint': 'Copy it from the IM bots settings page, or run /flow notify-test to list bots.',
      'notify.targetId': 'Delivery target id',
      'notify.targetIdHint': 'Copy it from the target list on the IM bots settings page.',
      'notify.webhookEnabled': 'Enable custom webhook fallback',
      'notify.webhookHint': 'Used when IM is unavailable; supports Feishu / DingTalk / WeCom / Bark / PushPlus.',
      'notify.webhookUrl': 'Webhook URL',
      'notify.emailEnabled': 'Enable email channel',
      'notify.emailHint': 'Email carries attachments: breaker logs, finalized specs and team reports.',
      'notify.providerHint': 'With a preset you only fill account and auth code; only Custom SMTP needs host and port.',
      'notify.fromName': 'Sender name',
      'notify.account': 'Email account',
      'notify.accountHint': 'For example you@qq.com.',
      'notify.secret': 'Auth code / app password',
      'notify.secretHint': 'Enter the SMTP auth code or Gmail app password, not your login password.',
      'notify.secretPlaceholder': 'Leave empty to keep the saved auth code',
      'notify.to': 'Recipient',
      'notify.toHint': 'Empty means send to your own account.',
      'notify.host': 'SMTP host',
      'notify.portHint': 'Usually 465 for SSL and 587 for STARTTLS.',
      'notify.attachHint': 'Per-attachment byte limit, default 2097152 (2 MB); oversize becomes a truncation note.',
      'notify.forceArchive': 'Always archive finalization/completion',
      'notify.forceArchiveHint': 'Send archive mail immediately regardless of desktop idle state.',
      'notify.testHint': 'To self-test, run /flow notify-test in the composer: it reports IM and email outcomes, including the SMTP transport actually used.',
      'threshold': 'Failure threshold',
      'idleSeconds': 'Desktop idle seconds',
      'rescueModel': 'Rescue model',
      'teamUrl': 'team-control base URL',
      'botId': 'Bot id',
      'targetId': 'Target id',
      'webhookUrl': 'Webhook URL',
      'fromName': 'Sender name',
      'account': 'Email account',
      'secret': 'Auth code',
      'to': 'Recipient',
      'host': 'SMTP host',
      'port': 'Port',
      'attachLimitBytes': 'Attachment limit (bytes)',
      'provider': 'Email provider preset',
      'security': 'Encryption',
      'kind': 'Webhook type',
      'brake': 'Breaker alert strategy',
      'gate': 'Pending approval strategy',
      'team': 'Team incident strategy',
      'archive': 'Finalization strategy',
      'base.title': 'Base contract',
      'base.hint': 'Always injected at the top of the system prompt, independent of mode.',
      'gate.specEnabled': 'Keep the .flow/spec.md anchor alive',
      'gate.specEnabledHint': 'The spec summary is injected as required context and re-materialized by the host after compaction; the file is only read, never created.',
      'gate.specPath': 'Spec file path',
      'gate.specMaxChars': 'Summary character limit',
      'gate.autoCompact': 'Compact context after a stage gate is approved',
      'gate.autoCompactHint': 'Compacts once after your approval, the mode switch, and the end of this turn; retries while busy.',
      'gate.remoteHint': 'Remote approval: both the opening route picker and the stage gate use the native question card. To forward them to WeChat / Feishu through dsh-im, bind this session to a two-way synced direct chat.',
      'set.add': 'Add prompt',
      'set.newName': 'Untitled prompt',
      'set.name': 'Name',
      'set.namePlaceholder': 'Name this prompt set',
      'set.text': 'Body',
      'set.enabled': 'Enabled',
      'set.appliesTo': 'Applies to',
      'set.modesNone': 'No modes',
      'set.expand': 'Expand',
      'set.collapse': 'Collapse',
      'set.empty': 'No global prompts yet.',
      'mode.model': 'Default model',
      'mode.permission': 'Permission on switch',
      'mode.prompt': 'Mode prompt',
      'model.none': 'Do not switch (keep current model)',
      'model.failures': 'Failed to read: {names}',
      'model.state.loading': 'Loading models…',
      'model.state.error': 'Model list unavailable; the saved model still shows and applies.',
      'model.state.unavailable': 'This connection exposes no model list.',
      'model.state.ready': '',
      'permission.read-only': 'Read-only',
      'permission.workspace-write': 'Workspace write',
      'permission.danger-full-access': 'Full access',
      'permission.keep': 'Leave unchanged',
      'common.remove': 'Remove',
      'common.reset': 'Reset to default',
    }

    /* ================================================================ *
     * 插件主体
     * ================================================================ */

    exports.inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session']
    exports.name = 'flow-client'

    function apply(ctx) {
      ensureStyles()

      ctx.effect(() => ctx.locale.register(CONFIG_NS, { zh, en }), 'flow: client dictionaries')
      const t = ctx.locale.bind(CONFIG_NS)

      // 聊天输入区：紧邻「开发权限」芯片右侧的 list 槽（同一行、同一 flex 容器）。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'flow-mode',
        order: 20,
        locale: CONFIG_NS,
        inject: () => ({ appCtx: ctx }),
      }, FlowModeChip))

      // 设置页：注册成左侧栏的独立 Settings 页。
      //
      // 为什么不用 `plugins.item`：该槽的 catalog 明确写着它是"官方插件"的卡片位，
      // 第三方 bundle 的配置应走 plugins.bundle.config / plugins.row.config；
      // 而且它按 `only: item.id` 过滤，id 必须与插件清单项完全一致，脆。
      // `settings.section` 才是"每个列表项一个设置页"，实测已挂第三方
      // im-settings / dsh-market，正好落在用户找得到的左侧栏设置导航里。
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
    return module.exports
  },
})
