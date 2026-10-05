/**
 * Shared helpers for the bridge (main-process side): the theme CSS math, and
 * the NODE_OPTIONS entry bookkeeping the launcher and early.cjs agree on.
 *
 * KEEP-IN-SYNC with runtime.js: the runtime is a plain browser script injected
 * as a string — CommonJS doesn't exist there — so it keeps its own copy of
 * BRIDGE_CSS / splashTintCss / tokenValue / hexToHsl / FONTS. This module is
 * what boot.cjs (main process) uses to compute the same "full CSS" for the
 * document-start preload. The preload only has to hold the first paint; the
 * runtime re-applies the identical text at dom-ready. When you change one
 * side, change the other (search: KEEP-IN-SYNC).
 */
'use strict'

/* ---------- the NODE_OPTIONS entry the launcher adds ----------
   freebuff.cjs's launchFreebuff appends `--require "<bridge>/early.cjs"` to
   NODE_OPTIONS; this is how early.cjs (and boot.cjs, as a safety net) find
   that entry again and remove it, so nothing Freebuff spawns inherits it.
   freebuff.cjs carries the same pattern for the launcher side (search:
   KEEP-IN-SYNC). */

/** Remove the bridge's --require entry from a NODE_OPTIONS value. '' = empty. */
function stripEarlyRequire(value) {
  if (typeof value !== 'string' || !value) return ''
  return value
    .replace(/--require\s+("[^"]*early\.cjs"|'[^']*early\.cjs'|\S*early\.cjs)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* Freebuff's Settings pages define their own "neutral" control tokens
   (--settings-neutral etc.) with hardcoded light-gray values that ignore
   the active theme — so secondary buttons, quiet icon buttons (+, ↻) and
   switches stay off-palette. Map them onto the theme's own tokens; the
   !important declarations win regardless of where the app scoped them. */
const BRIDGE_CSS = [
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

/* Freebuff's own font stack, captured from the app's :root declaration (the
   "Freebuff default" font option). Inter and Geist are pulled from Google
   Fonts on demand — nothing is installed on disk, and the fallback stack
   keeps the UI intact offline. Mirrors runtime.js — keep in sync. */
const FONTS = [
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
const FONT_FALLBACK = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"

function findFont(id) {
  for (let i = 0; i < FONTS.length; i++) if (FONTS[i].id === id) return FONTS[i]
  return FONTS[0]
}

/* Resolve a custom property out of a theme's own CSS, following var() hops
   so `--bg: var(--workspace-surface)` still yields a literal color. */
function tokenValue(css, name, hops) {
  if (hops > 3) return null
  const m = new RegExp('--' + name + '\\s*:\\s*([^;}]+)').exec(css)
  if (!m) return null
  // Theme files write `--brand: #1db954 !important;` — strip the flag before
  // anything tries to read the value as a color or a var() reference.
  const v = m[1].trim().replace(/!important\s*$/i, '').trim()
  const vm = /^var\(\s*--([a-z0-9-]+)/i.exec(v)
  if (vm) return tokenValue(css, vm[1], hops + 1)
  return v
}

function hexToHsl(hex) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(hex).trim())
  if (!m) return null
  let s = m[1]
  if (s.length === 3 || s.length === 4) s = s.replace(/./g, (c) => c + c)
  if (s.length < 6) return null
  const r = parseInt(s.slice(0, 2), 16) / 255
  const g = parseInt(s.slice(2, 4), 16) / 255
  const b = parseInt(s.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
  }
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h, s: sat, l }
}

// The bundled aurora is a sage/green wash; the app's own dark filter leaves it
// sitting at roughly this hue, so rotating by (brand - SPLASH_BASE_HUE) lands
// the photo on the theme's accent.
const SPLASH_BASE_HUE = 95

function splashTintCss(theme) {
  if (!theme) return ''
  const css = theme.css || ''
  const names = ['brand-2', 'brand', 'brand-1', 'brand-3', 'primary-action', 'accent']
  let picked = null
  for (let i = 0; i < names.length && !picked; i++) {
    const raw = tokenValue(css, names[i], 0)
    const hsl = raw && hexToHsl(raw)
    if (hsl && hsl.s >= 0.18) picked = hsl
  }
  const light = theme.mode === 'light'
  if (!picked) {
    // Monochrome brand (Uber, Vercel): drain the photo instead of faking a hue.
    return (
      ':root { --fbs-splash-hue: 0deg; --fbs-splash-sat: 0.06;' +
      ' --fbs-splash-bright: ' + (light ? '1.12' : '0.92') + '; --fbs-splash-opacity: 0.55; }'
    )
  }
  const rot = ((picked.h - SPLASH_BASE_HUE + 540) % 360) - 180
  const sat = Math.max(0.4, Math.min(0.95, picked.s * 0.75)).toFixed(2)
  const bright = light ? '1.06' : '1.08'
  const filter = light ? 'invert(1) brightness(1.6)' : 'none'
  return (
    ':root { --fbs-splash-hue: ' + rot + 'deg; --fbs-splash-sat: ' + sat + ';' +
    ' --fbs-splash-bright: ' + bright + '; --fbs-splash-opacity: 1;' +
    ' --fbs-logo-filter: ' + filter + '; }'
  )
}

/** The exact CSS the runtime would apply for this theme + font (same order). */
function buildEarlyCss(theme, fontId) {
  const f = findFont(fontId)
  let css = theme.css + '\n' + BRIDGE_CSS + '\n' + splashTintCss(theme) + '\n'
  if (f.family) {
    // A single family gets quoted and stacked on the fallback; a full stack
    // (comma inside) is Freebuff's own — insert it raw. Mirrors runtime.js.
    const value = f.family.indexOf(',') !== -1 ? f.family : "'" + f.family + "', " + FONT_FALLBACK
    css +=
      ':root, :root[data-theme], :root[data-theme=dark], :root[data-theme=light] {' +
      '--font-sans: ' + value + ' !important; }\n'
  }
  return css
}

/**
 * Source of the generated session preload (preload-active.cjs). Runs before the
 * document's first paint; only ever touches the app's own origins. The embedded
 * values are regenerated by boot.cjs whenever theme, font or origins change.
 * `origins` is the rolling list of loopback origins the app itself was seen
 * loading from (a random port per launch, plus any extras).
 */
function buildPreloadSource(payload) {
  const css = String(payload.css || '')
  const themeId = String(payload.themeId || '')
  const origins = Array.isArray(payload.origins) ? payload.origins.map(String) : []
  const f = findFont(payload.fontId)
  const fontHref = f.href || ''
  const fontLinkId = f.family ? 'fbs-font-' + f.id : ''
  return (
    '/* Generated by the Freebuff Theme Bridge — do not edit. */\n' +
    "'use strict'\n" +
    ';(function () {\n' +
    '  var CSS = ' + JSON.stringify(css) + '\n' +
    '  var THEME = ' + JSON.stringify(themeId) + '\n' +
    '  var ORIGINS = ' + JSON.stringify(origins) + '\n' +
    '  var FONT_HREF = ' + JSON.stringify(fontHref) + '\n' +
    '  var FONT_LINK_ID = ' + JSON.stringify(fontLinkId) + '\n' +
    '  try {\n' +
    '    if (!THEME || !CSS || !ORIGINS.length) return\n' +
    '    if (ORIGINS.indexOf(location.origin) === -1) return\n' +
    '    try {\n' +
    "      // A choice made later in this session wins over the embedded one.\n" +
    "      var live = localStorage.getItem('fbs.theme.active')\n" +
    '      if (live && live !== THEME) return\n' +
    '    } catch (e) {}\n' +
    "    /* Constructable sheet first: it applies without a DOM tree, so the\n" +
    '       themed canvas is in place before the parser even starts. The\n' +
    "       style element below stays as the fallback path and as the copy\n" +
    "       the runtime picks up at dom-ready. */\n" +
    '    try {\n' +
    "      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {\n" +
    '        var sheet = new CSSStyleSheet()\n' +
    '        sheet.replaceSync(CSS)\n' +
    '        var adopted = Array.prototype.slice.call(document.adoptedStyleSheets)\n' +
    '        adopted.push(sheet)\n' +
    '        document.adoptedStyleSheets = adopted\n' +
    '      }\n' +
    '    } catch (e) {}\n' +
    '    var stamped = false\n' +
    '    function apply() {\n' +
    '      try {\n' +
    '        var root = document.documentElement\n' +
    '        if (!root) return false\n' +
    "        root.setAttribute('data-fbs-theme', THEME)\n" +
    "        var el = document.getElementById('fbs-theme-style')\n" +
    '        if (!el) {\n' +
    "          el = document.createElement('style')\n" +
    "          el.id = 'fbs-theme-style'\n" +
    '          ;(document.head || root).appendChild(el)\n' +
    '        }\n' +
    '        if (el.textContent !== CSS) el.textContent = CSS\n' +
    '        if (FONT_HREF && FONT_LINK_ID && !document.getElementById(FONT_LINK_ID)) {\n' +
    "          var link = document.createElement('link')\n" +
    '          link.id = FONT_LINK_ID\n' +
    "          link.rel = 'stylesheet'\n" +
    '          link.href = FONT_HREF\n' +
    '          ;(document.head || root).appendChild(link)\n' +
    '        }\n' +
    '        if (!stamped) {\n' +
    '          stamped = true\n' +
    "          // Proof for support: the theme was in place this early.\n" +
    "          root.setAttribute('data-fbs-early', document.readyState || 'loading')\n" +
    '        }\n' +
    '        return true\n' +
    '      } catch (e) {\n' +
    '        return false\n' +
    '      }\n' +
    '    }\n' +
    '    if (!apply()) {\n' +
    '      var mo = new MutationObserver(function () {\n' +
    '        if (apply()) mo.disconnect()\n' +
    '      })\n' +
    '      mo.observe(document, { childList: true, subtree: true })\n' +
    "      document.addEventListener('readystatechange', function () {\n" +
    '        if (apply()) mo.disconnect()\n' +
    '      }, { once: true })\n' +
    '    }\n' +
    '  } catch (e) {}\n' +
    '})()\n'
  )
}

module.exports = {
  BRIDGE_CSS,
  FONTS,
  FONT_FALLBACK,
  findFont,
  tokenValue,
  hexToHsl,
  splashTintCss,
  buildEarlyCss,
  buildPreloadSource,
  stripEarlyRequire,
}
