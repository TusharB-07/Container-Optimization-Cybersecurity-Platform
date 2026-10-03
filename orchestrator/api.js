// orchestrator/api.js — Phase 3 session lifecycle API (FR-08, P0).
// ---------------------------------------------------------------------------
// Express + dockerode surface consumed by the platform front-end:
//   POST /sessions          {bundle, id?}        -> create   (FR-08)
//   GET  /sessions/:id                           -> status   (FR-08)
//   DELETE /sessions/:id                           -> teardown (FR-08)
//   GET  /sessions                               -> list ids
//   GET  /sessions/:id/events                    -> reaper warning/audit events (FR-10)
//   GET  /benchmarks                             -> live-measured metrics, else recorded baseline
//   POST /benchmarks/run                         -> measure a fresh pair now (202 {job_id})
//   GET  /benchmarks/status                      -> {running, last_run_at, error?}
//   GET  /health                                 -> liveness
//
// Provisioning delegates to orchestrator/provision.sh so the docker-run flag
// path (limits FR-06, digests FR-02, isolation NFR-03) has exactly ONE
// implementation; teardown mirrors provision.sh's cleanup contract. The idle
// reaper is a separate process (reaper.sh) — this API only exposes its state.
//
// No external npm deps are required to run or test it: a ~40-line Express
// shim sits in lib/http_shim.js so the module loads on a bare Node host and
// `node --test` integration tests run without `npm install`. In production,
// swap `require('./lib/http_shim')` for real express+dockerode when the
// platform orchestrator repo absorbs this file (PRD §10.1).
'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');
const { Router, json } = require('./lib/http_shim');

// ORCH_HOME lets integration tests sandbox the orchestrator dir (fake
// provision.sh + fake docker on PATH) without touching this repo copy.
//   ORCH_HOME     — dir holding limits.env/lifecycle.env/provision.sh (default: this dir)
//   PROVISION_BIN — provisioning entrypoint invoked by POST /sessions
//   MEASURE_BIN   — live benchmark script invoked by POST /benchmarks/run
//   BENCH_LIVE_FILE / BENCH_RECORDED_FILE — benchmark artifacts (default: under ROOT)
const HERE = process.env.ORCH_HOME || __dirname;
const ROOT = path.dirname(HERE);
const PROVISION_BIN = process.env.PROVISION_BIN || path.join(HERE, 'provision.sh');
const MEASURE_BIN = process.env.MEASURE_BIN || path.join(ROOT, 'benchmark', 'measure-live.sh');

// ---- config (SSoT files, never hardcoded values) ---------------------------
function readEnvFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(\S+)/); // first token before inline comment
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const LIMITS = readEnvFile(path.join(HERE, 'limits.env'));
const LIFECYCLE = readEnvFile(path.join(HERE, 'lifecycle.env'));
const STATE_DIR = process.env.STATE_DIR || path.join(HERE, '.state');
const WARN_LOG = process.env.WARN_LOG || path.join(STATE_DIR, 'warnings.log');
const KNOWN_BUNDLES = ['web-exploitation', 'network-recon', 'password-attacks'];

// Benchmark artifacts. LIVE is written by benchmark/measure-live.sh; RECORDED is the
// audited 2026-10-01 Phase-5 baseline and is the fallback. BENCH_PROTOCOL is surfaced
// in /benchmarks/status so the dashboard can describe a run without hardcoding numbers.
const BENCH_LIVE_FILE = process.env.BENCH_LIVE_FILE || path.join(ROOT, 'benchmark', 'live', 'latest.json');
const BENCH_RECORDED_FILE = process.env.BENCH_RECORDED_FILE || path.join(ROOT, 'docs', 'before-after-measurements.json');
const BENCH_STATUS_FILE = path.join(STATE_DIR, 'benchmarks-status.json');
const BENCH_LOG = path.join(STATE_DIR, 'benchmarks-run.log');
const BENCH_PROTOCOL = {
  settle_s: +(LIFECYCLE.BENCH_SETTLE_S || 0),
  samples: +(LIFECYCLE.BENCH_SAMPLES || 0),
  interval_s: +(LIFECYCLE.BENCH_SAMPLE_INTERVAL_S || 0),
  script: path.relative(ROOT, MEASURE_BIN) || MEASURE_BIN,
};

// 90s cap: never let a wedged provisioning call hang the API (healthcheck wait is 30s max)
// options overload (e.g. { env }) is supported for callers that must adjust
// the child environment; execFile merges nothing by default, so pass full env.
const sh = (cmd, args, optsOrCb, cb) =>
  typeof optsOrCb === 'function'
    ? execFile(cmd, args, { cwd: ROOT, timeout: 90000 }, optsOrCb)
    : execFile(cmd, args, { cwd: ROOT, timeout: 90000, ...optsOrCb }, cb);

// ---- routes -----------------------------------------------------------------
const app = Router();

app.get('/health', (_req, res) => res.json({ ok: true, phase: 3 }));

// ---- benchmarks: prefer a live measurement, fall back to the recorded baseline ---
//
// Provenance rule (enforced here so no UI can invent it): every number this endpoint
// returns carries a `source` tag. 'live' = measured by benchmark/measure-live.sh and
// stamped with its generated_at; 'recorded-baseline' = the frozen, audited 2026-10-01
// artifact docs/before-after-measurements.json, which can never claim to be live.
// `metric_source` names the tag per metric group so a dashboard can badge each cell.
// NO number is hardcoded in this response path — everything is read from a file.
const LIVE = 'live';
const RECORDED = 'recorded-baseline';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// measured optimized-pair block, normalised to the shape the recorded file uses so a
// live run can replace it in place (demo.html/demo-webpage.html read .optimized.*).
// Keys with no measured value are DROPPED rather than written as null, so a partial
// live artifact can never blank out a recorded figure it does not actually cover.
function liveOptimizedBlock(live) {
  const f = live.idle_footprint_mib || {};
  const out = {};
  for (const k of ['attacker', 'target', 'pair_total', 'procs_attacker', 'procs_target', 'procs_total']) {
    if (typeof f[k] === 'number' && Number.isFinite(f[k])) out[k] = f[k];
  }
  return out;
}

function mergeBenchmarks(live, recorded, livePath, recordedPath) {
  const warnings = [];
  if (!live && !recorded) {
    // Neither artifact exists (fresh clone, or someone deleted benchmark/live/latest.json).
    // This is NOT an error: the dashboards render a "no data" state instead of a 503.
    return { available: false, source: null, metric_source: {}, warnings, live_file: livePath, recorded_file: recordedPath };
  }
  const rec = recorded || {};
  const out = {
    available: true,
    source: live ? LIVE : RECORDED,
    host: live ? live.host : rec.host,
    protocol: live ? live.protocol : rec.protocol,
    caveats: rec.caveats || [],
    images: rec.images,
    image_reduction_pct: rec.image_reduction_pct,
    concurrency: rec.concurrency,
    // recorded-baseline never has a generated_at; its date is the measurement day
    date: live ? (live.generated_at || '').slice(0, 10) : rec.date,
    metric_source: {
      idle_footprint_mib: live ? LIVE : RECORDED,
      images: RECORDED, image_reduction_pct: RECORDED, concurrency: RECORDED,
      host: live ? LIVE : RECORDED,
    },
    live_file: livePath, recorded_file: recordedPath,
  };
  if (rec.idle_footprint_mib) out.idle_footprint_mib = { ...rec.idle_footprint_mib };
  if (live) {
    const opt = liveOptimizedBlock(live);
    out.idle_footprint_mib = { ...(out.idle_footprint_mib || {}), optimized: { ...(out.idle_footprint_mib?.optimized || {}), ...opt } };
    out.generated_at = live.generated_at || null;      // LIVE numbers always carry this
    out.session_id = live.session_id;
    out.samples = live.samples;                        // raw per-sample values, as measured
    if (typeof live.cold_start_s === 'number') {
      out.cold_start_s = live.cold_start_s;            // provision -> both healthchecks green
      out.metric_source.cold_start = LIVE;
    }
    const legacyTotal = out.idle_footprint_mib?.legacy?.pair_total;
    if (typeof legacyTotal === 'number' && typeof opt.pair_total === 'number' && legacyTotal > 0) {
      // derived, not stored: live optimized vs the RECORDED legacy figure it is
      // compared against — both figures stay individually attributable.
      out.idle_footprint_mib.pair_reduction_pct =
        Number((((legacyTotal - opt.pair_total) / legacyTotal) * 100).toFixed(1));
      out.metric_source.pair_reduction_pct = `${LIVE}-vs-${RECORDED}`;
    }
    if (live.dry_run) {
      warnings.push('live artifact is tagged dry_run — treat as a script self-test, not a measurement');
    }
  } else {
    warnings.push('no live measurement on disk — showing the recorded 2026-10-01 baseline (POST /benchmarks/run to measure now)');
    out.recorded = { source: RECORDED, date: rec.date, provenance: rec.provenance, protocol: rec.protocol };
  }
  out.baseline = { source: RECORDED, file: recordedPath, date: rec.date || null, available: !!recorded };
  if (!recorded) warnings.push('recorded baseline docs/before-after-measurements.json is missing — legacy columns unavailable');
  out.warnings = warnings;
  return out;
}

app.get('/benchmarks', (_req, res) => {
  const live = readJson(BENCH_LIVE_FILE);
  const recorded = readJson(BENCH_RECORDED_FILE);
  res.json(mergeBenchmarks(live, recorded, BENCH_LIVE_FILE, BENCH_RECORDED_FILE));
});

// ---- POST /benchmarks/run — spawn a fresh measurement, detached ---------------
// The run takes minutes (settle + N samples at I seconds) and provisions a real pair,
// so it must not hold the request open: 202 + job_id now, /benchmarks/status for
// progress. One job at a time — two concurrent measurements would provision two pairs
// under the same session id and race for benchmark/live/latest.json.
const BENCH_TAIL_BYTES = 800;
function readBenchStatus() {
  const st = readJson(BENCH_STATUS_FILE) || {};
  const running = !!st.running && pidAlive(st.pid);
  // A crash between spawn and the exit handler (API restart, kill -9) would otherwise
  // leave `running` stuck true forever and block every later run with a 409.
  return running ? { ...st, running: true } : { ...st, running: false, pid: running ? st.pid : null };
}
function writeBenchStatus(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${BENCH_STATUS_FILE}.tmp`;             // atomic swap: a reader never sees a partial status
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, BENCH_STATUS_FILE);
}
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
function benchErrorTail() {
  try { return fs.readFileSync(BENCH_LOG, 'utf8').slice(-BENCH_TAIL_BYTES).trim(); }
  catch { return null; }
}

app.post('/benchmarks/run', (_req, res) => {
  const cur = readBenchStatus();
  if (cur.running) {
    return res.status(409).json({
      error: 'benchmark run already in progress', job_id: cur.job_id || null,
      started_at: cur.started_at || null,
    });
  }
  if (!fs.existsSync(MEASURE_BIN)) {
    return res.status(500).json({ error: 'measure-live.sh not found', path: MEASURE_BIN });
  }
  const jobId = `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try { fs.writeFileSync(BENCH_LOG, ''); } catch {}
  const logFd = fs.openSync(BENCH_LOG, 'a');
  const child = spawn(MEASURE_BIN, [], {
    cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd],
    env: { ...process.env, STATE_DIR },
  });
  child.unref();   // the API must survive the measurement (and its restart) outliving it
  try { fs.closeSync(logFd); } catch {}   // the child holds its own copy; don't leak ours
  const started_at = new Date().toISOString();
  writeBenchStatus({ running: true, pid: child.pid, job_id: jobId, started_at, last_run_at: cur.last_run_at || null, error: null });
  const finish = (code, how) => {
    const ok = code === 0;
    writeBenchStatus({
      running: false, pid: null, job_id: jobId, started_at,
      last_run_at: new Date().toISOString(), error: ok ? null : `measure-live.sh ${how} (exit ${code}): ${benchErrorTail() || 'no output'}`,
    });
  };
  child.on('exit', (code, signal) => finish(code, signal ? `killed by ${signal}` : 'failed'));
  child.on('error', (e) => {
    writeBenchStatus({ running: false, pid: null, job_id: jobId, started_at,
      last_run_at: new Date().toISOString(), error: `spawn failed: ${e.message}` });
  });
  res.status(202).json({ job_id: jobId, started_at, status_url: '/benchmarks/status', protocol: BENCH_PROTOCOL });
});

app.get('/benchmarks/status', (_req, res) => {
  const st = readBenchStatus();
  res.json({
    running: st.running, last_run_at: st.last_run_at || null, error: st.error || undefined,
    job_id: st.job_id || null, started_at: st.started_at || null,
    live_file: BENCH_LIVE_FILE, protocol: BENCH_PROTOCOL,
  });
});

// POST /sessions  {bundle, id, ssh?}  — create (FR-08)
// `ssh: true` is the FR-18 per-lab SSH opt-in: forwarded to provision.sh as
// LAB_SSH_ENABLED=1 (sshd stays OFF for every session that doesn't ask).
app.post('/sessions', (req, res) => {
  json(req, res, () => {                    // parse body, then run the handler
  const { bundle, id, ssh } = req.body || {};
  if (!bundle || !KNOWN_BUNDLES.includes(bundle)) {
    return res.status(400).json({ error: `bundle must be one of ${KNOWN_BUNDLES.join(', ')}` });
  }
  if (id === undefined || !/^[0-9A-Za-z_-]+$/.test(String(id))) {
    return res.status(400).json({ error: 'id required ([0-9A-Za-z_-]+)' });
  }
  if (ssh !== undefined && typeof ssh !== 'boolean') {
    return res.status(400).json({ error: 'ssh must be a boolean when present (FR-18 opt-in)' });
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (process.env.PROVISION_STUB === '1') {   // test seam: no-Docker harnesses
    fs.writeFileSync(path.join(STATE_DIR, `session-${id}.meta`), `started=${Math.floor(Date.now() / 1000)}\nbundle=${bundle}\n`);
    return res.status(201).json({ session: String(id), bundle, status: 'ready', stubbed: true });
  }
  // FR-05 pull-only provisioning through the single canonical path.
  // KEEP_RUNNING=1: provision.sh's default EXIT trap tears the pair down on
  // exit (CI smoke mode); the API owns teardown via DELETE /sessions / reaper.
  sh(PROVISION_BIN, [bundle, String(id)],
    { env: { ...process.env, KEEP_RUNNING: '1', ...(ssh === true ? { LAB_SSH_ENABLED: '1' } : {}) } },
    (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'provision failed', log: (stderr || '') + (stdout || '') });
    fs.writeFileSync(path.join(STATE_DIR, `session-${id}.meta`), `started=${Math.floor(Date.now() / 1000)}\nbundle=${bundle}\n`);
    res.status(201).json({ session: String(id), bundle, status: 'ready', ssh_enabled: ssh === true });
  });
  });                                    // end json(...)
});

// GET /sessions/:id — status (FR-08): container states + reaper posture
// NOTE: the health segment is written WITHOUT spaces around the Go-template
// action (`{{if .State.Health}}{{...}}{{else}}none{{end}}`). provision.sh's
// wait_ready polls with a `{{if .State.Health}}`-style format string; the
// test-suite fake docker CLI discriminates the two callers on that token, and
// real `docker inspect` treats both spellings identically. Keep them distinct.
app.get('/sessions/:id', (req, res) => {
  const sid = req.params.id;
  sh('docker', ['inspect', '-f', '{{.Name}} {{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{else}} none{{end}}',
    `sess-${sid}-attacker`, `sess-${sid}-target`], (err, stdout, stderr) => {
    if (err && String(stderr).includes('No such object')) {
      return res.status(404).json({ session: sid, status: 'not-found' });
    }
    if (err) return res.status(500).json({ error: String(stderr) });
    const containers = stdout.trim().split('\n').map((l) => {
      const [name, state, health] = l.split(/\s+/);
      return { name: name.replace(/^\//, ''), state, health };
    });
    const warned = fs.existsSync(path.join(STATE_DIR, `idle-${sid}.warned`));
    let samples_low = 0;
    try { samples_low = parseInt(fs.readFileSync(path.join(STATE_DIR, `idle-${sid}.low`), 'utf8'), 10) || 0; } catch {}
    res.json({
      session: sid,
      status: warned ? 'idle-warning' : containers.every((c) => c.health === 'healthy') ? 'ready' : 'starting',
      containers, samples_low,
      limits: { attacker: `${LIMITS.ATTACKER_MEMORY}/${LIMITS.ATTACKER_CPUS}cpu/${LIMITS.ATTACKER_PIDS_LIMIT}pids`,
                target: `${LIMITS.TARGET_MEMORY}/${LIMITS.TARGET_CPUS}cpu/${LIMITS.TARGET_PIDS_LIMIT}pids` },
      reaper: { poll_s: +LIFECYCLE.IDLE_POLL_INTERVAL_S, flag_after_s: +LIFECYCLE.IDLE_CONSECUTIVE_SAMPLES * +LIFECYCLE.IDLE_POLL_INTERVAL_S, grace_s: +LIFECYCLE.REAPER_GRACE_PERIOD_S },
    });
  });
});

app.get('/sessions', (_req, res) => {
  sh('docker', ['ps', '--format', '{{.Names}}'], (err, stdout) => {
    if (err) return res.status(500).json({ error: 'docker ps failed' });
    const ids = [...new Set(stdout.split('\n')
      .map((n) => (n.match(/^sess-(.+)-(attacker|target)$/) || [])[1]).filter(Boolean))];
    res.json({ sessions: ids.sort() });
  });
});

// DELETE /sessions/:id — teardown (FR-08): same contract as provision cleanup
app.delete('/sessions/:id', (req, res) => {
  const sid = req.params.id;
  sh('docker', ['rm', '-f', `sess-${sid}-attacker`, `sess-${sid}-target`], (e1) => {
    sh('docker', ['network', 'rm', `sess-${sid}-net`], (e2) => {
      for (const f of ['prev', 'low', 'warned']) {
        try { fs.unlinkSync(path.join(STATE_DIR, `idle-${sid}.${f}`)); } catch {}
      }
      try { fs.unlinkSync(path.join(STATE_DIR, `session-${sid}.meta`)); } catch {}
      res.json({ session: sid, status: 'torn-down', partial_errors: [e1, e2].filter(Boolean).length });
    });
  });
});

// GET /sessions/:id/events — audit trail of warnings/reaps for this session (FR-10)
app.get('/sessions/:id/events', (req, res) => {
  const sid = req.params.id;
  let events = [];
  try {
    events = fs.readFileSync(WARN_LOG, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((e) => e.session === sid);
  } catch { /* no events yet */ }
  res.json({ session: sid, events });
});

// ---- listen (skipped under `node --test`) -----------------------------------
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

// Add CORS middleware
function addCorsHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

if (require.main === module) {
  const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (addCorsHeaders(req, res)) {
      return;
    }
    
    // Add CORS headers to all responses
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      addCorsHeaders(req, res);
      originalEnd.call(res, chunk, encoding);
    };
    
    app.handler()(req, res);
  });
  
  server.listen(PORT, HOST, () =>
    console.log(`lifecycle API on ${HOST}:${PORT} (phase 3, FR-08)`));
}
module.exports = { app, PORT, STATE_DIR, WARN_LOG, KNOWN_BUNDLES, mergeBenchmarks, MEASURE_BIN, BENCH_LIVE_FILE, BENCH_RECORDED_FILE, BENCH_STATUS_FILE, BENCH_PROTOCOL };
