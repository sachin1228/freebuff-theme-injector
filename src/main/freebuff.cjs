/**
 * Freebuff app detection, launch (with the theme bridge attached) and quit,
 * for macOS and Windows.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const INSPECT_PORT = 41731

const BRIDGE_DIR = path.join(os.homedir(), '.freebuff-theme-studio', 'bridge')
const EARLY_ENTRY = path.join(BRIDGE_DIR, 'early.cjs')

/* Remove only the --require entry this app adds to NODE_OPTIONS, so a user's
   own options survive and a "plain" launch never loads the bridge.
   KEEP-IN-SYNC: the same pattern lives in bridge/shared.cjs (used by
   early.cjs / boot.cjs to clean the environment inside Freebuff). */
function stripEarlyRequire(value) {
  if (typeof value !== 'string' || !value) return ''
  return value
    .replace(/--require\s+("[^"]*early\.cjs"|'[^']*early\.cjs'|\S*early\.cjs)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

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
  const out = await exec('pgrep', ['-x', 'Freebuff'])
  return out.trim().split('\n').filter(Boolean).map(Number)
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

/** Launch Freebuff with the bridge preloaded and attach it via the inspector.
    Two hooks are armed: `--require` (runs before Freebuff's own first frame
    when the NODE_OPTIONS fuse allows it) and the inspector attach, which must
    land. Packaged builds commonly reject NODE_OPTIONS — measured on Freebuff:
    Electron logs "Most NODE_OPTIONs are not supported in packaged apps" and
    replaces the var with " " — so the attach is the path that can never be
    skipped; the --require entry is a free upgrade for builds that permit it. */
function launchFreebuff(exePath, attachFn) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  if (fs.existsSync(EARLY_ENTRY)) {
    const entry = `--require "${EARLY_ENTRY}"`
    const existing = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS.trim() : ''
    env.NODE_OPTIONS = existing ? existing + ' ' + entry : entry
  }
  const child = spawn(exePath, [`--inspect=127.0.0.1:${INSPECT_PORT}`], {
    detached: true,
    stdio: 'ignore',
    env,
  })
  child.unref()
  return attachFn(INSPECT_PORT)
}

/** Launch Freebuff normally (no bridge, no inspector, no preload). */
function launchPlain(exePath) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  if (typeof env.NODE_OPTIONS === 'string') {
    const cleaned = stripEarlyRequire(env.NODE_OPTIONS)
    if (cleaned) env.NODE_OPTIONS = cleaned
    else delete env.NODE_OPTIONS
  }
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    env,
  })
  child.unref()
}

module.exports = { detectFreebuff, isFreebuffRunning, freebuffPids, quitFreebuff, launchFreebuff, launchPlain, INSPECT_PORT }
