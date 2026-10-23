/**
 * dsh-video-preview —— Host 半。
 *
 * 注册鉴权的视频流路由：按 HTTP Range 窗口分块读取工作区文件，
 * 让右侧文档预览可以拖动进度，并绕开 32 MiB 的 RPC 预览读取上限。
 */

// 单次 readByteRange 的上限；分块是为了避免一次性把大文件读进内存。
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

// 本插件只接受浏览器原生可解码的容器；具体编码仍取决于浏览器。
const CONTENT_TYPES = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
  ['ogg', 'video/ogg'],
  ['mkv', 'video/x-matroska'],
])

// 单个 Range 头：bytes=start-end / bytes=start- / bytes=-suffix
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/

export const inject = ['connection', 'workspaceFiles', 'typert', 'fs']

/**
 * 注册 Host 路由。
 *
 * @param {object} ctx DSH Host 上下文，需含 connection / typert / fs 能力。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-video-preview/stream',
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => serveVideo(ctx, request),
      }),
    'video-preview: stream route',
  )
}

/**
 * 处理 GET/HEAD 视频流请求。
 *
 * @param {object} ctx Host 上下文。
 * @param {Request} request 原始请求，URL 查询参数为 sessionId 与 path。
 * @returns {Promise<Response>} 视频流或错误响应。
 */
async function serveVideo(ctx, request) {
  let url
  try {
    url = new URL(request.url)
  } catch {
    return errorResponse(400)
  }

  const sessionId = url.searchParams.get('sessionId') ?? ''
  const requestedPath = url.searchParams.get('path') ?? ''
  if (sessionId === '' || requestedPath === '' || hasNul(sessionId) || hasNul(requestedPath)) {
    return errorResponse(400)
  }

  const contentType = contentTypeOf(requestedPath)
  if (contentType === undefined) {
    return errorResponse(415)
  }

  // 直接用 typert 查找会话工作区，避免为了取 cwd 而加载 Agent。
  let workspaceRoot
  try {
    const lookup = ctx.typert.lookups.get('workspaceFileScope')
    const scope = lookup === undefined ? undefined : await lookup.resolve(sessionId)
    workspaceRoot = scope === undefined || scope === null ? undefined : scope.workspaceRoot
  } catch (error) {
    return errorResponse(fsErrorStatus(error))
  }
  if (typeof workspaceRoot !== 'string') {
    return errorResponse(404)
  }

  let target
  let info
  try {
    target = await ctx.fs.resolve(requestedPath, { cwd: workspaceRoot, signal: request.signal })
    if (target === undefined || target === null) {
      return errorResponse(404)
    }
    info = await ctx.fs.stat(target, request.signal)
  } catch (error) {
    return errorResponse(fsErrorStatus(error))
  }
  if (info === undefined || info === null) {
    return errorResponse(404)
  }
  if (info.type !== 'file') {
    return errorResponse(403)
  }

  const size = knownSize(info.size)
  const headers = baseHeaders(contentType, info)

  // 大小未知时无法计算窗口，忽略 Range，从头流到 EOF（chunked）。
  if (size === undefined) {
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers })
    }
    return new Response(createBodyStream(ctx, target, 0, Number.POSITIVE_INFINITY, request.signal), {
      status: 200,
      headers,
    })
  }

  const rangeHeader = request.headers.get('range')
  if (rangeHeader !== null) {
    const range = parseRange(rangeHeader, size)
    if (range === null) {
      return errorResponse(416, { 'Content-Range': `bytes */${size}` })
    }
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    headers['Content-Length'] = String(range.end - range.start + 1)
    if (request.method === 'HEAD') {
      return new Response(null, { status: 206, headers })
    }
    return new Response(
      createBodyStream(ctx, target, range.start, range.end - range.start + 1, request.signal),
      { status: 206, headers },
    )
  }

  headers['Content-Length'] = String(size)
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers })
  }
  return new Response(createBodyStream(ctx, target, 0, size, request.signal), {
    status: 200,
    headers,
  })
}

/**
 * 构造按窗口读取的流；窗口结束、读到 EOF 或短读时关闭。
 *
 * @param {object} ctx Host 上下文。
 * @param {unknown} target ctx.fs.resolve 的结果。
 * @param {number} start 起始字节偏移。
 * @param {number} length 需要发送的字节数，未知时为 Infinity。
 * @param {AbortSignal} signal 请求信号。
 * @returns {ReadableStream<Uint8Array>}
 */
function createBodyStream(ctx, target, start, length, signal) {
  return new ReadableStream({
    async start(controller) {
      let offset = start
      let remaining = length
      try {
        while (remaining > 0) {
          const want = Math.min(MAX_CHUNK_BYTES, remaining)
          const chunk = await ctx.fs.readByteRange(target, { offset, length: want }, signal)
          if (chunk === undefined || chunk === null) {
            break
          }
          const received = chunk.byteLength
          if (received === 0) {
            break
          }
          controller.enqueue(chunk)
          offset += received
          remaining -= received
          // 短读说明已到 EOF（或底层流结束），不必再请求。
          if (received < want) {
            break
          }
        }
        closeQuietly(controller)
      } catch (error) {
        // 客户端主动断开时静默收尾，不制造额外错误。
        if (signal !== undefined && signal.aborted) {
          closeQuietly(controller)
        } else {
          failQuietly(controller, error)
        }
      }
    },
  })
}

/**
 * 解析单段 Range 头。
 *
 * @param {string} header 原始 Range 值。
 * @param {number} size 文件总字节数。
 * @returns {{ start: number, end: number } | null} 可满足时返回闭区间，否则 null。
 */
function parseRange(header, size) {
  const match = RANGE_PATTERN.exec(header.trim())
  if (match === null) {
    return null
  }
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') {
    return null
  }

  let start
  let end
  if (rawStart === '') {
    // 后缀范围：取最后 N 字节。
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) {
      return null
    }
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return null
    }
    if (start > end || start >= size) {
      return null
    }
    end = Math.min(end, size - 1)
  }

  if (start < 0 || end < start) {
    return null
  }
  return { start, end }
}

/**
 * 由文件名后缀映射 Content-Type。
 *
 * @param {string} filePath 请求中的工作区相对路径。
 * @returns {string | undefined} 支持的 MIME 类型，未知扩展名返回 undefined。
 */
function contentTypeOf(filePath) {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) {
    return undefined
  }
  return CONTENT_TYPES.get(base.slice(dot + 1).toLowerCase())
}

/**
 * 组装视频响应公共头（保持普通可序列化对象）。
 *
 * @param {string} contentType MIME 类型。
 * @param {{ version: unknown }} info ctx.fs.stat 的结果。
 * @returns {Record<string, string>}
 */
function baseHeaders(contentType, info) {
  return {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Dsh-Version': String(info.version),
  }
}

/**
 * 生成错误响应；不携带内部错误信息。
 *
 * @param {number} status HTTP 状态码。
 * @param {Record<string, string>} [extra] 额外响应头。
 * @returns {Response}
 */
function errorResponse(status, extra) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (extra !== undefined) {
    Object.assign(headers, extra)
  }
  return new Response(null, { status, headers })
}

/**
 * 把文件系统错误码映射为 HTTP 状态码。
 *
 * @param {unknown} error 底层抛出的错误。
 * @returns {number} HTTP 状态码。
 */
function fsErrorStatus(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  switch (code) {
    case 'FS_NOT_FOUND':
    case 'ENOENT':
      return 404
    case 'FS_NOT_REGULAR_FILE':
    case 'EISDIR':
    case 'FS_PERMISSION_DENIED':
    case 'EACCES':
    case 'FS_SANDBOX_DENIED':
      return 403
    case 'FS_ABORTED':
      return 499
    default:
      return 500
  }
}

/**
 * 仅当 stat 给出合法非负大小时才采用，否则视为未知大小。
 *
 * @param {unknown} size ctx.fs.stat 返回的 size。
 * @returns {number | undefined}
 */
function knownSize(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return undefined
  }
  return Math.floor(size)
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasNul(value) {
  return value.includes('\u0000')
}

/**
 * 关闭流；消费方已取消时 close 会抛错，忽略即可。
 *
 * @param {ReadableStreamDefaultController<Uint8Array>} controller
 */
function closeQuietly(controller) {
  try {
    controller.close()
  } catch {
    // 流已被取消
  }
}

/**
 * @param {ReadableStreamDefaultController<Uint8Array>} controller
 * @param {unknown} error
 */
function failQuietly(controller, error) {
  try {
    controller.error(error)
  } catch {
    // 流已被取消
  }
}
