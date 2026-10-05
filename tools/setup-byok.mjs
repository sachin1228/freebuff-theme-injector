/**
 * Set up (or check) the DeepSeek BYOK connection in a running Freebuff.
 *
 * The connection references its key as `env:DEEPSEEK_API_KEY` — no key ever
 * touches disk or this script. Freebuff must have been started with the key
 * exported (the Theme Injector passes its own environment through, so start
 * the Injector from a shell that has it).
 *
 * Usage:
 *   node tools/setup-byok.mjs [--inspect-port 41731] [--model deepseek-flash]
 *                             [--base-url https://api.deepseek.com/v1]
 *                             [--check]      # only report, create nothing
 */
import byok from '../src/main/byok.cjs'
import cdp from '../src/main/cdp.cjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = Number(arg('inspect-port', '41731'))
const MODEL = arg('model', byok.DEFAULT_MODEL)
const BASE_URL = arg('base-url', byok.DEFAULT_BASE_URL)
const CHECK_ONLY = args.includes('--check')

const line = (label, value) => console.log(String(label).padEnd(22) + value)

if (!(await cdp.isFreebuffInspectorUp(PORT))) {
  console.error(
    `Freebuff's inspector is not answering on 127.0.0.1:${PORT}.\n` +
      'Start Freebuff through the Theme Injector (switch on) or launch it with --inspect, then retry.',
  )
  process.exit(1)
}

let status = await byok.status(PORT)
line('Freebuff process', `up (inspector :${PORT})`)
line('DEEPSEEK_API_KEY', status.keyPresent ? 'visible to Freebuff' : 'NOT in Freebuff’s process')

if (!status.connection && !CHECK_ONLY) {
  console.log('\nCreating connection…')
  const created = await byok.setup(PORT, { model: MODEL, baseUrl: BASE_URL })
  if (!created.ok) {
    console.error('Could not create the connection:', created.error || created.status)
    process.exit(1)
  }
  if (created.created) {
    line('Created', `${created.connection.name} (${created.connection.id})`)
  } else {
    line('Existing', `${created.connection.name} (${created.connection.id})`)
  }
  status = await byok.status(PORT)
}

if (!status.connection) {
  console.error('\nNo DeepSeek connection is configured and --check was set.')
  process.exit(2)
}

const c = status.connection
line('Connection', c.name)
line('Provider', c.provider)
line('Model', c.model)
line('Base URL', c.baseUrl)
line('Credential ref', c.credentialRef)
line('Context window', String(c.contextWindow ?? '(default 32768)'))
line('Max output', String(c.maxOutputTokens ?? '(default 4096)'))
line('Routes to DeepSeek', String(byok.routesDirectlyToDeepSeek(c)))

console.log('\nValidating with the provider (this performs a real request)…')
const v = await byok.validate(PORT, c.id, c.revision)
if (!v.ok) {
  console.error('Validation call failed:', v.error)
  process.exit(1)
}
const result = v.result || {}
if (result.ok) {
  line('Validation', 'ok — DeepSeek answered')
  if (result.statusCode) line('HTTP status', String(result.statusCode))
  if (result.modelListed !== undefined) line('Model listed', String(result.modelListed))
  if (Array.isArray(result.availableModels) && result.availableModels.length) {
    line('Available models', result.availableModels.slice(0, 8).join(', '))
  }
  console.log('\nDone. Pick the connection in Freebuff (model picker → your connection) to route DeepSeek directly.')
} else {
  line('Validation', result.message || 'failed')
  console.log(
    '\nThe connection is stored. Fix the cause above (usually the key is not visible to\n' +
      'Freebuff), then re-run this script. To make the key visible: export it in the shell\n' +
      'you start the Theme Injector from, quit both apps, and start the Injector again.',
  )
}
