/**
 * Theme Injector — main process.
 * One job: keep the theme bridge installed, and flip Freebuff between
 * themed (enable) and plain (disable) launches.
 *
 * While the switch is ON a background watcher keeps themes "sticky": if
 * Freebuff is found running WITHOUT the bridge attached — e.g. it was
 * reopened normally, auto-started, or restarted by its own updater — the
 * watcher relaunches it once with themes. Nothing is ever written inside
 * Freebuff.app, so app updates can't break the injection; they only need
 * the one re-attach, which the watcher performs automatically.
 */
'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const bridge = require('./bridge.cjs')
const fb = require('./freebuff.cjs')
const byokApi = require('./byok.cjs')
const bench = require('./bench.cjs')

/* Renamed from "Freebuff Theme Studio" to "Theme Injector". Electron derives
   userData from the product name, so pin it (dev and packaged must agree) and
   carry the old toggle state forward — losing it would silently stop keeping
   Freebuff themed after an update. */
app.setName('Theme Injector')

const IS_DEV = !app.isPackaged
const BRIDGE_SRC = IS_DEV ? path.join(__dirname, '..', 'bridge') : path.join(process.resourcesPath, 'bridge')
const BUNDLED_THEMES = IS_DEV ? path.join(__dirname, '..', '..', 'themes') : path.join(process.resourcesPath, 'themes')
const ICON_PATH = IS_DEV
  ? path.join(__dirname, '..', '..', 'build', 'icon.png')
  : path.join(process.resourcesPath, 'icon.png')
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')

const LEGACY_APP_NAMES = ['Freebuff Theme Studio', 'freebuff-theme-studio']
function migrateSettings() {
  try {
    const target = SETTINGS_FILE()
    if (fs.existsSync(target)) return
    for (const legacy of LEGACY_APP_NAMES) {
      const from = path.join(app.getPath('appData'), legacy, 'settings.json')
      if (!fs.existsSync(from)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(from, target)
      return
    }
  } catch {}
}

const WATCH_INTERVAL_MS = 5000

/* Performance module defaults — mirror boot.cjs's normalizePerf. The Injector
   is the owner of these settings; it writes them into the bridge's state.json
   on every change, and the bridge pushes them into Freebuff live. */
const PERF_DEFAULTS = {
  enabled: true,
  overlay: true,
  nudge: true,
  nudgeIdleMs: 12 * 60 * 1000,
  nudgeContextTokens: 40000,
  effortDefault: 'low',
}
const PERF_EFFORTS = ['low', 'medium', 'high', 'max']

function normalizePerf(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: p.enabled !== false,
    overlay: p.overlay !== false,
    nudge: p.nudge !== false,
    nudgeIdleMs:
      typeof p.nudgeIdleMs === 'number' && p.nudgeIdleMs >= 60000 ? p.nudgeIdleMs : PERF_DEFAULTS.nudgeIdleMs,
    nudgeContextTokens:
      typeof p.nudgeContextTokens === 'number' && p.nudgeContextTokens >= 1000
        ? p.nudgeContextTokens
        : PERF_DEFAULTS.nudgeContextTokens,
    // Missing = never chosen, and the requested default is low (DeepSeek's
    // fastest effort). An explicit '' from the panel means "Model default"
    // and is kept as such.
    effortDefault:
      p.effortDefault === undefined || p.effortDefault === null
        ? PERF_DEFAULTS.effortDefault
        : PERF_EFFORTS.includes(p.effortDefault)
          ? p.effortDefault
          : '',
  }
}

/* Ads defaults — mirror boot.cjs's readSettings. The Injector owns the switch;
   it lands in the bridge's state.json as `hideAds` and the bridge re-applies
   it live. On by default: Freebuff's sponsored placements stay hidden unless
   the user turns them back on. */
function normalizeAds(raw) {
  const a = raw && typeof raw === 'object' ? raw : {}
  return { hide: a.hide !== false }
}

let win = null
let tray = null
let enabled = false
let busy = false
let watchTimer = null

function readSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))
    return { enabled: !!j.enabled, perf: normalizePerf(j.perf), ads: normalizeAds(j.ads) }
  } catch {
    return { enabled: false, perf: normalizePerf(null), ads: normalizeAds(null) }
  }
}
function patchSettings(patch) {
  let current = {}
  try { current = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) } catch {}
  const next = { ...current, ...patch }
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next)) } catch {}
  return next
}

/** The bridge reads its config from ~/.freebuff-theme-studio/state.json. The
    bridge mirrors the picker's own choices back into the same file, so every
    write is a read-merge-write — dropping an owner's key silently disables it. */
function stateFilePath() {
  return path.join(bridge.ROOT, 'state.json')
}
function syncStateToBridge(patch) {
  try {
    fs.mkdirSync(bridge.ROOT, { recursive: true })
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) } catch {}
    fs.writeFileSync(stateFilePath(), JSON.stringify({ ...existing, ...patch }))
  } catch {}
}

/* ---------- the sticky-themes watcher ---------- */

/**
 * Bring Freebuff up themed if it isn't already. Safe to call repeatedly;
 * reentrancy is guarded so a slow relaunch can't stack up.
 */
/* Boot grace: closing a Freebuff that is still starting up makes its own
   load chain reject against a destroyed window — Freebuff surfaces that as
   a "failed to start" dialog. A plain instance is only swapped once the
   same PID set has been observed running for PLAIN_GRACE_MS. */
const PLAIN_GRACE_MS = 8000
let plainSince = { key: '', at: 0 }

async function ensureThemed() {
  if (busy) return
  busy = true
  try {
    if (await bridge.isAttached(fb.INSPECT_PORT)) { plainSince = { key: '', at: 0 }; return } // already themed
    // Stickiness only applies while Freebuff is actually open: quitting it is
    // intent to close, and the injector must not reopen it. A plain launch
    // (manual open, login item, or the app's own updater restarted it) is
    // closed and relaunched with the bridge; Freebuff gets themed on that
    // next open instead.
    const pids = await fb.freebuffPids()
    if (!pids.length) { plainSince = { key: '', at: 0 }; return }
    const exe = fb.detectFreebuff()
    if (!exe) return
    const key = pids.join(',')
    const now = Date.now()
    if (plainSince.key !== key) plainSince = { key, at: now } // fresh process — clock its boot
    if (now - plainSince.at < PLAIN_GRACE_MS) return // still starting; hands off next tick
    const done = await fb.quitFreebuff()
    if (!done) return // user declined / stuck; retry on next tick
    plainSince = { key: '', at: 0 }
    await fb.launchFreebuff(exe, bridge.attachBridge)
  } catch (e) {
    // Never let a watcher tick crash the app; next tick retries. Log it —
    // a swallowed failure here is how a stuck-unthemed Freebuff hides.
    console.error('[theme-injector] ensureThemed failed:', e && e.message)
  } finally {
    busy = false
  }
}

function startWatch() {
  stopWatch()
  watchTimer = setInterval(() => {
    if (enabled) ensureThemed()
  }, WATCH_INTERVAL_MS)
}
function stopWatch() {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('app:status', async () => {
    const exe = fb.detectFreebuff()
    return {
      exe,
      running: await fb.isFreebuffRunning(),
      themed: await bridge.isAttached(fb.INSPECT_PORT),
      enabled,
    }
  })
  ipcMain.handle('app:enable', async () => {
    const exe = fb.detectFreebuff()
    if (!exe) return { ok: false, error: 'Freebuff was not found. Install it from freebuff.com first.' }
    enabled = true
    patchSettings({ enabled: true })
    startWatch()
    if (await bridge.isAttached(fb.INSPECT_PORT)) return { ok: true, note: 'Themes are already on.' }
    if (await fb.isFreebuffRunning()) {
      const done = await fb.quitFreebuff()
      if (!done) return { ok: false, error: 'Freebuff did not close. Close it manually, then flip the switch again.' }
    }
    try {
      await fb.launchFreebuff(exe, bridge.attachBridge)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: 'Could not attach the theme bridge: ' + e.message }
    }
  })
  ipcMain.handle('perf:get', async () => {
    const s = readSettings()
    return {
      perf: s.perf,
      keyPresent: !!process.env.DEEPSEEK_API_KEY,
      running: await fb.isFreebuffRunning(),
      themed: await bridge.isAttached(fb.INSPECT_PORT),
      enabled,
    }
  })
  ipcMain.handle('perf:set', async (_event, patch) => {
    const s = readSettings()
    const perf = normalizePerf({ ...s.perf, ...(patch && typeof patch === 'object' ? patch : {}) })
    patchSettings({ perf })
    syncStateToBridge({ perf })
    return { perf }
  })
  ipcMain.handle('ads:get', async () => {
    return { ads: readSettings().ads }
  })
  ipcMain.handle('ads:set', async (_event, patch) => {
    const s = readSettings()
    const ads = normalizeAds({ ...s.ads, ...(patch && typeof patch === 'object' ? patch : {}) })
    patchSettings({ ads })
    syncStateToBridge({ hideAds: ads.hide })
    return { ads }
  })
  ipcMain.handle('byok:status', async () => {
    try {
      return await byokApi.status(fb.INSPECT_PORT, process.env)
    } catch (e) {
      return { keyPresent: !!process.env.DEEPSEEK_API_KEY, inspectorUp: false, error: e.message }
    }
  })
  ipcMain.handle('byok:setup', async () => {
    if (!(await bridge.isAttached(fb.INSPECT_PORT))) {
      return { ok: false, error: 'Turn themes on and let Freebuff restart, then set up the connection.' }
    }
    try {
      return await byokApi.setup(fb.INSPECT_PORT)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('byok:validate', async () => {
    try {
      const st = await byokApi.status(fb.INSPECT_PORT, process.env)
      if (!st.connection) return { ok: false, error: 'No DeepSeek connection to validate yet.' }
      return await byokApi.validate(fb.INSPECT_PORT, st.connection.id, st.connection.revision)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('bench:run', async (_event, opts) => {
    if (!(await bridge.isAttached(fb.INSPECT_PORT))) {
      return { ok: false, error: 'Freebuff must be running with themes on to run the benchmark.' }
    }
    try {
      return await bench.run(fb.INSPECT_PORT, opts || {})
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('app:disable', async () => {
    const exe = fb.detectFreebuff()
    if (!exe) return { ok: false, error: 'Freebuff was not found.' }
    enabled = false
    patchSettings({ enabled: false })
    stopWatch()
    const wasThemed = await bridge.isAttached(fb.INSPECT_PORT)
    if (await fb.isFreebuffRunning()) {
      const done = await fb.quitFreebuff()
      if (!done) return { ok: false, error: 'Freebuff did not close. Close it manually and try again.' }
    }
    if (!wasThemed) return { ok: true, note: 'Themes are off.' }
    fb.launchPlain(exe)
    return { ok: true }
  })
}

/* ---------- window + tray ---------- */

function showWindow() {
  if (!win) {
    createWindow()
    return
  }
  win.show()
  win.focus()
}

function createWindow() {
  win = new BrowserWindow({
    width: 660,
    height: 820,
    minWidth: 560,
    minHeight: 560,
    title: 'Theme Injector',
    icon: ICON_PATH,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  // With themes on, closing the window must not stop the watcher: hide
  // instead. The tray (and Dock) keep the app reachable.
  win.on('close', (e) => {
    if (enabled && !app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { win = null })
}

function createTray() {
  if (tray) return
  try {
    const img = nativeImage.createFromPath(ICON_PATH)
    const small = img.isEmpty() ? img : img.resize({ width: 18, height: 18 })
    tray = new Tray(small)
    tray.setToolTip('Theme Injector')
    const menu = Menu.buildFromTemplate([
      { label: 'Show Theme Injector', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit Theme Injector',
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ])
    tray.on('click', showWindow)
    tray.setContextMenu(menu)
  } catch {
    tray = null // no icon available — window-close guard still protects the watcher
  }
}

/* ---------- lifecycle ---------- */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(() => {
    migrateSettings()
    bridge.installBridge(BRIDGE_SRC, BUNDLED_THEMES)
    const boot = readSettings()
    syncStateToBridge({ perf: boot.perf, hideAds: boot.ads.hide })
    registerIpc()
    createWindow()
    createTray()
    enabled = !!boot.enabled
    if (enabled) startWatch() // resume stickiness across app restarts
    app.on('activate', () => {
      if (win && win.isDestroyed()) win = null
      if (!win) createWindow()
      else showWindow()
    })
  })
  app.on('before-quit', () => { app.isQuitting = true })
  app.on('window-all-closed', () => {
    // Keep running (watcher + tray) while themes are on; on macOS the Dock
    // icon keeps it alive regardless.
    if (!enabled && process.platform !== 'darwin') app.quit()
  })
}
