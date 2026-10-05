/**
 * Freebuff Theme Bridge — renderer runtime.
 *
 * Executed inside Freebuff's UI window by boot.cjs. It:
 *  - Verifies it is running inside Freebuff's own UI document (the shell's
 *    left icon rail, or the pre-login loading / welcome screens) and stays
 *    completely inert anywhere else.
 *  - Applies the theme + font tokens to every app document, so the splash,
 *    the welcome screen and the shell all paint in the active palette.
 *  - Hides Freebuff's sponsored placements when the bridge's hideAds setting
 *    is on — the "Ad" cards in the chat, the composer placements and the
 *    full-content sponsor break. Stands alone: it hides with no theme too.
 *  - Adds a "Themes" palette button to the bottom of the rail.
 *  - Opens a picker: theme rows plus a font dropdown (system / Inter /
 *    Geist, the latter two streamed from Google Fonts). Choices persist in
 *    localStorage and re-apply on every launch.
 *  - Re-installs idempotently when the bridge pushes live updates
 *    (window.__FBS_INSTALL__ is called again after file changes).
 */
;(function () {
  'use strict'
  var LS_ACTIVE = 'fbs.theme.active'
  var LS_FONT = 'fbs.font'
  var STYLE_ID = 'fbs-theme-style'
  var FONT_STYLE_ID = 'fbs-font-style'
  var ADS_STYLE_ID = 'fbs-ads-style'
  var UI_ID = 'fbs-theme-ui'
  var NS = 'fbs'

  /* Freebuff's own font stack, captured from the app's :root declaration.
     The "Freebuff default" font option forces it back on — themes may claim
     --font-sans, so restoring it needs an explicit value. Inter and Geist are
     pulled from Google Fonts on demand — nothing is installed on disk, and
     the fallback stack keeps the UI intact offline. */
  var FONTS = [
    { id: '', name: 'System default', family: null, href: null },
    {
      id: 'freebuff',
      name: 'Freebuff default',
      family: '"Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
      href: null,
    },
    {
      id: 'inter',
      name: 'Inter',
      family: 'Inter',
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    },
    {
      id: 'geist',
      name: 'Geist',
      family: 'Geist',
      href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap',
    },
  ]
  var FONT_FALLBACK = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"

  function cssEscape(s) {
    return String(s).replace(/[^a-z0-9_-]/gi, '\\$&')
  }

  function textSafe(s) {
    return String(s).replace(/[<>&]/g, '')
  }

  function state() {
    return (window[NS] = window[NS] || { themes: [], installed: false, attached: false })
  }

  /* ---------- theme application ---------- */

  function activeStyleEl() {
    var el = document.getElementById(STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
      document.head.appendChild(el)
    }
    return el
  }

  function findTheme(id) {
    var themes = state().themes || []
    for (var i = 0; i < themes.length; i++) if (themes[i].id === id) return themes[i]
    return null
  }

  /* Freebuff "paints" rounded elements (count badges, composer box, tabs,
     streak banner…) by baking their computed background into an inline SVG
     data URL. The app's own observer re-bakes an element when its class,
     style or a handful of attributes change — but a theme swap only mutates
     CSS custom properties, so baked colors go stale. Their observer treats
     any mutation on <html> as "re-measure everything", so touching an
     inline custom property on documentElement forces a full repaint. */
  function repaintSquircles() {
    try {
      var d = document.documentElement
      var stamp = 'fbs-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
      d.style.setProperty('--fbs-repaint', stamp)
      // Second pass next frame: elements whose layout settles late.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          try { d.style.setProperty('--fbs-repaint', stamp + '-2') } catch {}
        })
      }
    } catch {}
  }

  /* Freebuff's Settings pages define their own "neutral" control tokens
     (--settings-neutral etc.) with hardcoded light-gray values that ignore
     the active theme — so secondary buttons, quiet icon buttons (+, ↻) and
     switches stay off-palette. Map them onto the theme's own tokens; the
     !important declarations win regardless of where the app scoped them. */
  var BRIDGE_CSS = [
    ':root, :root[data-theme], :root[data-theme] .settings-page, :root[data-theme] .modal {',
    ' --settings-neutral: var(--control-bg, var(--surface-2)) !important;',
    ' --settings-neutral-hover: var(--raised) !important;',
    ' --settings-neutral-ink: var(--text) !important;',
    ' --settings-disabled: var(--surface-2) !important;',
    ' --settings-disabled-ink: var(--faint) !important;',
    ' --settings-switch-track: var(--raised) !important;',
    '}',
    /* Freebuff's sidebar paints every label with --sidebar-ink, which defaults
       to a theme's full-strength --text. Pull it a little toward the theme's
       own canvas so the rail reads softer without going grey. */
    ':root[data-fbs-theme] .project-sidebar {',
    ' --sidebar-ink: color-mix(in srgb, var(--text) 84%, var(--bg)) !important;',
    '}',
    /* Toggle switches: the app hardcodes the knob to #fff and fills the "on"
       track with --brand, so a monochrome theme (white brand) collapses the
       whole pill into one white blob. Route both states through optional
       theme tokens — a theme that lights up --switch-track-on also gets to
       darken --switch-thumb-on against it. */
    ':root[data-fbs-theme] :is(.settings-page,.modal) :is(.settings-toggle-thumb,.mcp-switch-thumb) {',
    ' background: var(--switch-thumb-off, #fff) !important;',
    '}',
    ':root[data-fbs-theme] :is(.settings-page,.modal) :is(.settings-switch[aria-checked=true] .settings-toggle-track,.mcp-switch[aria-checked=true]) {',
    ' background: var(--switch-track-on, var(--brand)) !important;',
    '}',
    ':root[data-fbs-theme] :is(.settings-page,.modal) :is(.settings-switch[aria-checked=true] .settings-toggle-thumb,.mcp-switch[aria-checked=true] .mcp-switch-thumb) {',
    ' background: var(--switch-thumb-on, #fff) !important;',
    '}',
    /* Launch + sign-in surfaces. The welcome screen is plain token-driven React
       (.splash-*) except for the aurora photo behind it, which the app bakes
       green with a fixed hue-rotate/saturate pair. Re-point that filter at the
       theme's own brand hue (computed per theme in splashTintCss) and let the
       theme canvas read through for monochrome brands. */
    ':root[data-fbs-theme] .splash-background::before {',
    ' background-color: var(--bg) !important;',
    ' filter: hue-rotate(var(--fbs-splash-hue, 0deg)) saturate(var(--fbs-splash-sat, 0.55))',
    '  brightness(var(--fbs-splash-bright, 1.08)) !important;',
    ' opacity: var(--fbs-splash-opacity, 1) !important;',
    '}',
    // Same treatment for the mark: the app inverts it for its own light theme.
    ':root[data-fbs-theme] :is(.splash-logo,.loading-screen-logo) {',
    ' filter: var(--fbs-logo-filter, none) !important;',
    '}',
  ].join('\n')

  /* Freebuff's sponsored surfaces: the "Ad"-badged cards in the chat stream and
     at the thread bottom, the composer / skill-picker placements, and the
     full-content sponsor break. CSS-only hiding leaves the app's own ad DOM in
     place, so its observers and store keep working — only paint changes, and the
     placement simply never renders. Separate from the theme: this rides
     state.json's hideAds switch. KEEP-IN-SYNC with shared.cjs (ADS_CSS). */
  var ADS_CSS = [
    // Marker: lets dropPreloadSheets recognise the generated preload's adopted
    // sheet even when no theme CSS is in there to carry a --fbs- token.
    ':root { --fbs-ads: 1; }',
    '.sponsored-ad, .ad-banner, .ad-card, .partner-placement, .ad-showcase {',
    ' display: none !important;',
    '}',
  ].join('\n')

  /* ---------- launch-screen tinting ---------- */

  /* Resolve a custom property out of a theme's own CSS, following var() hops
     so `--bg: var(--workspace-surface)` still yields a literal color. */
  function tokenValue(css, name, hops) {
    if (hops > 3) return null
    var m = new RegExp('--' + name + '\\s*:\\s*([^;}]+)').exec(css)
    if (!m) return null
    // Theme files write `--brand: #1db954 !important;` — strip the flag before
    // anything tries to read the value as a color or a var() reference.
    var v = m[1].trim().replace(/!important\s*$/i, '').trim()
    var vm = /^var\(\s*--([a-z0-9-]+)/i.exec(v)
    if (vm) return tokenValue(css, vm[1], hops + 1)
    return v
  }

  function hexToHsl(hex) {
    var m = /^#([0-9a-f]{3,8})$/i.exec(String(hex).trim())
    if (!m) return null
    var s = m[1]
    if (s.length === 3 || s.length === 4) s = s.replace(/./g, function (c) { return c + c })
    if (s.length < 6) return null
    var r = parseInt(s.slice(0, 2), 16) / 255
    var g = parseInt(s.slice(2, 4), 16) / 255
    var b = parseInt(s.slice(4, 6), 16) / 255
    var max = Math.max(r, g, b)
    var min = Math.min(r, g, b)
    var d = max - min
    var l = (max + min) / 2
    var h = 0
    if (d) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h = Math.round(h * 60)
      if (h < 0) h += 360
    }
    var sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    return { h: h, s: sat, l: l }
  }

  // The bundled aurora is a sage/green wash; the app's own dark filter leaves it
  // sitting at roughly this hue, so rotating by (brand - SPLASH_BASE_HUE) lands
  // the photo on the theme's accent.
  var SPLASH_BASE_HUE = 95

  function splashTintCss(theme) {
    if (!theme) return ''
    var css = theme.css || ''
    var names = ['brand-2', 'brand', 'brand-1', 'brand-3', 'primary-action', 'accent']
    var picked = null
    for (var i = 0; i < names.length && !picked; i++) {
      var raw = tokenValue(css, names[i], 0)
      var hsl = raw && hexToHsl(raw)
      if (hsl && hsl.s >= 0.18) picked = hsl
    }
    var light = theme.mode === 'light'
    if (!picked) {
      // Monochrome brand (Uber, Vercel): drain the photo instead of faking a hue.
      return (
        ':root { --fbs-splash-hue: 0deg; --fbs-splash-sat: 0.06;' +
        ' --fbs-splash-bright: ' + (light ? '1.12' : '0.92') + '; --fbs-splash-opacity: 0.55; }'
      )
    }
    var rot = ((picked.h - SPLASH_BASE_HUE + 540) % 360) - 180
    var sat = Math.max(0.4, Math.min(0.95, picked.s * 0.75)).toFixed(2)
    var bright = light ? '1.06' : '1.08'
    var filter = light ? 'invert(1) brightness(1.6)' : 'none'
    return (
      ':root { --fbs-splash-hue: ' + rot + 'deg; --fbs-splash-sat: ' + sat + ';' +
      ' --fbs-splash-bright: ' + bright + '; --fbs-splash-opacity: 1;' +
      ' --fbs-logo-filter: ' + filter + '; }'
    )
  }


  function applyTheme(id) {
    var theme = id ? findTheme(id) : null
    var el = activeStyleEl()
    document.head.appendChild(el) // move to end so equal-specificity rules win
    el.textContent = theme ? theme.css + '\n' + BRIDGE_CSS + '\n' + splashTintCss(theme) + '\n' : ''
    if (theme) document.documentElement.setAttribute('data-fbs-theme', theme.id)
    else document.documentElement.removeAttribute('data-fbs-theme')
    try {
      if (id) localStorage.setItem(LS_ACTIVE, id)
      else localStorage.removeItem(LS_ACTIVE)
    } catch {}
    refreshPicker()
    repaintSquircles()
  }

  function storedActive() {
    try {
      return localStorage.getItem(LS_ACTIVE) || null
    } catch {
      return null
    }
  }

  /* ---------- font application ---------- */

  function findFont(id) {
    for (var i = 0; i < FONTS.length; i++) if (FONTS[i].id === id) return FONTS[i]
    return FONTS[0]
  }

  function fontStyleEl() {
    var el = document.getElementById(FONT_STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = FONT_STYLE_ID
      document.head.appendChild(el)
    }
    return el
  }

  function storedFont() {
    try {
      return localStorage.getItem(LS_FONT) || ''
    } catch {
      return ''
    }
  }

  function noteFontFail(f) {
    if (storedFont() !== f.id) return
    state().fontNote = 'Couldn’t load ' + f.name + ' — using the system default.'
    applyFont('', true)
  }

  function fontLink(f) {
    var id = 'fbs-font-' + f.id
    var el = document.getElementById(id)
    if (el) return el
    el = document.createElement('link')
    el.id = id
    el.rel = 'stylesheet'
    el.href = f.href
    el.addEventListener('error', function () {
      noteFontFail(f)
    })
    document.head.appendChild(el)
    return el
  }

  /* --font-sans drives every label in Freebuff (mono/code keeps its own
     token). It is declared on :root by the app *and* by themes, so the
     override needs !important plus a late style element. */
  function applyFont(id, keepNote) {
    var f = findFont(id)
    if (!keepNote) state().fontNote = ''
    var el = fontStyleEl()
    if (f.family) {
      // A single family gets quoted and stacked on the fallback; a full
      // stack (comma inside) is Freebuff's own — insert it raw.
      if (f.href) fontLink(f)
      var value =
        f.family.indexOf(',') !== -1 ? f.family : "'" + f.family + "', " + FONT_FALLBACK
      el.textContent =
        ':root, :root[data-theme], :root[data-theme=dark], :root[data-theme=light] {' +
        '--font-sans: ' + value + ' !important; }'
    } else {
      el.textContent = ''
    }
    try {
      if (f.id) localStorage.setItem(LS_FONT, f.id)
      else localStorage.removeItem(LS_FONT)
    } catch {}
    refreshPicker()
    repaintSquircles() // new metrics change element sizes
  }

  /* ---------- sponsored placements ---------- */

  function adsStyleEl() {
    var el = document.getElementById(ADS_STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = ADS_STYLE_ID
      document.head.appendChild(el)
    }
    return el
  }

  /* The bridge's own switch, independent of the theme: ads hide whether or
     not one is active. An absent setting means the bridge shipped it without
     one — the default is on. */
  function applyAds(hide) {
    var el = adsStyleEl()
    document.head.appendChild(el) // move to end so equal-specificity rules win
    el.textContent = hide === false ? '' : ADS_CSS
  }

  /* ---------- chrome (button + panel) ---------- */

  function baseCss() {
    return [
      '.fbs-theme-btn{cursor:pointer}',
      '.fbs-theme-btn:hover{color:var(--text)}',
      '.fbs-theme-btn.fbs-on{color:var(--text);background:color-mix(in srgb,var(--text) 14%,transparent)}',
      '.fbs-panel{position:fixed;z-index:2147483000;width:300px;max-height:520px;box-sizing:border-box;',
      ' display:flex;flex-direction:column;overflow:hidden;',
      ' border:1px solid var(--border);border-radius:var(--radius-popup,18px);',
      ' background:var(--popover,var(--surface));color:var(--text);',
      ' box-shadow:0 18px 60px rgb(0 0 0 / 35%);padding:12px;font-family:var(--font-sans,system-ui);',
      ' -webkit-app-region:no-drag}',
      // Theme rows scroll; the font control stays pinned at the bottom.
      '.fbs-list{flex:1 1 auto;min-height:0;overflow:auto}',
      '.fbs-foot{flex:0 0 auto;margin-top:8px;padding-top:10px;border-top:1px solid var(--border)}',
      '.fbs-panel h3{margin:0 0 2px;font-size:var(--font-size-title,15px);font-weight:var(--font-weight-semibold,600)}',
      '.fbs-panel .fbs-sub{margin:0 0 8px;font-size:var(--font-size-ui,12px);color:var(--muted)}',
      '.fbs-row{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;padding:4px 9px;',
      ' margin-bottom:3px;border:1px solid var(--border);border-radius:var(--radius-md,8px);background:transparent;',
      ' color:var(--text);font:inherit;font-size:var(--font-size-body,13px);text-align:left;cursor:pointer}',
      '.fbs-row:hover{background:var(--control-bg-hover,rgb(255 255 255 / 5%))}',
      '.fbs-row.fbs-sel{border-color:var(--brand);background:var(--selected)}',
      '.fbs-sw{display:flex;flex:0 0 auto}',
      '.fbs-sw i{width:10px;height:10px;border-radius:50%;margin-left:-3.5px;border:1.5px solid var(--popover,var(--surface))}',
      '.fbs-sw i:first-child{margin-left:0}',
      '.fbs-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fbs-check{flex:0 0 auto;color:var(--brand);font-weight:700;visibility:hidden}',
      '.fbs-row.fbs-sel .fbs-check{visibility:visible}',
      '.fbs-field{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.fbs-field-label{font-size:var(--font-size-ui,12px);color:var(--muted)}',
      // Native select, restyled: appearance:none plus an inline chevron
      // element (see CHEVRON_SVG) so the control follows theme tokens instead
      // of the OS accent and stays visible on light and dark themes alike.
      '.fbs-select-wrap{position:relative;display:inline-flex;align-items:center}',
      '.fbs-chev{position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted)}',
      '.fbs-select{appearance:none;-webkit-appearance:none;box-sizing:border-box;min-width:140px;',
      ' padding:6px 26px 6px 9px;border:1px solid var(--border);border-radius:var(--radius-md,8px);',
      ' background-color:var(--control-bg,var(--surface-2));color:var(--text);font:inherit;',
      ' font-size:var(--font-size-body,13px);cursor:pointer}',
      '.fbs-select:hover{background-color:var(--control-bg-hover,var(--raised))}',
      '.fbs-select:focus-visible{outline:none;border-color:var(--brand)}',
      '.fbs-note{display:block;margin-top:7px;font-size:var(--font-size-caption,11px);color:var(--warning-text,var(--muted))}',
    ].join('')
  }

  // The select's dropdown affordance: an inline SVG (not a background image)
  // so it inherits the panel's text colour and stays visible on every theme.
  var CHEVRON_SVG =
    '<svg class="fbs-chev" width="12" height="7" viewBox="0 0 12 7" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><path d="M1 1l5 5 5-5"/></svg>'

  var PALETTE_SVG =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2.5a1.5 1.5 0 0 0-1 2.6c.4.4.4 1.4-1 1.4Z"/>' +
    '<circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="11" cy="7" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/>' +
    '</svg>'

  var panelEl = null

  function swatchHtml(theme) {
    var list = theme.swatches && theme.swatches.length ? theme.swatches : ['#888', '#bbb']
    return (
      '<span class="fbs-sw">' +
      list
        .slice(0, 4)
        .map(function (c) {
          return '<i style="background:' + c.replace(/["'<>]/g, '') + '"></i>'
        })
        .join('') +
      '</span>'
    )
  }

  function rowHtml(id, name, theme) {
    var sel = storedActive() === id ? ' fbs-sel' : ''
    var sw = theme ? swatchHtml(theme) : '<span class="fbs-sw"><i style="background:#1c1d1c"></i><i style="background:#b5cea5"></i></span>'
    return (
      '<button class="fbs-row' + sel + '" data-fbs-id="' + cssEscape(id) + '">' +
      sw +
      '<span class="fbs-name">' + name.replace(/[<>&]/g, '') + '</span>' +
      '<span class="fbs-check">&#10003;</span></button>'
    )
  }

  function fontFieldHtml() {
    var cur = storedFont()
    // "System default" (the id-less no-override entry) is deliberately not a
    // choice: Freebuff's own stack already falls through to the system font,
    // so the picker starts at "Freebuff default". An unset stored font marks
    // no option, and the browser shows the first one — which is what renders.
    var opts = ''
    for (var i = 0; i < FONTS.length; i++) {
      var f = FONTS[i]
      if (!f.id) continue
      opts +=
        '<option value="' + f.id + '"' + (f.id === cur ? ' selected' : '') + '>' + textSafe(f.name) + '</option>'
    }
    var html =
      '<div class="fbs-field"><span class="fbs-field-label">Font</span>' +
      '<span class="fbs-select-wrap"><select class="fbs-select" data-fbs-font aria-label="Font">' +
      opts +
      '</select>' +
      CHEVRON_SVG +
      '</span></div>'
    if (state().fontNote) html += '<span class="fbs-note">' + textSafe(state().fontNote) + '</span>'
    return html
  }

  function panelHtml() {
    var rows = [rowHtml('', 'Freebuff default', null)]
    var themes = state().themes || []
    for (var i = 0; i < themes.length; i++) {
      rows.push(rowHtml(themes[i].id, themes[i].name, themes[i]))
    }
    return (
      '<h3>Themes</h3><p class="fbs-sub">Restyle Freebuff instantly.</p>' +
      '<div class="fbs-list">' + rows.join('') + '</div>' +
      '<div class="fbs-foot">' + fontFieldHtml() + '</div>'
    )
  }

  function refreshPicker() {
    if (panelEl && panelEl.isConnected) {
      panelEl.innerHTML = panelHtml()
      var skip = panelEl.querySelectorAll('*')
      for (var si = 0; si < skip.length; si++) skip[si].setAttribute('data-stream-word', '')
    }
  }

  function closePanel() {
    if (panelEl) panelEl.remove()
    panelEl = null
    var btn = document.querySelector('.fbs-theme-btn')
    if (btn) btn.classList.remove('fbs-on')
  }

  function openPanel(btn) {
    if (panelEl) return closePanel()
    panelEl = document.createElement('div')
    panelEl.className = 'fbs-panel'
    panelEl.id = UI_ID + '-panel'
    panelEl.innerHTML = panelHtml()
    // Opt the whole picker out of Freebuff's squircle SVG baking
    // (data-stream-word is the app's own skip marker for its paint
    // observer). Plain CSS then keeps the panel's colors locked to the
    // live theme tokens as soon as a theme is switched.
    panelEl.setAttribute('data-stream-word', '')
    var skip = panelEl.querySelectorAll('*')
    for (var si = 0; si < skip.length; si++) skip[si].setAttribute('data-stream-word', '')
    document.body.appendChild(panelEl)
    var r = btn.getBoundingClientRect()
    var top = Math.min(r.top, window.innerHeight - panelEl.offsetHeight - 12)
    panelEl.style.left = r.right + 10 + 'px'
    panelEl.style.top = Math.max(8, top) + 'px'
    btn.classList.add('fbs-on')
    panelEl.addEventListener('click', function (ev) {
      var row = ev.target.closest ? ev.target.closest('[data-fbs-id]') : null
      if (row) {
        applyTheme(row.getAttribute('data-fbs-id') || null)
      }
    })
    panelEl.addEventListener('change', function (ev) {
      var sel = ev.target.closest ? ev.target.closest('[data-fbs-font]') : null
      if (sel) applyFont(sel.value || '')
    })
    setTimeout(function () {
      document.addEventListener('pointerdown', onDocDown, true)
    }, 0)
  }

  function onDocDown(ev) {
    if (!panelEl) return
    if (panelEl.contains(ev.target)) return
    // Keep the panel open while the native font dropdown has focus.
    if (ev.target && ev.target.tagName === 'SELECT' && ev.target.hasAttribute('data-fbs-font')) return
    var btn = document.querySelector('.fbs-theme-btn')
    if (btn && btn.contains(ev.target)) return
    closePanel()
    document.removeEventListener('pointerdown', onDocDown, true)
  }

  /* ---------- rail attachment ---------- */

  function findRail() {
    // Two shell builds exist: the left icon nav (nav.shell-navigation) and
    // the older `.rail` column. Prefer whichever is present.
    var top = document.querySelector('.shell-navigation-top')
    if (top) return { container: top, btnClass: 'shell-nav-button' }
    var rail = document.querySelector('.rail')
    if (rail) return { container: rail, btnClass: 'rail-add' }
    return null
  }

  function attachButton() {
    var rail = findRail()
    if (!rail) return false
    if (document.getElementById(UI_ID + '-btn')) {
      state().attached = true
      return true
    }
    var btn = document.createElement('button')
    btn.id = UI_ID + '-btn'
    btn.type = 'button'
    btn.className = rail.btnClass + ' fbs-theme-btn'
    btn.title = 'Themes'
    btn.setAttribute('aria-label', 'Themes')
    btn.innerHTML = PALETTE_SVG
    btn.addEventListener('click', function () {
      openPanel(btn)
    })
    rail.container.appendChild(btn)
    state().attached = true
    return true
  }

  function ensureChrome() {
    if (!document.getElementById(STYLE_ID)) {
      var el = document.createElement('style')
      el.id = STYLE_ID
      document.head.appendChild(el)
    }
    if (!document.getElementById(UI_ID + '-base')) {
      var base = document.createElement('style')
      base.id = UI_ID + '-base'
      document.head.appendChild(base)
    }
    // Always rewrite the chrome CSS: a live push may carry new panel styles.
    document.getElementById(UI_ID + '-base').textContent = baseCss()
    if (activeStyleEl()) activeStyleEl().setAttribute('data-fbs', '1')
    attachButton()
    // Re-attach if React re-renders the rail away.
    if (!state().railObserver) {
      state().railObserver = new MutationObserver(function () {
        if (!document.querySelector('.fbs-theme-btn')) attachButton()
      })
      state().railObserver.observe(document.body, { childList: true, subtree: true })
    }
  }

  /* The theme has to paint before the shell exists: Freebuff opens on a native
     splash, then a React loading screen, then the sign-in "welcome" screen —
     none of which have the icon rail. Those documents are still the app (same
     origin, same token ramp), so accept any of them and let the rail watcher
     attach the picker button once the shell mounts. The markers are all
     Freebuff-specific on purpose: a localhost dev server opened in a surface
     window must stay untouched. */
  function isFreebuffDoc() {
    var d = document
    if (d.getElementById('startup-recovery')) return true
    if (d.title === 'Freebuff Desktop') return true
    return !!d.querySelector(
      '.splash,.splash-background,.loading-screen,.shell-navigation-top,.project-sidebar,nav.shell-navigation,.rail',
    )
  }

  function waitForShell(done) {
    var tries = 0
    var timer = setInterval(function () {
      tries++
      if (findRail() || isFreebuffDoc()) {
        clearInterval(timer)
        done(true)
      } else if (tries > 40) {
        clearInterval(timer)
        done(false)
      }
    }, 250)
  }

  /* ---------- install entry ---------- */

  // Bump when the picker markup or behaviour changes: an older closure that
  // already owns the chrome keeps serving its own (stale) panel after a live
  // push, so a version mismatch has to take the UI over instead of delegating.
  var VERSION = '8'

  // Capture any installer from a previous injection *before* redefining.
  var prevInstall = typeof window.__FBS_INSTALL__ === 'function' ? window.__FBS_INSTALL__ : null
  var prevOwned = !!state().ownsInstall
  var prevVersion = window.__FBS_VERSION__ || null

  function takeOver(s) {
    try {
      if (s.railObserver) {
        s.railObserver.disconnect()
        s.railObserver = null
      }
    } catch {}
    try {
      var b = document.getElementById(UI_ID + '-btn')
      if (b) b.remove()
      var p = document.getElementById(UI_ID + '-panel')
      if (p) p.remove()
    } catch {}
    panelEl = null
    s.installed = false
    s.ownsInstall = false
    s.attached = false
  }

  /* The generated session preload paints with an adopted stylesheet before any
     page script runs (first-paint flash guard). Constructable sheets beat
     document <style> elements in the cascade, so once the runtime is alive the
     preload's copy would shadow every later change made in-session. The
     preload is bootstrap only: drop it the moment the runtime (re)applies
     stored settings — from then on the live style elements are the single
     source of truth. Non-preload sheets (none today) are left alone; the
     generated preload is identified by its --fbs- token block. */
  function dropPreloadSheets() {
    try {
      var adopted = document.adoptedStyleSheets
      if (!adopted || !adopted.length) return
      var keep = []
      for (var i = 0; i < adopted.length; i++) {
        var isPreload = false
        try {
          var rules = adopted[i].cssRules
          for (var j = 0; j < rules.length; j++) {
            if (String(rules[j].cssText || '').indexOf('--fbs-') !== -1) {
              isPreload = true
              break
            }
          }
        } catch (e) {
          isPreload = false
        }
        if (!isPreload) keep.push(adopted[i])
      }
      if (keep.length !== adopted.length) document.adoptedStyleSheets = keep
    } catch {}
  }

  function applyStored(hideAds) {
    dropPreloadSheets()
    var active = storedActive()
    if (active && !findTheme(active)) {
      // theme was deleted — fall back to default
      applyTheme(null)
    } else {
      applyTheme(active)
    }
    applyFont(storedFont())
    applyAds(hideAds)
  }

  /* Freebuff's window is served from a fresh loopback port on every launch,
     which means its localStorage origin changes and the renderer's own copy
     of the choice is gone. The bridge therefore ships the saved pair in the
     install payload; localStorage still wins when it happens to be warm. */
  function seedSettings(settings) {
    if (!settings) return
    try {
      if (typeof settings.theme === 'string' && !localStorage.getItem(LS_ACTIVE)) {
        localStorage.setItem(LS_ACTIVE, settings.theme)
      }
      if (typeof settings.font === 'string' && !localStorage.getItem(LS_FONT)) {
        localStorage.setItem(LS_FONT, settings.font)
      }
    } catch {}
  }

  window.__FBS_INSTALL__ = function (payload) {
    var s = state()
    window.__FBS_VERSION__ = VERSION
    // Runtimes older than versioning never stamped __FBS_VERSION__, so a
    // missing marker counts as stale too.
    var stale = !!(prevInstall && prevOwned && prevVersion !== VERSION)
    if (stale) takeOver(s)
    // A previous install (or one still waiting for the shell) owns the UI;
    // delegate so repeat injections never create duplicate chrome.
    if (prevInstall && prevOwned && !stale) {
      prevInstall(payload)
      return
    }
    var themes = Array.isArray(payload) ? payload : (payload && payload.themes) || []
    var settings = Array.isArray(payload) ? null : payload && payload.settings
    s.themes = themes
    if (!s.installed) {
      s.ownsInstall = true
      // Only run inside the real Freebuff shell.
      waitForShell(function (isShell) {
        if (!isShell) {
          s.ownsInstall = false
          return
        }
        s.installed = true
        ensureChrome()
        seedSettings(settings)
        applyStored(settings && settings.hideAds)
      })
      return
    }
    ensureChrome()
    seedSettings(settings)
    applyStored(settings && settings.hideAds)
  }

  try {
    var pre = window.__FBS_PENDING__
    if (pre) window.__FBS_INSTALL__(pre)
  } catch {}
})()
