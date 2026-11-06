/**
 * Freebuff Theme Bridge — renderer runtime.
 *
 * Injected into Freebuff's UI documents by the Injector's main process (over
 * the Chromium DevTools Protocol). It:
 *  - Verifies it is running inside Freebuff's own UI document (the shell's
 *    left icon rail, or the pre-login loading / welcome screens) and stays
 *    completely inert anywhere else.
 *  - Applies the theme + font tokens to every app document, so the splash,
 *    the welcome screen and the shell all paint in the active palette.
 *  - Hides Freebuff's sponsored placements (chat cards, the composer banner,
 *    the showcase card and the sponsor break) — on by default, theme or not.
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
  var SPLASH_STYLE_ID = 'fbs-splash'
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

  /* The runtime is registered as a document-start script, so it can run before
     <head> exists. Always place styles on whatever host is available; a style
     appended to <html> is honoured by the parser and moved into <head> later. */
  function styleHost() {
    return document.head || document.documentElement || null
  }

  function activeStyleEl() {
    var el = document.getElementById(STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
      var host = styleHost()
      if (host) host.appendChild(el)
    }
    return el
  }

  function findTheme(id) {
    var themes = state().themes || []
    for (var i = 0; i < themes.length; i++) if (themes[i].id === id) return themes[i]
    return null
  }

  /* Freebuff paints its squircle fills onto controls (dataset.fill /
     --squircle-paint) by measuring computed colours. Its observer re-measures
     when `data-squircle-paint` changes anywhere or `data-theme` flips, but a
     theme swap only mutates CSS variables — so the baked fills go stale. Set
     and clear the marker attribute on <html> to trigger that re-measure.
     (The old shell listened for inline style changes there instead.) */
  function repaintSquircles() {
    try {
      var d = document.documentElement
      d.setAttribute('data-squircle-paint', '')
      d.removeAttribute('data-squircle-paint')
      // Second pass next frame: elements whose layout settles late.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          try {
            d.setAttribute('data-squircle-paint', '')
            d.removeAttribute('data-squircle-paint')
          } catch {}
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
    /* Desktop-shell tokens (Freebuff 0.0.200+). The rewrite added a second
       token layer for the chrome: sidebar canvas, panel dividers and nav
       icon colours. Themes predate it, so map the new names onto the theme
       tokens — otherwise those surfaces keep the app's neutral defaults. */
    ':root, :root[data-theme] {',
    ' --panel-divider: var(--border) !important;',
    ' --sidebar-canvas: var(--workspace-surface, var(--bg)) !important;',
    ' --sidebar-edge: var(--border) !important;',
    ' --nav-muted: var(--muted) !important;',
    ' --nav-text: var(--text) !important;',
    '}',
  ].join('\n')

  /* Freebuff's sponsored placements: the "Ad"-badged cards in the chat stream
     and above the composer, the large showcase card, the full-content sponsor
     break and the promo spotlight. CSS-only hiding leaves the app's own ad DOM
     in place — its store and observers keep working, only paint changes. This
     rides the injector's hideAds setting and works with or without a theme. */
  var ADS_CSS = [
    // Marker: lets dropPreloadSheets recognise this block on old installs.
    ':root { --fbs-ads: 1; }',
    '.cloud-ad-frame, .cloud-composer-ads,',
    '.sponsored-ad, .ad-banner, .ad-card, .partner-placement, .ad-showcase,',
    '.sponsor-intermission, .spotlight-card, .spotlight-backdrop,',
    '[data-ad-slot], [data-sponsor-ad], [data-advertisement] {',
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


  /* ---------- desktop web app (freebuff.com) ---------- */

  /* Freebuff 0.0.201's window is the freebuff.com web app, not the loopback
     shell. It has its own desktop token layer (--dk-bg, --dk-sidebar-canvas,
     all hex) and keeps the unprefixed names for Tailwind's hsl(var(--x))
     triples. So the theme is re-declared under --fbs-t-* (never touching the
     page's own variables) and mapped onto the --dk-* layer. The mapping has
     to sit on every element: the shell re-declares some --dk-* names on its
     own containers, which shadows anything merely inherited from <body>. */
  var WEB_TOKENS = [
    'bg', 'chrome', 'shell-base', 'workspace-surface', 'surface', 'surface-2',
    'raised', 'border', 'text', 'muted', 'faint', 'placeholder', 'accent',
    'accent-dim', 'brand', 'brand-1', 'brand-2', 'brand-3', 'brand-dim',
    'brand-ink', 'primary-action', 'primary-action-text', 'bubble',
    'message-fill', 'message-ink', 'selected', 'scrim', 'input', 'control-bg',
    'control-border', 'control-border-hover', 'field-focus', 'logo-filter',
    'matte-edge', 'tab-track', 'tab-indicator', 'tab-selected-text',
    'tab-active-surface', 'switch-track-on', 'switch-thumb-on', 'danger',
    'danger-text', 'warn', 'warning-text', 'success-text', 'ok', 'green',
    'info', 'premium', 'conflict', 'merged', 'syntax-comment',
    'syntax-function', 'syntax-keyword', 'syntax-number', 'syntax-property',
    'syntax-string', 'syntax-type',
  ]
  var WEB_ALIASES = [
    ['fg', 'text'],
    ['text-muted', 'muted'],
    ['text-secondary', 'muted'],
    ['block-header-bg', 'surface-2'],
    ['terminal-background', 'bg'],
    ['ad-fill', 'raised'],
    ['ad-ink', 'text'],
  ]

  function isWebAppDoc() {
    try {
      return /(^|\.)freebuff\.com$/i.test(location.hostname)
    } catch {
      return false
    }
  }

  function webThemeCss(theme) {
    var scoped = String(theme.css || '').replace(/--([a-z0-9-]+)/gi, '--fbs-t-$1')
    var decl = []
    var i
    for (i = 0; i < WEB_TOKENS.length; i++) {
      decl.push('--dk-' + WEB_TOKENS[i] + ': var(--fbs-t-' + WEB_TOKENS[i] + ') !important;')
    }
    for (i = 0; i < WEB_ALIASES.length; i++) {
      decl.push(
        '--dk-' + WEB_ALIASES[i][0] + ': var(--fbs-t-' + WEB_ALIASES[i][1] + ') !important;',
      )
    }
    return [
      scoped,
      'body.fb-desktop, body.fb-desktop * { ' + decl.join(' ') + ' }',
      'body.fb-desktop { background-color: var(--dk-bg) !important;' +
        ' color: var(--dk-text) !important; }',
      // The palette button and panel read unprefixed tokens; give them the
      // theme's values locally so the page's own names stay untouched.
      '.fbs-theme-btn, .fbs-panel {' +
        '--text: var(--fbs-t-text);--muted: var(--fbs-t-muted);' +
        '--border: var(--fbs-t-border);--brand: var(--fbs-t-brand);' +
        '--surface: var(--fbs-t-surface);--surface-2: var(--fbs-t-surface-2);' +
        '--raised: var(--fbs-t-raised);--popover: var(--fbs-t-surface);' +
        '--control-bg: var(--fbs-t-control-bg);' +
        '--control-bg-hover: var(--fbs-t-raised);' +
        '--warning-text: var(--fbs-t-warning-text);}',
    ].join('\n')
  }

  function applyTheme(id) {
    var theme = id ? findTheme(id) : null
    var el = activeStyleEl()
    var host = styleHost()
    if (host) host.appendChild(el) // move to end so equal-specificity rules win
    el.textContent = theme
      ? isWebAppDoc()
        ? webThemeCss(theme)
        : theme.css + '\n' + BRIDGE_CSS + '\n' + splashTintCss(theme) + '\n'
      : ''
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
      var host = styleHost()
      if (host) host.appendChild(el)
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
    var host = styleHost()
    if (host) host.appendChild(el)
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
        '--font-sans: ' + value + ' !important; }' +
        (isWebAppDoc()
          ? '\nbody.fb-desktop { --dk-font-sans: ' + value + ' !important; }'
          : '')
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
      var host = styleHost()
      if (host) host.appendChild(el)
    }
    return el
  }

  /* Independent of the theme: ads hide whether or not one is active. An
     absent setting means the injector shipped it without one — default on. */
  function applyAds(hide) {
    var el = adsStyleEl()
    var host = styleHost()
    if (host) host.appendChild(el) // move to end so equal-specificity rules win
    el.textContent = hide === false ? '' : ADS_CSS
  }

  /* ---------- launch splash (data: URL, no app tokens) ---------- */

  function isSplashDoc() {
    try {
      return location.protocol === 'data:' && !!document.querySelector('.bar')
    } catch {
      return false
    }
  }

  function splashPalette() {
    try {
      var s = state()
      var id = (s.settings && s.settings.theme) || storedActive()
      if (!id) return null
      var theme = findTheme(id)
      if (!theme || !theme.css) return null
      var pick = function (names) {
        for (var i = 0; i < names.length; i++) {
          var v = tokenValue(theme.css, names[i], 0)
          if (v && /^#([0-9a-f]{3,8})$/i.test(v.trim())) return v.trim()
        }
        return null
      }
      var bg = pick(['bg', 'workspace-surface', 'shell-base'])
      if (!bg) return null
      return {
        bg: bg,
        track: pick(['surface-2', 'raised', 'surface']) || bg,
        bar: pick(['brand-dim', 'brand', 'brand-2']) || bg,
        light: theme.mode === 'light',
      }
    } catch {
      return null
    }
  }

  /* The splash is Freebuff's first frame and is built by its main process with
     a fixed palette. Paint it with the active theme so the handoff to the app
     document never flashes the default. */
  function applySplash() {
    try {
      if (location.protocol !== 'data:' || !document.querySelector('.bar')) return false
      var p = splashPalette()
      if (!p) return false
      var host = styleHost()
      if (!host) return false
      var el = document.getElementById(SPLASH_STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = SPLASH_STYLE_ID
        host.appendChild(el)
      }
      el.textContent =
        'html,body{background:' + p.bg + ' !important}' +
        '.bar{background:' + p.track + ' !important}' +
        '.bar span{background:' + p.bar + ' !important}' +
        '.mark{filter:' + (p.light ? 'brightness(0) invert(0.16)' : 'brightness(0.88)') + ' !important}'
      return true
    } catch {
      return false
    }
  }

  var splashWatchInstalled = false
  function watchSplashDoc() {
    if (splashWatchInstalled) return
    splashWatchInstalled = true
    try {
      if (location.protocol !== 'data:') return
      var run = function () { applySplash() }
      run()
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true })
        document.addEventListener('readystatechange', run)
      }
    } catch {}
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
      '.fbs-row.fbs-sel{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 16%,var(--surface))}',
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
      optOutOfPaint(panelEl)
    }
  }

  /* The app paints squircle fills onto every <button> it finds. The picker is
     our own chrome and its rows are buttons, so mark the whole subtree as
     opted out and let the panel's CSS own every colour. (`data-squircle=off`
     is the desktop shell's own opt-out marker, used on its checkboxes.) */
  function optOutOfPaint(root) {
    if (!root) return
    root.setAttribute('data-squircle', 'off')
    var nodes = root.querySelectorAll('*')
    for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('data-squircle', 'off')
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
    // Keep the app's squircle painter away from the picker so its colours
    // stay locked to the live theme tokens as soon as a theme is switched.
    optOutOfPaint(panelEl)
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
    // Three shell builds: the desktop shell keeps its rail buttons in
    // .shell-navigation-bottom (bottom-aligned), older builds used
    // .shell-navigation-top, and the first Electron shell had .rail.
    var bottom = document.querySelector('.shell-navigation-bottom')
    if (bottom) return { container: bottom, btnClass: 'shell-nav-button' }
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
    var s = state()
    var host = styleHost()
    if (!host) return
    if (!document.getElementById(STYLE_ID)) {
      var el = document.createElement('style')
      el.id = STYLE_ID
      host.appendChild(el)
    }
    if (!document.getElementById(UI_ID + '-base')) {
      var base = document.createElement('style')
      base.id = UI_ID + '-base'
      host.appendChild(base)
    }
    // Always rewrite the chrome CSS: a live push may carry new panel styles.
    var baseEl = document.getElementById(UI_ID + '-base')
    if (baseEl) baseEl.textContent = baseCss()
    if (activeStyleEl()) activeStyleEl().setAttribute('data-fbs', '1')
    attachButton()
    // Document-start injection can beat <body>; the rail watcher needs it.
    if (!document.body) {
      if (!s.chromeDeferred) {
        s.chromeDeferred = true
        document.addEventListener('DOMContentLoaded', function () {
          s.chromeDeferred = false
          if (s.installed) ensureChrome()
        }, { once: true })
      }
      return
    }
    // Re-attach if React re-renders the rail away.
    if (!s.railObserver) {
      s.railObserver = new MutationObserver(function () {
        if (!document.querySelector('.fbs-theme-btn')) attachButton()
      })
      s.railObserver.observe(document.body, { childList: true, subtree: true })
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
      '.splash,.splash-background,.loading-screen,.desktop-shell,.shell-navigation,' +
        '.shell-navigation-bottom,.shell-navigation-top,.project-sidebar,.rail',
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
  var VERSION = '10'

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
    applySplash()
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

  /* Document-start injection can run before <html> exists. Wait for the root
     element, then apply — still long before React mounts the shell. */
  function whenRoot(fn) {
    if (document.documentElement) return fn()
    try {
      var mo = new MutationObserver(function () {
        if (!document.documentElement) return
        mo.disconnect()
        fn()
      })
      mo.observe(document, { childList: true, subtree: true })
    } catch {
      setTimeout(fn, 50)
    }
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
    s.settings = settings || null
    var hideAds = !settings || settings.hideAds !== false
    s.hideAds = hideAds
    watchSplashDoc()
    whenRoot(function () {
      // The splash is a Freebuff document too, but it has no shell: paint it
      // with the theme's palette and stop there.
      if (isSplashDoc()) {
        applySplash()
        return
      }
      // Tokens first: they need no <body> and have to land before React's
      // first render, which is still ahead of us at document-start.
      seedSettings(settings)
      applyStored(hideAds)
      if (s.installed) {
        ensureChrome()
        return
      }
      s.ownsInstall = true
      // Only run inside the real Freebuff shell.
      waitForShell(function (isShell) {
        if (!isShell) {
          s.ownsInstall = false
          return
        }
        s.installed = true
        ensureChrome()
      })
    })
  }

  try {
    var pre = window.__FBS_PENDING__
    if (pre) window.__FBS_INSTALL__(pre)
  } catch {}
})()
