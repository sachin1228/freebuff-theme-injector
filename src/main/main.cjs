/**
 * Theme Injector — main process.
 *
 * One job: keep the patched copy of Freebuff open and themed.
 *
 * Freebuff 0.0.201 refuses to start with any remote-debugging switch, and its
 * fuses disable NODE_OPTIONS / --inspect / ELECTRON_RUN_AS_NODE. patch.cjs
 * therefore builds a private copy with the launch guard removed and updates
 * disabled; this process launches only that copy, injects the theme runtime
 * over the DevTools port (bridge.cjs), and swaps any stock Freebuff for it.
 */
'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const bridge = require('./bridge.cjs')
const fb = require('./freebuff.cjs')
const patch = require('./patch.cjs')

app.setName('Theme Injector')

const IS_DEV = !app.isPackaged
const BRIDGE_SRC = IS_DEV ? path.join(__dirname, '..', 'bridge') : path.join(process.resourcesPath, 'bridge')
const BUNDLED_THEMES = IS_DEV ? path.join(__dirname, '..', '..', 'themes') : path.join(process.resourcesPath, 'themes')
const ICON_PATH = IS_DEV
  ? path.join(__dirname, '..', '..', 'build', 'icon.png')
  : path.join(process.resourcesPath, 'icon.png')

const WATCH_INTERVAL_MS = 5000
/* Boot grace: closing a Freebuff that is still starting up makes its own load
   chain reject against a destroyed window — Freebuff surfaces that as a
   "failed to start" dialog. A plain instance is only swapped once the same PID
   set has been observed running for PLAIN_GRACE_MS. */
const PLAIN_GRACE_MS = 8000

let win = null
let tray = null
let themedExe = null
let preparing = null
let prepareError = null
let busy = false
let watchTimer = null
let plainSince = { key: '', at: 0 }

/** Build (once) and remember the patched copy of the installed Freebuff. */
async function ensureThemedExe(exe) {
  if (themedExe && fs.existsSync(themedExe)) return themedExe
  if (!preparing) {
    preparing = patch.ensureThemedCopy(exe).finally(() => { preparing = null })
  }
  try {
    const meta = await preparing
    themedExe = (meta && meta.exe) || null
    prepareError = null
  } catch (e) {
    themedExe = null
    prepareError = e && e.message
    console.error('[theme-injector] could not build the patched Freebuff copy:', prepareError)
  }
  return themedExe
}

/* ---------- launching ---------- */

/**
 * Open the themed copy. Reuses a running attached copy, otherwise replaces any
 * stock Freebuff (same profile, same singleton lock) with the patched one.
 */
async function openThemed() {
  const exe = fb.detectFreebuff() || (fs.existsSync(patch.PATCHED_EXE) ? patch.PATCHED_EXE : null)
  if (!exe) return { ok: false, error: 'Freebuff was not found. Install it from freebuff.com first.' }

  if (await bridge.isDebugPortLive(fb.DEBUG_PORT)) {
    // The patched copy is already up; attach (or refresh a stale runtime)
    // instead of restarting the app under the user.
    try { await bridge.attachBridge(fb.DEBUG_PORT) } catch {}
    fb.openFreebuff(patch.BUNDLE) // bring the existing window forward
    return { ok: true, note: 'Freebuff is already open.' }
  }
  if (busy) return { ok: false, error: 'Freebuff is restarting — try again in a moment.' }

  busy = true
  try {
    const themed = await ensureThemedExe(exe)
    if (!themed) {
      return { ok: false, error: 'Could not prepare the patched copy of Freebuff: ' + (prepareError || 'unknown error') }
    }
    if (await fb.isFreebuffRunning()) {
      const done = await fb.quitFreebuff()
      if (!done) return { ok: false, error: 'Freebuff did not close. Quit it, then try again.' }
    }
    try {
      await fb.launchFreebuff(themed, bridge.attachBridge)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: 'Could not attach the theme bridge: ' + e.message }
    }
  } finally {
    busy = false
  }
}

/* ---------- the sticky themed copy ---------- */

/**
 * Keep the themed copy as the only Freebuff. Safe to call repeatedly;
 * reentrancy is guarded so a slow relaunch can't stack up. Quitting Freebuff
 * is intent to close, so nothing is reopened when no process is running.
 */
async function ensureThemed() {
  if (busy) return
  busy = true
  try {
    if (await bridge.isAttached(fb.DEBUG_PORT)) { plainSince = { key: '', at: 0 }; return }
    // Copy already running with the debug port: inject the current runtime
    // into it (covers a stale build) rather than quitting the app.
    if (await bridge.isDebugPortLive(fb.DEBUG_PORT)) {
      try { await bridge.attachBridge(fb.DEBUG_PORT) } catch {}
      return
    }
    const pids = await fb.freebuffPids()
    if (!pids.length) { plainSince = { key: '', at: 0 }; return }
    const exe = fb.detectFreebuff() || (fs.existsSync(patch.PATCHED_EXE) ? patch.PATCHED_EXE : null)
    if (!exe) return
    const themed = await ensureThemedExe(exe)
    if (!themed) return
    const key = pids.join(',')
    const now = Date.now()
    if (plainSince.key !== key) plainSince = { key, at: now } // fresh process — clock its boot
    if (now - plainSince.at < PLAIN_GRACE_MS) return // still starting; hands off next tick
    const done = await fb.quitFreebuff()
    if (!done) return // user declined / stuck; retry on next tick
    plainSince = { key: '', at: 0 }
    await fb.launchFreebuff(themed, bridge.attachBridge)
  } catch (e) {
    // Never let a watcher tick crash the app; next tick retries. Log it — a
    // swallowed failure here is how a stuck-unthemed Freebuff hides.
    console.error('[theme-injector] ensureThemed failed:', e && e.message)
  } finally {
    busy = false
  }
}

function startWatch() {
  stopWatch()
  watchTimer = setInterval(() => { ensureThemed() }, WATCH_INTERVAL_MS)
}
function stopWatch() {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('app:status', async () => {
    const exe = fb.detectFreebuff() || (fs.existsSync(patch.PATCHED_EXE) ? patch.PATCHED_EXE : null)
    return {
      exe,
      running: await fb.isFreebuffRunning(),
      themed: await bridge.isAttached(fb.DEBUG_PORT),
      copyReady: fs.existsSync(patch.PATCHED_EXE),
      busy,
    }
  })
  ipcMain.handle('app:open', () => openThemed())
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
    width: 560,
    height: 430,
    minWidth: 480,
    minHeight: 380,
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
  // Closing the window must not stop the watcher: hide instead. The tray (and
  // Dock) keep the app reachable.
  win.on('close', (e) => {
    if (!app.isQuitting) {
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
      { label: 'Open themed Freebuff', click: () => { openThemed() } },
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
    bridge.installBridge(BRIDGE_SRC, BUNDLED_THEMES)
    registerIpc()
    createWindow()
    createTray()
    startWatch()
    // Build/refresh the patched copy in the background so the button does not
    // stall on it the first time.
    const exe = fb.detectFreebuff()
    if (exe) ensureThemedExe(exe)
    app.on('activate', () => {
      if (win && win.isDestroyed()) win = null
      if (!win) createWindow()
      else showWindow()
    })
  })
  app.on('before-quit', () => { app.isQuitting = true })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
