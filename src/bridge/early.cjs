/**
 * Freebuff Theme Bridge — the earliest hook into Freebuff's process.
 *
 * The Theme Injector's launcher starts Freebuff with
 * `NODE_OPTIONS=--require <this file>`. WHEN THE FUSE ALLOWS IT this is the
 * one moment of a launch in which nothing of Freebuff has run yet — no
 * window, no painted frame — which is exactly what first-paint theming needs
 * (see boot.cjs). Packaged Electron apps usually reject NODE_OPTIONS
 * (node_bindings "Most NODE_OPTIONs are not supported" and the var is
 * neutralized), so treat this path as best-effort: the inspector attach from
 * the Injector is the mechanism that must land. Electron's
 * `require('electron')` is not resolvable this early either, so we poll for a
 * few ticks and then hand off to boot.cjs.
 *
 * The guard makes a stray require inert: only the real Electron main process
 * proceeds (utility processes and renderers that inherited NODE_OPTIONS fall
 * straight through). It deliberately reads no Electron globals at require
 * time — `process.type` / `process.versions.electron` may not be set yet
 * during the early bootstrap — the checks run inside handoff() instead.
 */
'use strict'

if (!globalThis.__FBS_EARLY__) {
  globalThis.__FBS_EARLY__ = true

  try {
    const path = require('node:path')
    const shared = require(path.join(__dirname, 'shared.cjs'))

    // Before anything of Freebuff's can spawn a child: the orchestrator (bun)
    // and every other child must not inherit this --require. Only the entry
    // we added is removed, so a user's own NODE_OPTIONS survives. (boot.cjs
    // repeats this as a safety net; by then it is a no-op.)
    try {
      const cleaned = shared.stripEarlyRequire(process.env.NODE_OPTIONS)
      if (cleaned) process.env.NODE_OPTIONS = cleaned
      else delete process.env.NODE_OPTIONS
    } catch {}

    // `require('electron')` throws during the first ticks of the process and
    // starts resolving well before the app is ready — poll until it does.
    // The cap is an escape hatch, not a budget: resolution takes ~30ms.
    let attempts = 0
    const handoff = () => {
      attempts += 1
      try {
        require('electron')
      } catch {
        if (attempts < 5000) setTimeout(handoff, 0)
        return
      }
      // Only the main (browser) process may hand off; by now the context has
      // taken shape, so reading these globals is safe.
      if (!(process.versions && process.versions.electron) || process.type !== 'browser') return
      try {
        require(path.join(__dirname, 'boot.cjs'))
      } catch (err) {
        try {
          console.error('[freebuff-theme-bridge] early handoff failed:', err && err.message)
        } catch {}
      }
    }
    handoff()
  } catch (err) {
    try {
      console.error('[freebuff-theme-bridge] early loader disabled:', err && err.message)
    } catch {}
  }
}
