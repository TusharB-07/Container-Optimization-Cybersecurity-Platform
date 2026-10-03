# Phase 0 / Phase 5 Benchmark Harness

Dependency-free harness implementing the PRD's **Appendix A methodology** across the
**Appendix B** test matrix. One driver serves both the Phase 0 baseline and the Phase 5
optimised run — only the image set changes.

## Quick start

```bash
./run.sh legacy    # Phase 0 baseline (platform/{attacker,target}:legacy)
./run.sh opt       # Phase 5 optimised run (platform/{attacker,target}:opt)
./run.sh live      # live measurement of one optimised pair -> benchmark/live/latest.json
```

Output: `benchmark/reports/run-<UTC-ts>-<pair>/` containing
`images.json`, `coldstart.json`, `idle.json`, `ramp.json`, `summary.json`, `report.md`
(plus `ramp.stdout`). The driver always tears down its `bm-*` containers/networks on exit
(via `trap`).

## `measure-live.sh` — the on-demand measurement served as LIVE

`./run.sh live` (or `./measure-live.sh`, `POST /benchmarks/run`, or the dashboard's
**Re-run benchmark** button) measures **one optimised pair, right now**, and publishes
it to `benchmark/live/latest.json`, which `GET /benchmarks` prefers over the recorded
`docs/before-after-measurements.json` baseline.

| Aspect | Behaviour |
|---|---|
| Provisioning | **delegated** to `orchestrator/provision.sh` — this file contains no `docker run` flags, so the measured pair always carries the FR-06 limits / FR-02 digests a real session gets |
| Readiness | both containers' healthchecks must be green before sampling |
| Sampling | `BENCH_SAMPLES` × `docker stats --no-stream --format '{{json .}}'` at `BENCH_SAMPLE_INTERVAL_S`, plus a `docker exec <c> ps aux \| wc -l` process count per container; every raw per-sample value is kept |
| Summary | median of the samples (mean, last and spread also recorded) |
| Host gauges | probed at run time (`nproc`/`sysctl hw.ncpu`, `/proc/meminfo` or `sysctl hw.memsize`, `docker version --format '{{.Server.Version}}'`) — never literals |
| Teardown | `trap` on EXIT/INT/TERM, mirroring the api.js `DELETE /sessions` + provision.sh contract: both containers, the per-session network, and the state files — **including on failure** |
| Publish | atomic: sibling temp file + `rename(2)`, so a reader sees the old or the new document, never a partial one; a failed run cannot truncate the last good result |
| Provenance | `generated_at` on every run; `dry_run: true` for self-tests |

```bash
./measure-live.sh                          # SSoT protocol from orchestrator/lifecycle.env
./measure-live.sh --settle 30 --samples 4  # CLI overrides for a quick check
./measure-live.sh --dry-run                # fake docker CLI, no daemon required (CI)
./measure-live.sh --out /tmp/probe.json    # measure somewhere else
```

`--dry-run` never writes `latest.json`: a self-test must not be able to pose as a
measurement. It writes `benchmark/live/dry-run.json` instead.

Process-count caveat: `ps aux` includes the transient `ps` used to read it, so these
counts run one above `docker top` (which produced the recorded `procs_*` values). The
protocol string in the artifact states the method.

Protocol knobs are **not** in this script — they are the `BENCH_*` block of
`orchestrator/lifecycle.env` (`BENCH_SESSION_ID`, `BENCH_BUNDLE`, `BENCH_SETTLE_S`,
`BENCH_SAMPLES`, `BENCH_SAMPLE_INTERVAL_S`), whose defaults are deliberately the
recorded 2026-10-01 protocol so a LIVE figure stays comparable with the BASELINE
figure it renders beside. Env overrides (`SETTLE_SECONDS`, `BENCH_SAMPLES`,
`BENCH_SAMPLE_INTERVAL_S`) sit between the file and the CLI flags.

## Stages

| Script | Measures | Key output |
|---|---|---|
| `measure-live.sh` | one optimised pair, live | `benchmark/live/latest.json` |
| `01-images.sh <dir>` | image sizes via `docker image inspect .Size` | `images.json` |
| `02-coldstart.sh <dir>` | provision → both-ready, `BENCH_RUNS` reps → median | `coldstart.json` |
| `03-idle.sh <dir> <pair#>` | settle, then median idle RAM/CPU/procs over window | `idle.json` |
| `04-ramp.js` (env `BENCH_OUT_DIR=<dir>`) | concurrent pairs before exhaustion | `ramp.json` |
| `05-report.sh <dir>` | aggregates all of the above | `summary.json`, `report.md` |
| `lib.sh` | shared helpers: naming, readiness probe, `host_stats`, teardown | — |

## Knobs (env vars, defaults in `lib.sh`)

| Var | Default | Meaning |
|---|---|---|
| `LAB_PAIR` | `legacy` | image-set label; also drives `IMG_ATTACKER`/`IMG_TARGET` |
| `BENCH_RUNS` | `3` | cold-start repetitions (median reported) |
| `IDLE_SETTLE_S` | `30` | wait after cold-start before sampling |
| `IDLE_SAMPLE_S` / `IDLE_INTERVAL_S` | `60` / `5` | idle sampling window / cadence |
| `RAMP_DWELL_S` | `8` | dwell per added pair (readiness + metric convergence) |
| `RAMP_MAX_PAIRS` | `24` | hard cap for the ramp |
| `EXHAUST_CPU_PCT` / `EXHAUST_CPU_SUSTAIN_S` | `90` / `60` | CPU trigger |
| `EXHAUST_MEM_FRAC` | `0.92` | memory trigger (fraction of host total) |
| `RAMP_POLL_S` | `2` | ramp metric poll interval |
| `COLD_START_SLA_S` | `60` | legacy cold-start guard (10s SLA is a Phase 5 target) |

## Design notes / gotchas

- **No `HEALTHCHECK` in Phase 0 images** — readiness is probed directly by the harness
  (attacker `docker exec` + target HTTP 200 on the per-session network). FR-07 healthchecks
  arrive in Phase 1 and replace this probe.
- **`docker stats` has no `--filter` flag** — `stats()`/`host_stats()` enumerate all
  containers and select `bm-*` client-side. Do not reintroduce `--filter` there.
  (`docker ps` *does* OR multiple `name=` filters, so multi-filter teardown loops are fine.)
- **Attacker stays resident only if stdin stays open** — a plain `bash`/`msfconsole` PID 1
  exits on EOF when run headless, so the legacy entrypoint pins stdin with
  `tail -f /dev/null`. Without that, pairs die mid-ramp and results are meaningless.
- **Exhaustion counts**: only pairs surviving a full dwell are credited to `max_pairs`;
  the pair that trips a threshold is excluded (`peak = n - 1`).
- Cleanup is scoped to the `bm-*`/`bm-net-*` prefixes so unrelated containers on the host
  are never touched. `measure-live.sh` instead reuses the `sess-<id>-*` naming of
  `orchestrator/provision.sh`, because it delegates provisioning to it and must clean up
  exactly what provision.sh created.
- `docker stats --format '{{json .}}'` is parsed with `sed`, never `jq` (no new tooling);
  the script needs only bash + the docker CLI on top of coreutils/sed/awk.
- **`benchmark/live/` is scratch**: it is git-ignored, and its contents are the output of
  whatever ran last on this host, not a committed record. The committed record is
  `docs/before-after-measurements.json`.
