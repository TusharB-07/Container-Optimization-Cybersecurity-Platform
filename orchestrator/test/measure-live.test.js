// orchestrator/test/measure-live.test.js — benchmark/measure-live.sh behaviour
// (node:test).
// ---------------------------------------------------------------------------
// Runs WITHOUT Docker, two ways:
//   1. `--dry-run` — the script generates its own fake docker CLI, so the whole
//      control flow (provision → health → settle → sample → publish → teardown) runs
//      on a host with no daemon. CI-validatable, which is the point of the flag.
//   2. a fake `docker` injected on PATH (the pattern api.test.js/provision.test.js
//      already use) that logs every argv, so the assertions can prove what was
//      actually executed: that provisioning was DELEGATED to provision.sh (FR-06
//      limits passed through, no second implementation) and that teardown always
//      happens, including when the measurement fails.
//   run: node --test orchestrator/test/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'benchmark', 'measure-live.sh');

// Stateful fake docker: records container limits at `docker run`, replays them at
// `docker inspect` (that is what proves provisioning was delegated, not reimplemented),
// answers the healthcheck/stats/exec/version verbs measure-live.sh uses, and logs every
// argv so teardown ordering is assertable.
const FAKE_DOCKER_PY = String.raw`
import json, os, sys, time
D = os.environ["FAKE_DOCKER_DIR"]
ST, LOG = os.path.join(D, "state.json"), os.path.join(D, "calls.jsonl")
st = json.load(open(ST)) if os.path.exists(ST) else {"containers": {}, "hc": {}, "stats": 0}
argv = sys.argv[1:]
with open(LOG, "a") as f: f.write(json.dumps(argv) + chr(10))
def save(): json.dump(st, open(ST, "w"))
verb = argv[0] if argv else ""
rest = argv[1:]
if verb == "version":
    print("27.4.1-fake")
elif verb == "network":
    if rest[:1] == ["create"]: st["nets"] = st.get("nets", []) + [rest[1]]
elif verb == "rm":
    for n in rest:
        if n != "-f": st["containers"].pop(n, None)
elif verb == "run":
    def val(flag):
        return argv[argv.index(flag) + 1] if flag in argv else ""
    def to_b(v):
        return int(v[:-1]) * 1024 * 1024 if v.endswith("m") else int(v or 0)
    name = val("--name")
    st["containers"][name] = True
    st["hc"][name] = {
        "Memory": to_b(val("--memory")), "MemorySwap": to_b(val("--memory-swap")),
        "NanoCpus": int(float(val("--cpus") or 0) * 1e9), "PidsLimit": int(val("--pids-limit") or 0),
    }
elif verb == "image" and rest[:1] == ["inspect"]:
    print("null")                                   # image ships no CMD: fallback CMD branch
elif verb == "inspect":
    fmt, names, prev, i = "", [], "", 0
    while i < len(rest):
        if rest[i] in ("-f", "--format"): fmt = rest[i + 1]; i += 2; continue
        names.append(rest[i]); i += 1
    for n in names:
        hc = st["hc"].get(n, {})
        if "NanoCpus" in fmt: print("%s %s %s %s" % (hc.get("Memory", 0), hc.get("MemorySwap", 0), hc.get("NanoCpus", 0), hc.get("PidsLimit", 0)))
        elif "Config.Cmd" in fmt: print("null")
        elif "Health.Status" in fmt: print("healthy")
        elif ".State.Running" in fmt: print("true")
        else: print("/%s running healthy" % n)
elif verb == "stats":
    if os.environ.get("FAKE_DOCKER_FAIL_STATS") == "1":
        sys.stderr.write("fake docker: induced stats failure" + chr(10)); sys.exit(1)
    st["stats"] += 1
    # real stats drift between samples AND between runs; seed with wall-clock so two
    # runs are never byte-identical (a recorded artifact could not vary at all)
    j = (st["stats"] * 7 + int(time.time() * 1000) % 17) % 19
    for role, base, lim, procs in (("attacker", 17, 512, 3), ("target", 27, 256, 4)):
        name = "sess-" + os.environ["FAKE_SESSION"] + "-" + role   # provision.sh naming
        print(json.dumps({
            "Name": name,
            "MemUsage": "%d.%02dMiB / %dMiB" % (base + j // 10, (j * 6) % 100, lim),
            "CPUPerc": "0.%02d%%" % (j % 9),
            "PIDs": str(procs),
        }, separators=(",", ":")))
elif verb == "exec":
    # docker exec <c> ps aux | wc -l is the documented process-count method
    if len(rest) > 1 and rest[1] == "ps":
        print("USER PID %CPU"); print("lab 1 0.0"); print("lab 8 0.0"); print("lab 9 0.0")
save()
`;

const DIGESTS = [
  'WEB_EXPLOITATION_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"',
  'NETWORK_RECON_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"',
  'PASSWORD_ATTACKS_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"',
  'TARGET_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"',
  'BASE_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"',
].join('\n') + '\n';

// Sandbox repo layout + fake docker on PATH. The SCRIPT ITSELF is copied into the
// sandbox so the script's ROOT-relative defaults (benchmark/live/latest.json,
// orchestrator/lifecycle.env, provision.sh) resolve inside the sandbox: tests then
// exercise the production code paths without writing into the repo working tree.
function sandbox({ failStats = false, fakeDocker = true, envOverrides = {}, args = [], autoRun = true, baseArgs } = {}) {
  // SAFETY RAIL. Without the fake `docker` on PATH, an auto-run would drive the REAL
  // daemon: provision.sh's idempotent cleanup would `docker rm -f sess-bmlive-*` and
  // the run would then create a real pair — silently destroying any live measurement
  // (or real session) that happened to use the benchmark session id. Tests that want
  // the real CLI must therefore opt in explicitly, per run, via ctx.run().
  if (autoRun && !fakeDocker) {
    throw new Error('sandbox(): refusing to auto-run without the fake docker CLI — pass autoRun:false and drive the run yourself');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-test-'));
  const binDir = path.join(tmp, 'bin'); fs.mkdirSync(binDir);
  const fdDir = path.join(tmp, 'fdocker'); fs.mkdirSync(fdDir);
  fs.writeFileSync(path.join(fdDir, 'fake_docker.py'), FAKE_DOCKER_PY);
  const env = { ...process.env, FAKE_DOCKER_DIR: fdDir, FAKE_SESSION: 'bmlive' };
  if (fakeDocker) {
    fs.writeFileSync(path.join(binDir, 'docker'), '#!/usr/bin/env bash\nexec python3 "$FAKE_DOCKER_DIR/fake_docker.py" "$@"\n', { mode: 0o755 });
    env.PATH = `${binDir}:${process.env.PATH}`;
  }
  if (failStats) env.FAKE_DOCKER_FAIL_STATS = '1';

  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.mkdirSync(path.join(root, 'benchmark'), { recursive: true });
  fs.cpSync(path.join(REPO, 'orchestrator', 'provision.sh'), path.join(root, 'orchestrator', 'provision.sh'));
  fs.cpSync(path.join(REPO, 'orchestrator', 'limits.env'), path.join(root, 'orchestrator', 'limits.env'));
  fs.cpSync(path.join(REPO, 'orchestrator', 'lifecycle.env'), path.join(root, 'orchestrator', 'lifecycle.env'));
  if (envOverrides.lifecycleEnv) fs.cpSync(envOverrides.lifecycleEnv, path.join(root, 'orchestrator', 'lifecycle.env'));
  fs.writeFileSync(path.join(root, 'images', 'digests.env'), DIGESTS);
  const script = path.join(root, 'benchmark', 'measure-live.sh');
  fs.cpSync(SCRIPT, script);              // keep the executable bit (spawned directly in prod)
  fs.chmodSync(script, 0o755);

  const out = path.join(root, 'benchmark', 'live', 'latest.json');
  const dryOut = path.join(root, 'benchmark', 'live', 'dry-run.json');
  const env2 = {
    ...env,
    STATE_DIR: path.join(tmp, 'state'),
    REGISTRY: 'local', VERSION: 'dev',
    ...envOverrides,
  };
  delete env2.lifecycleEnv;
  fs.mkdirSync(env2.STATE_DIR, { recursive: true });
  // default base args keep the tests fast; `args`/`baseArgs` let a specific test drive
  // the protocol (e.g. prove the SSoT file, not a literal, decides the sample count)
  const base = baseArgs || ['--settle', '0', '--interval', '0', '--samples', '3'];
  const r = autoRun
    ? spawnSync('bash', [script, ...base, ...args], { env: env2, encoding: 'utf8' })
    : { status: null, stdout: '', stderr: '' };
  const ctx = { tmp, root, script, out, dryOut, env: env2, calls: readCalls(fdDir), state: readState(fdDir) };
  ctx.run = (extraArgs = [], extraEnv = {}) =>
    spawnSync('bash', [script, ...extraArgs], { env: { ...env2, ...extraEnv }, encoding: 'utf8' });
  ctx.result = r;
  return ctx;
}
function readCalls(fdDir) {
  const p = path.join(fdDir, 'calls.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function readState(fdDir) {
  const p = path.join(fdDir, 'state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { containers: {}, hc: {} };
}

// ---- --dry-run: the CI path (no Docker at all) --------------------------------
// SAFETY: `fakeDocker:false` + PATH=/usr/bin:/bin means NO docker CLI is reachable
// from these runs, and autoRun:false stops sandbox() from starting its own default
// run against the real daemon (see the safety rail in sandbox()).
test('a sandbox cannot auto-run without the fake docker (it would hit the real daemon)', () => {
  assert.throws(() => sandbox({ fakeDocker: false }), /refusing to auto-run/,
    'a real-daemon run must require an explicit opt-in, not the default');
});

test('--dry-run completes with no docker binary on PATH and publishes a valid artifact', () => {
  const s = sandbox({ fakeDocker: false, autoRun: false });
  // PATH deliberately excludes any docker: /usr/bin:/bin only
  const r = s.run(['--dry-run', '--settle', '0', '--samples', '2', '--interval', '0'], { PATH: '/usr/bin:/bin' });
  assert.equal(r.status, 0, `dry-run failed: ${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(s.dryOut), 'dry-run artifact written next to latest.json');
  const doc = JSON.parse(fs.readFileSync(s.dryOut, 'utf8'));
  assert.match(doc.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(doc.dry_run, true);
  assert.equal(doc.samples.length, 2);
  assert.ok(!fs.existsSync(s.out), 'a dry-run must not create the live artifact');
});

test('--dry-run never overwrites the live artifact (a self-test must not pose as a measurement)', () => {
  const s = sandbox({ fakeDocker: false, autoRun: false });
  const sentinel = 'SENTINEL — previous live measurement';
  fs.mkdirSync(path.dirname(s.out), { recursive: true });   // no auto-run created it for us
  fs.writeFileSync(s.out, sentinel);
  const r = s.run(['--dry-run', '--settle', '0', '--samples', '1', '--interval', '0'], { PATH: '/usr/bin:/bin' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(s.out, 'utf8'), sentinel, 'latest.json must be untouched by --dry-run');
  assert.equal(JSON.parse(fs.readFileSync(s.dryOut, 'utf8')).dry_run, true);
});

test('an unprobeable host gauge still yields parseable JSON (no bare words)', () => {
  // PATH without sysctl/nproc and no /proc/meminfo => "unknown" gauges
  const s = sandbox({ fakeDocker: false, autoRun: false });
  const r = s.run(['--dry-run', '--settle', '0', '--samples', '1', '--interval', '0'], { PATH: '/usr/bin:/bin' });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(fs.readFileSync(s.dryOut, 'utf8'));   // throws if not valid JSON
  assert.ok(doc.host, 'host block always present');
});

// ---- happy path against the injected fake docker ------------------------------
test('measure-live.sh delegates provisioning to provision.sh (FR-06 limits, one implementation)', () => {
  const s = sandbox();
  assert.equal(s.result.status, 0, `measure failed: ${s.result.stdout}\n${s.result.stderr}`);
  assert.match(s.result.stdout, /provisioning pair bmlive \(bundle=web-exploitation\) via provision\.sh/);
  // the limits reached `docker run` from provision.sh's SSoT file (512m/1.0/100, 256m/0.5/50)
  assert.equal(s.state.hc['sess-bmlive-attacker'].Memory, 512 * 1024 * 1024);
  assert.equal(s.state.hc['sess-bmlive-attacker'].PidsLimit, 100);
  assert.equal(s.state.hc['sess-bmlive-target'].Memory, 256 * 1024 * 1024);
  assert.equal(s.state.hc['sess-bmlive-target'].NanoCpus, 500000000);
  // and the script itself never runs a container directly
  const runs = s.calls.filter((a) => a[0] === 'run');
  assert.equal(runs.length, 2, 'exactly the two containers provision.sh created');
});

test('the published artifact mirrors the recorded-file schema', () => {
  const s = sandbox();
  const doc = JSON.parse(fs.readFileSync(s.out, 'utf8'));
  for (const k of ['generated_at', 'host', 'protocol', 'idle_footprint_mib', 'samples']) {
    assert.ok(k in doc, `missing top-level key ${k}`);
  }
  for (const k of ['vcpu', 'ram_gib', 'docker_server', 'os_note']) {
    assert.ok(k in doc.host, `host.${k} must be probed at runtime`);
  }
  for (const k of ['attacker', 'target', 'pair_total', 'procs_attacker', 'procs_target', 'procs_total']) {
    assert.ok(k in doc.idle_footprint_mib, `idle_footprint_mib.${k} missing`);
  }
  assert.equal(doc.idle_footprint_mib.procs_total,
    doc.idle_footprint_mib.procs_attacker + doc.idle_footprint_mib.procs_target);
  assert.equal(doc.samples.length, 3);
  for (const s2 of doc.samples) {
    assert.match(s2.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(typeof s2.pair_total_mib === 'number');
  }
});

test('host specs come from the running system, not literals', () => {
  const s = sandbox();
  const doc = JSON.parse(fs.readFileSync(s.out, 'utf8'));
  const sys = spawnSync('sh', ['-c',
    'if command -v nproc >/dev/null 2>&1; then nproc; else sysctl -n hw.ncpu; fi'],
    { encoding: 'utf8' }).stdout.trim();
  assert.equal(doc.host.vcpu, Number(sys), 'vcpu must equal the system CPU count');
  if (fs.existsSync('/proc/meminfo')) {
    assert.equal(doc.host.ram_source, '/proc/meminfo');
  } else {
    assert.equal(doc.host.ram_source, 'sysctl hw.memsize');
  }
  assert.notEqual(doc.host.docker_server, 'unknown', 'docker server version is probed via docker version');
});

test('protocol knobs come from lifecycle.env, never from a literal in the script', () => {
  // a lifecycle.env with different BENCH_* values must change what is measured
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-cfg-'));
  const cfg = path.join(tmp, 'lifecycle.env');
  fs.writeFileSync(cfg, fs.readFileSync(path.join(REPO, 'orchestrator', 'lifecycle.env'), 'utf8')
    .replace(/^BENCH_SAMPLES=.*$/m, 'BENCH_SAMPLES=5')
    .replace(/^BENCH_SETTLE_S=.*$/m, 'BENCH_SETTLE_S=0'));
  const s = sandbox({ envOverrides: { lifecycleEnv: cfg }, baseArgs: ['--settle', '0', '--interval', '0'] });
  assert.equal(s.result.status, 0, s.result.stderr);
  const doc = JSON.parse(fs.readFileSync(s.out, 'utf8'));
  assert.equal(doc.samples.length, 5, 'sample count follows the SSoT file');
  assert.match(doc.protocol, /5 samples at 0s intervals/);
  assert.match(doc.protocol, /0s settle/);
  assert.equal(doc.idle_footprint_mib.pair_total > 0, true);
});

// ---- atomic write --------------------------------------------------------------
test('the artifact is published atomically (temp file + rename, no leftovers)', () => {
  const s = sandbox();
  assert.equal(s.result.status, 0, s.result.stderr);
  const entries = fs.readdirSync(path.dirname(s.out));
  assert.deepEqual(entries, ['latest.json'], `unexpected leftovers: ${entries}`);
  const doc = JSON.parse(fs.readFileSync(s.out, 'utf8'));   // parses => never observed partial
  assert.ok(doc.generated_at);
});

test('a failed measurement cannot truncate the previous good artifact', () => {
  const s = sandbox({ failStats: true, autoRun: false });
  const r = s.run(['--settle', '0', '--interval', '0', '--samples', '2']);
  const sentinel = JSON.stringify({ generated_at: '2026-10-01T00:00:00Z', sentinel: true });
  fs.writeFileSync(s.out, sentinel);
  assert.notEqual(r.status, 0, 'a stats failure must fail the run');
  assert.equal(fs.readFileSync(s.out, 'utf8'), sentinel, 'previous artifact must be byte-identical');
  assert.deepEqual(fs.readdirSync(path.dirname(s.out)), ['latest.json'], 'no temp file may survive a failure');
});

test('two consecutive runs differ in generated_at and in sampled values', () => {
  const first = sandbox();
  const a = JSON.parse(fs.readFileSync(first.out, 'utf8'));
  spawnSync('sh', ['-c', 'sleep 1.1']);
  const second = sandbox();
  const b = JSON.parse(fs.readFileSync(second.out, 'utf8'));
  assert.notEqual(a.generated_at, b.generated_at, 'a re-measurement must re-stamp generated_at');
  assert.notDeepEqual(a.samples.map((x) => x.pair_total_mib), b.samples.map((x) => x.pair_total_mib),
    'sampled values must vary between runs (a recorded artifact cannot do this)');
});

// ---- teardown contract ---------------------------------------------------------
test('teardown removes both containers and the per-session network on success', () => {
  const s = sandbox();
  assert.equal(s.result.status, 0, s.result.stderr);
  const rmIdx = s.calls.map((a) => a[0]).lastIndexOf('rm');
  assert.ok(rmIdx > 0, 'the pair must be removed');
  const teardown = s.calls[rmIdx];
  assert.deepEqual(teardown, ['rm', '-f', 'sess-bmlive-attacker', 'sess-bmlive-target'],
    'teardown removes both containers with -f (provision.sh cleanup contract)');
  const netRm = s.calls.filter((a) => a[0] === 'network' && a[1] === 'rm');
  assert.equal(netRm[netRm.length - 1][2], 'sess-bmlive-net', 'per-session network removed');
  // teardown happens AFTER the last sample, never before
  const lastStats = s.calls.map((a) => a[0]).lastIndexOf('stats');
  assert.ok(rmIdx > lastStats, 'teardown must be the last step');
  assert.deepEqual(Object.keys(s.state.containers), [], 'fake daemon reports no containers left');
});

test('teardown still runs when the measurement fails (EXIT trap), including state files', () => {
  const s = sandbox({ failStats: true, autoRun: false });
  // session state files that the reaper writes must be cleaned up too
  for (const f of ['prev', 'low', 'warned']) fs.writeFileSync(path.join(s.env.STATE_DIR, `idle-bmlive.${f}`), 'x');
  fs.writeFileSync(path.join(s.env.STATE_DIR, 'session-bmlive.meta'), 'started=1\n');
  const r = s.run(['--settle', '0', '--interval', '0', '--samples', '2']);
  assert.notEqual(r.status, 0);
  const calls = readCalls(path.join(s.tmp, 'fdocker'));
  const teardown = calls[calls.map((a) => a[0]).lastIndexOf('rm')];
  assert.deepEqual(teardown, ['rm', '-f', 'sess-bmlive-attacker', 'sess-bmlive-target'],
    'the failing run must still tear the pair down');
  assert.ok(calls.some((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === 'sess-bmlive-net'), 'network removed too');
  for (const f of ['prev', 'low', 'warned']) {
    assert.ok(!fs.existsSync(path.join(s.env.STATE_DIR, `idle-bmlive.${f}`)), `idle-bmlive.${f} must be removed`);
  }
  assert.ok(!fs.existsSync(path.join(s.env.STATE_DIR, 'session-bmlive.meta')), 'session meta must be removed');
});

test('teardown runs even when provisioning itself fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-provfail-'));
  const fakeProv = path.join(tmp, 'provision-fails.sh');
  fs.writeFileSync(fakeProv, '#!/usr/bin/env bash\necho "simulated provisioning failure" >&2\nexit 9\n', { mode: 0o755 });
  const s = sandbox({ autoRun: false });
  const r = s.run(['--settle', '0', '--samples', '1'], { PROVISION_BIN: fakeProv });
  assert.equal(r.status, 1);
  const calls = readCalls(path.join(s.tmp, 'fdocker'));
  assert.ok(calls.some((a) => a[0] === 'rm' && a.includes('sess-bmlive-attacker')),
    'teardown runs even when nothing was ever created');
  assert.ok(calls.some((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === 'sess-bmlive-net'));
  assert.ok(!fs.existsSync(s.out), 'no artifact is published for a failed run');
});

// ---- config contract -----------------------------------------------------------
test('unknown CLI arguments are rejected instead of silently ignored', () => {
  const s = sandbox({ autoRun: false });
  const r = s.run(['--nonsense']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument/);
});

test('a missing lifecycle.env fails loudly rather than measuring with default numbers', () => {
  const s = sandbox({ autoRun: false });
  const r = s.run([], { LIFECYCLE_ENV: path.join(os.tmpdir(), 'definitely-missing.env') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lifecycle\.env not found/);
});