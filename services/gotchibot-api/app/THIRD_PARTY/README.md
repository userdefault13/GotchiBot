# Third-party notices — GotchiBot phone app

## Mobilecode-open (Apache-2.0)

| Our file | Upstream | Notes |
|---|---|---|
| `app.css` | `web/src/styles.css` | Modified: trimmed to viewer subset; GotchiBot purple/pink palette; dropped Matrix rain / CRT scan FX |
| `js/icons.js` | `web/src/Icons.tsx` | Modified: React components → SVG string exports; added unlink / camera / QR originals in the same stroke style |

- Upstream repo: https://github.com/elkir0/Mobilecode-open
- Commit adapted: `b2ea0d5`
- Upstream is itself derived from [giuliastro/opencode-remote-android](https://github.com/giuliastro/opencode-remote-android) (Apache-2.0)
- Full license text: [`Mobilecode-open-LICENSE.txt`](./Mobilecode-open-LICENSE.txt)
- Upstream has **no NOTICE file**. Its `ATTRIBUTION.md` text is reproduced below.
- Modified files carry a prominent modification notice in their header comments.

### Upstream ATTRIBUTION.md (reproduced)

> This project is a derivative work based on **[opencode-remote-android](https://github.com/giuliastro/opencode-remote-android)** by `giuliastro`, licensed under the Apache License 2.0.
>
> Modifications: adapted for iOS (Capacitor iOS target, native SSE plugin, connection state machine). See `LICENSE` for the full license text and the git history for the complete record of changes.

We did **not** adapt Capacitor/native code, SSE, or anything that talks to `opencode serve`.

## jsQR (Apache-2.0)

| Our file | Source | Notes |
|---|---|---|
| `vendor/jsQR.min.js` | [cozmo/jsQR](https://github.com/cozmo/jsQR) 1.4.0 `dist/jsQR.js` | Minified with esbuild; UMD global `jsQR` preserved |
| `vendor/LICENSE-jsQR.txt` | package LICENSE | Exact copy |

jsQR 1.4.0 by Cosmo Wolfe and contributors (https://github.com/cozmo/jsQR).
Regenerate with `app/scripts/vendor-jsqr.sh`.

## Original GotchiBot files

`index.html`, `manifest.webmanifest`, `sw.js`, `js/main.js`, `js/version.js`,
`js/pair.js`, `js/markdown.js`, `js/thread-model.js`, `js/poller.js`,
`js/storage.js`, `js/api.js`, `js/scan.js`, `icons/*`, `scripts/make-icons.mjs`,
`NOTICE`, `README.md`, and Hub static serving (`../static.mjs`, `../server.mjs`
`/app/` route) are original to GotchiBot.

`js/markdown.js` matches Mobilecode-open `.message-content` conventions
visually but does **not** copy react-markdown / remark-gfm code.
