/**
 * A tiny CDP client for the Injector's out-of-band tools (BYOK setup and the
 * benchmark runner).
 *
 * Both talk to a bridge-launched Freebuff through its Node inspector on
 * INSPECT_PORT: they evaluate a snippet in the main process, which finds a
 * loopback UI window and runs the real work there (the page holds the
 * orchestrator's launch cookie, so its fetch is authenticated). Nothing is
 * ever written back to the app.
 */
'use strict'

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (m) => {
      let d
      try {
        d = JSON.parse(m.data)
      } catch {
        return
      }
      if (d.id && this.pending.has(d.id)) {
        this.pending.get(d.id).res(d)
        this.pending.delete(d.id)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(t)
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(t)
        reject(new Error('ws error'))
      })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { res: resolve, rej: reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.get(id).rej(new Error(method + ' timeout'))
          this.pending.delete(id)
        }
      }, 30000)
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
    try {
      this.ws.close()
    } catch {}
  }
}

/** Is a bridge-launched Freebuff answering on this inspector port? */
async function isFreebuffInspectorUp(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const list = await res.json()
    return Array.isArray(list) && list.some((t) => t.webSocketDebuggerUrl)
  } catch {
    return false
  }
}

async function connect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  const list = await res.json()
  const target = Array.isArray(list) && list.find((t) => t.webSocketDebuggerUrl)
  if (!target) throw new Error('no Freebuff inspector target on port ' + port)
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  return cdp
}

/**
 * Evaluate an expression in Freebuff's Electron main process (the process the
 * Node inspector is attached to). Used for plain facts like whether an
 * environment variable reached this Freebuff launch.
 */
async function evalInMain(port, expression) {
  let cdp = null
  try {
    cdp = await connect(port)
    return await cdp.evaluate(expression)
  } finally {
    if (cdp) cdp.close()
  }
}

/**
 * Run `script` (a string; promises are awaited) inside a Freebuff UI window.
 * Returns { ok, value } or { ok: false, error }.
 */
async function evalInUi(port, script) {
  // The inspector's evaluation context has no bare `require`; Electron's main
  // module is the supported route to the built-ins (same as attachBridge).
  const wrapped =
    '(function(){' +
    'try{' +
    'const require = process.mainModule.require;' +
    'const { webContents } = require("electron");' +
    'const page = webContents.getAllWebContents().find((c) => {' +
    ' try { return /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?\\//.test(c.getURL()) } catch (e) { return false }' +
    '});' +
    'if (!page) return Promise.resolve({ ok: false, error: "Freebuff is not showing its chat window yet" });' +
    'return page.executeJavaScript(' + JSON.stringify(script) + ', true).then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));' +
    '}catch(e){ return Promise.resolve({ ok: false, error: e && e.message ? e.message : String(e) }) }' +
    '})()'
  let cdp = null
  try {
    cdp = await connect(port)
    const result = await cdp.evaluate(wrapped)
    return result && typeof result === 'object' ? result : { ok: false, error: 'unexpected result' }
  } finally {
    if (cdp) cdp.close()
  }
}

module.exports = { Cdp, connect, evalInUi, evalInMain, isFreebuffInspectorUp }
