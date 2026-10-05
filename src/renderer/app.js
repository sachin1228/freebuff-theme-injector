'use strict'

const $ = (s) => document.querySelector(s)
const toggle = $('#toggle')
const statusLine = $('#statusLine')
const statusText = $('#statusText')
const backdrop = $('#modalBackdrop')
const modalBody = $('#modalBody')

let status = null
let busy = false

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
  renderPerfState()
  renderAdsState()
}

async function refresh() {
  if (busy) return
  status = await window.studio.status()
  render()
}

async function setToggle(wantOn) {
  if (busy) return
  busy = true
  status = { ...status, themed: !wantOn ? status.themed : false, busyNote: wantOn ? 'Restarting Freebuff with themes…' : 'Restarting Freebuff without themes…' }
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

/* ---------- ads panel ---------- */

function renderAdsState() {
  const el = $('#adsState')
  if (!el || !status) return
  if (!status.enabled) {
    el.textContent = 'Themes off — Freebuff untouched'
    el.className = 'pill'
  } else if (status.themed) {
    el.textContent = 'Live in Freebuff'
    el.className = 'pill ok'
  } else {
    el.textContent = 'Waiting for Freebuff'
    el.className = 'pill warn'
  }
}

async function loadAds() {
  try {
    const r = await window.studio.adsGet()
    $('#adsHide').checked = !(r && r.ads && r.ads.hide === false)
  } catch (e) {
    $('#adsHide').checked = true
  }
}

async function saveAds(hide) {
  try {
    await window.studio.adsSet({ hide })
    toast(hide ? 'Ads hidden — Freebuff picks it up live' : 'Ads are back — Freebuff picks it up live')
  } catch (e) {
    toast('Could not save the ads setting', 'err')
  }
}

function wireAds() {
  $('#adsHide').onchange = (e) => saveAds(e.target.checked)
}

/* ---------- performance panel ---------- */

function fmtMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 10000) return (ms / 1000).toFixed(1) + 's'
  return Math.round(ms / 1000) + 's'
}

function renderPerfState() {
  const el = $('#perfState')
  if (!el || !status) return
  if (!status.enabled) {
    el.textContent = 'Themes off — module idle'
    el.className = 'pill'
  } else if (status.themed) {
    el.textContent = 'Live in Freebuff'
    el.className = 'pill ok'
  } else {
    el.textContent = 'Waiting for Freebuff'
    el.className = 'pill warn'
  }
}

async function loadPerf() {
  const r = await window.studio.perfGet()
  const perf = r.perf || {}
  $('#perfOverlay').checked = perf.overlay !== false
  $('#perfEffort').value = perf.effortDefault || ''
  $('#perfNudge').checked = perf.nudge !== false
  $('#perfIdle').value = Math.max(1, Math.round((perf.nudgeIdleMs || 720000) / 60000))
  $('#perfCtx').value = perf.nudgeContextTokens || 40000
}

async function savePerf(patch) {
  try {
    await window.studio.perfSet(patch)
    toast('Performance settings saved — Freebuff picks them up live')
  } catch (e) {
    toast('Could not save performance settings', 'err')
  }
}

function byokLine(kind, text) {
  const line = $('#byokLine')
  line.className = 'status' + (kind ? ' ' + kind : '')
  $('#byokText').textContent = text
}

async function loadByok() {
  byokLine('', 'Checking…')
  let r = null
  try {
    r = await window.studio.byokStatus()
  } catch (e) {
    byokLine('err', 'Could not read provider settings')
    return
  }
  if (!r.keyPresent) {
    byokLine('warn', 'Export DEEPSEEK_API_KEY, restart the Injector from that shell, then set up the connection')
    return
  }
  if (!r.inspectorUp) {
    byokLine('warn', 'Key is visible to the Injector — turn themes on so Freebuff can receive it')
    return
  }
  if (r.connection && r.direct) {
    byokLine('ok', 'Routes to api.deepseek.com · ' + (r.connection.model || 'model') + ' · key visible to Freebuff')
  } else if (r.connection) {
    byokLine('warn', 'A DeepSeek connection exists but does not point at api.deepseek.com')
  } else {
    byokLine('', 'No DeepSeek connection yet — set one up below')
  }
}

function formatBench(r) {
  const lines = []
  lines.push('project  ' + r.projectPath)
  lines.push('prompt   ' + JSON.stringify(r.prompt) + '  (effort ' + r.effort + ', model ' + r.model + ')')
  ;(r.runs || []).forEach((run, i) => {
    if (run.error) {
      lines.push('run ' + (i + 1) + '   error: ' + run.error)
      return
    }
    const compaction = run.compaction
      ? (run.compaction.trigger || 'auto') + ' ' + fmtMs(run.compaction.durationMs)
      : '—'
    lines.push(
      'run ' + (i + 1) + '   ttft ' + fmtMs(run.ttftMs) + ' (' + (run.firstKind || '?') + ')' +
        ' · thinking ' + fmtMs(run.reasoningStartMs) +
        ' · answer ' + fmtMs(run.answerStartMs) +
        ' · tools ' + (run.toolCalls || 0) +
        ' · compaction ' + compaction +
        ' · capacity ' + (run.capacityWaitMs ? fmtMs(run.capacityWaitMs) : '—') +
        ' · total ' + fmtMs(run.totalMs),
    )
    if (run.notice) lines.push('          notice: ' + (run.notice.text || run.notice.notice))
    lines.push('          thread ' + run.threadId + (run.timedOut ? ' (timed out)' : ''))
  })
  return lines.join('\n')
}

function wirePerf() {
  $('#perfOverlay').onchange = (e) => savePerf({ overlay: e.target.checked })
  $('#perfEffort').onchange = (e) => savePerf({ effortDefault: e.target.value })
  $('#perfNudge').onchange = (e) => savePerf({ nudge: e.target.checked })
  $('#perfIdle').onchange = (e) =>
    savePerf({ nudgeIdleMs: Math.max(1, Math.min(60, Number(e.target.value) || 12)) * 60000 })
  $('#perfCtx').onchange = (e) =>
    savePerf({ nudgeContextTokens: Math.max(1000, Number(e.target.value) || 40000) })

  $('#byokCheck').onclick = () => loadByok()
  $('#byokSetup').onclick = async () => {
    const btn = $('#byokSetup')
    btn.disabled = true
    btn.textContent = 'Setting up…'
    try {
      const r = await window.studio.byokSetup()
      if (!r.ok) {
        toast(r.error || 'Could not create the connection', 'err')
      } else {
        toast(r.created ? 'DeepSeek connection created — key stays in DEEPSEEK_API_KEY' : 'A DeepSeek connection already exists')
        if (r.connection) {
          const v = await window.studio.byokValidate()
          const body = v && v.result
          if (v.ok && body && body.ok) toast('DeepSeek answered — the key works')
          else if (v.ok) toast((body && body.message) || 'Saved. Key check failed — see the field hint in Freebuff.', 'err')
        }
      }
    } finally {
      btn.disabled = false
      btn.textContent = 'Set up connection'
      loadByok()
    }
  }

  $('#benchRun').onclick = async () => {
    const btn = $('#benchRun')
    const out = $('#benchOut')
    btn.disabled = true
    btn.textContent = 'Running…'
    out.classList.remove('hidden')
    out.textContent = 'Creating a fresh thread and sending the prompt to Freebuff…'
    try {
      const r = await window.studio.benchRun({
        runs: Number($('#benchRuns').value) || 1,
        effort: $('#benchEffort').value === 'high' ? 'high' : 'low',
      })
      out.textContent = r.ok ? formatBench(r) : r.error || 'Benchmark failed'
    } catch (e) {
      out.textContent = 'Benchmark failed: ' + (e && e.message ? e.message : e)
    } finally {
      btn.disabled = false
      btn.textContent = 'Run in Freebuff'
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  refresh()
  setInterval(refresh, 4000)
  wirePerf()
  wireAds()
  loadPerf()
  loadAds()
  loadByok()
})
