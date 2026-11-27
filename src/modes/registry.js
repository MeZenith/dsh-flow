/**
 * 模式注册表与纯工具函数：模式解析、模型 key 编解码、权限映射、模式配置读取。
 *
 * @module dsh-flow/modes/registry
 */
import {
  MODE_CHOICES, MODE_IDS, MODE_OFF, MODE_PRESETS, PERMISSION_CHOICES,
} from '../config/constants.js'

export const MODEL_KEY_SEPARATOR = '::'

export function normalizeModeToken(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

export function parseModeArg(rawInput) {
  const token = normalizeModeToken(rawInput).split(/\s+/)[0] ?? ''
  return MODE_CHOICES.includes(token) ? token : null
}

export function isPromptMode(mode) {
  return MODE_IDS.includes(mode)
}

export function coerceModeToken(value) {
  return parseModeArg(typeof value === 'string' ? value : '')
}

export function parseModelKey(key) {
  if (typeof key !== 'string') return null
  const text = key.trim()
  if (text === '') return null
  const at = text.indexOf(MODEL_KEY_SEPARATOR)
  if (at <= 0) return null
  const provider = text.slice(0, at).trim()
  const model = text.slice(at + MODEL_KEY_SEPARATOR.length).trim()
  if (provider === '' || model === '') return null
  return { provider, model }
}

export function formatModelKey(provider, model) {
  return `${String(provider)}${MODEL_KEY_SEPARATOR}${String(model)}`
}

export function approvalFor(permission) {
  return permission === 'danger-full-access' ? 'never' : 'ask'
}

export function modeConfigOf(config, modeId) {
  const preset = MODE_PRESETS[modeId]
  const raw = config?.modes?.[modeId]
  return {
    label: typeof raw?.label === 'string' && raw.label !== '' ? raw.label : (preset?.label ?? modeId),
    description: typeof raw?.description === 'string' ? raw.description : (preset?.description ?? ''),
    model: typeof raw?.model === 'string' ? raw.model : '',
    permission: PERMISSION_CHOICES.includes(raw?.permission)
      ? raw.permission
      : (preset?.permission ?? 'keep'),
    prompt: typeof raw?.prompt === 'string' ? raw.prompt : '',
  }
}

export { MODE_OFF, MODE_IDS, MODE_CHOICES, MODE_PRESETS }
