/**
 * 纯函数：由配置 + 当前模式 + 会话等级计算动态注入文本。
 *
 * v0.6.0 改进：
 * - `behavior.flowAutonomy`（one-gate / step-by-step）真正接入动态注入块，不再是安慰剂配置；
 * - 等级与文档清单与 `workflow/level.js` 同源，支持传入实例级 `stateStore`。
 *
 * @module dsh-flow/modes/planner
 */
import { AUTONOMY_CHOICES } from '../config/constants.js'
import { isPromptMode, modeConfigOf } from './registry.js'
import { gateRequiredDocs, levelDef, levelOfSession, notifyNodesOf } from '../workflow/level.js'

const JOINER = '\n\n'
const ROSTER_MODES = new Set(['flow', 'plan-ultra'])

export { AUTONOMY_CHOICES }

export function autonomyOf(config) {
  const value = config?.behavior?.flowAutonomy
  return value === 'step-by-step' ? 'step-by-step' : 'one-gate'
}

export function buildLevelBlock(config, sessionId, stateStore) {
  const level = levelOfSession(config, sessionId, undefined, stateStore)
  const def = levelDef(level)
  const docs = def.docs.length === 0 ? '无（S 级不产编号文档）' : def.docs.join(' ')
  const buildGate = gateRequiredDocs({ level, kind: 'stage', nextMode: 'build' })
  const acceptGate = gateRequiredDocs({ level, kind: 'acceptance' })
  const notify = notifyNodesOf(level)
  const autonomy = autonomyOf(config)
  const autonomyLine = autonomy === 'step-by-step'
    ? '执行档位：分阶段确认（03 / 04 / 05 / 验收每个关键节点均走门禁）'
    : '执行档位：全托管（05 定稿一次拍板后自动施工与内部返工 ≤3 轮，仅关键停点或阻断时询问）'
  const writePolicy = config?.docs?.writePolicy === 'ask'
    ? '文档写入策略：ask（需先申请 permission 门禁）'
    : '文档写入策略：auto（.flow/docs/** 与 .flow/spec.md 白名单内直接落盘后呈报审核，无需单独申请写盘权限）'

  return [
    `[Flow 等级与文档] 等级 ${def.id}｜人工停点 ${def.stops} 次`,
    autonomyLine,
    writePolicy,
    `必做文档：${docs}`,
    buildGate.length === 0 ? '切 Build 门禁：S 级不校验文档' : `切 Build 前必须齐备：${buildGate.join(' ')}`,
    acceptGate.length === 0 ? '验收门禁：S 级不校验文档' : `终态验收必须齐备：${acceptGate.join(' ')}`,
    notify.length === 0 ? '通知节点：无（S 级不发通知）' : `通知节点：${notify.join(' / ')}（文档落盘后主动推送审核）`,
    '写文档后用 flow_docs_check 自检；缺必填章节门禁会直接拦下。',
  ].join('\n')
}

export function buildModeText(config, modeId, store, context = {}) {
  if (!isPromptMode(modeId)) return ''

  const parts = []
  const sets = Array.isArray(config?.promptSets) ? config.promptSets : []
  for (const set of sets) {
    if (set === null || typeof set !== 'object') continue
    if (set.enabled === false) continue
    const text = typeof set.text === 'string' ? set.text.trim() : ''
    if (text === '') continue
    const modes = Array.isArray(set.modes) ? set.modes : []
    if (!modes.includes(modeId)) continue
    parts.push(text)
  }

  const fromStore = typeof store?.mode === 'function' ? store.mode(modeId).text : undefined
  const own = (typeof fromStore === 'string' ? fromStore : modeConfigOf(config, modeId).prompt).trim()
  if (own !== '') parts.push(own)

  if (ROSTER_MODES.has(modeId) && typeof store?.roster === 'function') {
    const roster = store.roster().trim()
    if (roster !== '') parts.push(roster)
  }

  const levelBlock = buildLevelBlock(config, context?.sessionId, context?.stateStore)
  if (levelBlock !== '') parts.push(levelBlock)

  return parts.join(JOINER)
}

export function hasModeText(config, modeId, store, context) {
  return buildModeText(config, modeId, store, context) !== ''
}
