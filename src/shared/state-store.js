/**
 * 插件级统一状态存储：保存跨重启需要记住的轻量运行状态（会话等级、返工轮次、飞书话题/私聊绑定、最近工作区）。
 *
 * 设计要点：
 * - 实例作用域（非模块顶层全局单例），插件卸载或测试隔离互不污染；
 * - 持久化到 `$DSH_PROFILE_DIR/data/dsh-flow/state.json`（回落 `~/.dsh-flow/state.json`），
 *   与插件包目录隔离，升级/重装不丢失；
 * - 全部集合设容量上限并支持按 `sessionId` 主动回收，彻底消除长运行内存泄漏。
 *
 * @module dsh-flow/shared/state-store
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './fs-safe.js'

const MAX_ENTRIES = 500
const MAX_WORKSPACES = 40

/** 解析插件外部数据根目录。 */
export function resolveDataDir({ env = process.env, home = homedir() } = {}) {
  const profileDir = String(env?.DSH_PROFILE_DIR ?? '').trim()
  if (profileDir !== '') return join(profileDir, 'data', 'dsh-flow')
  return join(home, '.dsh-flow')
}

function trimMap(map, limit = MAX_ENTRIES) {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * 创建统一状态仓库。
 *
 * @param {{ filePath?: string, persist?: boolean, logger?: { warn?: Function } }} [options]
 */
export function createFlowStateStore({
  filePath = join(resolveDataDir(), 'state.json'),
  persist = true,
  logger,
} = {}) {
  const levels = new Map()
  const reworks = new Map()
  const dispatches = new Map()
  /** 飞书群话题 threadId/rootId → { sessionId, cwd, chatId, updatedAt } */
  const feishuThreads = new Map()
  /** 飞书私聊 openId → { sessionId, cwd, chatId, updatedAt } */
  const feishuFocus = new Map()
  /** 最近活跃工作区 cwd → lastSeenAt */
  const recentWorkspaces = new Map()

  function load() {
    if (!persist || typeof filePath !== 'string' || !existsSync(filePath)) return
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'))
      const hydrate = (target, obj) => {
        if (!obj || typeof obj !== 'object') return
        for (const [k, v] of Object.entries(obj)) target.set(k, v)
        trimMap(target)
      }
      hydrate(levels, raw?.levels)
      hydrate(reworks, raw?.reworks)
      hydrate(dispatches, raw?.dispatches)
      hydrate(feishuThreads, raw?.feishuThreads)
      hydrate(feishuFocus, raw?.feishuFocus)
      if (raw?.recentWorkspaces && typeof raw.recentWorkspaces === 'object') {
        for (const [k, v] of Object.entries(raw.recentWorkspaces)) recentWorkspaces.set(k, v)
        trimMap(recentWorkspaces, MAX_WORKSPACES)
      }
    } catch (error) {
      logger?.warn?.(`flow: 状态文件读取失败，已按空态启动 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function save() {
    if (!persist || typeof filePath !== 'string') return
    try {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        levels: Object.fromEntries(levels),
        reworks: Object.fromEntries(reworks),
        dispatches: Object.fromEntries(dispatches),
        feishuThreads: Object.fromEntries(feishuThreads),
        feishuFocus: Object.fromEntries(feishuFocus),
        recentWorkspaces: Object.fromEntries(recentWorkspaces),
      }
      writeAtomic(filePath, JSON.stringify(payload, null, 2))
    } catch (error) {
      logger?.warn?.(`flow: 状态文件保存失败 → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  load()

  return {
    filePath,

    /* ---- 等级记忆 ---- */
    getLevel(sessionId) {
      const key = String(sessionId ?? '')
      return key === '' ? undefined : levels.get(key)
    },
    setLevel(sessionId, level) {
      const key = String(sessionId ?? '')
      if (key === '') return
      levels.delete(key)
      levels.set(key, level)
      trimMap(levels)
      save()
    },

    /* ---- 返工轮次 ---- */
    getRework(sessionId) {
      const key = String(sessionId ?? '')
      return Number(reworks.get(key) ?? 0)
    },
    setRework(sessionId, round) {
      const key = String(sessionId ?? '')
      if (key === '') return
      if (round <= 0) reworks.delete(key)
      else {
        reworks.delete(key)
        reworks.set(key, round)
        trimMap(reworks)
      }
      save()
    },
    resetRework(sessionId) {
      const key = String(sessionId ?? '')
      if (key !== '' && reworks.delete(key)) save()
    },

    /* ---- 派单声明 ---- */
    getDispatch(sessionId) {
      const key = String(sessionId ?? '')
      return key === '' ? undefined : dispatches.get(key)
    },
    setDispatch(sessionId, data) {
      const key = String(sessionId ?? '')
      if (key === '') return
      dispatches.delete(key)
      dispatches.set(key, { ...data, at: Date.now() })
      trimMap(dispatches)
      save()
    },
    clearDispatch(sessionId) {
      if (dispatches.delete(String(sessionId ?? ''))) save()
    },

    /* ---- 飞书话题 & 私聊焦点绑定 ---- */
    getFeishuThread(threadKey) {
      return feishuThreads.get(String(threadKey ?? ''))
    },
    setFeishuThread(threadKey, binding) {
      const key = String(threadKey ?? '')
      if (key === '') return
      feishuThreads.delete(key)
      feishuThreads.set(key, { ...binding, updatedAt: Date.now() })
      trimMap(feishuThreads)
      save()
    },
    findFeishuThreadBySession(sessionId) {
      const sid = String(sessionId ?? '')
      if (sid === '') return undefined
      for (const [threadKey, binding] of feishuThreads.entries()) {
        if (binding?.sessionId === sid) return { threadKey, ...binding }
      }
      return undefined
    },
    getFeishuFocus(openId) {
      return feishuFocus.get(String(openId ?? ''))
    },
    setFeishuFocus(openId, binding) {
      const key = String(openId ?? '')
      if (key === '') return
      feishuFocus.delete(key)
      feishuFocus.set(key, { ...binding, updatedAt: Date.now() })
      trimMap(feishuFocus)
      save()
    },
    getAllFeishuThreads() {
      return Object.fromEntries(feishuThreads)
    },
    getAllFeishuFocuses() {
      return Object.fromEntries(feishuFocus)
    },

    /* ---- 最近工作区 ---- */
    touchWorkspace(cwd) {
      const key = String(cwd ?? '').trim()
      if (key === '') return
      recentWorkspaces.delete(key)
      recentWorkspaces.set(key, Date.now())
      trimMap(recentWorkspaces, MAX_WORKSPACES)
      save()
    },
    rememberWorkspace(cwd) {
      const key = String(cwd ?? '').trim()
      if (key === '') return
      recentWorkspaces.delete(key)
      recentWorkspaces.set(key, Date.now())
      trimMap(recentWorkspaces, MAX_WORKSPACES)
      save()
    },
    listRecentWorkspaces() {
      return [...recentWorkspaces.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cwd, at]) => ({ cwd, at }))
    },
    getRecentWorkspaces() {
      return [...recentWorkspaces.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cwd, at]) => ({ cwd, at }))
    },

    /* ---- 清理 ---- */
    forgetSession(sessionId) {
      const key = String(sessionId ?? '')
      if (key === '') return
      let changed = false
      if (dispatches.delete(key)) changed = true
      if (reworks.delete(key)) changed = true
      if (changed) save()
    },
  }
}
