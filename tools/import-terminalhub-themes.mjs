/**
 * Import TerminalHub's brand themes as Freebuff token themes.
 *
 * Source of truth: /Users/sachin/Documents/GitHub/terminal/renderer/app.js
 * (THEMES array) and renderer/styles.css (:root graphite ramp). Values were
 * transcribed on 2026-10-04; re-run after TerminalHub theme changes.
 *
 * TerminalHub ramp -> Freebuff token mapping:
 *   --bg-0 titlebar      -> --shell-base
 *   --bg-1 main content  -> --workspace-surface
 *   --bg-2 sidebar       -> --surface, --tab-track
 *   --bg-3 raised        -> --surface-2, --popover
 *   --bg-4 pills         -> --raised, --selected, --input
 *   --bg-5 hover         -> --tab-indicator (bubbles)
 *   --border/-strong     -> --border / --control-border-hover
 *   --text/-dim/-faint   -> --text / --muted / --faint
 *   --accent (brand)     -> --brand-1..3 (darken/lighten variants)
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT_ROOTS = [
  path.join(import.meta.dirname, '..', 'themes'),
  path.join(os.homedir(), '.freebuff-theme-studio', 'themes'),
]

// [id, name, accent, term, vars{bg0,bg1,bg2,bg3,bg4,bg5,border,borderStrong,text,textDim,textFaint}]
const BRANDS = [
  ['terminalhub', 'TerminalHub Graphite', '#ff9f2e', '#101113', { bg0: '#0a0b0c', bg1: '#101113', bg2: '#141416', bg3: '#1d1d20', bg4: '#212227', bg5: '#34353c', border: '#29292d', borderStrong: '#3a3a42', text: '#e8e8ea', textDim: '#98989f', textFaint: '#6e6e76' }],
  ['vercel', 'Vercel', '#0070f3', '#000000', { bg0: '#000000', bg1: '#0a0a0a', bg2: '#0d0d0d', bg3: '#141414', bg4: '#1c1c1c', bg5: '#262626', border: '#262626', borderStrong: '#363636', text: '#ededed', textDim: '#9f9fa6', textFaint: '#6f6f76' }],
  ['uber', 'Uber', '#06c167', '#000000', { bg0: '#000000', bg1: '#0b0b0c', bg2: '#0f0f11', bg3: '#16161a', bg4: '#1f1f24', bg5: '#2a2a30', border: '#25252b', borderStrong: '#37373f', text: '#ffffff', textDim: '#a2a2ab', textFaint: '#6e6e78' }],
  ['airbnb', 'Airbnb', '#ff5a5f', '#1b1718', { bg0: '#131011', bg1: '#1b1718', bg2: '#201c1d', bg3: '#292425', bg4: '#332e2f', bg5: '#403a3b', border: '#322d2e', borderStrong: '#4a4344', text: '#f7f4f4', textDim: '#b5adaf', textFaint: '#7d7577' }],
  ['stripe', 'Stripe', '#635bff', '#0a0e1f', { bg0: '#05070f', bg1: '#0a0e1f', bg2: '#0d1226', bg3: '#131a35', bg4: '#1b2447', bg5: '#26315c', border: '#1d2648', borderStrong: '#31407a', text: '#e8eaf8', textDim: '#9aa2c4', textFaint: '#6a7295' }],
  ['spotify', 'Spotify', '#1db954', '#121212', { bg0: '#000000', bg1: '#121212', bg2: '#171717', bg3: '#1f1f1f', bg4: '#2a2a2a', bg5: '#363636', border: '#2a2a2a', borderStrong: '#404040', text: '#ffffff', textDim: '#b3b3b3', textFaint: '#7a7a7a' }],
  ['netflix', 'Netflix', '#e50914', '#141414', { bg0: '#000000', bg1: '#141414', bg2: '#191919', bg3: '#212121', bg4: '#2c2c2c', bg5: '#383838', border: '#2b2b2b', borderStrong: '#414141', text: '#f5f5f1', textDim: '#b3b3b0', textFaint: '#787875' }],
  ['figma', 'Figma', '#a259ff', '#16161a', { bg0: '#0d0d10', bg1: '#151519', bg2: '#1a1a1f', bg3: '#222227', bg4: '#2c2c33', bg5: '#393941', border: '#2b2b32', borderStrong: '#3f3f49', text: '#ebebf2', textDim: '#a6a6b0', textFaint: '#71717c' }],
  ['linear', 'Linear', '#5e6ad2', '#0f1011', { bg0: '#08090a', bg1: '#0f1012', bg2: '#131517', bg3: '#1b1d20', bg4: '#24272b', bg5: '#303339', border: '#232629', borderStrong: '#34383e', text: '#f7f8f9', textDim: '#9ba1ab', textFaint: '#6b727c' }],
  ['github', 'GitHub', '#238636', '#0d1117', { bg0: '#010409', bg1: '#0d1117', bg2: '#10161c', bg3: '#161b22', bg4: '#21262d', bg5: '#2d333b', border: '#30363d', borderStrong: '#444c56', text: '#e6edf3', textDim: '#8b949e', textFaint: '#626a73' }],
  ['shopify', 'Shopify', '#95bf47', '#111410', { bg0: '#0a0c09', bg1: '#12150f', bg2: '#161a13', bg3: '#1e231b', bg4: '#282e25', bg5: '#343c31', border: '#272d25', borderStrong: '#3b4438', text: '#eef2ea', textDim: '#a6b09e', textFaint: '#727b6c' }],
]

/* ---------- color helpers ---------- */
function hex(c) {
  c = c.replace('#', '')
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]
}
function toHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
function mix(c, target, amt) {
  const a = hex(c), b = hex(target)
  return toHex(a.map((v, i) => v + (b[i] - v) * amt))
}
const darken = (c, amt) => mix(c, '#000000', amt)
const lighten = (c, amt) => mix(c, '#ffffff', amt)
function luminance(c) {
  const [r, g, b] = hex(c)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function buildTheme([id, name, accent, term, v]) {
  const brand2 = luminance(accent) < 0.35 ? lighten(accent, 0.18) : accent
  const brand1 = darken(brand2, 0.18)
  const brand3 = lighten(brand2, 0.45)
  const primaryText = luminance(brand2) > 0.55 ? darken(v.bg1, 0.2) : '#f5f6f7'
  const rows = {
    'color-scheme': 'dark',
    '--shell-base': v.bg0,
    '--workspace-surface': v.bg1,
    '--bg': 'var(--workspace-surface)',
    '--chrome': 'var(--shell-base)',
    '--surface': v.bg2,
    '--surface-2': v.bg3,
    '--raised': v.bg4,
    '--border': v.border,
    '--text': v.text,
    '--muted': v.textDim,
    '--faint': v.textFaint,
    '--accent': v.text,
    '--accent-dim': v.textFaint,
    '--brand-1': brand1,
    '--brand-2': brand2,
    '--brand-3': brand3,
    '--brand': 'var(--brand-2)',
    '--brand-ink': brand2,
    '--brand-dim': brand1,
    '--primary-action': 'var(--brand)',
    '--primary-action-text': primaryText,
    '--green': brand2,
    '--ok': brand2,
    '--success-text': brand2,
    '--premium': '#e6b455',
    '--danger': '#ff5252',
    '--danger-text': '#ff7b7b',
    '--warn': '#e6a23c',
    '--warning-text': '#e6b455',
    '--info': '#62b5ff',
    '--conflict': '#e6a23c',
    '--merged': '#c48aff',
    '--bubble': v.bg3,
    '--popover': v.bg3,
    '--input': v.bg3,
    '--placeholder': v.textFaint,
    '--field-focus': brand1,
    '--selected': v.bg4,
    '--tab-track': v.bg2,
    '--tab-active-surface': v.bg3,
    '--tab-indicator': v.bg5,
    '--tab-selected-text': v.text,
    '--message-fill': 'var(--tab-indicator)',
    '--message-ink': 'var(--tab-selected-text)',
    '--matte-edge': 'rgb(255 255 255 / 7%)',
    '--control-border': 'var(--matte-edge)',
    '--control-border-hover': v.borderStrong,
    '--control-bg': 'var(--surface-2)',
    '--scrim': 'rgb(0 0 0 / 50%)',
    '--logo-filter': 'brightness(.92)',
    '--syntax-comment': v.textFaint,
    '--syntax-keyword': brand2,
    '--syntax-string': '#7fd8a4',
    '--syntax-number': '#e6b455',
    '--syntax-function': '#62b5ff',
    '--syntax-type': '#e6c56a',
    '--syntax-property': '#6fd8d0',
  }
  const decls = Object.entries(rows)
    .map(([k, val]) => `  ${k}: ${val} !important;`)
    .join('\n')
  const css = `/* ${name} — ported from TerminalHub's brand theme ramp */\n:root,\n:root[data-theme],\n:root[data-theme=dark] {\n${decls}\n}\n`
  const meta = {
    id, name, mode: 'dark',
    swatches: [v.bg1, v.bg3, brand2, v.text],
    version: 1,
    author: 'TerminalHub import',
  }
  return { css, meta }
}

for (const root of OUT_ROOTS) {
  for (const brand of BRANDS) {
    const dir = path.join(root, brand[0])
    fs.mkdirSync(dir, { recursive: true })
    const { css, meta } = buildTheme(brand)
    fs.writeFileSync(path.join(dir, 'style.css'), css)
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(meta, null, 2) + '\n')
  }
  console.log('wrote', BRANDS.length, 'themes to', root)
}
