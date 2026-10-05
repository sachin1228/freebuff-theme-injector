/**
 * Bridge manager: installs the theme bridge files into
 * ~/.freebuff-theme-studio/bridge and attaches it to a running Freebuff
 * Electron main process through the Node inspector.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(os.homedir(), '.freebuff-theme-studio')
const BRIDGE_DIR = path.join(ROOT, 'bridge')
const THEMES_DIR = path.join(ROOT, 'themes')

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (m) => {
      let d
      try { d = JSON.parse(m.data) } catch { return }
      if (d.id && this.pending.has(d.id)) {
        this.pending.get(d.id).res(d)
        this.pending.delete(d.id)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((r, j) => {
      const t = setTimeout(() => j(new Error('ws connect timeout')), 5000)
      ws.addEventListener('open', () => { clearTimeout(t); r() })
      ws.addEventListener('error', (e) => { clearTimeout(t); j(new Error('ws error')) })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.get(id).rej(new Error(method + ' timeout'))
          this.pending.delete(id)
        }
      }, 10000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.result && r.result.exceptionDetails) {
      const ex = r.result.exceptionDetails
      throw new Error((ex.exception && ex.exception.description) || ex.text || 'eval exception')
    }
    return r.result && r.result.result && r.result.result.value
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

/** Copy bridge sources + seed themes from the packaged app into the home dir. */
function installBridge(bridgeSrcDir, bundledThemesDir) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true })
  fs.mkdirSync(THEMES_DIR, { recursive: true })
  for (const f of ['early.cjs', 'boot.cjs', 'runtime.js', 'shared.cjs', 'perf-tap.js', 'perf-overlay.js']) {
    const src = path.join(bridgeSrcDir, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BRIDGE_DIR, f))
  }
  // Seed bundled themes once per slug; user edits are never overwritten.
  if (fs.existsSync(bundledThemesDir)) {
    for (const slug of fs.readdirSync(bundledThemesDir)) {
      const from = path.join(bundledThemesDir, slug)
      const to = path.join(THEMES_DIR, slug)
      if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue
      fs.cpSync(from, to, { recursive: true })
    }
  }
  return { root: ROOT, bridgeDir: BRIDGE_DIR, themesDir: THEMES_DIR }
}

/** Wait until Freebuff's inspector answers on the given port. */
async function waitForInspector(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      const list = await res.json()
      if (Array.isArray(list) && list.length) return list
    } catch {}
    // Poll tightly: attaching earlier means the bridge is in place before
    // Freebuff paints its launch splash, so the splash is themed from pixel one.
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('Freebuff inspector did not come up on port ' + port)
}

/**
 * Attach the bridge to Freebuff's main process.
 *
 * Retries on purpose: the inspector server answers a beat *before* Freebuff's
 * own main module has loaded, and evaluating then throws (`process.mainModule`
 * is still undefined, measured ~170ms after spawn). Without a retry that one
 * early attempt is the only attempt — the watcher then sees the inspect port
 * up, assumes the bridge is in, and the app stays unthemed. Each retry is
 * cheap and the first successful evaluation wins.
 */
async function attachBridge(port) {
  const list = await waitForInspector(port)
  const target = list.find((t) => t.webSocketDebuggerUrl)
  if (!target) throw new Error('no inspector target')
  const bootSrc = fs.readFileSync(path.join(BRIDGE_DIR, 'boot.cjs'), 'utf8')
  const wrapped =
    ';(function(){' +
    'const require = process.mainModule.require;\n' +
    `const __dirname = ${JSON.stringify(BRIDGE_DIR)};\n` +
    'const module = { exports: {} };\n' +
    bootSrc +
    "\nreturn 'bridge-attached';})()"
  const deadline = Date.now() + 20000
  let lastErr = null
  while (Date.now() < deadline) {
    let cdp = null
    try {
      cdp = await Cdp.connect(target.webSocketDebuggerUrl)
      await cdp.send('Runtime.enable')
      const result = await cdp.evaluate(wrapped)
      cdp.close()
      if (result === 'bridge-attached') return result
      lastErr = new Error('unexpected attach result: ' + result)
    } catch (e) {
      lastErr = e
      if (cdp) cdp.close()
      // Main module not loaded yet, or a mid-boot context reset: retry.
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw lastErr || new Error('attach timed out')
}

/**
 * True when a themed Freebuff is actually live on the inspect port.
 *
 * "The port answers" is not enough: Freebuff is launched with --inspect
 * before the bridge lands, and an attach can still be pending or have failed.
 * Only the boot flag in the live process proves the bridge is installed.
 */
async function isAttached(port) {
  let cdp = null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const list = await res.json()
    const target = Array.isArray(list) && list.find((t) => t.webSocketDebuggerUrl)
    if (!target) return false
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    const alive = await cdp.evaluate('!!globalThis.__FBS_BOOT__')
    return alive === true
  } catch {
    return false
  } finally {
    if (cdp) cdp.close()
  }
}

module.exports = { ROOT, BRIDGE_DIR, THEMES_DIR, installBridge, attachBridge, isAttached }
