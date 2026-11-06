/**
 * Freebuff app detection, launch (with the theme injector attached) and quit,
 * for macOS and Windows.
 *
 * The injector needs a channel into the running app. Freebuff 0.0.200+ sets
 * the Electron fuses `EnableNodeOptionsEnvironmentVariable` and
 * `EnableNodeCliInspectArguments` to Disabled, which kills the old two hooks
 * (NODE_OPTIONS --require and --inspect). Chromium's remote debugging port is
 * not fused, so that is the channel: it reaches every renderer, which is where
 * the theme lives.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

/* Loopback CDP port Freebuff is launched with. The app itself does not use it
   (electron/cdp-bridge.cjs is an HTTP bridge scoped to preview webviews). */
const DEBUG_PORT = 41731

/* Both loopback spellings: Chromium rejects a WebSocket whose Origin is not
   allowlisted, and the client's origin can be either. No wildcard — a web page
   in any browser must not be able to drive Freebuff over this port. */
const DEBUG_ORIGINS = `http://127.0.0.1:${DEBUG_PORT},http://localhost:${DEBUG_PORT}`

function exeCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Freebuff.app/Contents/MacOS/Freebuff',
      path.join(os.homedir(), 'Applications', 'Freebuff.app', 'Contents', 'MacOS', 'Freebuff'),
    ]
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const pf64 = process.env.PROGRAMFILES || 'C:\\Program Files'
    return [
      path.join(local, 'Programs', 'Freebuff', 'Freebuff.exe'),
      path.join(pf64, 'Freebuff', 'Freebuff.exe'),
      path.join(pf, 'Freebuff', 'Freebuff.exe'),
    ]
  }
  return ['/opt/Freebuff/freebuff', path.join(os.homedir(), '.local', 'share', 'Freebuff', 'freebuff')]
}

function detectFreebuff() {
  for (const p of exeCandidates()) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

/** PIDs of running Freebuff main processes (any instance). */
async function freebuffPids() {
  if (process.platform === 'win32') {
    const out = await exec('tasklist', ['/FI', 'IMAGENAME eq Freebuff.exe', '/NH', '/FO', 'CSV'])
    return out
      .split('\n')
      .map((line) => {
        const m = /"Freebuff\.exe","(\d+)"/i.exec(line)
        return m ? Number(m[1]) : null
      })
      .filter(Boolean)
  }
  /* macOS keeps p_comm as the (possibly truncated) executable path, so
     `pgrep -x Freebuff` matches nothing even while Freebuff runs. That made
     the injector believe the app was closed, skip the quit, and hand a second
     launch to the already-running instance — no debug port, no targets, no
     theme. Read the real path from ps and match the binary name instead. */
  const out = await exec('ps', ['-Ao', 'pid=,comm='])
  const pids = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    if (/(^|\/)Freebuff$/.test(m[2])) pids.push(Number(m[1]))
  }
  return pids
}

/** Is a Freebuff main process running? (any instance) */
async function isFreebuffRunning() {
  return (await freebuffPids()).length > 0
}

async function quitFreebuff() {
  if (process.platform === 'win32') {
    // Graceful close, then force after a grace period.
    await exec('taskkill', ['/IM', 'Freebuff.exe'])
    await new Promise((r) => setTimeout(r, 2500))
    if (await isFreebuffRunning()) await exec('taskkill', ['/F', '/IM', 'Freebuff.exe'])
  } else {
    await exec('osascript', ['-e', 'tell application "Freebuff" to quit'])
    const deadline = Date.now() + 6000
    while (Date.now() < deadline && (await isFreebuffRunning())) {
      await new Promise((r) => setTimeout(r, 300))
    }
    if (await isFreebuffRunning()) {
      const out = await exec('pgrep', ['-x', 'Freebuff'])
      for (const pid of out.trim().split('\n').filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGTERM') } catch {}
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  return !(await isFreebuffRunning())
}

/** Launch Freebuff with the CDP port open and attach the theme runtime. */
function launchFreebuff(exePath, attachFn) {
  const { spawn } = require('node:child_process')
  const child = spawn(
    exePath,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--remote-allow-origins=${DEBUG_ORIGINS}`,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    },
  )
  child.unref()
  return attachFn(DEBUG_PORT)
}

/** Bring an already-running copy forward without relaunching it. */
function openFreebuff(bundlePath) {
  const { spawn } = require('node:child_process')
  try {
    const child = spawn('open', [bundlePath], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {}
}

module.exports = {
  detectFreebuff,
  isFreebuffRunning,
  freebuffPids,
  quitFreebuff,
  launchFreebuff,
  openFreebuff,
  DEBUG_PORT,
}
