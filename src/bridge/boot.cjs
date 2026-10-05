/**
 * Freebuff Theme Bridge — main-process loader.
 *
 * Installed by "Theme Injector" and loaded into Freebuff's Electron main
 * process the moment it starts: early.cjs arrives via
 * `NODE_OPTIONS=--require` and hands off to this file before any Freebuff
 * code runs, while a Node-inspector re-attach covers launches that started
 * without the loader. It never modifies Freebuff's app bundle, so it
 * survives app updates and reinstalls of Freebuff itself.
 *
 * Responsibilities:
 *  - Read themes from ~/.freebuff-theme-studio/themes (theme.json + style.css).
 *  - Inject the renderer runtime + theme payload into Freebuff's UI windows.
 *  - Watch the themes directory and push live updates to open windows.
 *
 * Every hook is wrapped in try/catch: the bridge must never take Freebuff
 * down with it.
 */
'use strict'

const IS_ELECTRON = !!(process.versions && process.versions.electron)
const IS_BROWSER_PROCESS = process.type === 'browser'

if (IS_ELECTRON && IS_BROWSER_PROCESS && !globalThis.__FBS_BOOT__) {
  try {
    // A second require (manual re-attach) must not stack duplicate listeners
    // or watchers — the first instance already owns the hooks.
    globalThis.__FBS_BOOT__ = true

    const fs = require('node:fs')
    const path = require('node:path')
    const { app, session, webContents, BrowserWindow } = require('electron')

    const ROOT = path.join(
      process.env.FREEBUFF_THEME_STUDIO_HOME ||
        path.join(app.getPath('home'), '.freebuff-theme-studio'),
    )
    const THEMES_DIR = path.join(ROOT, 'themes')
    const BRIDGE_DIR = __dirname
    const RUNTIME_PATH = path.join(BRIDGE_DIR, 'runtime.js')
    const STATE_PATH = path.join(ROOT, 'state.json')
    // Generated at runtime — the document-start half of the theme (see
    // writeEarlyPreload below).
    const PRELOAD_PATH = path.join(BRIDGE_DIR, 'preload-active.cjs')
    const shared = require(path.join(BRIDGE_DIR, 'shared.cjs'))

    // The orchestrator (bun) and other children must not inherit the
    // --require entry that loaded this bridge. early.cjs strips it at the
    // earliest tick; this is the belt to its suspenders (it is a no-op when
    // early.cjs already ran).
    try {
      const cleaned = shared.stripEarlyRequire(process.env.NODE_OPTIONS)
      if (cleaned) process.env.NODE_OPTIONS = cleaned
      else delete process.env.NODE_OPTIONS
    } catch {}

    let lastPayload = null

    /* The UI's own localStorage is per-origin, and Freebuff serves its window
       from a *different loopback port on every launch* — so a theme or font
       picked in the renderer is wiped by the next restart. The bridge keeps
       the authoritative copy in ~/.freebuff-theme-studio/state.json: it ships
       the saved choice to each new document and mirrors the renderer back. */
    function readSettings() {
      try {
        const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
        return {
          theme: typeof j.theme === 'string' ? j.theme : null,
          font: typeof j.font === 'string' ? j.font : null,
        }
      } catch {
        return { theme: null, font: null }
      }
    }

    function writeSettings(next) {
      try {
        fs.mkdirSync(ROOT, { recursive: true })
        fs.writeFileSync(STATE_PATH, JSON.stringify(next))
        return true
      } catch {
        return false
      }
    }

    let settings = readSettings()
    // Only trust a window that actually runs the picker: Freebuff keeps other
    // loopback webContents around whose storage is not the user's choice.
    const LS_READ =
      ";(window.fbs && window.fbs.installed)" +
      " ? JSON.stringify({theme: localStorage.getItem('fbs.theme.active') || null," +
      " font: localStorage.getItem('fbs.font') || null}) : null"

    function sameSettings(a, b) {
      return a && b && a.theme === b.theme && a.font === b.font
    }

    function syncSettings() {
      for (const contents of webContents.getAllWebContents()) {
        if (!isUiTarget(contents)) continue
        try {
          contents
            .executeJavaScript(LS_READ)
            .then((raw) => {
              let got = null
              try {
                got = raw ? JSON.parse(raw) : null
              } catch {}
              if (!got) return
              if (!got.theme && !got.font && (settings.theme || settings.font)) return
              if (sameSettings(settings, got)) return
              if (writeSettings(got)) {
                settings = got
                if (lastPayload) lastPayload.settings = got
                writeEarlyPreload()
                // The palette can change while a splash is still on screen.
                repaintLiveSplashes()
              }
            })
            .catch(() => {})
        } catch {}
      }
    }

    function readThemes() {
      const themes = []
      let entries = []
      try {
        entries = fs.readdirSync(THEMES_DIR, { withFileTypes: true })
      } catch {
        return themes
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const dir = path.join(THEMES_DIR, ent.name)
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'))
          let css = ''
          try {
            css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8')
          } catch {}
          if (!meta || !meta.id || !css) continue
          themes.push({
            id: String(meta.id),
            name: String(meta.name || meta.id),
            mode: meta.mode === 'light' ? 'light' : 'dark',
            swatches: Array.isArray(meta.swatches) ? meta.swatches.slice(0, 4).map(String) : [],
            css,
          })
        } catch {}
      }
      themes.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      return themes
    }

    /* ---------- document-start preload ----------
       The renderer runtime reaches a window at dom-ready, which for the app's
       own loading screen is already one painted frame too late. A generated
       session preload carries the active theme's CSS for the app's origin and
       applies it at document-start, so the first frame the window paints is
       already themed. Regenerated whenever the theme, the font, or the app
       origin (a random loopback port on every launch) changes. */
    let appOrigins = []

    function writeEarlyPreload() {
      try {
        const themes = (lastPayload && lastPayload.themes) || readThemes()
        const theme = settings.theme
          ? themes.find((t) => t.id === settings.theme) || null
          : null
        const src = shared.buildPreloadSource({
          css: theme ? shared.buildEarlyCss(theme, settings.font) : '',
          themeId: theme ? theme.id : '',
          origins: appOrigins,
          fontId: settings.font,
        })
        // Atomic swap: a navigation must never read a half-written file.
        const tmp = PRELOAD_PATH + '.tmp'
        fs.writeFileSync(tmp, src)
        fs.renameSync(tmp, PRELOAD_PATH)
      } catch {}
    }

    // Learn the app's origins from window navigations only. Freebuff's dev
    // previews live in webviews inside the renderer, so a BrowserWindow
    // navigation to a loopback URL is the app itself — and the preload's own
    // localStorage check stays in place as a second line of defence. A list,
    // not a slot, so one odd navigation cannot evict the real app origin.
    function noteNavigation(url) {
      try {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
        const u = new URL(url)
        if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return
        if (appOrigins.indexOf(u.origin) !== -1) return
        appOrigins.push(u.origin)
        if (appOrigins.length > 5) appOrigins = appOrigins.slice(-5)
        writeEarlyPreload()
      } catch {}
    }

    const preloadRegisteredOn = new WeakSet()
    function registerPreloadOn(ses) {
      try {
        if (!ses || !fs.existsSync(PRELOAD_PATH) || preloadRegisteredOn.has(ses)) return
        // Electron >= 35 replaced setPreloads with registerPreloadScript;
        // prefer the successor where it exists (Freebuff ships Electron 33).
        if (typeof ses.registerPreloadScript === 'function') {
          ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH })
        } else {
          const list = ses.getPreloads().filter((p) => p !== PRELOAD_PATH)
          ses.setPreloads(list.concat(PRELOAD_PATH))
        }
        preloadRegisteredOn.add(ses)
      } catch {}
    }

    // Touching session.defaultSession the first time itself fires
    // session-created for it, so both call sites must share one WeakSet —
    // a duplicate registration would run the preload twice per document.
    function registerPreloads() {
      registerPreloadOn(session.defaultSession)
    }

    function buildPayload() {
      let runtime = ''
      try {
        runtime = fs.readFileSync(RUNTIME_PATH, 'utf8')
      } catch {}
      settings = readSettings()
      lastPayload = { runtime, themes: readThemes(), settings }
      writeEarlyPreload()
      return lastPayload
    }

    // Only the UI windows we care about are served by the local orchestrator
    // over http on loopback. The renderer runtime additionally self-checks
    // for Freebuff's sidebar before doing anything, so a user browsing a
    // localhost dev server inside Freebuff is left untouched.
    function isUiTarget(contents) {
      try {
        if (contents.isDestroyed()) return false
        const url = contents.getURL()
        return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url)
      } catch {
        return false
      }
    }

    function installCode(payload) {
      return (
        ';(function(){' +
        payload.runtime +
        '\nwindow.__FBS_INSTALL__(' +
        JSON.stringify({ themes: payload.themes, settings: payload.settings }) +
        ');})()'
      )
    }

    function inject(contents) {
      try {
        const payload = lastPayload || buildPayload()
        contents.executeJavaScript(installCode(payload)).catch(() => {})
      } catch {}
    }

    /* ---------- native launch splash ----------
       Freebuff's very first frame is not a document the renderer runtime can
       reach: main.cjs builds a data: URL out of splash.cjs with a hardcoded
       SHELL_THEMES palette (dark #292b2a / light #e3e7e4, sage bar). Rewrite
       those colors from the active theme, and keep the native window
       background in sync so the frame never flashes the app default. */
    function resolveToken(css, name, depth) {
      if (depth > 3) return null
      const m = new RegExp('--' + name + '\\s*:\\s*([^;}]+)').exec(css)
      if (!m) return null
      const v = m[1].trim().replace(/!important\s*$/i, '').trim()
      const vm = /^var\(\s*--([a-z0-9-]+)/i.exec(v)
      return vm ? resolveToken(css, vm[1], depth + 1) : v
    }

    function isHex(v) {
      return typeof v === 'string' && /^#([0-9a-f]{3,8})$/i.test(v.trim())
    }

    function splashPalette() {
      try {
        if (!settings.theme) return null
        const themes = (lastPayload && lastPayload.themes) || readThemes()
        const theme = themes.find((t) => t.id === settings.theme)
        if (!theme || !theme.css) return null
        const pick = (names) => {
          for (const n of names) {
            const v = resolveToken(theme.css, n, 0)
            if (isHex(v)) return v.trim()
          }
          return null
        }
        const bg = pick(['bg', 'workspace-surface', 'shell-base'])
        const track = pick(['surface-2', 'raised', 'surface'])
        const bar = pick(['brand-dim', 'brand', 'brand-2'])
        if (!bg) return null
        return {
          bg,
          track: track || bg,
          bar: bar || bg,
          light: theme.mode === 'light',
        }
      } catch {
        return null
      }
    }

    function splashStyle(p) {
      return [
        'html,body{background:' + p.bg + ' !important}',
        '.bar{background:' + p.track + ' !important}',
        '.bar span{background:' + p.bar + ' !important}',
        // the mark is a black glyph: lift it for dark canvases, sink it for light
        '.mark{filter:' + (p.light ? 'brightness(0) invert(0.16)' : 'brightness(0.88)') + ' !important}',
      ].join('')
    }

    /* The splash is a data: URL built by main.cjs. Match that frame exactly —
       never an arbitrary data: page and never the app's own UI window. */
    function isSplashUrl(url) {
      try {
        if (typeof url !== 'string' || !url.startsWith('data:text/html')) return false
        const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
        return /@keyframes\s+sweep/.test(html) && /class="bar"/.test(html)
      } catch {
        return false
      }
    }

    function themeSplashURL(url) {
      const p = splashPalette()
      if (!p || !isSplashUrl(url)) return url
      const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
      return (
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(html.replace('</head>', '<style>' + splashStyle(p) + '</style></head>'))
      )
    }

    // Wrap loadURL so a splash loaded after we attach is themed from pixel one.
    function patchSplashLoadURL(target) {
      try {
        if (!target || typeof target.loadURL !== 'function' || target.__fbsSplashHooked) return
        target.__fbsSplashHooked = true
        const orig = target.loadURL
        target.loadURL = function (url) {
          const args = Array.prototype.slice.call(arguments)
          try {
            noteNavigation(url)
            args[0] = themeSplashURL(url)
            const p = splashPalette()
            if (p && isSplashUrl(url)) this.setBackgroundColor(p.bg)
          } catch {}
          const res = orig.apply(this, args)
          // A window destroyed mid-load (e.g. during quit) rejects with
          // "Object has been destroyed" — meaningless once the frame is gone.
          // Swallow only that error; anything else must reach Freebuff as-is.
          if (res && typeof res.catch === 'function') {
            return res.catch((err) => {
              if (err && /destroyed/i.test(String(err && err.message))) return undefined
              throw err
            })
          }
          return res
        }
      } catch {}
    }

    // A splash can already be on screen when the bridge attaches, and its
    // document may still be loading: style the live document directly.
    function paintSplashWindow(win) {
      try {
        const contents = win && win.webContents
        if (!contents || contents.isDestroyed()) return
        if (!isSplashUrl(contents.getURL())) return
        const p = splashPalette()
        if (!p) return
        try {
          win.setBackgroundColor(p.bg)
        } catch {}
        contents
          .executeJavaScript(
            ';(function(){var s=document.getElementById("fbs-splash");' +
              'if(!s){s=document.createElement("style");s.id="fbs-splash";' +
              '(document.head||document.documentElement).appendChild(s)}' +
              's.textContent=' +
              JSON.stringify(splashStyle(p)) +
              ';return 1})()',
          )
          .catch(() => {})
      } catch {}
    }

    function repaintLiveSplashes() {
      try {
        const p = splashPalette()
        for (const win of BrowserWindow.getAllWindows()) {
          // The frame colour shows wherever the document does not cover it —
          // keep it themed alongside the splash documents themselves.
          if (p && win && !win.isDestroyed()) {
            try {
              win.setBackgroundColor(p.bg)
            } catch {}
          }
          paintSplashWindow(win)
        }
      } catch {}
    }

    const splashWatched = new WeakSet()
    function watchSplashWindow(win) {
      try {
        patchSplashLoadURL(win)
        // A window is created with Freebuff's own default background and is
        // shown a few frames later — paint it themed at creation, before the
        // first frame can reach the screen. Safe before show, cheap to repeat.
        const p = splashPalette()
        if (p && win && !win.isDestroyed()) win.setBackgroundColor(p.bg)
        paintSplashWindow(win)
        const contents = win && win.webContents
        if (!contents || contents.isDestroyed() || splashWatched.has(contents)) return
        splashWatched.add(contents)
        const nudge = () => paintSplashWindow(win)
        contents.on('dom-ready', nudge)
        contents.on('did-navigate', nudge)
      } catch {}
    }

    function pushUpdate() {
      buildPayload()
      repaintLiveSplashes()
      const code = installCode(lastPayload)
      for (const contents of webContents.getAllWebContents()) {
        if (!isUiTarget(contents)) continue
        try {
          contents.executeJavaScript(code).catch(() => {})
        } catch {}
      }
    }

    let watchTimer = null
    function watchThemesDir() {
      try {
        fs.mkdirSync(THEMES_DIR, { recursive: true })
      } catch {}
      try {
        fs.watch(THEMES_DIR, { recursive: true }, () => {
          clearTimeout(watchTimer)
          watchTimer = setTimeout(pushUpdate, 250)
        })
      } catch {}
    }

    app.on('web-contents-created', (_event, contents) => {
      contents.on('dom-ready', () => {
        if (isUiTarget(contents)) inject(contents)
      })
      contents.on('did-navigate', () => {
        if (isUiTarget(contents)) inject(contents)
      })
      // Freebuff reloads its own window (update apply, recovery). Electron
      // does not always replay dom-ready for the replacement document, so
      // re-inject once the load settles as well.
      contents.on('did-stop-loading', () => {
        if (isUiTarget(contents)) inject(contents)
      })
    })

    // Self-heal: cheap probe on every UI window; if the runtime vanished with
    // a navigation the listeners missed, push it back in.
    setInterval(() => {
      for (const contents of webContents.getAllWebContents()) {
        if (!isUiTarget(contents)) continue
        try {
          // Only re-inject when the runtime itself is gone (fresh document);
          // a pending first install resolves on its own.
          contents
            .executeJavaScript(';!!window.__FBS_INSTALL__')
            .then((ok) => {
              if (!ok) inject(contents)
            })
            .catch(() => {})
        } catch {}
      }
    }, 4000)

    // Mirror the renderer's picks into state.json (throttled; cheap read-only).
    setInterval(syncSettings, 3000)

    buildPayload()
    /* Splash theming must win the race in every order of events: we may attach
       before the window exists (patch loadURL), after it exists but before it
       navigates (per-window patch), or while a splash is already on screen
       (direct repaint + a short burst that covers its document still loading). */
    patchSplashLoadURL(BrowserWindow.prototype)
    for (const win of BrowserWindow.getAllWindows()) watchSplashWindow(win)
    app.on('browser-window-created', (_event, win) => watchSplashWindow(win))
    for (const ms of [0, 150, 400, 900, 1600, 2600, 4000]) setTimeout(repaintLiveSplashes, ms)
    // Windows that exist before the bridge attaches (bridge injected late).
    for (const contents of webContents.getAllWebContents()) {
      if (isUiTarget(contents)) inject(contents)
    }
    const onReady = () => {
      // Session preloads can only be touched once the app is ready. This
      // module loads before Freebuff's own code, so our ready handler runs
      // before its first window is created.
      registerPreloads()
      watchThemesDir()
    }
    if (app.isReady()) onReady()
    else app.on('ready', onReady)
    // Any additional session (a partition added later) gets the preload too.
    app.on('session-created', (ses) => registerPreloadOn(ses))
  } catch (err) {
    try {
      console.error('[freebuff-theme-bridge] disabled:', err && err.message)
    } catch {}
  }
}
