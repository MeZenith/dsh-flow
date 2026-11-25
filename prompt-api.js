/**
 * 提示词本地接口：仅限回环访问的读写端点。
 *
 * 依赖宿主的 `ctx.webServer.register({ kind, path, handler })`
 * （`@deepseek-ai/dsh-webserver`，`WebRoute.kind` 只有 `exact` / `prefix`）。
 *
 * 端点：
 * - `GET    /api/dsh-flow/prompts`            概览（版本、底座、五模式、目录、子代理）
 * - `POST   /api/dsh-flow/prompts/update`     执行一键更新
 * - `PUT    /api/dsh-flow/subagents/:id`      写入自定义覆盖层
 * - `DELETE /api/dsh-flow/subagents/:id`      删除覆盖层（官方项即恢复默认）
 * - `PUT    /api/dsh-flow/roster`             写入自定义目录
 * - `DELETE /api/dsh-flow/roster`             删除自定义目录（恢复默认）
 *
 * 安全：非回环来源一律 403；子代理 id 走白名单正则，杜绝路径穿越。
 *
 * @module dsh-flow/prompt-api
 */
import { SUBAGENT_ID_PATTERN } from './prompt-store.js'

/** 路径前缀。 */
export const API_PREFIX = '/api/dsh-flow'

/** 单次请求体上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 是否来自本机回环。 */
export function isLoopback(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
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

/**
 * 构造接口处理器集合。
 *
 * @param {{ store: object, update: (signal?: AbortSignal) => Promise<{ result: object, text: string }> }} deps
 */
export function createPromptApi({ store, update }) {
  /** 概览数据。 */
  function overview() {
    const manifest = store.manifestInfo()
    const base = store.base()
    const modes = ['plan', 'plan-ultra', 'build', 'review', 'flow'].map(id => {
      const hit = store.mode(id)
      return {
        id,
        source: hit.source,
        path: hit.path,
        content: hit.text,
      }
    })
    const roster = store.rosterInfo()
    return {
      version: manifest.version,
      updatedAt: manifest.updatedAt,
      fileCount: manifest.fileCount,
      root: store.root,
      officialDir: store.officialDir,
      customDir: store.customDir,
      base: { source: base.source, path: base.path, content: base.text },
      modes,
      roster: { content: roster.content, source: roster.source, hasCustom: roster.hasCustom, path: roster.path },
      subagents: store.listSubagents().map(item => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        overridden: item.overridden,
        content: item.content,
        resolvedPath: item.resolvedPath,
      })),
    }
  }

  /** 写类操作的公共守卫。 */
  function guard(request, response) {
    if (isLoopback(request)) return true
    sendJson(response, 403, { ok: false, error: 'forbidden' })
    return false
  }

  return {
    /** GET /api/dsh-flow/prompts */
    async getOverview(request, response) {
      if (!guard(request, response)) return
      try {
        sendJson(response, 200, { ok: true, data: overview() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/prompts/update */
    async postUpdate(request, response) {
      if (!guard(request, response)) return
      try {
        const { result, text } = await update()
        store.invalidate()
        sendJson(response, 200, { ok: result.ok === true, result, text })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /**
     * PUT /api/dsh-flow/subagents/:id  ·  DELETE 同路径
     *
     * `:id` 从路径末段取，正则校验后才落盘。
     */
    async subagent(request, response) {
      if (!guard(request, response)) return
      const url = parseUrl(request)
      const id = decodeURIComponent(url.pathname.slice(`${API_PREFIX}/subagents/`.length))
      if (!SUBAGENT_ID_PATTERN.test(id)) {
        sendJson(response, 400, { ok: false, error: 'invalid-id' })
        return
      }
      try {
        if (request.method === 'DELETE') {
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

    /** PUT /api/dsh-flow/roster  ·  DELETE 同路径 */
    async roster(request, response) {
      if (!guard(request, response)) return
      try {
        if (request.method === 'DELETE') {
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
