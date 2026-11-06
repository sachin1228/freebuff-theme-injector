/**
 * Patched Freebuff copy builder.
 *
 * Freebuff 0.0.201 exits on launch when any Chromium remote-debugging switch is
 * present:
 *
 *     if (app.isPackaged && hasRemoteDebuggingSwitch(process.argv)) app.exit(1)
 *
 * and its Electron fuses disable NODE_OPTIONS, --inspect and
 * ELECTRON_RUN_AS_NODE, so the Injector has no channel into a stock install.
 *
 * Instead of touching /Applications/Freebuff.app (Developer ID signed, hardened
 * runtime, asar integrity hash in Info.plist), this builds a private copy under
 * ~/.freebuff-theme-studio/freebuff-themed that:
 *   - has the launch guard neutralised inside app.asar (same byte length, so
 *     every file offset in the archive stays valid),
 *   - points its updater at a dead loopback feed, so the copy can never be
 *     replaced by a stock build,
 *   - is ad-hoc re-signed so macOS will run it.
 *
 * The copy must keep app.asar: Freebuff enables the OnlyLoadAppFromAsar fuse,
 * so an unpacked `app/` directory is ignored and the app exits immediately.
 * Asar-integrity validation is disabled, which is what makes the in-place
 * patch viable.
 *
 * Rebuilt automatically when the source app's version or mtime changes.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

const ROOT = path.join(os.homedir(), '.freebuff-theme-studio')
const PATCH_DIR = path.join(ROOT, 'freebuff-themed')
const BUNDLE = path.join(PATCH_DIR, 'Freebuff.app')
const EXE = path.join(BUNDLE, 'Contents', 'MacOS', 'Freebuff')
const META = path.join(PATCH_DIR, 'meta.json')

// Bump when the patch recipe changes so existing copies are rebuilt.
const FINGERPRINT = 'guard-removed-in-asar+no-updates-1'

const DEAD_FEED = [
  'provider: generic',
  'url: "http://127.0.0.1:9/"',
  'updaterCacheDirName: "freebuff-themed-disabled"',
  '',
].join('\n')

const GUARD_EXPR = 'hasRemoteDebuggingSwitch(process.argv)'

function run(cmd, args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(cmd + ' failed: ' + String(stderr || err.message).trim()))
      else resolve(String(stdout))
    })
  })
}

/** Walk up from the executable to the enclosing .app bundle. */
function bundleOf(exePath) {
  let dir = path.dirname(String(exePath || ''))
  while (dir && dir !== path.dirname(dir)) {
    if (dir.endsWith('.app')) return dir
    dir = path.dirname(dir)
  }
  return null
}

async function versionOf(bundle) {
  const out = await run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print CFBundleShortVersionString',
    path.join(bundle, 'Contents', 'Info.plist'),
  ])
  return out.trim()
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Neutralise the launch guard inside app.asar, in place.
 *
 * The expression becomes a commented-out false literal, padded to the original
 * byte length so every offset in the archive (and the header) stays as it was.
 * Asar-integrity validation is disabled on this app, so the stale per-file
 * hash for main.cjs is not checked; the bundle is re-signed after the edit.
 */
function patchAsar(asarPath) {
  const buf = fs.readFileSync(asarPath)
  const needle = Buffer.from(GUARD_EXPR)
  const replacement = Buffer.from('false/*' + 'x'.repeat(needle.length - 9) + '*/')
  if (replacement.length !== needle.length) throw new Error('asar patch length mismatch')
  let hits = 0
  let idx = buf.indexOf(needle)
  while (idx !== -1) {
    replacement.copy(buf, idx)
    hits += 1
    idx = buf.indexOf(needle, idx + needle.length)
  }
  if (hits) fs.writeFileSync(asarPath, buf)
  return hits
}

async function build(source, version, sourceMtime) {
  fs.rmSync(PATCH_DIR, { recursive: true, force: true })
  fs.mkdirSync(PATCH_DIR, { recursive: true })

  // APFS clone: instant and cheap; ditto as the portable fallback.
  try {
    await run('cp', ['-cR', source, BUNDLE])
  } catch {
    fs.rmSync(BUNDLE, { recursive: true, force: true })
    await run('ditto', [source, BUNDLE])
  }

  const resources = path.join(BUNDLE, 'Contents', 'Resources')
  const hits = patchAsar(path.join(resources, 'app.asar'))
  if (!hits) throw new Error('launch guard not found in Freebuff ' + version)

  // A dead feed: the copy never downloads or installs an update.
  fs.writeFileSync(path.join(resources, 'app-update.yml'), DEAD_FEED)

  try {
    await run('xattr', ['-dr', 'com.apple.quarantine', BUNDLE])
  } catch {}

  await run('codesign', ['--force', '--deep', '--sign', '-', BUNDLE])

  const meta = {
    fingerprint: FINGERPRINT,
    source,
    version,
    sourceMtime,
    builtAt: new Date().toISOString(),
    guardsRemoved: hits,
    bundle: BUNDLE,
    exe: EXE,
  }
  fs.writeFileSync(META, JSON.stringify(meta))
  return meta
}

let building = null

/** Build (or reuse) the patched copy of the installed Freebuff. */
async function ensureThemedCopy(exePath) {
  const source = bundleOf(exePath)
  if (!source) throw new Error('Freebuff.app bundle not found')
  if (building) return building
  building = (async () => {
    const version = await versionOf(source)
    const sourceMtime = fs.statSync(source).mtimeMs
    const meta = readMeta()
    if (
      meta &&
      meta.fingerprint === FINGERPRINT &&
      meta.version === version &&
      meta.sourceMtime === sourceMtime &&
      fs.existsSync(EXE)
    ) {
      return meta
    }
    return build(source, version, sourceMtime)
  })().finally(() => {
    building = null
  })
  return building
}

module.exports = {
  ROOT,
  PATCH_DIR,
  BUNDLE,
  EXE,
  PATCHED_EXE: EXE,
  ensureThemedCopy,
  bundleOf,
}
