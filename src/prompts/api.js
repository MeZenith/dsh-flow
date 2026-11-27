/**
 * 本地回环控制 API：提示词管理 + 通知自检 + 直连飞书接入与管理。
 *
 * 端点与方法：
 * - `GET|HEAD /api/dsh-flow/prompts`            提示词概览
 * - `POST     /api/dsh-flow/prompts/update`     一键更新提示词
 * - `PUT|DELETE /api/dsh-flow/subagents/:id`    写入/删除子代理覆盖层
 * - `PUT|DELETE /api/dsh-flow/roster`           写入/删除自定义花名册
 * - `POST     /api/dsh-flow/notify/test`        通知渠道（飞书 / dsh-im / 邮箱）一键测试
 * - `GET|HEAD /api/dsh-flow/feishu/status`      飞书连接状态与当前信息
 * - `GET|HEAD /api/dsh-flow/feishu/presets`     飞书机器人内置头像预设列表
 * - `POST     /api/dsh-flow/feishu/onboard/start`  启动扫码建应用（支持自定义名称/简介/头像URL）
 * - `GET|HEAD /api/dsh-flow/feishu/onboard/status` 轮询扫码进度
 * - `POST     /api/dsh-flow/feishu/onboard/cancel` 取消扫码
 * - `POST     /api/dsh-flow/feishu/connect`     应用当前配置并建立/重连飞书长连接
 * - `POST     /api/dsh-flow/feishu/disconnect`  断开飞书长连接
 * - `POST     /api/dsh-flow/feishu/test`        发送一张飞书互动测试卡片
 * - `POST     /api/dsh-flow/feishu/verify`      手动 AppID/AppSecret 凭证连通性校验
 *
 * 五道回环安全防线：对端 IP → Host → Origin → Method → Content-Type。
 * v0.6.0 修复 B-12：decodeURIComponent try/catch、HEAD 不写 body、参数校验返回 400、写响应路径脱敏。
 *
 * @module dsh-flow/prompts/api
 */
import { displayPathOf, SUBAGENT_ID_PATTERN } from './store.js'
import { PROMPT_MODES } from '../config/constants.js'

/** 路径前缀。 */
export const API_PREFIX = '/api/dsh-flow'

/** 单次请求体上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 合法 Host：回环三种写法，可带一个端口。 */
export const HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/

/** 是否来自本机回环。 */
export function isLoopback(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

/** Host 头是否合法。 */
export function isAllowedHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.trim().toLowerCase()
  if (host === '') return false
  if (host.includes('@') || host.includes('/') || host.endsWith('.')) return false
  if (!HOST_PATTERN.test(host)) return false
  const portMatch = host.match(/:(\d{1,5})$/)
  if (portMatch !== null && Number(portMatch[1]) > 65535) return false
  return true
}

/** 带了 Origin 就必须与 Host 同源。 */
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

/** Content-Type 是否 JSON。 */
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** 方法归一化。 */
function methodOf(request) {
  return String(request?.method ?? 'GET').toUpperCase()
}

/** 统一 JSON 响应（HEAD 仅写头不写响应体）。 */
function sendJson(request, response, status, body) {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  if (methodOf(request) === 'HEAD') {
    response.end()
    return
  }
  response.end(text)
}

class PayloadTooLargeError extends Error {
  constructor(message = '请求体过大') {
    super(message)
    this.name = 'PayloadTooLargeError'
    this.statusCode = 413
  }
}

class BadRequestError extends Error {
  constructor(message = '请求体不是合法 JSON 对象') {
    super(message)
    this.name = 'BadRequestError'
    this.statusCode = 400
  }
}

class UnsupportedMediaTypeError extends Error {
  constructor(message = 'Content-Type 必须为 application/json') {
    super(message)
    this.name = 'UnsupportedMediaTypeError'
    this.statusCode = 415
  }
}

/** 读取并解析 JSON 请求体（严格校验体积上限、JSON 语法与纯对象结构，P2-2 修复）。 */
async function readJson(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError('请求体过大（超过 1MB 上限）')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BadRequestError('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('请求体必须是 JSON 对象')
  }
  return parsed
}

/** 允许空请求体，但只要带了 Content-Type 就校验为 JSON 并严格解析。 */
async function readOptionalJson(request) {
  const ct = request?.headers?.['content-type']
  if (typeof ct === 'string' && ct.trim() !== '' && !isJsonContentType(ct)) {
    throw new UnsupportedMediaTypeError()
  }
  return readJson(request)
}

function sendBodyError(request, response, error, fallbackStatus = 500) {
  const status = error instanceof PayloadTooLargeError
    ? 413
    : error instanceof UnsupportedMediaTypeError
      ? 415
      : (error instanceof BadRequestError || error instanceof SyntaxError ? 400 : fallbackStatus)
  sendJson(request, response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

/** 取 URL 里的路径与查询串。 */
function parseUrl(request) {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

/** 路径字段脱敏。 */
function sanitizePath(value) {
  if (typeof value !== 'string' || value === '') return ''
  return displayPathOf(value)
}

/**
 * 构造本地 API 处理器集合。
 *
 * @param {{
 *   store: object,
 *   update: (signal?: AbortSignal) => Promise<{ result: object, text: string }>,
 *   feishu?: object,
 *   testNotify?: (channel?: string) => Promise<object>,
 * }} deps
 */
export function createPromptApi({ store, update, feishu, testNotify }) {
  function overview() {
    const manifest = store.manifestInfo()
    const base = store.base()
    const display = store.display ?? {}
    const modes = PROMPT_MODES.map(id => {
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
      root: display.root ?? 'prompts',
      officialDir: display.officialDir ?? 'prompts/subagents',
      customDir: display.customDir ?? '',
      base: {
        source: base.source,
        path: sanitizePath(base.path),
        content: base.text,
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

  /** 五道回环拦截层。 */
  function guard(request, response, { methods, json = false } = {}) {
    if (!isLoopback(request)) {
      sendJson(request, response, 403, { ok: false, error: 'forbidden', reason: 'non-loopback' })
      return false
    }
    const host = request?.headers?.host
    if (!isAllowedHost(host)) {
      sendJson(request, response, 403, { ok: false, error: 'forbidden', reason: 'bad-host' })
      return false
    }
    if (!isSameOrigin(request?.headers?.origin, host)) {
      sendJson(request, response, 403, { ok: false, error: 'forbidden', reason: 'cross-origin' })
      return false
    }
    const method = methodOf(request)
    if (Array.isArray(methods) && methods.length > 0 && !methods.includes(method)) {
      response.setHeader('allow', methods.join(', '))
      sendJson(request, response, 405, { ok: false, error: 'method-not-allowed', allow: methods })
      return false
    }
    if (json && (method === 'PUT' || method === 'POST') && !isJsonContentType(request?.headers?.['content-type'])) {
      sendJson(request, response, 415, { ok: false, error: 'unsupported-media-type', expected: 'application/json' })
      return false
    }
    return true
  }

  /** 把写入类结果里的绝对路径脱敏，区分 400（参数问题）与 500（磁盘错误）。 */
  function sendWriteResult(request, response, done) {
    if (done.ok === true) {
      const payload = { ok: true }
      if (typeof done.path === 'string' && done.path !== '') payload.path = sanitizePath(done.path)
      sendJson(request, response, 200, payload)
      return
    }
    const reason = String(done.reason ?? '写入失败')
    const isClientError = /不合法|上限|必须是字符串/.test(reason)
    sendJson(request, response, isClientError ? 400 : 500, { ok: false, reason })
  }

  function requireFeishu(request, response) {
    if (feishu === undefined || feishu === null) {
      sendJson(request, response, 503, { ok: false, error: 'feishu-unavailable', reason: '飞书模块未装配' })
      return false
    }
    return true
  }

  return {
    /** GET|HEAD /api/dsh-flow/prompts */
    async getOverview(request, response) {
      if (!guard(request, response, { methods: ['GET', 'HEAD'] })) return
      try {
        sendJson(request, response, 200, { ok: true, data: overview() })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/prompts/update */
    async postUpdate(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      try {
        const { result, text } = await update()
        store.invalidate()
        sendJson(request, response, 200, { ok: result.ok === true, result, text })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** PUT|DELETE /api/dsh-flow/subagents/:id */
    async subagent(request, response) {
      if (!guard(request, response, { methods: ['PUT', 'DELETE'], json: true })) return
      const url = parseUrl(request)
      const rawTail = url.pathname.slice(`${API_PREFIX}/subagents/`.length)
      let id = ''
      try {
        id = decodeURIComponent(rawTail)
      } catch {
        sendJson(request, response, 400, { ok: false, error: 'invalid-id' })
        return
      }
      if (!SUBAGENT_ID_PATTERN.test(id)) {
        sendJson(request, response, 400, { ok: false, error: 'invalid-id' })
        return
      }
      try {
        if (methodOf(request) === 'DELETE') {
          const done = store.deleteSubagent(id)
          sendWriteResult(request, response, done)
          return
        }
        const body = await readJson(request)
        const done = store.writeSubagent(id, typeof body.content === 'string' ? body.content : '')
        sendWriteResult(request, response, done)
      } catch (error) {
        sendBodyError(request, response, error, 400)
      }
    },

    /** PUT|DELETE /api/dsh-flow/roster */
    async roster(request, response) {
      if (!guard(request, response, { methods: ['PUT', 'DELETE'], json: true })) return
      try {
        if (methodOf(request) === 'DELETE') {
          const done = store.deleteRoster()
          sendWriteResult(request, response, done)
          return
        }
        const body = await readJson(request)
        const done = store.writeRoster(typeof body.content === 'string' ? body.content : '')
        sendWriteResult(request, response, done)
      } catch (error) {
        sendBodyError(request, response, error, 400)
      }
    },

    /** POST /api/dsh-flow/notify/test */
    async postNotifyTest(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (typeof testNotify !== 'function') {
        sendJson(request, response, 503, { ok: false, error: 'notify-unavailable' })
        return
      }
      try {
        const body = await readOptionalJson(request)
        const result = await testNotify(typeof body?.channel === 'string' ? body.channel : 'all')
        sendJson(request, response, 200, { ok: true, result })
      } catch (error) {
        sendBodyError(request, response, error, 500)
      }
    },

    /** GET|HEAD /api/dsh-flow/feishu/status */
    async feishuStatus(request, response) {
      if (!guard(request, response, { methods: ['GET', 'HEAD'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const data = typeof feishu.status === 'function' ? await feishu.status() : {}
        sendJson(request, response, 200, { ok: true, data })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** GET|HEAD /api/dsh-flow/feishu/presets */
    async feishuPresets(request, response) {
      if (!guard(request, response, { methods: ['GET', 'HEAD'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const data = typeof feishu.presets === 'function' ? feishu.presets() : { avatars: [] }
        sendJson(request, response, 200, { ok: true, data })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/feishu/onboard/start */
    async feishuOnboardStart(request, response) {
      if (!guard(request, response, { methods: ['POST'], json: true })) return
      if (!requireFeishu(request, response)) return
      try {
        const body = await readJson(request)
        const result = await feishu.startOnboarding(body)
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendBodyError(request, response, error, 400)
      }
    },

    /** GET|HEAD /api/dsh-flow/feishu/onboard/status */
    async feishuOnboardStatus(request, response) {
      if (!guard(request, response, { methods: ['GET', 'HEAD'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const data = feishu.onboardingStatus()
        sendJson(request, response, 200, { ok: true, data })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/feishu/onboard/cancel */
    async feishuOnboardCancel(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        feishu.cancelOnboarding()
        sendJson(request, response, 200, { ok: true })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/feishu/connect */
    async feishuConnect(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const body = await readOptionalJson(request)
        const result = await feishu.connect(body)
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendBodyError(request, response, error, 500)
      }
    },

    /** POST /api/dsh-flow/feishu/disconnect */
    async feishuDisconnect(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        await feishu.disconnect()
        sendJson(request, response, 200, { ok: true })
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/feishu/verify */
    async feishuVerify(request, response) {
      if (!guard(request, response, { methods: ['POST'], json: true })) return
      if (!requireFeishu(request, response)) return
      try {
        const body = await readJson(request)
        const result = await feishu.verifyCredentials(body)
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendBodyError(request, response, error, 400)
      }
    },

    /** POST /api/dsh-flow/feishu/test */
    async feishuTest(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const body = await readOptionalJson(request)
        const result = await feishu.sendTestCard(body)
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendBodyError(request, response, error, 500)
      }
    },

    /** POST /api/dsh-flow/feishu/welcome */
    async feishuWelcome(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const body = await readOptionalJson(request)
        const result = await feishu.sendWelcomeCard(body)
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendBodyError(request, response, error, 500)
      }
    },

    /** POST /api/dsh-flow/feishu/slash/sync */
    async feishuSlashSync(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const result = await feishu.syncSlashCommands()
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** POST /api/dsh-flow/feishu/onboard/upgrade */
    async feishuOnboardUpgrade(request, response) {
      if (!guard(request, response, { methods: ['POST'] })) return
      if (!requireFeishu(request, response)) return
      try {
        const body = await readOptionalJson(request)
        const result = await feishu.startPermissionUpgrade(body)
        sendJson(request, response, result?.ok === true ? 200 : 400, result)
      } catch (error) {
        sendBodyError(request, response, error, 400)
      }
    },

    /** 路由表：交给 `webServer.register` 逐条注册。 */
    routes() {
      return [
        { kind: 'exact', path: `${API_PREFIX}/prompts`, handler: (q, s) => this.getOverview(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/prompts/update`, handler: (q, s) => this.postUpdate(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/roster`, handler: (q, s) => this.roster(q, s) },
        { kind: 'prefix', path: `${API_PREFIX}/subagents`, handler: (q, s) => this.subagent(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/notify/test`, handler: (q, s) => this.postNotifyTest(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/status`, handler: (q, s) => this.feishuStatus(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/presets`, handler: (q, s) => this.feishuPresets(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/onboard/start`, handler: (q, s) => this.feishuOnboardStart(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/onboard/upgrade`, handler: (q, s) => this.feishuOnboardUpgrade(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/onboard/status`, handler: (q, s) => this.feishuOnboardStatus(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/onboard/cancel`, handler: (q, s) => this.feishuOnboardCancel(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/connect`, handler: (q, s) => this.feishuConnect(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/disconnect`, handler: (q, s) => this.feishuDisconnect(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/verify`, handler: (q, s) => this.feishuVerify(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/test`, handler: (q, s) => this.feishuTest(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/welcome`, handler: (q, s) => this.feishuWelcome(q, s) },
        { kind: 'exact', path: `${API_PREFIX}/feishu/slash/sync`, handler: (q, s) => this.feishuSlashSync(q, s) },
      ]
    },
  }
}
