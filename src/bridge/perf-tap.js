/**
 * Freebuff Performance Tap — main-world instrumentation for the Theme
 * Injector's performance overlay.
 *
 * Runs inside every Freebuff UI document before the app's own scripts
 * (boot.cjs installs it through the generated session preload, with a
 * dom-ready re-injection as a fallback). It never changes what the app sees:
 * it wraps `EventSource` and `fetch`, forwards every call untouched, and
 * records timings alongside.
 *
 * What it times, per thread:
 *  - send → first activity (any reasoning/text/tool/compaction event) = TTFT
 *  - send → first reasoning delta, first visible text, first tool call
 *  - status stages (request-sent, thinking, admitting, capacity-wait, …)
 *  - compaction passes (duration, trigger, pre/post tokens) from the
 *    `compaction` event and `message-metrics` receipts
 *  - turn end (`finish`), plus context tokens once a model step reports them
 *
 * State is exposed on `window.__FBS_PERF__` so the overlay (perf-overlay.js)
 * and the Theme Injector's benchmark tooling can read it. The tap keeps its
 * own ring buffer and is safe to call twice: the first instance wins.
 */
;(function () {
  'use strict'

  if (window.__FBS_PERF__) return

  var EMBEDDED_CONFIG = window.__FBS_PERF_CONFIG__ || {}
  var MAX_EVENTS = 4000
  var MAX_TURNS = 40

  var DEFAULTS = {
    enabled: true,
    overlay: true,
    nudge: true,
    nudgeIdleMs: 12 * 60 * 1000,
    nudgeContextTokens: 40000,
    effortDefault: 'low',
  }

  var config = Object.assign({}, DEFAULTS, EMBEDDED_CONFIG)
  var subscribers = []
  var events = []
  var turns = {} // threadId -> newest turn
  var turnOrder = [] // threadIds, most recent first
  var meta = {} // threadId -> { model, harnessId, effort }
  var queuedSends = {} // threadId -> count of sends while a turn ran
  var lastActivityAt = {} // threadId -> ts of the last SSE event
  var tappedInstances = 0 // EventSource objects built through our wrapper
  var tappedMessages = 0 // SSE messages seen through wrapped instances
  var probe = null // late-injection fallback stream (see below)
  var probeRetry = null
  var probeArmed = false

  function now() {
    return Date.now()
  }

  function emit(kind, threadId, data) {
    var ev = { t: now(), kind: kind, threadId: threadId || null, data: data || null }
    events.push(ev)
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    for (var i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i](ev)
      } catch (e) {}
    }
    return ev
  }

  function touch(threadId) {
    if (threadId) lastActivityAt[threadId] = now()
  }

  function newTurn(threadId, sendT, source) {
    return {
      id: 't' + sendT + '-' + Math.random().toString(36).slice(2, 6),
      threadId: threadId,
      source: source || 'send',
      startedAt: sendT,
      firstAt: null,
      firstKind: null,
      firstReasoningAt: null,
      firstTextAt: null,
      firstToolAt: null,
      toolCalls: 0,
      stages: {},
      currentStage: null,
      stageSince: sendT,
      capacityWaitMs: 0,
      compaction: null,
      compactions: [],
      notice: null,
      finishAt: null,
      ended: false,
      contextTokens: null,
      windowTokens: null,
      compactionThresholdTokens: null,
      effort: null,
    }
  }

  function currentTurn(threadId) {
    var t = turns[threadId]
    return t && !t.ended ? t : null
  }

  function startTurn(threadId, sendT, source) {
    var active = currentTurn(threadId)
    if (active) {
      queuedSends[threadId] = (queuedSends[threadId] || 0) + 1
      emit('send-queued', threadId, { pending: queuedSends[threadId] })
      return active
    }
    var turn = newTurn(threadId, sendT, source)
    turns[threadId] = turn
    // Keep the newest MAX_TURNS threads addressable from the overlay.
    turnOrder = [threadId].concat(turnOrder.filter(function (id) { return id !== threadId }))
    if (turnOrder.length > MAX_TURNS) {
      var dropped = turnOrder.slice(MAX_TURNS)
      turnOrder = turnOrder.slice(0, MAX_TURNS)
      for (var i = 0; i < dropped.length; i++) delete turns[dropped[i]]
    }
    emit('turn-start', threadId, { source: turn.source })
    return turn
  }

  function finishTurn(threadId, t) {
    var turn = currentTurn(threadId)
    if (!turn) return
    turn.finishAt = t
    turn.ended = true
    emit('turn-end', threadId, {
      totalMs: turn.finishAt - turn.startedAt,
      ttftMs: turn.firstAt ? turn.firstAt - turn.startedAt : null,
    })
    if (queuedSends[threadId]) {
      queuedSends[threadId] -= 1
      if (queuedSends[threadId] <= 0) delete queuedSends[threadId]
      startTurn(threadId, t, 'queue')
    }
  }

  function markFirst(turn, kind) {
    var t = now()
    if (!turn.firstAt) {
      turn.firstAt = t
      turn.firstKind = kind
    }
    if (kind === 'reasoning' && !turn.firstReasoningAt) turn.firstReasoningAt = t
    if (kind === 'text' && !turn.firstTextAt) turn.firstTextAt = t
    if (kind === 'tool' && !turn.firstToolAt) turn.firstToolAt = t
  }

  function stage(threadId, turn, name) {
    var t = now()
    if (turn.currentStage === name) return
    if (turn.currentStage) {
      var spent = t - turn.stageSince
      turn.stages[turn.currentStage] = (turn.stages[turn.currentStage] || 0) + spent
      if (turn.currentStage === 'capacity-wait') turn.capacityWaitMs += spent
    }
    turn.currentStage = name
    turn.stageSince = t
    if (name) emit('stage', threadId, { stage: name })
  }

  function closeStage(turn) {
    if (!turn || !turn.currentStage) return
    var spent = now() - turn.stageSince
    turn.stages[turn.currentStage] = (turn.stages[turn.currentStage] || 0) + spent
    if (turn.currentStage === 'capacity-wait') turn.capacityWaitMs += spent
    turn.currentStage = null
  }

  function applyContext(turn, context) {
    if (!context || typeof context !== 'object') return
    if (typeof context.usedTokens === 'number') turn.contextTokens = context.usedTokens
    if (typeof context.windowTokens === 'number') turn.windowTokens = context.windowTokens
    if (typeof context.compactionThresholdTokens === 'number') {
      turn.compactionThresholdTokens = context.compactionThresholdTokens
    }
  }

  function applyMetrics(threadId, metrics) {
    if (!metrics || typeof metrics !== 'object') return
    var turn = currentTurn(threadId) || turns[threadId]
    if (!turn) return
    if (metrics.context) applyContext(turn, metrics.context)
    var list = Array.isArray(metrics.compactions) ? metrics.compactions : []
    for (var i = 0; i < list.length; i++) {
      var c = list[i]
      if (!c || typeof c !== 'object') continue
      if (turn.compactions.some(function (x) { return sameCompaction(x, c) })) continue
      turn.compactions.push(c)
      turn.compaction = {
        trigger: c.trigger || null,
        durationMs: typeof c.durationMs === 'number' ? c.durationMs : null,
        preTokens: typeof c.preTokens === 'number' ? c.preTokens : null,
        postTokens: typeof c.postTokens === 'number' ? c.postTokens : null,
        at: now(),
        source: 'metrics',
      }
      emit('compaction-metrics', threadId, turn.compaction)
    }
  }

  function sameCompaction(a, b) {
    return (
      a &&
      b &&
      a.trigger === b.trigger &&
      a.preTokens === b.preTokens &&
      a.postTokens === b.postTokens &&
      a.durationMs === b.durationMs
    )
  }

  /* ---------- SSE ingest ---------- */

  function ingestAgentEvent(threadId, event) {
    if (!event || typeof event !== 'object') return
    touch(threadId)
    var type = event.type
    var turn = currentTurn(threadId)
    if (!turn) {
      // A turn we never saw a send for: another client (mission, queue) or a
      // missed fetch hook. Only *output* events may open one — a `finish` or
      // `status` for a turn that ended before the tap landed must not
      // fabricate a turn (it would read as a 0ms total forever running).
      var startsTurn =
        type === 'reasoning_delta' || type === 'text' || type === 'tool_call' || type === 'compaction'
      if (!startsTurn) {
        if (type === 'finish' && event.metrics) applyMetrics(threadId, event.metrics)
        return
      }
      turn = startTurn(threadId, now(), 'stream')
    }

    if (type === 'status') {
      var stageName = typeof event.stage === 'string' ? event.stage : null
      // A status event means the turn is alive: close any capacity wait when
      // it is followed by real work.
      if (stageName && stageName !== 'capacity-wait') closeStageBefore(turn, stageName)
      stage(threadId, turn, stageName)
      return
    }
    if (type === 'reasoning_delta') {
      if (event.text) {
        closeStage(turn)
        markFirst(turn, 'reasoning')
      }
      return
    }
    if (type === 'text') {
      if (event.text) {
        closeStage(turn)
        markFirst(turn, 'text')
      }
      return
    }
    if (type === 'tool_call') {
      closeStage(turn)
      markFirst(turn, 'tool')
      turn.toolCalls += 1
      return
    }
    if (type === 'compaction') {
      closeStage(turn)
      markFirst(turn, 'compaction')
      var receipt = event.receipt && typeof event.receipt === 'object' ? event.receipt : {}
      turn.compaction = {
        trigger: receipt.trigger || null,
        durationMs: typeof receipt.durationMs === 'number' ? receipt.durationMs : null,
        preTokens: typeof receipt.preTokens === 'number' ? receipt.preTokens : null,
        postTokens: typeof receipt.postTokens === 'number' ? receipt.postTokens : null,
        at: now(),
        source: 'event',
      }
      if (receipt.postTokens !== undefined) turn.contextTokens = receipt.postTokens
      if (receipt.thresholdTokens !== undefined) turn.compactionThresholdTokens = receipt.thresholdTokens
      turn.compactions.push(turn.compaction)
      emit('compaction', threadId, turn.compaction)
      return
    }
    if (type === 'finish') {
      closeStage(turn)
      if (event.metrics) applyMetrics(threadId, event.metrics)
      finishTurn(threadId, now())
      return
    }
    if (type === 'notice') {
      closeStage(turn)
      // Engine notices carry the why of an aborted turn (e.g. the hosted-model
      // slot being taken by another tab). Keep the last one for the card and
      // the benchmark — a turn that ends in 0.7s with no tokens is otherwise
      // indistinguishable from a network failure.
      turn.notice = {
        notice: typeof event.notice === 'string' ? event.notice : null,
        text: typeof event.text === 'string' ? event.text : null,
        at: now(),
      }
      emit('notice', threadId, turn.notice)
      return
    }
    if (type === 'subagent_start' || type === 'subagent_finish') {
      closeStage(turn)
      return
    }
    if (type === 'response_reset') {
      return
    }
  }

  function closeStageBefore(turn, nextStage) {
    if (turn.currentStage && turn.currentStage !== nextStage) closeStage(turn)
  }

  function ingest(raw) {
    if (!raw || typeof raw !== 'object') return
    var threadId = typeof raw.threadId === 'string' ? raw.threadId : null
    if (raw.type === 'agent' && raw.event && typeof raw.event === 'object') {
      ingestAgentEvent(threadId, raw.event)
      return
    }
    if (raw.type === 'message-metrics') {
      if (threadId) applyMetrics(threadId, raw.metrics)
      return
    }
    if (raw.type === 'thread' && threadId && raw.thread && typeof raw.thread === 'object') {
      var th = raw.thread
      meta[threadId] = meta[threadId] || {}
      if (typeof th.model === 'string') meta[threadId].model = th.model
      if (typeof th.harnessId === 'string') meta[threadId].harnessId = th.harnessId
      if (typeof th.reasoningEffort === 'string') meta[threadId].effort = th.reasoningEffort
      if (th.autoCompacting === true) {
        var active = currentTurn(threadId)
        if (active && !active.compactionStartedAt) {
          active.compactionStartedAt = now()
          emit('compaction-start', threadId, null)
        }
      }
      return
    }
    if (raw.type === 'prompt' && threadId) {
      // Queued/steered prompt delivered to the engine.
      if (typeof raw.origin === 'string' || raw.text !== undefined) {
        var running = currentTurn(threadId)
        if (!running) startTurn(threadId, now(), 'prompt')
      }
      touch(threadId)
      return
    }
    if (raw.type === 'message-committed' && threadId) touch(threadId)
  }

  /* ---------- late-injection SSE fallback ----------
     Loaded from the session preload, the tap wraps EventSource before the
     app's code runs, and every message flows through the wrapper below. If
     the tap arrives late (the dom-ready re-injection path) the app's own
     stream already exists and cannot be wrapped — so open a second,
     read-only subscription and feed it to ingest() until a wrapped stream
     proves it is live. /api/events is a broadcast, so extra subscribers are
     harmless. */

  function stopProbe() {
    if (probeRetry) {
      clearTimeout(probeRetry)
      probeRetry = null
    }
    if (probe) {
      try {
        probe.close()
      } catch (e) {}
      probe = null
    }
  }

  function startProbe() {
    if (probe) return
    if (!config.enabled) return
    if (tappedInstances > 0 || tappedMessages > 0) return
    if (typeof NativeEventSource !== 'function') return
    if (!/^https?:$/.test(location.protocol)) return
    if (!document.querySelector('#root')) return // only the app's own document
    try {
      var es = new NativeEventSource('/api/events')
      probe = es
      es.onmessage = function (m) {
        if (tappedInstances > 0 || tappedMessages > 0) {
          stopProbe()
          return
        }
        try {
          ingest(JSON.parse(m.data))
        } catch (e) {}
      }
      es.onerror = function () {
        stopProbe()
        if (tappedInstances === 0 && tappedMessages === 0) {
          probeRetry = setTimeout(startProbe, 5000)
        }
      }
      emit('probe-open', null, { url: '/api/events' })
    } catch (e) {
      stopProbe()
    }
  }

  function armProbe() {
    if (probeArmed) return
    if (document.readyState === 'loading') {
      document.addEventListener('readystatechange', armProbe)
      return
    }
    if (document.readyState !== 'complete') {
      window.addEventListener('load', armProbe, { once: true })
      return
    }
    probeArmed = true
    // The app mounts its React tree and subscribes well before load; if no
    // wrapped stream exists by now, the tap missed the boat — use our own.
    setTimeout(function () {
      if (tappedInstances === 0 && tappedMessages === 0) startProbe()
    }, 1500)
  }

  /* ---------- EventSource tap ---------- */

  var NativeEventSource = window.EventSource
  if (typeof NativeEventSource === 'function') {
    function TapEventSource(url, options) {
      var es = new NativeEventSource(url, options)
      tappedInstances += 1
      stopProbe()
      try {
        es.addEventListener('message', function (m) {
          tappedMessages += 1
          stopProbe()
          try {
            ingest(JSON.parse(m.data))
          } catch (e) {}
        })
        es.addEventListener('open', function () {
          emit('sse-open', null, { url: String(url) })
        })
        es.addEventListener('error', function () {
          emit('sse-error', null, { url: String(url) })
        })
      } catch (e) {}
      return es
    }
    TapEventSource.prototype = NativeEventSource.prototype
    ;['CONNECTING', 'OPEN', 'CLOSED'].forEach(function (k) {
      if (k in NativeEventSource) TapEventSource[k] = NativeEventSource[k]
    })
    window.EventSource = TapEventSource
  }

  /* ---------- fetch tap ---------- */

  function pathOf(input) {
    try {
      var raw =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
            ? input.url
            : null
      if (!raw) return null
      var u = new URL(raw, location.href)
      return { path: u.pathname, url: u.toString() }
    } catch (e) {
      return null
    }
  }

  function methodOf(input, init) {
    if (init && typeof init.method === 'string') return init.method.toUpperCase()
    if (input && typeof input === 'object' && typeof input.method === 'string') {
      return input.method.toUpperCase()
    }
    return 'GET'
  }

  function bodyOf(init) {
    try {
      if (!init || typeof init.body !== 'string') return null
      return JSON.parse(init.body)
    } catch (e) {
      return null
    }
  }

  function maybeDefaultEffort(thread) {
    if (!config.effortDefault) return
    if (!thread || typeof thread !== 'object' || typeof thread.id !== 'string') return
    if (thread.reasoningEffort !== undefined && thread.reasoningEffort !== null) return
    if (thread.harnessId !== undefined && thread.harnessId !== null && thread.harnessId !== 'codebuff') return
    var model = typeof thread.model === 'string' ? thread.model : ''
    if (model && !/deepseek/i.test(model)) return
    var turnMeta = meta[thread.id] || (meta[thread.id] = {})
    turnMeta.effort = config.effortDefault
    emit('effort-default', thread.id, { effort: config.effortDefault, model: model || null })
    try {
      nativeFetch.call(window, '/api/thread/' + encodeURIComponent(thread.id) + '/effort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: config.effortDefault }),
      }).catch(function () {})
    } catch (e) {}
  }

  function observeThreadsResponse(res) {
    if (!res || typeof res.clone !== 'function') return
    try {
      res
        .clone()
        .json()
        .then(function (payload) {
          // POST /api/threads answers with the thread object itself.
          var thread =
            payload && typeof payload.id === 'string'
              ? payload
              : payload && payload.thread && typeof payload.thread === 'object'
                ? payload.thread
                : null
          if (!thread) return
          try {
            maybeDefaultEffort(thread)
          } catch (e) {}
        })
        .catch(function () {})
    } catch (e) {}
  }

  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var method = methodOf(input, init)
      var info = pathOf(input)
      var promise = nativeFetch.apply(this, arguments)
      if (info && info.path.indexOf('/api/') === 0) {
        try {
          var m = /^\/api\/thread\/([^/]+)\/(message|queue|compact|effort)$/.exec(info.path)
          var created = method === 'POST' && info.path === '/api/threads'
          var effort = m && method === 'POST' && m[2] === 'effort'
          if (m && method === 'POST' && m[2] === 'message') {
            var body = bodyOf(init)
            startTurn(decodeURIComponent(m[1]), now(), 'send')
            emit('send', decodeURIComponent(m[1]), {
              textLength: body && typeof body.text === 'string' ? body.text.length : null,
            })
          }
          if (m && method === 'POST' && m[2] === 'compact') {
            var compactThread = decodeURIComponent(m[1])
            var turn = currentTurn(compactThread)
            if (turn && !turn.compactionStartedAt) turn.compactionStartedAt = now()
            emit('compact-request', compactThread, null)
          }
          if (effort) {
            var effThread = decodeURIComponent(m[1])
            meta[effThread] = meta[effThread] || {}
            var eb = bodyOf(init)
            meta[effThread].effort =
              eb && typeof eb.effort === 'string' ? eb.effort : config.effortDefault
            emit('effort-set', effThread, { effort: meta[effThread].effort })
          }
          if (created) promise.then(observeThreadsResponse, function () {})
        } catch (e) {}
      }
      return promise
    }
  }

  /* ---------- public state ---------- */

  function turnView(threadId) {
    var turn = turns[threadId]
    if (!turn) return null
    var ttft = turn.firstAt ? turn.firstAt - turn.startedAt : null
    var elapsed = (turn.finishAt || now()) - turn.startedAt
    return {
      id: turn.id,
      threadId: threadId,
      source: turn.source,
      startedAt: turn.startedAt,
      ttftMs: ttft,
      firstKind: turn.firstKind,
      reasoningStartMs: turn.firstReasoningAt ? turn.firstReasoningAt - turn.startedAt : null,
      answerStartMs: turn.firstTextAt ? turn.firstTextAt - turn.startedAt : null,
      toolStartMs: turn.firstToolAt ? turn.firstToolAt - turn.startedAt : null,
      toolCalls: turn.toolCalls,
      stages: Object.assign({}, turn.stages, turn.currentStage
        ? { [turn.currentStage]: (turn.stages[turn.currentStage] || 0) + (now() - turn.stageSince) }
        : {}),
      capacityWaitMs: turn.capacityWaitMs,
      compaction: turn.compaction,
      compactions: turn.compactions.slice(),
      notice: turn.notice,
      finishAt: turn.finishAt,
      ended: turn.ended,
      elapsedMs: elapsed,
      contextTokens: turn.contextTokens,
      windowTokens: turn.windowTokens,
      compactionThresholdTokens: turn.compactionThresholdTokens,
      effort: (meta[threadId] && meta[threadId].effort) || null,
      model: (meta[threadId] && meta[threadId].model) || null,
    }
  }

  function turnsList() {
    return turnOrder.map(turnView).filter(Boolean)
  }

  function idleMs(threadId) {
    var last = lastActivityAt[threadId]
    if (!last) return 0
    return now() - last
  }

  /**
   * Threads whose next message would pay for a compaction pass: the engine
   * compacts a DeepSeek Flash thread that sat idle past its cache window once
   * it carries enough tokens. The overlay surfaces this before it fires.
   */
  function nudges() {
    if (!config.nudge) return []
    var out = []
    var ids = Object.keys(turns)
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]
      var turn = turns[id]
      if (!turn || !turn.ended) continue
      var idle = idleMs(id)
      if (idle < config.nudgeIdleMs) continue
      if (typeof turn.contextTokens !== 'number') continue
      if (turn.contextTokens < config.nudgeContextTokens) continue
      out.push({
        threadId: id,
        idleMs: idle,
        contextTokens: turn.contextTokens,
        compactionThresholdTokens: turn.compactionThresholdTokens,
      })
    }
    out.sort(function (a, b) { return b.idleMs - a.idleMs })
    return out
  }

  function compactNow(threadId) {
    if (!threadId) return Promise.resolve(null)
    return nativeFetch
      .call(window, '/api/thread/' + encodeURIComponent(threadId) + '/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      .then(function (r) {
        return r.json().catch(function () { return null })
      })
  }

  function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return config
    config = Object.assign({}, config, patch)
    emit('config', null, { config: config })
    return config
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {}
    subscribers.push(fn)
    return function () {
      subscribers = subscribers.filter(function (f) { return f !== fn })
    }
  }

  window.__FBS_PERF__ = {
    version: 1,
    get config() { return config },
    setConfig: setConfig,
    subscribe: subscribe,
    ingest: ingest,
    events: function () { return events.slice() },
    turns: turnsList,
    turn: turnView,
    meta: function () { return meta },
    nudges: nudges,
    compactNow: compactNow,
    idleMs: idleMs,
  }

  emit('tap-installed', null, { href: location.href })
  armProbe()
})()
