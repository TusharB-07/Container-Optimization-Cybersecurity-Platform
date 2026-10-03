#!/usr/bin/env bash
# measure-live.sh — Phase 5 live benchmark measurement (measured on demand, not recorded).
# ---------------------------------------------------------------------------
# docs/before-after-measurements.json is the AUDITED 2026-10-01 baseline: a frozen
# artifact, served as such by GET /benchmarks. This script produces the *other* kind
# of number — one measured now, on this host, by this daemon — and publishes it to
# benchmark/live/latest.json, which the API prefers over the recorded file.
#
# Deliberate non-goals (each keeps a single source of truth):
#   - It does NOT reimplement `docker run` flags. Provisioning is delegated to
#     orchestrator/provision.sh (FR-06 limits, FR-02 digests, NFR-03 isolation all
#     live there; duplicating them here would let the measured pair drift from the
#     pair a real session gets). This script only decides WHEN to sample and HOW to
#     record it.
#   - It does NOT duplicate protocol numbers: settle/samples/interval come from the
#     BENCH_* block of orchestrator/lifecycle.env (rationale recorded there).
#
# Protocol (identical to the recorded baseline, so a LIVE number stays comparable
# with the BASELINE number it renders next to): provision one optimized pair, wait for
# both healthchecks, settle, then N samples at INTERVAL seconds. Each sample records
# `docker stats --no-stream --format '{{json .}}'` plus a process count taken with
# `docker exec <container> ps aux | wc -l`.
#
# PROCESS COUNT CAVEAT: `ps aux` includes the transient `ps` used to read it, so these
# counts run one higher than `docker top` (which produced the recorded procs_* values).
# One counting method is fixed here rather than two that could silently disagree; the
# emitted protocol string states the method so a reader can adjust the comparison.
#
# Teardown mirrors the api.js DELETE /sessions + provision.sh cleanup contract (both
# containers, the per-session network, the state files) and runs from an EXIT trap, so a
# failed or interrupted measurement never leaves a pair or an orphan network behind.
#
# Usage:
#   ./measure-live.sh [--settle N] [--samples N] [--interval N]
#                     [--session-id ID] [--bundle B] [--out PATH] [--dry-run] [--help]
#
# Precedence: CLI flag > env (SETTLE_SECONDS / BENCH_SAMPLES / BENCH_SAMPLE_INTERVAL_S
# / BENCH_SESSION_ID / BENCH_BUNDLE) > orchestrator/lifecycle.env defaults.
#
# --dry-run runs the whole control flow against a generated fake docker CLI, so CI can
# validate this script on a host with no Docker daemon. Its output goes to
# benchmark/live/dry-run.json, never to latest.json: a self-test must not be able to
# masquerade as a measurement. Forced elsewhere with --out it is still tagged
# "dry_run": true, and GET /benchmarks then surfaces that in its warnings.
#
# Env seams (tests/ops): OUT_FILE (output path, same as --out), PROVISION_BIN,
# LIFECYCLE_ENV, STATE_DIR, BENCH_HEALTH_WAIT_S (healthcheck poll budget, seconds).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LIFECYCLE_ENV="${LIFECYCLE_ENV:-$ROOT/orchestrator/lifecycle.env}"
PROVISION_BIN="${PROVISION_BIN:-$ROOT/orchestrator/provision.sh}"
STATE_DIR="${STATE_DIR:-$ROOT/orchestrator/.state}"

# ---- config SSoT (no protocol numbers below this line) -------------------------
[[ -f "$LIFECYCLE_ENV" ]] || { echo "FAIL: lifecycle.env not found: $LIFECYCLE_ENV" >&2; exit 1; }
# shellcheck disable=SC1090
source "$LIFECYCLE_ENV"

SESSION_ID="${BENCH_SESSION_ID:?BENCH_SESSION_ID missing from $LIFECYCLE_ENV}"
BUNDLE="${BENCH_BUNDLE:?BENCH_BUNDLE missing from $LIFECYCLE_ENV}"
SETTLE_SECONDS="${SETTLE_SECONDS:-${BENCH_SETTLE_S:?BENCH_SETTLE_S missing from $LIFECYCLE_ENV}}"
SAMPLES="${BENCH_SAMPLES:?BENCH_SAMPLES missing from $LIFECYCLE_ENV}"
INTERVAL_SECONDS="${BENCH_SAMPLE_INTERVAL_S:?BENCH_SAMPLE_INTERVAL_S missing from $LIFECYCLE_ENV}"
DRY_RUN=0
OUT_FILE="${OUT_FILE:-}"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'; }

# ---- CLI (beats env, beats the SSoT file) ---------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --settle)     SETTLE_SECONDS="${2:?--settle needs a value}"; shift 2 ;;
    --samples)    SAMPLES="${2:?--samples needs a value}"; shift 2 ;;
    --interval)   INTERVAL_SECONDS="${2:?--interval needs a value}"; shift 2 ;;
    --session-id) SESSION_ID="${2:?--session-id needs a value}"; shift 2 ;;
    --bundle)     BUNDLE="${2:?--bundle needs a value}"; shift 2 ;;
    --out)        OUT_FILE="${2:?--out needs a value}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

[[ -n "$OUT_FILE" ]] || OUT_FILE="$ROOT/benchmark/live/latest.json"
[[ "$DRY_RUN" == 1 ]] && [[ "$OUT_FILE" == "$ROOT/benchmark/live/latest.json" ]] && OUT_FILE="$HERE/live/dry-run.json"
OUT_DIR="$(dirname "$OUT_FILE")"
ATT_C="sess-$SESSION_ID-attacker"
TGT_C="sess-$SESSION_ID-target"
NET="sess-$SESSION_ID-net"
HEALTH_WAIT_S="${BENCH_HEALTH_WAIT_S:-30}"
PROCS_METHOD='docker exec <container> ps aux | wc -l'

mkdir -p "$OUT_DIR" "$STATE_DIR"

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "FAIL: $*"; exit 1; }
utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
utc_epoch() { date -u '+%s'; }

# ---- unit conversion: pure bash integer math (milli-MiB) -----------------------
# to_milli_mib "17.89MiB" -> 17890. Integer arithmetic only, so summing and
# averaging samples cannot drift the way floating-point accumulation would.
to_milli_mib() {
  local s num unit int frac
  s="${1%%/*}"                 # "17.89MiB / 512MiB" -> "17.89MiB "
  s="${s//[[:space:]]/}"       # kill the surrounding spaces
  num="${s%%[A-Za-z]*}"; unit="${s#"$num"}"
  [[ -z "$num" ]] && { echo 0; return 0; }
  int="${num%%.*}"; frac="${num#*.}"; [[ "$frac" == "$num" ]] && frac=0
  int="${int:-0}"; frac="${frac}000"; frac="${frac:0:3}"   # keep 3 decimals
  frac=$(( 10#$frac ))
  case "$unit" in
    GiB) echo $(( int * 1024 * 1000 + frac * 1024 )) ;;
    MiB) echo $(( int * 1000 + frac )) ;;
    KiB) echo $(( int * 1000 / 1024 + frac / 1024 )) ;;
    B)   echo $(( int * 1000 / 1048576 + frac / 1048576 )) ;;
    *)   echo $(( int * 1000 + frac )) ;;
  esac
}
fmt_milli() { printf '%d.%02d' $(( $1 / 1000 )) $(( $1 % 1000 )); }
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# JSON scalars must never be bare words: an unprobeable gauge emits "unknown", which
# would make the whole artifact unparseable (and therefore invisible to the API).
json_num() { [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && printf '%s' "$1" || printf '"%s"' "$(json_str "$1")"; }

# ---- host gauges: every field probed at runtime, never a literal ---------------
host_vcpu() {  # logical CPUs: nproc on Linux, sysctl elsewhere
  if command -v nproc >/dev/null 2>&1; then nproc
  elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.ncpu 2>/dev/null || echo unknown
  else getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown; fi
}
HOST_MEM_SOURCE="unknown"
# Prints "<gib>|<source>" on ONE line: the caller reads it back with `read`, because a
# $(...) capture runs in a subshell and could not carry a global assignment out with it.
host_ram_gib() {
  local kb bytes
  if [[ -r /proc/meminfo ]]; then
    kb="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo | head -1)"
    if [[ -n "$kb" ]]; then
      HOST_MEM_SOURCE="/proc/meminfo"
      printf '%s|%s' "$(awk -v k="$kb" 'BEGIN{printf "%.1f", k/1048576}')" "$HOST_MEM_SOURCE"   # kB -> GiB
      return 0
    fi
  fi
  if command -v sysctl >/dev/null 2>&1; then
    bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
    if [[ -n "$bytes" ]]; then
      HOST_MEM_SOURCE="sysctl hw.memsize"
      printf '%s|%s' "$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1073741824}')" "$HOST_MEM_SOURCE"  # bytes -> GiB
      return 0
    fi
  fi
  printf 'unknown|unknown'
}
docker_server_version() { docker version --format '{{.Server.Version}}' 2>/dev/null || printf 'unknown'; }

# ---- dry-run: a fake docker CLI generated here (no new tooling) ----------------
# Only used with --dry-run, so CI without a Docker daemon can still exercise every
# branch of this script (provision → health → settle → sample → publish → teardown).
# It answers exactly the verbs provision.sh and this script issue.
DRY_RUN_DOCKER_DIR=""   # named so it can never clobber an inherited FAKE_DOCKER_* seam
write_fake_docker() {
  DRY_RUN_DOCKER_DIR="$(mktemp -d)"
  local fake="$DRY_RUN_DOCKER_DIR/docker" state="$DRY_RUN_DOCKER_DIR/state.env"
  cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
# Generated by benchmark/measure-live.sh --dry-run. Self-test stub, NOT a measurement.
set -uo pipefail
S="${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE unset}"
[[ -f "$S" ]] || printf 'FDC_STATS_N=0\n' > "$S"
# shellcheck disable=SC1090
source "$S"
verb="${1:-}"; shift || true
# Fault injection: FAKE_DOCKER_FAIL_VERBS="stats inspect" makes those verbs exit
# non-zero, which is how the "does it still tear the pair down when the measurement
# fails?" path is exercised without a real daemon.
if [[ -n "${FAKE_DOCKER_FAIL_VERBS:-}" ]] && [[ " $FAKE_DOCKER_FAIL_VERBS " == *" $verb "* ]]; then
  printf 'fake docker: induced failure for %s\n' "$verb" >&2; exit 1
fi
case "$verb" in
  version) printf '0.0.0-fake\n'; exit 0 ;;
  rm)      exit 0 ;;
  logs)    exit 0 ;;
  network) [[ "${1:-}" == create ]] && printf 'ok\n'; exit 0 ;;
  run)
    # record the container name + its cgroup limits so `inspect` can replay them,
    # exactly as a real daemon reports back the flags it was handed
    name=""; mem=""; swap=""; cpus=""; pids=""; prev=""
    for a in "$@"; do
      case "$prev" in
        --name) name="$a" ;; --memory) mem="$a" ;; --memory-swap) swap="$a" ;;
        --cpus) cpus="$a" ;; --pids-limit) pids="$a" ;;
      esac
      prev="$a"
    done
    to_b() { [[ "$1" == *m ]] && echo $(( ${1%m} * 1024 * 1024 )) || echo "${1:-0}"; }
    printf '%s %s %s %s\n' "$(to_b "$mem")" "$(to_b "$swap")" \
      "$(awk -v c="$cpus" 'BEGIN{printf "%d", c*1e9}')" "${pids:-0}" \
      > "$(dirname "$S")/hc-$name"
    printf 'id\n'; exit 0 ;;
  ps)      printf 'sess-%s-attacker\nsess-%s-target\n' "$FDC_SID" "$FDC_SID"; exit 0 ;;
  inspect|image)
    [[ "$verb" == image ]] && shift                     # drop the "image" sub-verb
    fmt=""; prev=""; names=""
    for a in "$@"; do
      if [[ "$prev" == -f || "$prev" == --format ]]; then fmt="$a"; prev=""; continue; fi
      case "$a" in -f|--format) ;; -*) ;; *) names="$names $a" ;; esac
      prev="$a"
    done
    [[ -z "${names// /}" ]] && exit 1
    for n in $names; do
      hc="$(dirname "$S")/hc-$n"
      case "$fmt" in
        *NanoCpus*)    if [[ -f "$hc" ]]; then cat "$hc"; else printf '0 0 0 0\n'; fi ;;
        *Config.Cmd*)  printf 'null\n' ;;
        *Health*)      printf 'healthy\n' ;;
        *Running*)     printf 'true\n' ;;
        *)             printf '/%s running healthy\n' "$n" ;;
      esac
    done; exit 0 ;;
  stats)
    n=$(( ${FDC_STATS_N:-0} + 1 ))
    jitter=$(( (n * 7 + 9) % 23 ))                       # varies per call AND per run
    printf '{"Name":"sess-%s-attacker","MemUsage":"%d.%02dMiB / 512MiB","CPUPerc":"0.%02d%%","PIDs":"2"}\n' \
      "$FDC_SID" "$(( 17 + jitter / 10 ))" "$(( (jitter * 6) % 100 ))" "$(( jitter % 9 ))"
    printf '{"Name":"sess-%s-target","MemUsage":"%d.%02dMiB / 256MiB","CPUPerc":"0.%02d%%","PIDs":"3"}\n' \
      "$FDC_SID" "$(( 27 + jitter / 10 ))" "$(( (jitter * 5) % 100 ))" "$(( jitter % 7 ))"
    printf 'FDC_STATS_N=%s\n' "$n" >> "$S"; exit 0 ;;
  exec)
    container="${1:-}"; shift
    if [[ "${1:-}" == ps ]]; then
      printf 'USER PID %%CPU\nlab 1 0.0\nlab 7 0.0\nlab 8 0.0\n'   # 4 lines -> | wc -l
    fi
    exit 0 ;;
esac
exit 0
FAKE
  chmod 0755 "$fake"
  printf 'FDC_SID=%s\nFDC_STATS_N=0\n' "$SESSION_ID" > "$state"
  export FAKE_DOCKER_STATE="$state"
  export PATH="$DRY_RUN_DOCKER_DIR:$PATH"
  log "dry-run: fake docker CLI injected at $fake (PATH-prefixed for this process tree)"
}

# ---- cleanup contract (mirrors api.js DELETE /sessions + provision.sh) ---------
# Runs from the EXIT trap on success, failure or signal, so a wedged or failed
# measurement can never leave containers, a network, or state files behind. INT/TERM
# are trapped explicitly: an untrapped signal would kill the shell without reaching
# the EXIT trap, which is exactly how a half-measured pair would be orphaned.
teardown() {
  docker rm -f "$ATT_C" "$TGT_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  for f in prev low warned; do rm -f "$STATE_DIR/idle-$SESSION_ID.$f" 2>/dev/null || true; done
  rm -f "$STATE_DIR/session-$SESSION_ID.meta" 2>/dev/null || true
  [[ -n "$DRY_RUN_DOCKER_DIR" ]] && rm -rf "$DRY_RUN_DOCKER_DIR" 2>/dev/null
  return 0
}
trap teardown EXIT
trap 'teardown; exit 130' INT
trap 'teardown; exit 143' TERM

# ---- 1. provision (delegated: this file contains no docker-run flags) ----------
[[ "$DRY_RUN" == 1 ]] && write_fake_docker
PROVISION_STARTED_EPOCH="$(utc_epoch)"
log "provisioning pair $SESSION_ID (bundle=$BUNDLE) via provision.sh"
# KEEP_RUNNING=1: provision.sh's default EXIT trap would tear the pair down the
# moment it finished verifying, and its healthcheck wait is exactly the readiness
# gate this script needs before it can settle and sample.
KEEP_RUNNING=1 "$PROVISION_BIN" "$BUNDLE" "$SESSION_ID" \
  || die "provision.sh failed for bundle=$BUNDLE session=$SESSION_ID"
# Cold-start KPI (PRD §5 ≤ 10 s): provision.sh returns only after BOTH containers are
# healthy and their limits verified, so this span is docker run -> both healthy. On a
# first run it also contains the image pull, which is why the protocol string says so.
COLD_START_S=$(( $(utc_epoch) - PROVISION_STARTED_EPOCH ))

# ---- 2. both healthchecks green, then settle ----------------------------------
# provision.sh already blocks until both report healthy; re-checking keeps this
# script correct when pointed at a PROVISION_BIN that returns early, and fails loudly
# (instead of sampling a dying container) if the pair dies mid-wait.
wait_healthy() {  # <container>
  local c="$1" i s
  for i in $(seq 1 "$HEALTH_WAIT_S"); do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || true)"
    [[ "$s" == healthy ]] && return 0
    if [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || true)" == false ]]; then
      log "FAIL: $c exited before becoming healthy"; docker logs "$c" >&2 2>/dev/null || true; return 1
    fi
    sleep 1
  done
  log "FAIL: $c never became healthy"; return 1
}
wait_healthy "$ATT_C" || die "attacker never healthy"
wait_healthy "$TGT_C" || die "target never healthy"

log "both healthy; settling ${SETTLE_SECONDS}s before sampling"
[[ "$SETTLE_SECONDS" -gt 0 ]] && sleep "$SETTLE_SECONDS"

# ---- 3. sample ----------------------------------------------------------------
# One iteration = one `docker stats --no-stream` read of BOTH containers plus one
# `ps aux | wc -l` per container. Raw per-sample values are preserved in the output
# (the recorded baseline's numbers are likewise a statistic over samples like these);
# the summary block is the median, never an invented "current" value.
samples_json=""
sum_att_m=0; sum_tgt_m=0; sum_att_p=0; sum_tgt_p=0
last_att_m=0; last_tgt_m=0; last_att_p=0; last_tgt_p=0
vals_att_m=""; vals_tgt_m=""; vals_att_p=""; vals_tgt_p=""

json_field() {  # <json line> <key> -> raw value (docker stats emits one JSON object per line)
  # the whitespace after the colon is optional: docker's {{json .}} is compact, but a
  # missing field must return empty (caught below) rather than silently parse as 0.
  printf '%s' "$1" | sed -n "s/.*\"$2\":[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"
}

for i in $(seq 1 "$SAMPLES"); do
  stats="$(docker stats --no-stream --format '{{json .}}' "$ATT_C" "$TGT_C")" || die "docker stats failed on sample $i"
  att_line="$(printf '%s\n' "$stats" | grep -F "\"$ATT_C\"" || true)"
  tgt_line="$(printf '%s\n' "$stats" | grep -F "\"$TGT_C\"" || true)"
  [[ -n "$att_line" ]] || die "sample $i: no stats line for $ATT_C"
  [[ -n "$tgt_line" ]] || die "sample $i: no stats line for $TGT_C"
  att_mem_raw="$(json_field "$att_line" MemUsage)"
  tgt_mem_raw="$(json_field "$tgt_line" MemUsage)"
  # never publish a 0 that is really "the daemon did not report this"
  [[ -n "$att_mem_raw" ]] || die "sample $i: $ATT_C reported no MemUsage (raw: $att_line)"
  [[ -n "$tgt_mem_raw" ]] || die "sample $i: $TGT_C reported no MemUsage (raw: $tgt_line)"
  att_cpu="$(json_field "$att_line" CPUPerc)"
  tgt_cpu="$(json_field "$tgt_line" CPUPerc)"
  att_m="$(to_milli_mib "$att_mem_raw")"
  tgt_m="$(to_milli_mib "$tgt_mem_raw")"
  pair_m=$(( att_m + tgt_m ))
  att_p="$(docker exec "$ATT_C" ps aux | wc -l | tr -d ' ')"
  tgt_p="$(docker exec "$TGT_C" ps aux | wc -l | tr -d ' ')"
  [[ "$att_p" =~ ^[0-9]+$ ]] || att_p=0
  [[ "$tgt_p" =~ ^[0-9]+$ ]] || tgt_p=0
  last_att_m=$att_m; last_tgt_m=$tgt_m; last_att_p=$att_p; last_tgt_p=$tgt_p
  sum_att_m=$(( sum_att_m + att_m )); sum_tgt_m=$(( sum_tgt_m + tgt_m ))
  sum_att_p=$(( sum_att_p + att_p )); sum_tgt_p=$(( sum_tgt_p + tgt_p ))
  vals_att_m="$vals_att_m$att_m"$'\n'; vals_tgt_m="$vals_tgt_m$tgt_m"$'\n'
  vals_att_p="$vals_att_p$att_p"$'\n'; vals_tgt_p="$vals_tgt_p$tgt_p"$'\n'
  samples_json="$samples_json{\"index\":$i,\"at\":\"$(utc_now)\",\"attacker_mem_usage\":\"$(json_str "$att_mem_raw")\",\"target_mem_usage\":\"$(json_str "$tgt_mem_raw")\",\"attacker_mib\":$(fmt_milli "$att_m"),\"target_mib\":$(fmt_milli "$tgt_m"),\"pair_total_mib\":$(fmt_milli "$pair_m"),\"attacker_cpu_pct\":\"$(json_str "$att_cpu")\",\"target_cpu_pct\":\"$(json_str "$tgt_cpu")\",\"procs_attacker\":$att_p,\"procs_target\":$tgt_p},"
  log "sample $i/$SAMPLES: pair=$(fmt_milli "$pair_m") MiB (att=$(fmt_milli "$att_m") tgt=$(fmt_milli "$tgt_m")) procs=$(( att_p + tgt_p ))"
  [[ "$i" -lt "$SAMPLES" ]] && [[ "$INTERVAL_SECONDS" -gt 0 ]] && sleep "$INTERVAL_SECONDS"
done
samples_json="${samples_json%,}"

# median of newline-separated integers (mean of the two middles when the count is even)
median() {
  printf '%s' "$1" | grep -E '^[0-9]+$' | sort -n \
    | awk '{a[NR]=$1} END{if(NR==0){print 0} else if(NR%2==1){printf "%d\n", a[(NR+1)/2]} else {printf "%d\n", (a[NR/2]+a[NR/2+1])/2}}'
}
minmax_spread() { printf '%s' "$1" | sort -n | awk 'NR==1{lo=$1} {hi=$1} END{print hi-lo+0}'; }
med_att_m="$(median "$vals_att_m")"; med_tgt_m="$(median "$vals_tgt_m")"
med_att_p="$(median "$vals_att_p")"; med_tgt_p="$(median "$vals_tgt_p")"
mean_att_m=$(( sum_att_m / SAMPLES )); mean_tgt_m=$(( sum_tgt_m / SAMPLES ))
mean_att_p=$(( sum_att_p / SAMPLES )); mean_tgt_p=$(( sum_tgt_p / SAMPLES ))
spread_att_m="$(minmax_spread "$vals_att_m")"; spread_tgt_m="$(minmax_spread "$vals_tgt_m")"

HOST_VCPU="$(host_vcpu)"
IFS='|' read -r HOST_RAM_GIB HOST_MEM_SOURCE <<< "$(host_ram_gib)"
HOST_DOCKER_SERVER="$(docker_server_version)"
HOST_OS_NOTE="$(uname -s -r -m 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g; s/ $//')"
GENERATED_AT="$(utc_now)"
RUN_ELAPSED_S=$(( $(utc_epoch) - PROVISION_STARTED_EPOCH ))
PROTOCOL="one optimized pair (bundle=$BUNDLE, session=$SESSION_ID), ${SETTLE_SECONDS}s settle, $SAMPLES samples at ${INTERVAL_SECONDS}s intervals, docker stats --no-stream; procs via $PROCS_METHOD (includes the sampling ps itself, so one above docker top)"
PROVENANCE="Measured on this host at $GENERATED_AT by benchmark/measure-live.sh, which provisions through orchestrator/provision.sh with limits.env quotas (FR-06). No value here is estimated or copied; docs/before-after-measurements.json remains the audited 2026-10-01 baseline."

# ---- 4. atomic publish -------------------------------------------------------
# Write a sibling temp file then rename(2) over the destination: a concurrent reader
# (the API, a reloading dashboard) sees either the previous complete document or the
# new complete document, never a half-written one. A failed run never reaches this
# point, so a measurement error can not truncate the previous good result.
tmp_out="$(mktemp "$OUT_DIR/.$(basename "$OUT_FILE").tmp.XXXXXX")"
{
  printf '{\n'
  printf '  "generated_at": "%s",\n' "$GENERATED_AT"
  printf '  "session_id": "%s",\n' "$SESSION_ID"
  printf '  "bundle": "%s",\n' "$BUNDLE"
  printf '  "dry_run": %s,\n' "$([[ "$DRY_RUN" == 1 ]] && echo true || echo false)"
  printf '  "host": { "vcpu": %s, "ram_gib": %s, "docker_server": "%s", "os_note": "%s", "ram_source": "%s" },\n' \
    "$(json_num "$HOST_VCPU")" "$(json_num "$HOST_RAM_GIB")" "$HOST_DOCKER_SERVER" \
    "$(json_str "$HOST_OS_NOTE")" "$(json_str "$HOST_MEM_SOURCE")"
  printf '  "protocol": "%s",\n' "$(json_str "$PROTOCOL")"
  printf '  "run_elapsed_s": %s,\n' "$RUN_ELAPSED_S"
  printf '  "cold_start_s": %s,\n' "$COLD_START_S"
  printf '  "idle_footprint_mib": {\n'
  printf '    "attacker": %s, "target": %s, "pair_total": %s,\n' \
    "$(fmt_milli "$med_att_m")" "$(fmt_milli "$med_tgt_m")" "$(fmt_milli $(( med_att_m + med_tgt_m )))"
  printf '    "mean_attacker": %s, "mean_target": %s, "mean_pair_total": %s,\n' \
    "$(fmt_milli "$mean_att_m")" "$(fmt_milli "$mean_tgt_m")" "$(fmt_milli $(( mean_att_m + mean_tgt_m )))"
  printf '    "last_attacker": %s, "last_target": %s, "last_pair_total": %s,\n' \
    "$(fmt_milli "$last_att_m")" "$(fmt_milli "$last_tgt_m")" "$(fmt_milli $(( last_att_m + last_tgt_m )))"
  printf '    "spread_attacker_mib": %s, "spread_target_mib": %s,\n' \
    "$(fmt_milli "$spread_att_m")" "$(fmt_milli "$spread_tgt_m")"
  printf '    "procs_attacker": %s, "procs_target": %s, "procs_total": %s,\n' \
    "$med_att_p" "$med_tgt_p" $(( med_att_p + med_tgt_p ))
  printf '    "mean_procs_attacker": %s, "mean_procs_target": %s\n' "$mean_att_p" "$mean_tgt_p"
  printf '  },\n'
  printf '  "samples": [%s],\n' "$samples_json"
  printf '  "provenance": "%s"\n' "$(json_str "$PROVENANCE")"
  printf '}\n'
} > "$tmp_out"
chmod 0644 "$tmp_out"   # mktemp creates 0600; the dashboard may be served by another user
mv -f "$tmp_out" "$OUT_FILE"
log "wrote $OUT_FILE (generated_at=$GENERATED_AT)"