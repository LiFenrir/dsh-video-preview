window.__ModuleLoader__.load({
  id: '@lifenrir/dsh-video-preview',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sidebarVideo'
    const VIDEO_ID = 'dsh-video-preview/video'
    const EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', 'mkv']
    const STREAM_PATH = '/api/dsh-video-preview/stream'
    const RESOURCE_PREFIX = 'dsh-resource://'

    const zh = {
      title: '视频播放',
      loading: '正在加载视频…',
      failed: '视频加载失败。',
      unsupported: '浏览器无法播放这个视频格式。',
      retry: '重试',
      a11y: '视频预览',
    }

    const en = {
      title: 'Video',
      loading: 'Loading video…',
      failed: 'The video could not be loaded.',
      unsupported: 'This browser cannot play this video format.',
      retry: 'Retry',
      a11y: 'Video preview',
    }

    const inject = ['slots', 'locale', 'documentPreviews']

    /**
     * 注册语言包、文档预览定义与右侧面板主体。
     *
     * @param {object} ctx 客户端插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'video-preview: locale')
      const t = ctx.locale.bind(NS)

      // loading: 'renderer' 表示文件内容由渲染器自己获取，owner 不经过 RPC 预读。
      ctx.effect(
        () =>
          ctx.documentPreviews.register({
            id: VIDEO_ID,
            extensions: EXTENSIONS,
            binaryExtensions: EXTENSIONS,
            title: () => t('title'),
            loading: 'renderer',
            wrap: false,
          }),
        'video-preview: document definition',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.document', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.document',
                key: VIDEO_ID,
                locale: NS,
              },
              VideoBody,
            ),
          ),
        'video-preview: document body',
      )
    }

    /**
     * 解析 dsh-resource://file/session/<sessionId>/<path...>。
     *
     * @param {unknown} address 资源地址。
     * @returns {{ sessionId: string, path: string } | undefined} 非法输入返回 undefined。
     */
    function parseResourceAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(RESOURCE_PREFIX)) {
        return undefined
      }

      let rest = address.slice(RESOURCE_PREFIX.length)
      const suffix = rest.search(/[?#]/)
      if (suffix >= 0) {
        rest = rest.slice(0, suffix)
      }

      const segments = rest.split('/')
      if (segments.length < 4 || segments[0] !== 'file' || segments[1] !== 'session') {
        return undefined
      }

      try {
        const sessionId = decodeURIComponent(segments[2])
        const path = segments.slice(3).map(decodeURIComponent).join('/')
        if (sessionId === '' || path === '') {
          return undefined
        }
        return { sessionId, path }
      } catch {
        // 非法的百分号编码
        return undefined
      }
    }

    // 样式：仅内联，随主题变量走。
    const containerStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      minHeight: 0,
      background: 'var(--dsw-alias-bg-layer-2)',
    }

    const videoStyle = {
      display: 'block',
      width: '100%',
      height: '100%',
      maxHeight: '100%',
      objectFit: 'contain',
      background: '#000',
    }

    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      padding: '24px',
      textAlign: 'center',
      boxSizing: 'border-box',
    }

    const errorStyle = {
      color: 'var(--dsw-alias-state-error-primary)',
    }

    const retryButtonStyle = {
      marginTop: '12px',
      padding: '6px 14px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      cursor: 'pointer',
    }

    /**
     * 右侧文档面板的视频主体。
     *
     * @param {object} props
     * @param {object} props.content 渲染器内容对象（kind === 'renderer'）。
     * @param {string} props.resourceAddress 资源地址。
     * @param {(key: string) => string} props.t 本地化函数。
     */
    function VideoBody(props) {
      const { content, resourceAddress, t } = props
      const translate = typeof t === 'function' ? t : (key) => key
      const rendererContent = content !== null && typeof content === 'object' && content.kind === 'renderer' ? content : undefined
      const revision = rendererContent === undefined ? undefined : rendererContent.revision
      const hasRenderer = rendererContent !== undefined

      const [attempt, setAttempt] = React.useState(0)
      const [state, setState] = React.useState({ phase: 'loading' })

      // 用 ref 读取最新的 content，避免把 content 身份放进 effect 依赖导致重复请求。
      const contentRef = React.useRef(undefined)
      React.useEffect(() => {
        contentRef.current = rendererContent
      }, [rendererContent])

      React.useEffect(() => {
        if (!hasRenderer) {
          return undefined
        }

        const parsed = parseResourceAddress(resourceAddress)
        if (parsed === undefined) {
          const current = contentRef.current
          if (current !== undefined && typeof current.failed === 'function') {
            current.failed()
          }
          setState({ phase: 'error', reason: 'failed' })
          return undefined
        }

        const controller = new AbortController()
        setState({ phase: 'loading' })

        const query = new URLSearchParams({
          sessionId: parsed.sessionId,
          path: parsed.path,
        }).toString()
        const url = STREAM_PATH + '?' + query

        // 先 HEAD 验证路径、MIME 与工作区权限，再让 <video> 自己发起带 Range 的 GET。
        fetch(url, {
          method: 'HEAD',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
          .then((response) => {
            if (!response.ok) {
              throw new Error('video preview HEAD failed: ' + response.status)
            }
            const version = response.headers.get('x-dsh-version') || ''
            const current = contentRef.current
            if (current !== undefined && typeof current.loaded === 'function') {
              current.loaded(version)
            }
            setState({ phase: 'ready', url })
          })
          .catch(() => {
            if (controller.signal.aborted) {
              return
            }
            const current = contentRef.current
            if (current !== undefined && typeof current.failed === 'function') {
              current.failed()
            }
            setState({ phase: 'error', reason: 'failed' })
          })

        return () => {
          controller.abort()
        }
      }, [hasRenderer, revision, resourceAddress, attempt])

      if (!hasRenderer) {
        return null
      }

      if (state.phase === 'ready') {
        return h(
          'div',
          { style: containerStyle },
          h('video', {
            controls: true,
            playsInline: true,
            preload: 'metadata',
            src: state.url,
            'aria-label': translate('a11y'),
            style: videoStyle,
            onError: () => setState({ phase: 'error', reason: 'unsupported' }),
          }),
        )
      }

      if (state.phase === 'error') {
        return h(
          'div',
          { style: containerStyle },
          h(
            'div',
            { style: { ...statusStyle, ...errorStyle }, role: 'alert' },
            h('div', null, translate(state.reason === 'unsupported' ? 'unsupported' : 'failed')),
            h(
              'button',
              {
                type: 'button',
                style: retryButtonStyle,
                onClick: () => setAttempt((value) => value + 1),
              },
              translate('retry'),
            ),
          ),
        )
      }

      return h(
        'div',
        { style: containerStyle },
        h('div', { style: statusStyle, role: 'status' }, translate('loading')),
      )
    }

    return { inject, apply }
  },
})
