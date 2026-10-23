# DSH Video Preview

[中文](README.zh.md)

Play workspace videos directly in DeepSeek Harness's right-side context / document preview panel. Instead of showing "unsupported file type", the panel renders a native video player with working seeking, including files larger than the 32 MiB RPC preview read limit.

- Package: `@lifenrir/dsh-video-preview`
- DSH: `>= 0.2.1-rc.2`
- Node: `^22.19 || >=24`

## Features

- Inline `<video controls playsInline preload="metadata">` inside the right-side document panel: play, pause, seek, and fullscreen.
- Authenticated Host route `/api/dsh-video-preview/stream` that implements HTTP `Range` (`206` / `416`), so seeking is not limited by the RPC preview cap.
- 4 MiB chunked reads through `ctx.fs.readByteRange`; a `HEAD` probe validates the path, MIME type, and workspace permission before the browser issues its `GET`.
- Only known video extensions are accepted; everything else returns `415`.
- The player follows the DSH theme through `--dsw-alias-*` design tokens.

## Supported containers and codecs

| Extension | Content-Type |
| --- | --- |
| `.mp4`, `.m4v` | `video/mp4` |
| `.mov` | `video/quicktime` |
| `.webm` | `video/webm` |
| `.ogv`, `.ogg` | `video/ogg` |
| `.mkv` | `video/x-matroska` |

Container recognition does not imply codec support. The browser still has to decode the stream:

- H.264/AAC in MP4 and VP8/VP9 in WebM have the widest compatibility.
- `.mov` often contains ProRes, and `.mkv` often contains H.265/AC-3 or other codecs browsers do not ship decoders for. When decoding fails the panel shows "This browser cannot play this video format" with a Retry button.

## Install

### From npm

```sh
dsh plugin add @lifenrir/dsh-video-preview
```

### From a local directory

```sh
git clone https://github.com/LiFenrir/dsh-video-preview.git
dsh plugin add /absolute/path/to/dsh-video-preview
```

No build step is required: the Host half is the ESM entry `index.js`, and the browser half is `client.js`, loaded through `window.__ModuleLoader__`.

### From git

```sh
dsh plugin add git+https://github.com/LiFenrir/dsh-video-preview.git
```

Reload the Web UI (or restart the profile) after adding and enabling the plugin.

## Usage

1. Open a workspace video from the Files tab.
2. The right-side preview panel shows the player.
3. Use the native controls to play, seek, and enter fullscreen.

## How it works

- `index.js` registers the streaming route on the authenticated connection layer via `ctx.connection.fetch.register`.
- The route resolves the session workspace through the `workspaceFileScope` lookup, then resolves and stats the requested path with `ctx.fs`, which keeps sandbox rules in force.
- `client.js` registers a document-preview definition for the supported extensions and the panel component. It parses the `dsh-resource://file/session/<sessionId>/<path>` address, performs the `HEAD` probe, and only then points the `<video>` element at the stream URL.

## Security

- The stream route is served through DSH's authenticated connection layer; paths are resolved relative to the session's workspace root and remain subject to the `ctx.fs` sandbox.
- Responses use `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
- Error responses do not leak internal error details.
- Request paths containing NUL bytes are rejected, and only the extensions listed above are served.

## Verify

1. Enable the plugin and reload the Web UI.
2. Open a `.mp4` file from the Files tab.
3. The right-side preview should show a player, and dragging the progress bar should seek correctly.
4. Optionally open a file larger than 32 MiB and confirm that seeking still works.

If the panel reports a load failure, check that the file exists, lies inside the current session workspace, and has a supported extension. If it reports an unsupported format, the container may be recognized but the codec is not decodable by the browser.

## Development

This package has no build step and no runtime dependencies. The source files are the shipped files:

```text
index.js            Host half (stream route)
client.js           Browser half (document preview + player)
cordis.patch.yml    Bundle manifest
locale/{en,zh}.json Display metadata
icon.svg            Plugin icon
```

To test a change locally, point `dsh plugin add` at this directory and reload the Web UI.

## License

MIT. See [LICENSE](LICENSE).
