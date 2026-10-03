// orchestrator/test/benchmarks.test.js — live-vs-recorded benchmark routing (node:test).
// ---------------------------------------------------------------------------
// Covers the provenance contract of GET /benchmarks and the measurement job
// lifecycle of POST /benchmarks/run + GET /benchmarks/status:
//   - fallback precedence: benchmark/live/latest.json wins over
//     docs/before-after-measurements.json; deleting the live file reverts cleanly
//   - never a hard failure: with neither artifact the endpoint answers
//     {available:false} instead of 5xx
//   - one job at a time: 202 {job_id} then 409 while it runs
//   - every number comes from a file (fixtures here use values that appear in
//     NO other artifact, so a hardcoded constant would fail these assertions)
//   - no hardcoded numbers anywhere in the response path
//
// Runs WITHOUT Docker: nothing in this suite touches the docker CLI. The measurement
// script is replaced by a fake (MEASURE_BIN) so the job lifecycle is exercised as-is.
//   run: node --test orchestrator/test/
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let tmp, server, baseUrl, mod;
let ROOT_DIR, ORCH_DIR, LIVE_FILE, RECORDED_FILE, STATE_DIR, MEASURE_BIN;

// Stand-in for benchmark/measure-live.sh: same contract (writes the live artifact,
// exits non-zero on failure), but needs no Docker. One PID line per run is logged and
// each run stamps a distinct generated_at + pair_total, so a re-measure is observable.
const FAKE_MEASURE_SH = String.raw`#!/usr/bin/env bash
# Stand-in for benchmark/measure-live.sh (test seam: no Docker required).
set -uo pipefail
printf '%s\n' "$$" >> "$FAKE_MEASURE_LOG"
sleep "$FAKE_MEASURE_SLEEP"
if [[ "$FAKE_MEASURE_FAIL" == 1 ]]; then
  echo "fake measure: induced failure" >&2
  exit 3
fi
n=$(( $(cat "$FAKE_MEASURE_STAMP" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$n" > "$FAKE_MEASURE_STAMP"
gen="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tenth=$(( n % 10 ))
pair="40.$tenth"
att="$(awk -v p="$pair" 'BEGIN{printf "%.2f", p-27.5}')"
cat > "$FAKE_LIVE_FILE" <<JSON
{
  "generated_at": "$gen",
  "session_id": "bmlive",
  "bundle": "web-exploitation",
  "dry_run": false,
  "host": { "vcpu": 11, "ram_gib": 22.5, "docker_server": "29.9.1", "os_note": "Linux fixture", "ram_source": "/proc/meminfo" },
  "protocol": "one optimized pair, 60s settle, 8 samples at 8s intervals",
  "run_elapsed_s": 133,
  "cold_start_s": 5,
  "idle_footprint_mib": {
    "attacker": $att, "target": 27.5, "pair_total": $pair,
    "spread_attacker_mib": 2, "spread_target_mib": 1,
    "procs_attacker": 4, "procs_target": 5, "procs_total": 9
  },
  "samples": [{ "index": 1, "at": "$gen", "attacker_mib": $att, "target_mib": 27.5, "pair_total_mib": $pair, "procs_attacker": 4, "procs_target": 5 }],
  "provenance": "live fixture"
}
JSON
exit 0
`;


// Recorded-baseline fixture. The numbers are deliberately unlike anything else in the
// repo: if the API ever served a literal instead of reading this file, these asserts
// would catch it.
const RECORDED_FIXTURE = {
  date: '2026-10-01',
  host: { vcpu: 7, ram_gib: 6.5, docker_server: '29.8.0', note: 'fixture host' },
  protocol: 'one pair, 60s settle, 8 samples at 8s intervals, docker stats --no-stream',
  images: {
    legacy_attacker: { size_mib: 3650 },
    legacy_target: { size_mib: 955 },
    opt_attacker: { size_mib: 342 },
    opt_target: { size_mib: 275 },
  },
  idle_footprint_mib: {
    legacy: { attacker: 401.5, target: 44.98, pair_total: 446.48, procs_attacker: 8, procs_target: 7, procs_total: 15 },
    optimized: { attacker: 17.89, target: 27.55, pair_total: 45.44, procs_attacker: 2, procs_target: 3, procs_total: 5 },
    pair_reduction_pct: 89.8,
  },
  image_reduction_pct: { attacker: 90.6, target: 71.2 },
  concurrency: { legacy_max_stable_pairs: 37, optimized_max_stable_pairs: 62, ratio: 1.68 },
  caveats: ['fixture caveat'],
  provenance: 'fixture provenance',
};

// Live fixture written by the fake measure script (same schema measure-live.sh emits).
function liveFixture(generatedAt, pairTotal) {
  return {
    generated_at: generatedAt,
    session_id: 'bmlive',
    bundle: 'web-exploitation',
    dry_run: false,
    host: { vcpu: 11, ram_gib: 22.5, docker_server: '29.9.1', os_note: 'Linux fixture', ram_source: '/proc/meminfo' },
    protocol: 'one optimized pair, 60s settle, 8 samples at 8s intervals',
    run_elapsed_s: 133,
    cold_start_s: 5,
    idle_footprint_mib: {
      attacker: pairTotal - 27.5, target: 27.5, pair_total: pairTotal,
      mean_attacker: pairTotal - 27.6, mean_target: 27.6, mean_pair_total: pairTotal,
      spread_attacker_mib: 2, spread_target_mib: 1,
      procs_attacker: 4, procs_target: 5, procs_total: 9,
    },
    samples: [{ index: 1, at: generatedAt, pair_total_mib: pairTotal }],
    provenance: 'live fixture',
  };
}

function writeLive(obj) {
  fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true });
  fs.writeFileSync(LIVE_FILE, JSON.stringify(obj, null, 2));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-api-test-'));
  ROOT_DIR = tmp;                                   // api.js resolves ROOT = dirname(ORCH_HOME)
  ORCH_DIR = path.join(tmp, 'orchestrator');
  LIVE_FILE = path.join(tmp, 'benchmark', 'live', 'latest.json');
  RECORDED_FILE = path.join(tmp, 'docs', 'before-after-measurements.json');
  STATE_DIR = path.join(tmp, 'state');
  fs.mkdirSync(ORCH_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(RECORDED_FILE), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  for (const f of ['limits.env', 'lifecycle.env']) {
    fs.copyFileSync(path.join(__dirname, '..', f), path.join(ORCH_DIR, f));
  }
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(ORCH_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(RECORDED_FILE, JSON.stringify(RECORDED_FIXTURE, null, 2));

  // Fake measure-live.sh: stands in for the real script (which needs Docker) so the
  // 202/409/status lifecycle can be driven end to end. One PID line per run is logged,
  // and each run stamps a distinct generated_at + pair_total into the live artifact.
  MEASURE_BIN = path.join(tmp, 'fake-measure-live.sh');
  fs.writeFileSync(MEASURE_BIN, FAKE_MEASURE_SH, { mode: 0o755 });

  process.env.ORCH_HOME = ORCH_DIR;
  process.env.STATE_DIR = STATE_DIR;
  process.env.WARN_LOG = path.join(STATE_DIR, 'warnings.log');
  process.env.MEASURE_BIN = MEASURE_BIN;
  process.env.FAKE_LIVE_FILE = LIVE_FILE;
  process.env.FAKE_MEASURE_LOG = path.join(tmp, 'measure-runs.log');
  process.env.FAKE_MEASURE_STAMP = path.join(tmp, 'measure-stamp.txt');
  process.env.FAKE_MEASURE_SLEEP = '0.4';
  process.env.FAKE_MEASURE_FAIL = '0';

  mod = require(path.join(__dirname, '..', 'api.js'));
  server = http.createServer(mod.app.handler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  try { fs.unlinkSync(LIVE_FILE); } catch {}
  fs.writeFileSync(RECORDED_FILE, JSON.stringify(RECORDED_FIXTURE, null, 2));
  fs.writeFileSync(process.env.FAKE_MEASURE_STAMP, '');
  fs.writeFileSync(process.env.FAKE_MEASURE_LOG, '');
  process.env.FAKE_MEASURE_FAIL = '0';
});

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(p, baseUrl), { method }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function waitForIdle(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await req('GET', '/benchmarks/status');
    if (!st.json.running) return st;
    if (Date.now() > deadline) throw new Error('benchmark job never finished');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function measuredRuns() {
  return fs.readFileSync(process.env.FAKE_MEASURE_LOG, 'utf8').split('\n').filter(Boolean).length;
}

// ---- fallback precedence -------------------------------------------------------
test('GET /benchmarks falls back to the recorded baseline when no live file exists', async () => {
  const r = await req('GET', '/benchmarks');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, true);
  assert.equal(r.json.source, 'recorded-baseline');
  assert.equal(r.json.baseline.source, 'recorded-baseline');
  assert.equal(r.json.baseline.date, '2026-10-01');
  // fixture values, verbatim: the response path contains no literals of its own
  assert.equal(r.json.idle_footprint_mib.optimized.pair_total, 45.44);
  assert.equal(r.json.idle_footprint_mib.legacy.pair_total, 446.48);
  assert.equal(r.json.images.opt_attacker.size_mib, 342);
  assert.equal(r.json.concurrency.optimized_max_stable_pairs, 62);
  assert.equal(r.json.host.vcpu, 7);
  // a recorded number must never be presentable as live
  assert.equal(r.json.generated_at, undefined);
  assert.ok(r.json.warnings.some((w) => /recorded/i.test(w)), 'must say it is showing the baseline');
});

test('a live measurement takes precedence over the recorded baseline', async () => {
  writeLive(liveFixture('2026-10-03T09:00:00Z', 47.47));
  const r = await req('GET', '/benchmarks');
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'live');
  assert.equal(r.json.generated_at, '2026-10-03T09:00:00Z');   // provenance stamp, mandatory
  assert.equal(r.json.idle_footprint_mib.optimized.pair_total, 47.47);  // from the live file
  assert.equal(r.json.idle_footprint_mib.optimized.attacker, 19.97);
  assert.equal(r.json.idle_footprint_mib.legacy.pair_total, 446.48);     // legacy stays recorded
  assert.equal(r.json.host.vcpu, 11);                                  // host comes from the live run
  assert.equal(r.json.cold_start_s, 5);
  // per-metric provenance: live where measured, recorded-baseline everywhere else
  assert.equal(r.json.metric_source.idle_footprint_mib, 'live');
  assert.equal(r.json.metric_source.images, 'recorded-baseline');
  assert.equal(r.json.metric_source.concurrency, 'recorded-baseline');
  assert.equal(r.json.metric_source.cold_start, 'live');
  // derived, not stored: live optimized vs the recorded legacy figure
  assert.equal(r.json.metric_source.pair_reduction_pct, 'live-vs-recorded-baseline');
  assert.equal(r.json.idle_footprint_mib.pair_reduction_pct, 89.4);
});

test('deleting benchmark/live/latest.json cleanly reverts the UI to the labelled baseline', async () => {
  writeLive(liveFixture('2026-10-03T09:00:00Z', 47.47));
  assert.equal((await req('GET', '/benchmarks')).json.source, 'live');
  fs.unlinkSync(LIVE_FILE);
  const after2 = await req('GET', '/benchmarks');
  assert.equal(after2.json.source, 'recorded-baseline');
  assert.equal(after2.json.generated_at, undefined);
  assert.equal(after2.json.idle_footprint_mib.optimized.pair_total, 45.44);
});

test('neither artifact present -> {available:false} (never a 5xx)', async () => {
  try { fs.unlinkSync(LIVE_FILE); } catch {}
  fs.unlinkSync(RECORDED_FILE);
  const r = await req('GET', '/benchmarks');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, false);
  assert.equal(r.json.source, null);
  assert.equal(r.json.idle_footprint_mib, undefined);   // no unattributed numbers at all
});

test('an unreadable live file degrades to the baseline instead of failing', async () => {
  fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true });
  fs.writeFileSync(LIVE_FILE, '{ this is not json');
  const r = await req('GET', '/benchmarks');
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'recorded-baseline');
});

// ---- POST /benchmarks/run: 202, 409, status -----------------------------------
test('POST /benchmarks/run returns 202 {job_id} and a second concurrent run gets 409', async () => {
  const first = await req('POST', '/benchmarks/run');
  assert.equal(first.status, 202);
  assert.match(first.json.job_id, /^bm-/);
  assert.equal(first.json.protocol.samples, 8);        // from lifecycle.env SSoT
  assert.equal(first.json.protocol.settle_s, 60);

  const running = await req('GET', '/benchmarks/status');
  assert.equal(running.json.running, true);
  assert.equal(running.json.job_id, first.json.job_id);

  const second = await req('POST', '/benchmarks/run');
  assert.equal(second.status, 409);
  assert.equal(second.json.job_id, first.json.job_id);
  assert.match(second.json.error, /already in progress/);

  const done = await waitForIdle();
  assert.equal(done.json.running, false);
  assert.equal(done.json.error, undefined);
  assert.ok(done.json.last_run_at, 'last_run_at recorded on completion');
  assert.equal(measuredRuns(), 1, 'the 409 must not have started a second measurement');

  // the measurement the API spawned is what /benchmarks now serves
  const bm = await req('GET', '/benchmarks');
  assert.equal(bm.json.source, 'live');
  assert.match(bm.json.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('two consecutive runs yield different generated_at and different sampled values', async () => {
  await req('POST', '/benchmarks/run');
  await waitForIdle();
  const first = (await req('GET', '/benchmarks')).json;
  await new Promise((r) => setTimeout(r, 1100));
  await req('POST', '/benchmarks/run');
  await waitForIdle();
  const second = (await req('GET', '/benchmarks')).json;

  assert.equal(first.source, 'live');
  assert.equal(second.source, 'live');
  assert.notEqual(first.generated_at, second.generated_at, 'a re-measure must re-stamp generated_at');
  assert.notEqual(first.idle_footprint_mib.optimized.pair_total, second.idle_footprint_mib.optimized.pair_total);
  assert.equal(measuredRuns(), 2);
});

test('a failed measurement surfaces the error and leaves the previous result intact', async () => {
  await req('POST', '/benchmarks/run');
  await waitForIdle();
  const good = (await req('GET', '/benchmarks')).json;

  process.env.FAKE_MEASURE_FAIL = '1';
  const run = await req('POST', '/benchmarks/run');
  assert.equal(run.status, 202);
  const done = await waitForIdle();
  assert.equal(done.json.running, false);
  assert.match(done.json.error, /induced failure/);
  process.env.FAKE_MEASURE_FAIL = '0';

  const afterFail = (await req('GET', '/benchmarks')).json;
  assert.equal(afterFail.generated_at, good.generated_at, 'a failed run must not clobber the last good data');
});

test('POST /benchmarks/run refuses to spawn a missing measurement script', () => {
  // wiring assertion (same style as ci/smoke.sh step 13): without the guard the API
  // would answer 202 and then silently never measure anything
  const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  assert.match(src, /existsSync\(MEASURE_BIN\)/);
  assert.match(src, /status\(500\)\.json\(\{ error: 'measure-live\.sh not found'/);
});

// ---- pure-function level checks (no HTTP) -------------------------------------
test('mergeBenchmarks: live artifact only -> available with live tags, no legacy columns', () => {
  const out = mod.mergeBenchmarks(liveFixture('2026-10-03T09:00:00Z', 40.1), null, 'L', 'R');
  assert.equal(out.available, true);
  assert.equal(out.source, 'live');
  assert.equal(out.idle_footprint_mib.optimized.pair_total, 40.1);
  assert.equal(out.idle_footprint_mib.legacy, undefined);
  assert.equal(out.baseline.available, false);
  assert.ok(out.warnings.some((w) => /recorded baseline .* is missing/.test(w)));
});

test('mergeBenchmarks: a dry_run-tagged live artifact is flagged, never silently trusted', () => {
  const l = liveFixture('2026-10-03T09:00:00Z', 40.1);
  l.dry_run = true;
  const out = mod.mergeBenchmarks(l, RECORDED_FIXTURE, 'L', 'R');
  assert.ok(out.warnings.some((w) => /dry_run/.test(w)));
});

test('lifecycle.env BENCH_* values reach the script config (no duplicated magic numbers)', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', 'lifecycle.env'), 'utf8');
  for (const key of ['BENCH_SESSION_ID', 'BENCH_BUNDLE', 'BENCH_SETTLE_S', 'BENCH_SAMPLES', 'BENCH_SAMPLE_INTERVAL_S']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `${key} must live in lifecycle.env`);
  }
  assert.equal(mod.BENCH_PROTOCOL.settle_s, 60);
  assert.equal(mod.BENCH_PROTOCOL.samples, 8);
  assert.equal(mod.BENCH_PROTOCOL.interval_s, 8);
  const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  assert.doesNotMatch(src, /settle[^=\n]*=\s*60/, 'api.js must not restate the settle time');
});

test('measure-live.sh exists and is executable (the API target for POST /benchmarks/run)', () => {
  const p = path.join(__dirname, '..', '..', 'benchmark', 'measure-live.sh');
  assert.ok(fs.existsSync(p));
  const st = fs.statSync(p);
  assert.ok(st.mode & 0o111, 'measure-live.sh must be executable (spawned directly by the API)');
  assert.equal(spawnSync('bash', [p, '--help'], { encoding: 'utf8' }).status, 0);
});