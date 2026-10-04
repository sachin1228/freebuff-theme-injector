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

let win = null
let tray = null
let enabled = false
let busy = false
let watchTimer = null

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) } catch { return { enabled: false } }
}
function writeSettings(s) {
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s)) } catch {}
}

/* ---------- the sticky-themes watcher ---------- */

/**
 * Bring Freebuff up themed if it isn't already. Safe to call repeatedly;
 * reentrancy is guarded so a slow relaunch can't stack up.
 */
async function ensureThemed() {
  if (busy) return
  busy = true
  try {
    if (await bridge.isAttached(fb.INSPECT_PORT)) return // already themed
    // Stickiness only applies while Freebuff is actually open: quitting it is
    // intent to close, and the injector must not reopen it. A plain launch
    // (manual open, login item, or the app's own updater restarted it) is
    // closed and relaunched with the bridge; Freebuff gets themed on that
    // next open instead.
    if (!(await fb.isFreebuffRunning())) return
    const exe = fb.detectFreebuff()
    if (!exe) return
    const done = await fb.quitFreebuff()
    if (!done) return // user declined / stuck; retry on next tick
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
    writeSettings({ enabled: true })
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
  ipcMain.handle('app:disable', async () => {
    const exe = fb.detectFreebuff()
    if (!exe) return { ok: false, error: 'Freebuff was not found.' }
    enabled = false
    writeSettings({ enabled: false })
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
    height: 688,
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
    registerIpc()
    createWindow()
    createTray()
    enabled = !!readSettings().enabled
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
