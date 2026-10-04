/**
 * Attach the Freebuff Theme Bridge to a running Freebuff Electron main
 * process through the Node inspector (`--inspect`), then verify the renderer
 * picked it up. This is the same routine the Theme Injector app uses after it
 * launches Freebuff.
 *
 * Usage: node attach-bridge.mjs [--inspect-port 9237] [--cdp-port 9336] [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dflt
}
const INSPECT_PORT = arg('inspect-port', '9237')
const CDP_PORT = arg('cdp-port', '9336')
const BRIDGE_DIR = arg('bridge-dir', path.join(os.homedir(), '.freebuff-theme-studio', 'bridge'))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data)
      if (d.id && this.pending.has(d.id)) {
        const { res } = this.pending.get(d.id)
        this.pending.delete(d.id)
        res(d)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((r, j) => {
      ws.addEventListener('open', r)
      ws.addEventListener('error', j)
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.id
      this.pending.set(id, { res })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval exception')
    }
    return r.result?.result?.value
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

// 1) Attach to the Electron main process via the Node inspector.
const mainList = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json`)).json()
const mainTarget = mainList.find((t) => t.webSocketDebuggerUrl)
if (!mainTarget) throw new Error('no inspector target')
const main = await Cdp.connect(mainTarget.webSocketDebuggerUrl)
await main.send('Runtime.enable')

const bootSrc = fs.readFileSync(path.join(BRIDGE_DIR, 'boot.cjs'), 'utf8')
const wrapped =
  ';(function(){' +
  `const require = process.mainModule.require;\n` +
  `const __dirname = ${JSON.stringify(BRIDGE_DIR)};\n` +
  'const module = { exports: {} };\n' +
  bootSrc +
  "\nreturn 'bridge-attached';})()"
const attachResult = await main.evaluate(wrapped)
console.log('main process:', attachResult)
main.close()

// 2) Find the Freebuff UI page target through the Chromium DevTools port.
const pageList = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const uiPages = pageList.filter(
  (t) => t.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(t.url),
)
if (!uiPages.length) throw new Error('no UI page target yet — is the orchestrator up?')
const page = await Cdp.connect(uiPages[0].webSocketDebuggerUrl)
await page.send('Runtime.enable')

const probe = await page.evaluate(`JSON.stringify({
  btn: !!document.querySelector('.fbs-theme-btn'),
  themes: (window.fbs && window.fbs.themes || []).map(t => t.id),
  rail: !!document.querySelector('.rail'),
})`)
console.log('renderer:', probe)
page.close()
