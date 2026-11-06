# Freebuff Theme Injector

Desktop app that themes [Freebuff](https://freebuff.com) with community themes — applied **before the first frame**, so there's no flash of the default theme when Freebuff opens.

## How it works

- Freebuff 0.0.201 refuses to start with any `--remote-debugging-port`/`-pipe`/`-address` switch (`app.exit(1)`), and its Electron fuses disable `NODE_OPTIONS`, `--inspect` and `ELECTRON_RUN_AS_NODE`. The Injector therefore builds a **private patched copy** of the installed app at `~/.freebuff-theme-studio/freebuff-themed/Freebuff.app` — the launch guard is neutralised inside `app.asar` (same byte length, since the `OnlyLoadAppFromAsar` fuse means an unpacked directory is ignored), the bundle is ad-hoc signed, and its updater is pointed at a dead loopback feed so the copy can never be replaced by a stock build. The installed `Freebuff.app` is never modified; the copy is rebuilt when Freebuff's version changes.
- Launches that copy with Chromium's remote debugging port open and injects a small theme runtime into the app's pages over the DevTools Protocol.
- The runtime applies the active theme's CSS at document-start, themes the launch splash and the window background, and adds a theme + font picker to the bottom of Freebuff's sidebar.
- Freebuff 0.0.201's main window is the `freebuff.com` web app, not the loopback loading shell. That document keeps unprefixed CSS variables for Tailwind's `hsl(var(--x))` triples and paints its desktop chrome from a `--dk-*` token layer, so the runtime re-declares the theme under `--fbs-t-*` and maps it onto `--dk-*` instead of overwriting the page's own names.
- It also hides Freebuff's sponsored placements — the "Ad" cards in the chat and above the composer, the large showcase card, the sponsor break and the promo spotlight. This is always on in the patched copy.
- A background watcher keeps the copy "sticky": a Freebuff started without the injector (manual open, auto-start, updater) is closed and the themed copy launched instead. Quitting Freebuff stays quit.

## Use

1. Install the DMG from [Releases](../../releases) (or run from source: `npm install && npm start`).
2. Click **Open themed Freebuff** — any running Freebuff is replaced by the patched copy, themed.
3. Pick a theme and font from the picker in Freebuff's sidebar (bottom of the icon rail).

Themes live in `~/.freebuff-theme-studio/themes/<id>/` as `theme.json` + `style.css` — drop in your own; open windows update live.

## Bundled themes

Figma, GitHub, Linear, Netflix, Spotify, TerminalHub, Uber, Vercel.

## Debugging

`node tools/attach-bridge.mjs` prints every debuggable Freebuff page and whether the theme runtime is live in it. Use `--port` if Freebuff was launched on a different debug port.

## License

MIT
