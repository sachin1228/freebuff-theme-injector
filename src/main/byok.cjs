/**
 * BYOK DeepSeek — set up and check a "bring your own key" provider
 * connection in Freebuff without writing anything inside the app.
 *
 * The connection references its credential as `env:DEEPSEEK_API_KEY`: the key
 * itself is never stored, never sent through this module and never copied to
 * disk. Freebuff reads the variable from its own process at request time, and
 * the Injector launches Freebuff with its own environment, so exporting the
 * key before starting the Injector is enough.
 *
 * The app's own rules do the rest: an `openai-compatible` connection pointing
 * at https://api.deepseek.com/v1 speaks Chat Completions, and DeepSeek sits in
 * the SDK's `openai` reasoning dialect, so the thread's effort slider maps
 * straight onto `reasoning_effort`.
 */
'use strict'

const cdp = require('./cdp.cjs')

const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const CREDENTIAL_REF = 'env:DEEPSEEK_API_KEY'
const NAME = 'DeepSeek (BYOK — env key)'

// Conservative, user-editable limits: the connection form pre-fills 32,768 /
// 4,096 when nobody chooses, which is too small for coding threads. 131,072 is
// the SDK's own "remote endpoint does not report a window" constant.
const CONTEXT_WINDOW = 131072
const MAX_OUTPUT_TOKENS = 8192

function deepseekConnection(connections) {
  if (!Array.isArray(connections)) return null
  return (
    connections.find(
      (c) =>
        c &&
        c.provider === 'openai-compatible' &&
        typeof c.baseUrl === 'string' &&
        /(^|\/\/|\.)deepseek\.com(\/|$)/i.test(c.baseUrl),
    ) || null
  )
}

/** Does this stored connection route to DeepSeek's own API? */
function routesDirectlyToDeepSeek(connection) {
  if (!connection || connection.provider !== 'openai-compatible') return false
  try {
    const url = new URL(String(connection.baseUrl || ''))
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com'
  } catch {
    return false
  }
}

async function list(port) {
  const script =
    '(async () => {' +
    ' const res = await fetch("/api/byok/connections");' +
    ' const body = await res.json().catch(() => null);' +
    ' return JSON.stringify({ status: res.status, connections: (body && body.connections) || [], error: (body && body.error) || null });' +
    '})()'
  const r = await cdp.evalInUi(port, script)
  if (!r.ok) return { ok: false, error: r.error }
  const data = typeof r.value === 'string' ? JSON.parse(r.value) : r.value
  return { ok: true, ...data }
}

async function setup(port, options = {}) {
  const model = options.model || DEFAULT_MODEL
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL
  const script =
    '(async () => {' +
    ' const NAME = ' + JSON.stringify(options.name || NAME) + ';' +
    ' const MODEL = ' + JSON.stringify(model) + ';' +
    ' const BASE = ' + JSON.stringify(baseUrl) + ';' +
    ' const REF = ' + JSON.stringify(CREDENTIAL_REF) + ';' +
    ' const listRes = await fetch("/api/byok/connections");' +
    ' const list = await listRes.json().catch(() => null);' +
    ' const existing = ((list && list.connections) || []).find((c) => c && c.provider === "openai-compatible" && typeof c.baseUrl === "string" && /deepseek\\.com/i.test(c.baseUrl));' +
    ' if (existing) return JSON.stringify({ created: false, connection: existing });' +
    ' const res = await fetch("/api/byok/connections", {' +
    '  method: "POST",' +
    '  headers: { "content-type": "application/json" },' +
    '  body: JSON.stringify({ name: NAME, provider: "openai-compatible", model: MODEL, baseUrl: BASE, credentialRef: REF, contextWindow: ' +
    CONTEXT_WINDOW +
    ', maxOutputTokens: ' +
    MAX_OUTPUT_TOKENS +
    ' }),' +
    ' });' +
    ' const body = await res.json().catch(() => null);' +
    ' return JSON.stringify({ created: res.status === 201, status: res.status, connection: (body && body.connection) || null, error: (body && body.error) || null });' +
    '})()'
  const r = await cdp.evalInUi(port, script)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, ...(typeof r.value === 'string' ? JSON.parse(r.value) : r.value) }
}

async function validate(port, id, revision) {
  const script =
    '(async () => {' +
    ' const res = await fetch("/api/byok/connections/" + encodeURIComponent(' +
    JSON.stringify(id) +
    ') + "/validate", {' +
    '  method: "POST",' +
    '  headers: { "content-type": "application/json" },' +
    '  body: JSON.stringify({ revision: ' +
    Number(revision) +
    ' }),' +
    ' });' +
    ' const body = await res.json().catch(() => null);' +
    ' return JSON.stringify({ status: res.status, result: body });' +
    '})()'
  const r = await cdp.evalInUi(port, script)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, ...(typeof r.value === 'string' ? JSON.parse(r.value) : r.value) }
}

/**
 * A full status for the Performance panel: whether the key is visible to
 * Freebuff's process (the Injector's env is what it launches with), whether a
 * connection exists, and whether it points at api.deepseek.com.
 */
async function status(port, env = process.env) {
  let keyPresent = !!env.DEEPSEEK_API_KEY
  const out = {
    keyPresent,
    credentialRef: CREDENTIAL_REF,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    inspectorUp: await cdp.isFreebuffInspectorUp(port).catch(() => false),
  }
  if (!out.inspectorUp) return out
  // The authority is Freebuff's own process environment: the key has to be
  // there at launch time, not merely in this tool's shell.
  try {
    const inFreebuff = await cdp.evalInMain(
      port,
      '!!(process.env && process.env.DEEPSEEK_API_KEY)',
    )
    if (typeof inFreebuff === 'boolean') {
      keyPresent = inFreebuff
      out.keyPresent = inFreebuff
    }
  } catch {}
  const listed = await list(port)
  if (!listed.ok) {
    out.error = listed.error
    return out
  }
  const connection = deepseekConnection(listed.connections)
  out.connections = listed.connections
  if (connection) {
    out.connection = connection
    out.direct = routesDirectlyToDeepSeek(connection)
    out.credentialOk = connection.credentialRef === CREDENTIAL_REF || !!connection.credentialRef
  }
  return out
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  CREDENTIAL_REF,
  NAME,
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  deepseekConnection,
  routesDirectlyToDeepSeek,
  list,
  setup,
  validate,
  status,
}
