# Freebuff Theme Injector

Desktop app that themes [Freebuff](https://freebuff.com) with community themes — applied **before the first frame**, so there's no flash of the default theme when Freebuff opens.

## How it works

- Launches Freebuff with an inspector port and attaches a small bridge to its Electron main process. Nothing is ever written inside `Freebuff.app`, so app updates can't break it.
- The bridge generates a session preload that applies the active theme's CSS at document-start, themes the launch splash and the window's background color, and adds a theme + font picker to Freebuff's sidebar.
- A background watcher keeps themes "sticky": if Freebuff starts without the bridge (manual open, auto-start, updater), it's relaunched once, themed. Flip the switch off to get the default look back.

## Use

1. Install the DMG from [Releases](../../releases) (or run from source: `npm install && npm start`).
2. Flip the switch on — Freebuff reopens themed.
3. Pick a theme and font from the picker in Freebuff's sidebar.

Themes live in `~/.freebuff-theme-studio/themes/<id>/` as `theme.json` + `style.css` — drop in your own.

## Bundled themes

Figma, GitHub, Linear, Netflix, Spotify, TerminalHub, Uber, Vercel.

## License

MIT
