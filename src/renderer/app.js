'use strict'

const $ = (s) => document.querySelector(s)
const openBtn = $('#openBtn')
const statusLine = $('#statusLine')
const statusText = $('#statusText')

let status = null
let busy = false

function toast(msg, kind) {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'toast' + (kind === 'err' ? ' err' : '')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3600)
}

function render() {
  if (!status) return
  const working = busy || status.busy
  const ready = !!status.exe

  openBtn.disabled = working || !ready
  openBtn.textContent = working
    ? 'Opening…'
    : status.themed
      ? 'Focus Freebuff'
      : 'Open themed Freebuff'

  let cls = 'status'
  let txt
  if (!ready) {
    cls += ' err'
    txt = 'Freebuff is not installed — get it from freebuff.com first'
  } else if (working) {
    cls += ' warn'
    txt = 'Preparing the patched copy and opening Freebuff…'
  } else if (status.themed) {
    cls += ' ok'
    txt = 'Freebuff is open — themed, ad-free, and pinned'
  } else if (status.running) {
    txt = 'Freebuff is open unthemed — this replaces it with the patched copy'
  } else if (status.copyReady) {
    txt = 'Ready — opens the patched copy of Freebuff'
  } else {
    txt = 'Ready — builds the patched copy on first open'
  }
  statusLine.className = cls
  statusText.textContent = txt
}

async function refresh() {
  if (busy) return
  status = await window.studio.status()
  render()
}

openBtn.onclick = async () => {
  if (busy || !status || !status.exe) return
  busy = true
  render()
  try {
    const r = await window.studio.open()
    if (!r || !r.ok) toast((r && r.error) || 'Could not open Freebuff', 'err')
    else if (r.note) toast(r.note)
  } catch {
    toast('Could not open Freebuff', 'err')
  } finally {
    busy = false
    status = await window.studio.status()
    render()
  }
}

window.addEventListener('DOMContentLoaded', () => {
  refresh()
  setInterval(refresh, 3000)
})
