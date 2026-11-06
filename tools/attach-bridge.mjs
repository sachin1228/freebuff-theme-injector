/**
 * Probe a running Freebuff that was launched by the Theme Injector.
 *
 * Lists every inspectable Freebuff page over the Chromium DevTools Protocol
 * and reports whether the theme runtime is live in it. Injection itself is
 * done by the Injector's main process; this is a read-only support tool.
 *
 * Usage: node tools/attach-bridge.mjs [--port 41731]
 */
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = arg('port', '41731')
const BRIDGE_DIR = arg('bridge-dir', path.join(os.homedir(), '.freebuff-theme-studio', 'bridge'))

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error('CDP answered HTTP ' + res.status)
  return res.json()
}

function isFreebuff(t) {
  if (!t || t.type !== 'page' || typeof t.url !== 'string') return false
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(t.url)
  const splash = t.url.startsWith('data:text/html') && decodeURIComponent(t.url.slice(t.url.indexOf(',') + 1)).includes('sweep')
  if (!loopback && !splash) return false
  return !t.title || /freebuff/i.test(t.title)
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket timeout')), 4000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')) }, { once: true })
  })
  const id = 1
  const result = new Promise((resolve, reject) => {
    ws.addEventListener('message', (m) => {
      try {
        const d = JSON.parse(m.data)
        if (d.id !== id) return
        if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.text || 'eval failed'))
        else resolve(d.result?.result?.value)
      } catch (e) {
        reject(e)
      }
    })
    setTimeout(() => reject(new Error('evaluate timeout')), 5000)
  })
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  try {
    return await result
  } finally {
    try { ws.close() } catch {}
  }
}

let list
try {
  list = await targets()
} catch (e) {
  console.error(`Freebuff is not answering on the debug port ${PORT}.`)
  console.error('Start it from the Theme Injector (switch on), or pass --port.')
  console.error(String(e && e.message))
  process.exit(1)
}

const pages = list.filter(isFreebuff)
if (!pages.length) {
  console.error(`No Freebuff page targets on port ${PORT} yet — the app may still be starting.`)
  process.exit(1)
}

console.log(`runtime: ${path.join(BRIDGE_DIR, 'runtime.js')}`)
for (const page of pages) {
  const title = page.title || '(no title)'
  let state = 'unreachable'
  try {
    const probe = await evaluate(
      page.webSocketDebuggerUrl,
      'JSON.stringify({attached: !!window.__FBS_ATTACHED__, installed: !!window.__FBS_INSTALL__, version: window.__FBS_VERSION__ || null, theme: document.documentElement.getAttribute("data-fbs-theme")})',
    )
    const info = JSON.parse(probe)
    state = info.attached ? `themed (runtime v${info.version || '?'}, theme ${info.theme || 'default'})` : 'not themed'
  } catch (e) {
    state = 'probe failed: ' + (e && e.message)
  }
  console.log(`- ${title}  ${page.url.slice(0, 90)}  ->  ${state}`)
}
