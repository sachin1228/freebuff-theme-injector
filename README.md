# Freebuff Theme Injector

Desktop app that themes [Freebuff](https://freebuff.com) with community themes — applied **before the first frame**, so there's no flash of the default theme when Freebuff opens.

## How it works

- Launches Freebuff with Chromium's remote debugging port open and injects a small theme runtime into the app's pages over the DevTools Protocol. Freebuff 0.0.200+ **disables the Electron fuses for `NODE_OPTIONS` and `--inspect`**, so the old main-process bridge can no longer attach; the debug port is the channel that still works. Nothing is ever written inside `Freebuff.app`, so app updates can't break it.
- The runtime applies the active theme's CSS at document-start, themes the launch splash and the window background, and adds a theme + font picker to the bottom of Freebuff's sidebar.
- It also hides Freebuff's sponsored placements — the "Ad" cards in the chat and above the composer, the large showcase card, the sponsor break and the promo spotlight. It's on by default, works with or without a theme, and has its own switch in the Injector window (changes apply live).
- A background watcher keeps themes "sticky": if Freebuff starts without the injector (manual open, auto-start, updater), it's relaunched once, themed. Freebuff is only ever themed when it's open — quitting it stays quit. Flip the switch off to get the default look back.

## Use

1. Install the DMG from [Releases](../../releases) (or run from source: `npm install && npm start`).
2. Flip the switch on — Freebuff reopens themed.
3. Pick a theme and font from the picker in Freebuff's sidebar (bottom of the icon rail).

Themes live in `~/.freebuff-theme-studio/themes/<id>/` as `theme.json` + `style.css` — drop in your own; open windows update live.

## Bundled themes

Figma, GitHub, Linear, Netflix, Spotify, TerminalHub, Uber, Vercel.

## Debugging

`node tools/attach-bridge.mjs` prints every debuggable Freebuff page and whether the theme runtime is live in it. Use `--port` if Freebuff was launched on a different debug port.

## License

MIT
