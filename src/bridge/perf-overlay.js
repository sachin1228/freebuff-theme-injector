/**
 * Freebuff Performance Overlay — the panel that renders the timings recorded
 * by perf-tap.js inside Freebuff's UI window.
 *
 * boot.cjs injects this file (main world) whenever the Theme Injector's
 * performance module is on. It is idempotent: a re-install only refreshes the
 * config and re-renders. Turning the overlay off in the Injector removes the
 * panel on the next bridge push.
 *
 * The panel is plain DOM on purpose: Freebuff's React tree is none of our
 * business, and a fixed, themed little card keeps the risk to zero. It reads
 * window.__FBS_PERF__ (the tap) and never calls into the app.
 */
;(function () {
  'use strict'

  var STYLE_ID = 'fbs-perf-style'
  var ROOT_ID = 'fbs-perf-root'
  var LS_OPEN = 'fbs.perf.open'
  var TICK_MS = 500

  var CONFIG = window.__FBS_PERF_CONFIG__ || {}

  function perf() {
    return window.__FBS_PERF__ || null
  }

  function style() {
    var el = document.getElementById(STYLE_ID)
    if (el) return el
    el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = [
      '#fbs-perf-root{position:fixed;right:14px;bottom:14px;z-index:2147482999;',
      ' font-family:var(--font-sans,system-ui);font-size:var(--font-size-ui,12px);color:var(--text);',
      ' -webkit-app-region:no-drag}',
      '.fbs-perf-pill{display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer;',
      ' border:1px solid var(--border);border-radius:999px;background:var(--popover,var(--surface));',
      ' box-shadow:0 8px 30px rgb(0 0 0 / 30%)}',
      '.fbs-perf-pill:hover{background:var(--control-bg-hover,var(--raised))}',
      '.fbs-perf-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--brand);flex:0 0 auto}',
      '.fbs-perf-pill.idle .dot{background:var(--faint,var(--muted))}',
      '.fbs-perf-pill .badge{background:var(--warning-text,var(--brand));color:var(--bg);border-radius:999px;',
      ' padding:0 6px;font-size:10px;line-height:16px}',
      '.fbs-perf-card{width:340px;max-height:62vh;display:flex;flex-direction:column;overflow:hidden;',
      ' border:1px solid var(--border);border-radius:var(--radius-popup,14px);background:var(--popover,var(--surface));',
      ' box-shadow:0 18px 60px rgb(0 0 0 / 35%)}',
      '.fbs-perf-head{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--border)}',
      '.fbs-perf-head strong{flex:1 1 auto;font-weight:600}',
      '.fbs-perf-head button{cursor:pointer;border:0;background:transparent;color:var(--muted);font:inherit}',
      '.fbs-perf-head button:hover{color:var(--text)}',
      '.fbs-perf-body{overflow:auto;padding:8px 11px 11px}',
      '.fbs-perf-turn{border:1px solid var(--border);border-radius:var(--radius-md,8px);padding:7px 9px;margin-bottom:6px}',
      '.fbs-perf-turn.live{border-color:var(--brand)}',
      '.fbs-perf-turn .top{display:flex;align-items:center;gap:6px;margin-bottom:4px}',
      '.fbs-perf-turn .top .id{font-family:var(--font-mono,ui-monospace,monospace);color:var(--muted)}',
      '.fbs-perf-turn .chip{border:1px solid var(--border);border-radius:999px;padding:0 6px;font-size:10px;color:var(--muted)}',
      '.fbs-perf-grid{display:grid;grid-template-columns:auto 1fr;gap:1px 10px}',
      '.fbs-perf-grid .k{color:var(--muted)}',
      '.fbs-perf-grid .v{text-align:right;font-variant-numeric:tabular-nums}',
      '.fbs-perf-grid .v.hot{color:var(--warning-text,#e5a34a)}',
      '.fbs-perf-note{margin:2px 0 8px;padding:7px 9px;border:1px solid var(--border);border-radius:var(--radius-md,8px);',
      ' background:color-mix(in srgb,var(--warning-text,var(--brand)) 12%,transparent)}',
      '.fbs-perf-note b{display:block;margin-bottom:2px}',
      '.fbs-perf-note button{margin-top:6px;cursor:pointer;border:1px solid var(--border);border-radius:var(--radius-md,8px);',
      ' background:var(--control-bg,var(--surface-2));color:var(--text);font:inherit;padding:3px 9px}',
      '.fbs-perf-note button:hover{background:var(--control-bg-hover,var(--raised))}',
      '.fbs-perf-warn{margin-top:5px;color:var(--warning-text,#e5a34a);font-size:10.5px;line-height:1.4}',
      '.fbs-perf-empty{color:var(--muted);padding:4px 0 8px}',
      '.fbs-perf-foot{padding:0 11px 9px;color:var(--faint,var(--muted));font-size:10px}',
    ].join('')
    document.head.appendChild(el)
    return el
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fmtMs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return Math.round(ms) + 'ms'
    if (ms < 10000) return (ms / 1000).toFixed(1) + 's'
    return Math.round(ms / 1000) + 's'
  }

  function fmtTokens(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—'
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + 'k'
    return String(Math.round(n))
  }

  function fmtIdle(ms) {
    var m = Math.floor(ms / 60000)
    if (m < 60) return m + 'm'
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
  }

  function shortId(id) {
    return String(id || '').slice(-6)
  }

  function isOpen() {
    try {
      return localStorage.getItem(LS_OPEN) !== '0'
    } catch (e) {
      return true
    }
  }

  function setOpen(open) {
    try {
      localStorage.setItem(LS_OPEN, open ? '1' : '0')
    } catch (e) {}
    render()
  }

  function turnCard(view) {
    var live = !view.ended
    var compaction = view.compaction
    var compactionMs = null
    if (compaction && typeof compaction.durationMs === 'number') compactionMs = compaction.durationMs
    else if (compaction && compaction.at && view.compactionStartedAt) compactionMs = compaction.at - view.compactionStartedAt
    var rows = [
      ['TTFT', fmtMs(view.ttftMs), view.firstKind],
      ['thinking', fmtMs(view.reasoningStartMs)],
      ['answer', fmtMs(view.answerStartMs)],
      ['tools', view.toolCalls ? view.toolCalls + ' · first ' + fmtMs(view.toolStartMs) : '—'],
      ['compaction', compaction
        ? (compactionMs !== null ? fmtMs(compactionMs) : 'done') +
          ' · ' + (compaction.trigger || 'auto')
        : '—',
        compaction && (compaction.preTokens || compaction.postTokens)
          ? fmtTokens(compaction.preTokens) + ' → ' + fmtTokens(compaction.postTokens)
          : null],
      ['capacity wait', view.capacityWaitMs ? fmtMs(view.capacityWaitMs) : '—', view.capacityWaitMs ? 'hot' : null],
      ['context', view.contextTokens !== null
        ? fmtTokens(view.contextTokens) + (view.compactionThresholdTokens ? ' / ' + fmtTokens(view.compactionThresholdTokens) : '')
        : '—'],
      ['total', fmtMs(view.elapsedMs), live ? 'hot' : null],
    ]
    var grid = rows
      .filter(function (r) { return !(r[0] === 'tools' && r[1] === '—') })
      .map(function (r) {
        var cls = r[2] && r[2] !== 'hot' ? r[2] : ''
        var hot = r[2] === 'hot' ? ' hot' : ''
        return (
          '<span class="k">' + esc(r[0]) + (r[2] && r[2] !== 'hot' ? ' · ' + esc(r[2]) : '') + '</span>' +
          '<span class="v' + hot + '">' + esc(r[1]) + '</span>'
        )
      })
      .join('')
    return (
      '<div class="fbs-perf-turn' + (live ? ' live' : '') + '">' +
      '<div class="top"><span class="id">' + esc(shortId(view.threadId)) + '</span>' +
      (view.model ? '<span class="chip">' + esc(String(view.model).split('/').pop()) + '</span>' : '') +
      (view.effort ? '<span class="chip">effort ' + esc(view.effort) + '</span>' : '') +
      (live ? '<span class="chip">running</span>' : '') +
      '</div>' +
      '<div class="fbs-perf-grid">' + grid + '</div>' +
      (view.notice
        ? '<div class="fbs-perf-warn">' + esc(view.notice.text || view.notice.notice) + '</div>'
        : '') +
      '</div>'
    )
  }

  function nudgeCard(nudge) {
    return (
      '<div class="fbs-perf-note">' +
      '<b>Compaction likely on your next message</b>' +
      'Thread idle ' + esc(fmtIdle(nudge.idleMs)) + ' with ' + esc(fmtTokens(nudge.contextTokens)) +
      ' tokens of context — Freebuff compacts idle DeepSeek Flash threads. ' +
      'Compact now to pay it while you wait, not mid-message.' +
      '<br><button data-fbs-compact="' + esc(nudge.threadId) + '">Compact this thread now</button>' +
      '</div>'
    )
  }

  function paint() {
    var root = document.getElementById(ROOT_ID)
    var P = perf()
    if (!root || !P) return
    var open = isOpen()
    var turns = P.turns() || []
    var running = turns.some(function (t) { return !t.ended })
    var nudges = P.nudges() || []

    if (!CONFIG.overlay) {
      root.innerHTML = ''
      root.style.display = 'none'
      return
    }
    root.style.display = ''

    if (!open) {
      root.innerHTML =
        '<div class="fbs-perf-pill' + (running ? '' : ' idle') + '" data-fbs-toggle="1" role="button" tabindex="0"' +
        ' title="Freebuff turn timings">' +
        '<span class="dot"></span><span>Perf</span>' +
        (nudges.length ? '<span class="badge">' + nudges.length + '</span>' : '') +
        '</div>'
      return
    }

    root.innerHTML =
      '<div class="fbs-perf-card">' +
      '<div class="fbs-perf-head"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:' +
      (running ? 'var(--brand)' : 'var(--faint,var(--muted))') + '"></span>' +
      '<strong>Freebuff performance</strong>' +
      '<button data-fbs-toggle="1" title="Collapse">–</button>' +
      '</div>' +
      '<div class="fbs-perf-body">' +
      (nudges.length ? nudges.slice(0, 2).map(nudgeCard).join('') : '') +
      (turns.length ? turns.slice(0, 8).map(turnCard).join('') : '<div class="fbs-perf-empty">No turns measured yet.</div>') +
      '</div>' +
      '<div class="fbs-perf-foot">Timings from Freebuff\'s own event stream. TTFT = send → first model activity.</div>' +
      '</div>'

    var compactBtn = root.querySelector('[data-fbs-compact]')
    if (compactBtn) {
      compactBtn.onclick = function () {
        var id = compactBtn.getAttribute('data-fbs-compact')
        compactBtn.disabled = true
        compactBtn.textContent = 'Compacting…'
        Promise.resolve(P.compactNow(id)).then(
          function () { render() },
          function () { compactBtn.disabled = false; compactBtn.textContent = 'Compact failed — retry' },
        )
      }
    }
  }

  function render() {
    style()
    var root = document.getElementById(ROOT_ID)
    if (!root) {
      root = document.createElement('div')
      root.id = ROOT_ID
      document.documentElement.appendChild(root)
      root.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-fbs-toggle]') : null
        if (el) setOpen(!isOpen())
      })
      root.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute('data-fbs-toggle')) {
          e.preventDefault()
          setOpen(!isOpen())
        }
      })
    }
    paint()
  }

  var tick = null
  function startTicker() {
    if (tick) return
    tick = setInterval(function () {
      var root = document.getElementById(ROOT_ID)
      if (!root) return
      if (document.hidden) return
      paint()
    }, TICK_MS)
  }

  function install(config) {
    if (config && typeof config === 'object') CONFIG = Object.assign({}, CONFIG, config)
    var P = perf()
    if (P && typeof P.setConfig === 'function') P.setConfig(CONFIG)
    if (!CONFIG.enabled || !CONFIG.overlay) {
      var gone = document.getElementById(ROOT_ID)
      if (gone) gone.remove()
      return
    }
    render()
    startTicker()
    if (P && typeof P.subscribe === 'function') {
      if (!install._sub) {
        install._sub = P.subscribe(function () {
          var root = document.getElementById(ROOT_ID)
          if (root && !document.hidden) paint()
        })
      }
    }
  }

  window.__FBS_PERF_UI_INSTALL__ = install
})()
