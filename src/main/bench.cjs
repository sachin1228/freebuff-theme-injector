/**
 * Freebuff benchmark runner.
 *
 * Sends one short prompt to a fresh thread on the hosted DeepSeek V4.1 Flash
 * model and reports what the performance tap measured: time to first token,
 * when reasoning started, when visible text started, compaction passes and
 * capacity waits — plus the total turn.
 *
 * It runs entirely through a running, bridge-launched Freebuff: the script
 * below executes in the app's own UI page, so the messages it creates appear
 * in Freebuff like any other thread. A fresh thread means no compaction and a
 * tiny context, which is the honest "same prompt, same model" comparison
 * baseline.
 */
'use strict'

const cdp = require('./cdp.cjs')

const DEFAULT_PROMPT = 'Reply with exactly: BENCH-OK'
const DEFAULT_EFFORT = 'low'
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'
const RUN_TIMEOUT_MS = 180000

function pageScript(options) {
  const prompt = JSON.stringify(options.prompt || DEFAULT_PROMPT)
  const effort = JSON.stringify(options.effort || DEFAULT_EFFORT)
  const model = JSON.stringify(options.model || DEFAULT_MODEL)
  const requestedProject = JSON.stringify(options.projectPath || '')
  const runs = Number(options.runs) > 0 ? Math.min(5, Number(options.runs)) : 1
  const timeoutMs = Math.min(RUN_TIMEOUT_MS, Number(options.timeoutMs) || RUN_TIMEOUT_MS)

  return (
    '(async () => {' +
    ' const P = window.__FBS_PERF__;' +
    ' if (!P) return JSON.stringify({ ok: false, error: "The performance tap is not installed in this Freebuff window. Turn the Injector on and let Freebuff restart, then retry." });' +
    ' const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    ' const json = (r) => r.json().catch(() => null);' +
    ' const projectsRes = await fetch("/api/projects");' +
    ' const projectsBody = await json(projectsRes);' +
    ' const list = Array.isArray(projectsBody) ? projectsBody : (projectsBody && (projectsBody.projects || projectsBody.recent)) || [];' +
    ' const pathOf = (p) => (p && (p.path || p.rootPath || p.projectPath)) || null;' +
    ' const wanted = ' + requestedProject + ';' +
    ' let projectPath = wanted || null;' +
    ' if (!projectPath) {' +
    '  for (const p of list) { const q = pathOf(p); if (q) { projectPath = q; break } }' +
    ' }' +
    ' if (!projectPath) return JSON.stringify({ ok: false, error: "No project is open in Freebuff to create a benchmark thread in." });' +
    ' const out = { ok: true, projectPath, prompt: ' + prompt + ', effort: ' + effort + ', model: ' + model + ', runs: [] };' +
    ' for (let i = 0; i < ' + runs + '; i++) {' +
    '  if (i > 0) await sleep(1500);' +
    '  const created = await fetch("/api/threads", {' +
    '   method: "POST",' +
    '   headers: { "content-type": "application/json" },' +
    '   body: JSON.stringify({ projectPath, harnessId: "codebuff", model: ' + model + ', reasoningEffort: ' + effort + ', executionMode: "local" }),' +
    '  });' +
    '  const createdBody = await json(created);' +
    '  /* POST /api/threads answers with the thread object itself (200), not {thread}. */' +
    '  const thread = createdBody && typeof createdBody.id === "string" ? createdBody : (createdBody && createdBody.thread);' +
    '  if (!created.ok || !thread || !thread.id) {' +
    '   out.runs.push({ error: "Could not create a benchmark thread: " + ((createdBody && createdBody.error) || created.status) });' +
    '   continue;' +
    '  }' +
    '  const threadId = thread.id;' +
    '  const sent = await fetch("/api/thread/" + encodeURIComponent(threadId) + "/message", {' +
    '   method: "POST",' +
    '   headers: { "content-type": "application/json" },' +
    '   body: JSON.stringify({ text: ' + prompt + ', attachments: [] }),' +
    '  });' +
    '  if (!sent.ok) {' +
    '   const sb = await json(sent);' +
    '   out.runs.push({ threadId, error: "Could not send the benchmark prompt: " + ((sb && sb.error) || sent.status) });' +
    '   continue;' +
    '  }' +
    '  const deadline = Date.now() + ' + timeoutMs + ';' +
    '  let view = null;' +
    '  while (Date.now() < deadline) {' +
    '   view = P.turn(threadId);' +
    '   if (view && view.ended) break;' +
    '   await sleep(250);' +
    '  }' +
    '  if (!view) { out.runs.push({ threadId, error: "No turn was recorded for this thread." }); continue }' +
    '  out.runs.push({' +
    '   threadId,' +
    '   model: view.model || null,' +
    '   effort: view.effort || null,' +
    '   ttftMs: view.ttftMs,' +
    '   firstKind: view.firstKind,' +
    '   reasoningStartMs: view.reasoningStartMs,' +
    '   answerStartMs: view.answerStartMs,' +
    '   toolStartMs: view.toolStartMs,' +
    '   toolCalls: view.toolCalls,' +
    '   compaction: view.compaction || null,' +
    '   notice: view.notice || null,' +
    '   capacityWaitMs: view.capacityWaitMs,' +
    '   contextTokens: view.contextTokens,' +
    '   totalMs: view.ended ? view.elapsedMs : null,' +
    '   timedOut: !view.ended,' +
    '  });' +
    ' }' +
    ' return JSON.stringify(out);' +
    '})()'
  )
}

async function run(port, options = {}) {
  const r = await cdp.evalInUi(port, pageScript(options))
  if (!r.ok) return { ok: false, error: r.error }
  try {
    return typeof r.value === 'string' ? JSON.parse(r.value) : r.value
  } catch (e) {
    return { ok: false, error: 'could not parse benchmark result: ' + e.message }
  }
}

module.exports = { run, DEFAULT_PROMPT, DEFAULT_EFFORT, DEFAULT_MODEL }
