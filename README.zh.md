# DSH 视频预览

[English](README.md)

在 DeepSeek Harness 右侧的上下文 / 文档预览面板中直接播放工作区视频。面板不再显示“不支持的文件类型”，而是内嵌原生视频播放器并支持拖动进度，不受 32 MiB RPC 预览读取上限的限制。

- 包名：`@lifenrir/dsh-video-preview`
- DSH：`>= 0.2.1-rc.2`
- Node：`^22.19 || >=24`

## 功能

- 右侧文档面板内嵌 `<video controls playsInline preload="metadata">`，支持播放、暂停、拖动进度与全屏。
- Host 端通过鉴权路由 `/api/dsh-video-preview/stream` 提供视频流，支持 HTTP `Range`（`206` / `416`），因此大文件也能 seek。
- 通过 `ctx.fs.readByteRange` 按 4 MiB 分块读取；浏览器发起 `GET` 前先由 `HEAD` 探测路径、MIME 类型与工作区权限。
- 只接受已知的视频扩展名，其余扩展名返回 `415`。
- 播放器通过 `--dsw-alias-*` 设计变量跟随 DSH 主题。

## 支持的容器与编解码

| 扩展名 | Content-Type |
| --- | --- |
| `.mp4`、`.m4v` | `video/mp4` |
| `.mov` | `video/quicktime` |
| `.webm` | `video/webm` |
| `.ogv`、`.ogg` | `video/ogg` |
| `.mkv` | `video/x-matroska` |

容器能被识别不代表浏览器能解码其中的编码：

- H.264/AAC 的 MP4 与 VP8/VP9 的 WebM 兼容性最好。
- `.mov` 常见 ProRes，`.mkv` 常见 H.265/AC-3 等编码，能否播放取决于浏览器内置解码器。解码失败时面板显示“浏览器无法播放这个视频格式”，并提供“重试”按钮。

## 安装

### 从 npm 安装

```sh
dsh plugin add @lifenrir/dsh-video-preview
```

### 从本地目录安装

```sh
git clone https://github.com/LiFenrir/dsh-video-preview.git
dsh plugin add /absolute/path/to/dsh-video-preview
```

无需构建：Host 半是 ESM 入口 `index.js`，浏览器半是 `client.js`，由 `window.__ModuleLoader__` 直接加载。

### 从 git 安装

```sh
dsh plugin add git+https://github.com/LiFenrir/dsh-video-preview.git
```

添加并启用插件后，刷新 Web UI（或重启 profile）。

## 使用

1. 在 Files 标签页打开工作区中的视频文件。
2. 右侧预览面板显示播放器。
3. 使用原生控件播放、拖动进度与全屏。

## 工作原理

- `index.js` 通过 `ctx.connection.fetch.register` 在鉴权连接层注册流路由。
- 路由通过 `workspaceFileScope` 查找会话工作区，再用 `ctx.fs` 解析并 stat 请求路径，沙箱规则继续生效。
- `client.js` 注册支持扩展名的文档预览定义与面板组件：解析 `dsh-resource://file/session/<sessionId>/<path>` 地址，先做 `HEAD` 探测，再把 `<video>` 指向流地址。

## 安全

- 流路由走 DSH 的鉴权连接层；路径相对会话工作区根目录解析，并受 `ctx.fs` sandbox 约束。
- 响应头包含 `Cache-Control: private, no-store` 与 `X-Content-Type-Options: nosniff`。
- 错误响应不泄露内部错误信息。
- 含 NUL 字节的请求路径会被拒绝，且只提供上述扩展名。

## 验证

1. 启用插件后刷新 Web UI。
2. 在 Files 标签页打开一个 `.mp4` 文件。
3. 右侧预览应出现播放器，拖动进度条应能正确 seek。
4. 可选：打开大于 32 MiB 的文件，确认拖动进度仍然可用。

若面板提示加载失败，请确认文件存在、位于当前会话工作区内且扩展名受支持。若提示格式不支持，可能是容器已被识别但浏览器无法解码其中的编码。

## 开发

本包没有构建步骤，也没有运行时依赖，源码文件就是发布文件：

```text
index.js            Host 半（流路由）
client.js           浏览器半（文档预览与播放器）
cordis.patch.yml    bundle 清单
locale/{en,zh}.json 展示元数据
icon.svg            插件图标
```

本地验证时把 `dsh plugin add` 指向本目录，然后刷新 Web UI。

## 许可证

MIT，见 [LICENSE](LICENSE)。
