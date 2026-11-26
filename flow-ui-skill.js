/**
 * UI 设计 Skill 探测：判断本机装没装 `taste` / `impeccable`，给出**非阻塞**的分流建议。
 *
 * === 为什么是"非阻塞" ===
 *
 * 设计 Skill 只影响"怎么做 UI"，不影响"能不能继续"。所以这里绝不弹门禁、绝不 ask()，
 * 只回一段可以直接在对话里选的三选一文本 —— 用户回 1/2/3 或"跳过"都行，
 * 不回也不会把流水线卡死（默认按内置 `ui-architect` 规范继续）。
 *
 * === 探测口径 ===
 *
 * `ctx.get('skills')?.list({ cwd })`（服务名 `skills`，见宿主 `skill/skill/src/index.ts`）。
 * 别名归一：`taste-skill | tasteskill | design-taste-frontend → taste`，`impeccable → impeccable`。
 * 服务不可用（精简组合/未挂载）时返回 `source:'unavailable'`，调用方按内置规范走。
 *
 * @module dsh-flow/flow-ui-skill
 */

/** Skill 名 → 归一化标识。 */
export const SKILL_ALIASES = Object.freeze({
  'taste-skill': 'taste',
  tasteskill: 'taste',
  'design-taste-frontend': 'taste',
  impeccable: 'impeccable',
})

/** 未安装时的三选一（非阻塞）。 */
export const INSTALL_OPTIONS = Object.freeze([
  { n: 1, key: 'taste', label: '安装 taste-skill 参考', url: 'https://github.com/Leonxlnx/taste-skill' },
  { n: 2, key: 'impeccable', label: '安装 impeccable 参考', url: 'https://github.com/pbakaus/impeccable' },
  { n: 3, key: 'none', label: '暂不安装，用内置 ui-architect 规范', url: '' },
])

/** 缓存有效期：一分钟。够避免每个 step 都打一次 skill 目录。 */
const CACHE_TTL_MS = 60_000

/** 把 skill 名归一；未登记的原样返回（供日志排查）。 */
export function normalizeSkillName(name) {
  const key = String(name ?? '').trim().toLowerCase()
  return SKILL_ALIASES[key] ?? key
}

/** 生成安装选项文本块（纯对话，不带任何门禁）。 */
export function installOptionsText() {
  return [
    '[Flow UI Skills] 本机没装可参考的设计 Skill，你想怎么走？（直接回数字即可，不回也行）',
    ...INSTALL_OPTIONS.map(option => (option.url === ''
      ? `  ${option.n}) ${option.label}`
      : `  ${option.n}) ${option.label}：${option.url}`)),
    '  提示：安装走 🟡 黄灯规则（先确认体积来源，慢或报代理错我会停下来问你）。',
    '  回「跳过」等价于 3)。',
  ].join('\n')
}

/**
 * 根据已安装集合给出分流建议（纯函数，便于单测）。
 *
 * @param {{ taste: boolean, impeccable: boolean, available: boolean }} installed
 * @returns {{ recommendation: 'taste'|'impeccable'|'builtin'|'unknown', text: string }}
 */
export function adviceOf({ taste, impeccable, available }) {
  if (!available) {
    return {
      recommendation: 'builtin',
      text: '[Flow UI Skills] 宿主没有 skills 服务，无法探测。按内置 `ui-architect` 规范执行（Token + 8 态矩阵 + 断点 + ≥44px）。',
    }
  }
  if (taste && impeccable) {
    return {
      recommendation: 'taste',
      text: [
        '[Flow UI Skills] 已安装：taste（design-taste-frontend）、impeccable。',
        '- 从 0 建新页 / 新站 → 优先 taste',
        '- 老项目评审、抛光、补状态 → 优先 impeccable',
        '一次只用其中一个；要在两者间切换，先说明上一个哪里不够。',
      ].join('\n'),
    }
  }
  if (taste) {
    return {
      recommendation: 'taste',
      text: '[Flow UI Skills] 已安装 taste（design-taste-frontend）：新页与改造页都用它；老页深度评审时可说明差异后临时用内置规范。',
    }
  }
  if (impeccable) {
    return {
      recommendation: 'impeccable',
      text: '[Flow UI Skills] 已安装 impeccable：适合老项目评审、抛光、补状态；从 0 建新页时可先用它出方向，再落 Token。',
    }
  }
  return {
    recommendation: 'builtin',
    text: `${installOptionsText()}\n  当前先用内置 ui-architect 规范继续，不阻塞流程。`,
  }
}

/**
 * 创建探测器（带一分钟缓存 + 并发去重）。
 *
 * @param {{
 *   getSkills: () => { list?: Function } | undefined,
 *   logger?: { warn?: Function },
 *   diag?: (message: string) => void,
 *   ttlMs?: number,
 * }} deps
 */
export function createUiSkillProbe({ getSkills, getConfig, logger, diag = () => {}, ttlMs = CACHE_TTL_MS }) {
  /** cwd → { at, result } */
  const cache = new Map()
  /** cwd → 进行中的探测（并发去重） */
  const inFlight = new Map()

  /**
   * 探测某个工作区的已装 Skill。
   *
   * @param {string} cwd 会话工作目录（技能发现依赖项目根）。
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{
   *   ok: boolean, source: 'skills-service'|'unavailable'|'error',
   *   installed: { taste: boolean, impeccable: boolean },
   *   names: string[], recommendation: string, text: string,
   * }>}
   */
  async function probe(cwd, { force = false } = {}) {
    const key = String(cwd ?? '')

    // 设置页关掉探测：直接回内置规范，连 skill 目录都不扫。
    const disabled = (() => {
      try { return getConfig?.()?.ui?.skillProbe === false } catch { return false }
    })()
    if (disabled) {
      return {
        ok: false,
        source: 'disabled',
        installed: { taste: false, impeccable: false },
        names: [],
        recommendation: 'builtin',
        text: '[Flow UI Skills] 探测已在设置里关闭。按内置 `ui-architect` 规范执行（Token + 8 态矩阵 + 断点 + ≥44px）。',
      }
    }

    const hit = cache.get(key)
    if (force !== true && hit !== undefined && Date.now() - hit.at < ttlMs) return hit.result
    const running = inFlight.get(key)
    if (running !== undefined) return running

    const task = (async () => {
      const service = (() => {
        try { return getSkills() } catch { return undefined }
      })()
      if (service === undefined || typeof service.list !== 'function') {
        const result = {
          ok: false,
          source: 'unavailable',
          installed: { taste: false, impeccable: false },
          names: [],
          ...adviceOf({ taste: false, impeccable: false, available: false }),
        }
        cache.set(key, { at: Date.now(), result })
        return result
      }
      try {
        const list = await service.list(key === '' ? {} : { cwd: key })
        const names = (Array.isArray(list) ? list : [])
          .map(item => (typeof item === 'string' ? item : item?.name))
          .filter(name => typeof name === 'string' && name !== '')
        const normalized = new Set(names.map(normalizeSkillName))
        const installed = { taste: normalized.has('taste'), impeccable: normalized.has('impeccable') }
        const result = {
          ok: true,
          source: 'skills-service',
          installed,
          names,
          ...adviceOf({ ...installed, available: true }),
        }
        cache.set(key, { at: Date.now(), result })
        diag(`ui-skill probe cwd=${key || '-'} taste=${installed.taste} impeccable=${installed.impeccable} total=${names.length}`)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try { logger?.warn?.(`flow: UI Skill 探测失败 → ${message}`) } catch { /* 忽略 */ }
        const result = {
          ok: false,
          source: 'error',
          installed: { taste: false, impeccable: false },
          names: [],
          ...adviceOf({ taste: false, impeccable: false, available: false }),
        }
        cache.set(key, { at: Date.now(), result })
        return result
      } finally {
        inFlight.delete(key)
      }
    })()

    inFlight.set(key, task)
    return task
  }

  /** 热一下缓存（`agent/created` 调用，失败静默）。 */
  function warm(cwd) {
    void probe(cwd).catch(() => { /* 探测失败不影响主流程 */ })
  }

  /** 清缓存（测试与设置变更用）。 */
  function invalidate() {
    cache.clear()
  }

  return { probe, warm, invalidate }
}
