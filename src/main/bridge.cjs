/**
 * Renderer injector.
 *
 * Freebuff 0.0.200+ ships with Electron fuses that disable both
 * EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments:
 * NODE_OPTIONS is neutralised and `--inspect` never opens a server. The old
 * bridge — a module loaded into Freebuff's main process — therefore cannot
 * attach any more, which is exactly why themes stopped showing up.
 *
 * Chromium's own remote debugging port is not fused. Freebuff is launched with
 * `--remote-debugging-port`; this module talks CDP to every page target the
 * app opens, registers the theme runtime as a document-start script and
 * injects it into the live document. The runtime is still the renderer script
 * (bridge/runtime.js), so themes, the picker, fonts and the ad filter keep
 * working without writing anything inside Freebuff.app.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(os.homedir(), '.freebuff-theme-studio')
const BRIDGE_DIR = path.join(ROOT, 'bridge')
const THEMES_DIR = path.join(ROOT, 'themes')
const STATE_PATH = path.join(ROOT, 'state.json')
const RUNTIME_PATH = path.join(BRIDGE_DIR, 'runtime.js')

const TICK_MS = 1200
const ATTACH_TIMEOUT_MS = 25000
const SETTINGS_EVERY_TICKS = 3
const MAX_TARGETS = 12

/* ---------- CDP plumbing ---------- */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.closed = false
    this.onclose = null
    ws.addEventListener('message', (m) => {
      let d
      try { d = JSON.parse(m.data) } catch { return }
      if (!d.id || !this.pending.has(d.id)) return
      const p = this.pending.get(d.id)
      this.pending.delete(d.id)
      if (d.error) p.rej(new Error(d.error.message || 'cdp error'))
      else p.res(d.result)
    })
    ws.addEventListener('close', () => this._closed())
    ws.addEventListener('error', () => {})
  }
  _closed() {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.rej(new Error('cdp connection closed'))
    this.pending.clear()
    if (this.onclose) {
      try { this.onclose() } catch {}
    }
  }
  static connect(url, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let ws
      try {
        ws = new WebSocket(url)
      } catch (e) {
        return reject(e)
      }
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error('cdp connect timeout'))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new Cdp(ws))
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('cdp websocket error'))
      }, { once: true })
    })
  }
  send(method, params = {}, timeoutMs = 8000) {
    if (this.closed) return Promise.reject(new Error('cdp connection closed'))
    return new Promise((res, rej) => {
      const id = ++this.id
      this.pending.set(id, { res, rej })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        return rej(e)
      }
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rej(new Error(method + ' timeout'))
      }, timeoutMs)
    })
  }
  async evaluate(expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs)
    if (r && r.exceptionDetails) {
      const ex = r.exceptionDetails
      throw new Error((ex.exception && ex.exception.description) || ex.text || 'eval exception')
    }
    return r && r.result && r.result.value
  }
  close() {
    try { this.ws.close() } catch {}
    this._closed()
  }
}

async function fetchTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  })
  if (!res.ok) throw new Error('cdp http ' + res.status)
  const list = await res.json()
  if (!Array.isArray(list)) throw new Error('cdp returned no target list')
  return list
}

/* Freebuff serves its UI from a fresh loopback port each launch, and its very
   first frame is a data: URL splash. Both are injection targets; a dev server
   opened in a webview is loopback too, so the runtime itself stays inert
   outside Freebuff's own documents. */
function isSplashUrl(url) {
  if (typeof url !== 'string' || url.indexOf('data:text/html') !== 0) return false
  try {
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    return /@keyframes\s+sweep/.test(html) && /class="bar"/.test(html)
  } catch {
    return false
  }
}

function isUiTargetUrl(url) {
  if (typeof url !== 'string') return false
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url)) return true
  return isSplashUrl(url)
}

function isFreebuffTarget(t) {
  if (!t || t.type !== 'page') return false
  if (!isUiTargetUrl(t.url)) return false
  // A target that names itself something else is not Freebuff (dev servers in
  // webviews can share the loopback origin shape). Empty titles are the splash.
  if (typeof t.title === 'string' && t.title && !/freebuff/i.test(t.title)) return false
  return true
}

/* ---------- theme + settings reading (main-process copy) ---------- */

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

function readSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    return {
      theme: typeof j.theme === 'string' ? j.theme : null,
      font: typeof j.font === 'string' ? j.font : null,
      // Ads are hidden by default: an absent key means the user never chose.
      hideAds: j.hideAds !== false,
    }
  } catch {
    return { theme: null, font: null, hideAds: true }
  }
}

function writeSettings(patch) {
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    let existing = {}
    try {
      existing = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    } catch {}
    const merged = Object.assign({}, existing, patch)
    fs.writeFileSync(STATE_PATH, JSON.stringify(merged))
    return merged
  } catch {
    return null
  }
}

/** Resolve a token out of a theme's CSS, following var() hops. */
function tokenValue(css, name, hops) {
  if (hops > 3) return null
  const m = new RegExp('--' + name + '\\s*:\\s*([^;}]+)').exec(css)
  if (!m) return null
  const v = m[1].trim().replace(/!important\s*$/i, '').trim()
  const vm = /^var\(\s*--([a-z0-9-]+)/i.exec(v)
  return vm ? tokenValue(css, vm[1], hops + 1) : v
}

function parseHex(v) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(v || '').trim())
  if (!m) return null
  let s = m[1]
  if (s.length === 3 || s.length === 4) s = s.replace(/./g, (c) => c + c)
  if (s.length < 6) return null
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  }
}

/** The theme's canvas, painted as the window background so no frame flashes. */
function themeBackground(theme) {
  if (!theme || !theme.css) return null
  for (const name of ['bg', 'workspace-surface', 'shell-base']) {
    const v = tokenValue(theme.css, name, 0)
    const rgb = parseHex(v)
    if (rgb) return rgb
  }
  return null
}

/* ---------- payload ---------- */

function buildPayload() {
  let runtime = ''
  try {
    runtime = fs.readFileSync(RUNTIME_PATH, 'utf8')
  } catch {}
  return { runtime, themes: readThemes(), settings: readSettings() }
}

function installCode(payload) {
  return (
    ';(function(){try{window.__FBS_ATTACHED__=true}catch(e){}' +
    payload.runtime +
    '\nwindow.__FBS_INSTALL__(' +
    JSON.stringify({ themes: payload.themes, settings: payload.settings }) +
    ');})()'
  )
}

/* The picker writes its choice to localStorage; the app's origin (a random
   loopback port) changes every launch, so main keeps the durable copy. */
const LS_READ =
  ';(window.fbs && window.fbs.installed)' +
  " ? JSON.stringify({theme: localStorage.getItem('fbs.theme.active') || null," +
  " font: localStorage.getItem('fbs.font') || null}) : null"

/* ---------- injector loop ---------- */

let injector = null
let themeWatcher = null
let watchDebounce = null

function startInjector(port) {
  if (injector && injector.port === port && !injector.stopped) return injector
  if (injector) stopInjector()
  const state = {
    port,
    stopped: false,
    sessions: new Map(),
    connecting: new Set(),
    payload: buildPayload(),
    timer: null,
    ticks: 0,
    pushing: false,
  }
  injector = state
  tick(state)
  return state
}

function stopInjector() {
  if (!injector) return
  const state = injector
  injector = null
  state.stopped = true
  if (state.timer) clearTimeout(state.timer)
  for (const s of state.sessions.values()) {
    if (s && s.cdp) s.cdp.close()
  }
  state.sessions.clear()
}

function liveSessions(state) {
  const out = []
  for (const s of state.sessions.values()) {
    if (s && !s.closed && s.cdp && !s.cdp.closed) out.push(s)
  }
  return out
}

async function registerBootstrap(state, session) {
  if (!session.cdp || session.cdp.closed) return
  try {
    if (session.scriptId) {
      await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: session.scriptId,
      })
      session.scriptId = null
    }
  } catch {}
  try {
    const res = await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: installCode(state.payload),
    })
    if (res && res.identifier) session.scriptId = res.identifier
  } catch {}
}

async function applyBackground(state, session) {
  if (!session.cdp || session.cdp.closed) return
  try {
    const theme = state.payload.themes.find((t) => t.id === state.payload.settings.theme)
    const bg = themeBackground(theme)
    await session.cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      color: bg ? { r: bg.r, g: bg.g, b: bg.b, a: 1 } : { r: 0, g: 0, b: 0, a: 0 },
    })
  } catch {}
}

async function installInto(state, session) {
  if (!session.cdp || session.cdp.closed) return
  await registerBootstrap(state, session)
  await session.cdp.evaluate(installCode(state.payload))
  await applyBackground(state, session)
  session.injected = true
}

async function ensureSession(state, target) {
  const existing = state.sessions.get(target.id)
  if (existing) {
    if (existing.closed || !existing.cdp || existing.cdp.closed) {
      state.sessions.delete(target.id)
    } else {
      // The target survives navigations (splash -> app, reloads), and a
      // document-start script only covers documents that start after it was
      // registered. Re-install when the URL moves, and verify periodically
      // that the runtime survived whatever the app did to the page.
      if (target.url !== existing.url) {
        existing.url = target.url
        try { await installInto(state, existing) } catch {}
      } else if (state.ticks % 2 === 0) {
        let alive = false
        try {
          alive = await existing.cdp.evaluate('!!window.__FBS_INSTALL__', 2500)
        } catch {}
        if (!alive) {
          try { await installInto(state, existing) } catch {}
        }
      }
      return existing
    }
  }
  if (state.connecting.has(target.id) || state.connecting.size >= MAX_TARGETS) return null
  state.connecting.add(target.id)
  let cdp = null
  try {
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    try {
      await cdp.send('Page.enable')
    } catch {}
    const session = {
      id: target.id,
      cdp,
      url: target.url,
      scriptId: null,
      injected: false,
      closed: false,
    }
    cdp.onclose = () => {
      session.closed = true
      if (state.sessions.get(target.id) === session) state.sessions.delete(target.id)
    }
    state.sessions.set(target.id, session)
    await installInto(state, session)
    return session
  } catch {
    if (cdp) cdp.close()
    return null
  } finally {
    state.connecting.delete(target.id)
  }
}

async function pushPayload(state) {
  if (state.stopped || state.pushing) return
  state.pushing = true
  try {
    state.payload = buildPayload()
    for (const session of liveSessions(state)) {
      try {
        await installInto(state, session)
      } catch {}
    }
  } finally {
    state.pushing = false
  }
}

/** Mirror a picker choice into state.json and fan it out to other windows. */
async function syncSettings(state) {
  const sessions = liveSessions(state)
  if (!sessions.length) return
  for (const session of sessions.slice(0, 4)) {
    let raw = null
    try {
      raw = await session.cdp.evaluate(LS_READ, 2500)
    } catch {
      continue
    }
    let got = null
    try {
      got = raw ? JSON.parse(raw) : null
    } catch {}
    if (!got) continue
    const current = state.payload.settings
    if (!got.theme && !got.font && (current.theme || current.font)) continue
    if (got.theme === current.theme && got.font === current.font) continue
    const merged = writeSettings({ theme: got.theme, font: got.font })
    if (!merged) continue
    await pushPayload(state)
    return
  }
}

async function tick(state) {
  if (state.stopped) return
  state.ticks += 1
  let list = null
  try {
    list = await fetchTargets(state.port)
  } catch {}
  if (list) state.lastTargets = list
  if (list) {
    const seen = new Set()
    for (const target of list) {
      if (!isFreebuffTarget(target)) continue
      seen.add(target.id)
      await ensureSession(state, target)
    }
    for (const [id, session] of state.sessions) {
      if (seen.has(id)) continue
      try { session.cdp.close() } catch {}
      state.sessions.delete(id)
    }
    if (state.ticks % SETTINGS_EVERY_TICKS === 0) {
      try { await syncSettings(state) } catch {}
    }
  }
  if (!state.stopped) state.timer = setTimeout(() => { tick(state) }, TICK_MS)
}

/* ---------- public API ---------- */

/** Copy the runtime + seed bundled themes into the home dir. */
function installBridge(bridgeSrcDir, bundledThemesDir) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true })
  fs.mkdirSync(THEMES_DIR, { recursive: true })
  const runtime = path.join(bridgeSrcDir, 'runtime.js')
  if (fs.existsSync(runtime)) fs.copyFileSync(runtime, RUNTIME_PATH)
  // Seed bundled themes once per slug; user edits are never overwritten.
  if (fs.existsSync(bundledThemesDir)) {
    for (const slug of fs.readdirSync(bundledThemesDir)) {
      const from = path.join(bundledThemesDir, slug)
      const to = path.join(THEMES_DIR, slug)
      try {
        if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue
      } catch {
        continue
      }
      fs.cpSync(from, to, { recursive: true })
    }
  }
  watchThemes()
  return { root: ROOT, bridgeDir: BRIDGE_DIR, themesDir: THEMES_DIR }
}

/** Push theme-file edits into every open window, live. */
function watchThemes() {
  if (themeWatcher) return
  try {
    fs.mkdirSync(THEMES_DIR, { recursive: true })
  } catch {
    return
  }
  try {
    themeWatcher = fs.watch(THEMES_DIR, { recursive: true }, () => {
      clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        watchDebounce = null
        const state = injector
        if (state && !state.stopped) pushPayload(state)
      }, 250)
    })
  } catch {}
}

/**
 * Attach the runtime to a running Freebuff and resolve once at least one live
 * page target has it. Safe to call repeatedly (the watcher does, every 5s).
 */
async function attachBridge(port) {
  const state = startInjector(port)
  const deadline = Date.now() + ATTACH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (liveSessions(state).some((s) => s.injected)) return 'bridge-attached'
    // A tick is already scheduled; let it run, then look again.
    await new Promise((r) => setTimeout(r, 150))
    if (state.stopped) break
  }
  // Say what the debug port actually exposed: a silent timeout used to be
  // indistinguishable from a port that never opened.
  const pages = (state.lastTargets || []).filter((t) => t && t.type === 'page')
  const seen = pages.length
    ? pages.map((t) => (t.title || '(no title)') + ' ' + String(t.url).slice(0, 60)).slice(0, 3).join(', ')
    : 'no page targets on port ' + port
  throw new Error('Freebuff renderer did not accept the theme runtime (' + seen + ')')
}

/** True when a Freebuff launched with the debug port has the runtime live. */
async function isAttached(port) {
  let list
  try {
    list = await fetchTargets(port)
  } catch {
    return false
  }
  const targets = list.filter(isFreebuffTarget).slice(0, 3)
  if (!targets.length) return false
  for (const target of targets) {
    let cdp = null
    try {
      cdp = await Cdp.connect(target.webSocketDebuggerUrl, 2000)
      const alive = await cdp.evaluate('!!window.__FBS_ATTACHED__', 2500)
      if (alive === true) return true
    } catch {
    } finally {
      if (cdp) cdp.close()
    }
  }
  return false
}

/** Current ad-hiding preference (default on). */
function getHideAds() {
  return readSettings().hideAds
}

/** Persist the ad switch and push it into every open Freebuff window. */
async function setHideAds(hide) {
  const merged = writeSettings({ hideAds: hide === true })
  if (!merged) return false
  const state = injector
  if (state && !state.stopped) await pushPayload(state)
  return true
}

module.exports = {
  ROOT,
  BRIDGE_DIR,
  THEMES_DIR,
  installBridge,
  attachBridge,
  isAttached,
  stopInjector,
  getHideAds,
  setHideAds,
}
