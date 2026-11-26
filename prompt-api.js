/**
 * 提示词本地接口：仅限回环访问的读写端点。
 *
 * 依赖宿主的 `ctx.webServer.register({ kind, path, handler })`
 * （`@deepseek-ai/dsh-webserver`，`WebRoute.kind` 只有 `exact` / `prefix`）。
 *
 * 端点与允许的方法：
 * - `GET|HEAD /api/dsh-flow/prompts`          概览（版本、底座、五模式、目录、子代理）
 * - `POST     /api/dsh-flow/prompts/update`   执行一键更新
 * - `PUT|DELETE /api/dsh-flow/subagents/:id`  写入 / 删除自定义覆盖层
 * - `PUT|DELETE /api/dsh-flow/roster`         写入 / 删除自定义目录
 *
 * === 五道防线（顺序固定，任何一道不过都不进入读写逻辑） ===
 *
 * 1. **对端**：`socket.remoteAddress` 必须是回环（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），否则 403。
 * 2. **Host**：必须是 `127.0.0.1` / `localhost` / `[::1]`（可带单个端口），否则 403。
 *    挡的是 DNS Rebinding：攻击者把自己的域名解到 127.0.0.1，浏览器就会带 `Host: evil.example`。
 * 3. **Origin**：请求若带 `Origin`，其 `host` 必须与 `Host` 完全一致，否则 403。
 *    同源导航与本地 curl 不带 `Origin`，照常放行。
 * 4. **方法**：按端点白名单校验，越界 405 + `Allow` 头，且**在读写之前**返回。
 * 5. **正文类型**：`PUT` 必须是 `application/json`（允许 `; charset=utf-8`），否则 415。
 *    浏览器跨站表单只能发 `text/plain` / `form-urlencoded`，这一道把它们挡在门外。
 *
 * 另外：子代理 id 走白名单正则（防路径穿越）；返回给前端的路径一律脱敏，
 * 不暴露完整磁盘前缀（见 `sanitizePathFields`）。
 *
 * @module dsh-flow/prompt-api
 */
import { displayPathOf, SUBAGENT_ID_PATTERN } from './prompt-store.js'

/** 路径前缀。 */
export const API_PREFIX = '/api/dsh-flow'

/** 单次请求体上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 合法 Host：回环三种写法，可带一个端口；`@`、`/`、尾点、双端口都不匹配。 */
export const HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/

/** 是否来自本机回环。 */
export function isLoopback(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

/**
 * Host 头是否合法。
 *
 * @param {unknown} hostHeader
 * @returns {boolean}
 */
export function isAllowedHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.trim().toLowerCase()
  if (host === '') return false
  if (host.includes('@') || host.includes('/') || host.endsWith('.')) return false
  if (!HOST_PATTERN.test(host)) return false
  // 正则只保证"最多 5 位数字"，端口还得在合法区间内。
  const portMatch = host.match(/:(\d{1,5})$/)
  if (portMatch !== null && Number(portMatch[1]) > 65535) return false
  return true
}

/**
 * 带了 `Origin` 就必须与 `Host` 同源（host:port 完全一致，大小写不敏感）。
 *
 * @param {unknown} originHeader
 * @param {unknown} hostHeader
 * @returns {boolean}
 */
export function isSameOrigin(originHeader, hostHeader) {
  if (originHeader === undefined || originHeader === null) return true
  const origin = String(originHeader).trim()
  if (origin === '' || origin === 'null') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const expected = String(hostHeader ?? '').trim().toLowerCase()
  return parsed.host.toLowerCase() === expected
}

/** Content-Type 是否 JSON（允许参数段）。 */
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** 统一 JSON 响应。 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(text)
}

/** 读取并解析 JSON 请求体。 */
async function readJson(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** 取 URL 里的路径与查询串。 */
function parseUrl(request) {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

/** 方法归一化。 */
function methodOf(request) {
  return String(request?.method ?? 'GET').toUpperCase()
}

/** 路径字段脱敏（去掉盘符与家目录前缀）。 */
function sanitizePath(value) {
  if (typeof value !== 'string' || value === '') return ''
  return displayPathOf(value)
}

/**
 * 构造接口处理器集合。
 *
 * @param {{ store: object, update: (signal?: AbortSignal) => Promise<{ result: object, text: string }> }} deps
 */
export function createPromptApi({ store, update }) {
  /** 概览数据（路径一律脱敏）。 */
  function overview() {
    const manifest = store.manifestInfo()
    const base = store.base()
    const display = store.display ?? {}
    const modes = ['plan', 'plan-ultra', 'build', 'review', 'flow'].map(id => {
      const hit = store.mode(id)
      return {
        id,
        source: hit.source,
        path: sanitizePath(hit.path),
        content: hit.text,
      }
    })
    const roster = store.rosterInfo()
    return {
      version: manifest.version,
      updatedAt: manifest.updatedAt,
      fileCount: manifest.fileCount,
      // 只给相对/收敛后的展示值：不向本机任意进程暴露完整磁盘路径。
      root: display.root ?? 'prompts',
      officialDir: display.officialDir ?? 'prompts/subagents',
      customDir: display.customDir ?? '',
      base: {
        source: base.source,
        path: sanitizePath(base.path),
        content: base.text,
        // 磁盘原文：即使配置覆盖生效，也把 base.md 一并返回，供设置页「恢复默认」立即回显。
        fileContent: store.baseFile(),
      },
      modes,
      roster: {
        content: roster.content,
        source: roster.source,
        hasCustom: roster.hasCustom,
        path: sanitizePath(roster.path),
      },
      subagents: store.listSubagents().map(item => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        overridden: item.overridden,
        content: item.content,
        resolvedPath: sanitizePath(item.resolvedPath),
      })),
    }
  }

  /**
   * 统一拦截层：对端 → Host → Origin → 方法 →（PUT）正文类型。
   *
   * @param {object} request
   * @param {object} response
   * @param {{ methods?: string[], json?: boolean }} [options]
   * @returns {boolean} 通过为 true；否则已写好响应体，调用方直接 return。
   */
  function guard(request, response, { methods, json = false } = {}) {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, error: 'forbidden', reason: 'non-loopback' })
      return false
    }
    const host = request?.headers?.host
    if (!isAllowedHost(host)) {
      sendJson(response, 403, { ok: false, error: 'forbidden', reason: 'bad-host' })
      return false
    }
    if (!isSameOrigin(request?.headers?.origin, host)) {
      sendJson(response, 403, { ok: false, error: 'forbidden', reason: 'cross-origin' })
      return false
    }
    if (Array.isArray(methods) && methods.length > 0) {
      const method = methodOf(request)
      if (!methods.includes(method)) {
        response.setHeader('allow', methods.join(', '))
        sendJson(response, 405, { ok: false, error: 'method-not-allowed', allow: methods })
        return false
      }
    }
    if (json && methodOf(request) === 'PUT' && !isJsonContentType(request?.headers?.['content-type'])) {
      sendJson(response, 415, { ok: false, error: 'unsupported-media-type', expected: 'application/json' })
      return false
    }
    return true
  }

  return {
    /** GET|HEAD /api/dsh-flow/prompts */
    async getOverview(request, response) {
      if (!guard(request, response, { methods: ['GET', 'HEAD'] })) return
      try {
        sendJson(response, 200, { ok: true, data: overview() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/prompts/update */
    async postUpdate(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      try {
        const { result, text } = await update()
        store.invalidate()
        sendJson(response, 200, { ok: result.ok === true, result, text })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /**
     * PUT|DELETE /api/dsh-flow/subagents/:id
     *
     * `:id` 从路径末段取，正则校验后才落盘。
     */
    async subagent(request, response) {
      if (!guard(request, response, { methods: ['PUT', 'DELETE'], json: true })) return
      const url = parseUrl(request)
      const id = decodeURIComponent(url.pathname.slice(`${API_PREFIX}/subagents/`.length))
      if (!SUBAGENT_ID_PATTERN.test(id)) {
        sendJson(response, 400, { ok: false, error: 'invalid-id' })
        return
      }
      try {
        if (methodOf(request) === 'DELETE') {
          const done = store.deleteSubagent(id)
          sendJson(response, done.ok === true ? 200 : 500, done)
          return
        }
        const body = await readJson(request)
        const done = store.writeSubagent(id, typeof body.content === 'string' ? body.content : '')
        sendJson(response, done.ok === true ? 200 : 500, done)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** PUT|DELETE /api/dsh-flow/roster */
    async roster(request, response) {
      if (!guard(request, response, { methods: ['PUT', 'DELETE'], json: true })) return
      try {
        if (methodOf(request) === 'DELETE') {
          const done = store.deleteRoster()
          sendJson(response, done.ok === true ? 200 : 500, done)
          return
        }
        const body = await readJson(request)
        const done = store.writeRoster(typeof body.content === 'string' ? body.content : '')
        sendJson(response, done.ok === true ? 200 : 500, done)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** 路由表：交给 `webServer.register` 逐条注册。 */
    routes() {
      return [
        { kind: 'exact', path: `${API_PREFIX}/prompts`, handler: (q, s) => this.getOverview(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/prompts/update`, handler: (q, s) => this.postUpdate(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/roster`, handler: (q, s) => this.roster(q, s) },
        { kind: 'prefix', path: `${API_PREFIX}/subagents`, handler: (q, s) => this.subagent(q, s) },
      ]
    },
  }
}
