'use strict'

const $ = (s) => document.querySelector(s)
const toggle = $('#toggle')
const statusLine = $('#statusLine')
const statusText = $('#statusText')
const adsToggle = $('#adsToggle')
const adsLine = $('#adsLine')
const adsText = $('#adsText')
const backdrop = $('#modalBackdrop')
const modalBody = $('#modalBody')

let status = null
let busy = false
let adsBusy = false

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function toast(msg, kind) {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'toast' + (kind === 'err' ? ' err' : '')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3600)
}

function confirmDialog(title, sub, onYes, yesLabel) {
  modalBody.innerHTML = `
    <h3>${esc(title)}</h3>
    <p>${esc(sub)}</p>
    <div class="modal-actions">
      <button class="btn" data-x="cancel">Cancel</button>
      <button class="btn primary" data-x="yes">${esc(yesLabel)}</button>
    </div>`
  backdrop.classList.remove('hidden')
  modalBody.querySelector('[data-x="cancel"]').onclick = () => backdrop.classList.add('hidden')
  modalBody.querySelector('[data-x="yes"]').onclick = () => {
    backdrop.classList.add('hidden')
    onYes()
  }
}

function render() {
  if (!status) return
  const on = !!(status.enabled != null ? status.enabled : status.themed)
  toggle.setAttribute('aria-checked', on ? 'true' : 'false')
  toggle.disabled = busy || !status.exe
  let cls = 'status'
  let txt
  if (!status.exe) {
    cls += ' err'
    txt = 'Freebuff is not installed — get it from freebuff.com first'
  } else if (busy) {
    cls += ' warn'
    txt = status.busyNote || 'Working…'
  } else if (status.enabled && status.themed) {
    cls += ' ok'
    txt = 'On — themes stay on automatically, even after Freebuff updates'
  } else if (status.enabled) {
    cls += ' ok'
    txt = 'On — Theme Injector is watching Freebuff; it comes back themed on its own'
  } else if (status.running) {
    txt = 'Off — Freebuff is open; turning on restarts it once with themes'
  } else {
    txt = 'Off — turning on launches Freebuff with themes'
  }
  statusLine.className = cls
  statusText.textContent = txt

  // Ads hide with or without a theme; the switch lives next to the theme one.
  const hideAds = status.hideAds !== false
  adsToggle.setAttribute('aria-checked', hideAds ? 'true' : 'false')
  adsToggle.disabled = adsBusy || !status.exe
  // With the injector off nothing is applied, so say so instead of claiming
  // the ads are already hidden.
  adsLine.className = 'status' + (hideAds && status.enabled ? ' ok' : '')
  adsText.textContent = hideAds
    ? status.enabled
      ? 'On — sponsored cards, banners and breaks are hidden'
      : 'On — applies when the injector is on'
    : 'Off — Freebuff shows its sponsored placements'
}

async function refresh() {
  if (busy) return
  status = await window.studio.status()
  render()
}

async function setToggle(wantOn) {
  if (busy) return
  busy = true
  status = {
    ...status,
    themed: !wantOn ? status.themed : false,
    busyNote: wantOn ? 'Preparing themed Freebuff and restarting it…' : 'Restarting Freebuff without themes…',
  }
  render()
  try {
    const r = wantOn ? await window.studio.enable() : await window.studio.disable()
    if (!r.ok) toast(r.error || 'Something went wrong', 'err')
    else if (r.note) toast(r.note)
    else if (wantOn) toast('Themes are on — click the palette button in Freebuff’s left sidebar')
    else toast('Themes are off — Freebuff relaunched as usual')
  } finally {
    busy = false
    status = await window.studio.status()
    render()
  }
}

adsToggle.onclick = async () => {
  if (!status || adsBusy) return
  const want = adsToggle.getAttribute('aria-checked') !== 'true'
  adsBusy = true
  status = { ...status, hideAds: want }
  render()
  try {
    const r = await window.studio.setAds(want)
    if (!r || !r.ok) {
      status.hideAds = !want
      toast((r && r.error) || 'Could not change the ad setting', 'err')
    } else {
      toast(want ? 'Ads hidden — sponsored placements are gone' : 'Ads are back in Freebuff')
    }
  } catch {
    status.hideAds = !want
    toast('Could not change the ad setting', 'err')
  } finally {
    adsBusy = false
    status = await window.studio.status()
    render()
  }
}

toggle.onclick = () => {
  if (!status || busy) return
  const wantOn = toggle.getAttribute('aria-checked') !== 'true'
  if (wantOn && status.running && !status.themed) {
    confirmDialog(
      'Freebuff needs one restart',
      'Turning themes on closes Freebuff and opens it again with the theme button. Nothing is lost — your chats and projects come right back.',
      () => setToggle(true),
      'Restart with themes',
    )
    return
  }
  if (!wantOn && (status.themed || status.enabled)) {
    confirmDialog(
      'Turn themes off?',
      status.themed
        ? 'Freebuff will restart once without the palette button.'
        : 'Theme Injector will stop keeping Freebuff themed.',
      () => setToggle(false),
      status.themed ? 'Restart without themes' : 'Turn off',
    )
    return
  }
  setToggle(wantOn)
}

window.addEventListener('DOMContentLoaded', () => {
  refresh()
  setInterval(refresh, 4000)
})
