# Container Optimization Cybersecurity Platform
# Documentation (Phase 1 - Phase 5)

## Project Overview

This project implements a Container Optimization cybersecurity platform that demonstrates
how container resource limits can be used to optimize security and reduce attack surface.
The platform provisions isolated container pairs (attacker + target) with enforced
resource constraints and provides measurement capabilities.

**Phase Timeline:**
- **Phase 1**: Image build with digest pins (FR-01, FR-02, FR-03, FR-16)
- **Phase 2**: Session provisioning with cgroup limits verification (FR-05, FR-06, NFR-03)
- **Phase 3**: Session lifecycle API (FR-08) + benchmarking (FR-10)
- **Phase 4**: Monitoring stack integration (FR-11, FR-12, NFR-08)
- **Phase 5**: Idle session reaping & optimization metrics (FR-13, FR-14, FR-15)

## Architecture

### Core Components

1. **Orchestrator API** (`orchestrator/api.js`)
   - Express-compatible Node.js server (bare-metal compatible via lib/http_shim.js)
   - RESTful endpoints for session lifecycle management
   - Delegates provisioning/teardown to `orchestrator/provision.sh`
   - Benchmark lifecycle management (live measurement + recorded baseline)

2. **Provisioning Script** (`orchestrator/provision.sh`)
   - Single canonical entrypoint for session creation (FR-05)
   - Pull-only image references with digest pins (FR-02, FR-05)
   - cgroup limit enforcement at creation time (FR-06):
     - Memory / Memory-Swap limits
     - CPU shares (NanoCpus)
     - PID limits
   - SSH opt-in via FR-18 (per-lab configuration)
   - Container verification via `docker inspect` exit criterion

3. **Image Build System** (`images/build.sh`)
   - Canonical build entrypoint (FR-01/FR-02/FR-03/FR-16)
   - Sources `images/digests.env` as single source of truth
   - Multi-stage Docker builds with BuildKit
   - Shared base layer (`platform/base`) for maximum OverlayFS layer sharing (FR-16)
   - Bundle-specific images (web-exploitation, network-recon, password-attacks)
   - Optimized target image (reduced proc count vs legacy)

4. **Demo Scripts**
   - `start-demo.sh` - Starts API + web server, opens browser
   - `demo.sh` - Session management (create, status, resources, cleanup)

5. **Benchmark System**
   - Live measurement via `benchmark/measure-live.sh`
   - Recorded baseline: `docs/before-after-measurements.json` (2026-10-01 Phase-5 baseline)
   - Dashboard reads `/benchmarks` endpoint for metrics

### Image Hierarchy

```
platform/base:phase1     -> debian:bookworm-slim + ttyd + tini (shared by ALL)
platform/target:phase1   -> platform/base + php + sqlite + app (target container)
bundles/web-exploitation:phase1 -> platform/base + kali tools (sqlmap, hydra, whatweb)
bundles/network-recon:phase1   -> platform/base + nmap, hydra, etc.
bundles/password-attacks:phase1-> platform/base + wordlists, hydra
```

### Key Directories

```
.
├── orchestrator/           # Core API and provisioning
│   ├── api.js              # Express API server
│   ├── provision.sh        # Session creation/teardown
│   ├── scheduler.js        # Session scheduler
│   ├── lifecycle.env       # Lifecycle configuration
│   ├── limits.env          # cgroup limits (FR-06)
│   ├── state/              # Runtime state directory (.state/)
│   └── test/               # Integration tests
├── images/                 # Docker build context
│   ├── Dockerfile          # Base image target
│   ├── bundles/            # Bundle-specific Dockerfiles
│   │   ├── web-exploitation/Dockerfile
│   │   ├── network-recon/Dockerfile
│   │   └── password-attacks/Dockerfile
│   ├── target/Dockerfile   # Optimized target
│   ├── digests.env         # Single source of truth for image digests (FR-02, FR-16)
│   ├── build.sh            # Canonical build entrypoint
│   ├── base/               # Base image build files
│   ├── shared/             # Shared scripts (entrypoint.sh, ssh-briefing.sh)
│   └── bundles/            # Bundle build configurations
├── lab-configs/            # Per-bundle lab configurations (FR-18 SSH opt-in)
│   ├── web-exploitation.yaml
│   ├── network-recon.yaml
│   ├── password-attacks.yaml
│   └── sample-lab.yaml
├── docs/                   # Documentation and benchmark artifacts
│   └── before-after-measurements.json  # Recorded baseline
├── benchmark/              # Benchmark scripts
│   └── measure-live.sh     # Live measurement script
├── compose/                # Docker compose monitoring stack
├── start-demo.sh           # Cross-platform demo starter
├── demo.sh                 # Cross-platform demo session manager
└── demo-webpage.html / demo.html  # Front-end dashboards
```

## Feature Requirements Map

| Req | Description | Location |
|-----|-------------|----------|
| FR-01 | No legacy-image content in published images | images/Dockerfiles |
| FR-02 | Digest-pinned base image references | images/digests.env |
| FR-03 | cgroup limits enforced at creation | orchestrator/provision.sh |
| FR-04 | CI must publish via build.sh | images/build.sh |
| FR-05 | Pull-only provisioning, no docker build | orchestrator/provision.sh |
| FR-06 | Four limits at creation: mem, swap, cpus, pids | orchestrator/provision.sh |
| FR-07 | Healthchecks on containers | Dockerfile HEALTHCHECK |
| FR-08 | Session lifecycle API (CRUD + status) | orchestrator/api.js |
| FR-09 | (Not explicitly listed in surviving code) | - |
| FR-10 | Benchmark audit trail / reaper events | orchestrator/api.js + WARN_LOG |
| FR-11 | Container labels for cAdvisor | orchestrator/provision.sh |
| FR-12 | Monitoring stack compose config | compose/ |
| FR-13 | Idle session reaping after configurable period | reaper.sh |
| FR-14 | Resource usage metrics for idle sessions | scheduler.js |
| FR-15 | Per-session optimization metrics | api.js + mergeBenchmarks |
| FR-16 | Shared base layer for layer sharing (FR-16) | images/base + digests.env |
| FR-17 | (Not in surviving code) | - |
| FR-18 | Per-lab SSH opt-in (default OFF) | lab-configs/*.yaml + provision.sh |

## Configuration Files

### `images/digests.env` - Digest Pinning (FR-02, FR-16)

Single source of truth for all image digests. All base images and binary checksums
are pinned by SHA-256 digest, never floating tags. Placeholder digests
(`sha256:000...`) are intentional for development and must be updated after CI publish.

Key values:
- `BASE_DEBIAN=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251`
- `KALI_BASE=kalilinux/kali-rolling@sha256:30399bd65187e06525008dd13eecc2b3439d26a82b2c6b0ba32dee72bd843117`
- `WEB_EXPLOITATION_DIGEST`, `NETWORK_RECON_DIGEST`, `PASSWORD_ATTACKS_DIGEST`, `TARGET_DIGEST` - session image digests (placeholder by default)

### `orchestrator/limits.env` - cgroup Limits (FR-06)

Single source of truth for container resource limits. Format: `NAME=VALUE`. Read
by `orchestrator/api.js` and `orchestrator/provision.sh`.

Typical values (adjust as needed):
- `ATTACKER_MEMORY=512m`
- `ATTACKER_MEMORY_SWAP=512m`
- `ATTACKER_CPUS=0.5`
- `ATTACKER_PIDS_LIMIT=256`
- `TARGET_MEMORY=256m`
- `TARGET_MEMORY_SWAP=256m`
- `TARGET_CPUS=0.25`
- `TARGET_PIDS_LIMIT=128`

### `lab-configs/*.yaml` - Per-Lab SSH Opt-in (FR-18)

Per-bundle laboratory configuration. Controls whether SSH is enabled by default
for that bundle's labs. Value overrides resolved in this order:
1. Explicit `LAB_SSH_ENABLED` env var (API body / operator shell)
2. `lab-configs/<bundle>.yaml` `ssh_enabled` field
3. Default `0` (SSH stays off, minimal idle process set)

Example (`lab-configs/web-exploitation.yaml`):
```yaml
version: 1
attacker_bundle: web-exploitation
target_app: vuln-webapp-lite
labs:
  - lab_id: sqli-001
    ssh_enabled: false
  - lab_id: xss-stored-002
    ssh_enabled: false
validation_rule: "New labs MUST declare ssh_enabled explicitly."
```

### `orchestrator/provision.sh` Environment Overrides

| Env Var | Description | Default |
|---------|-------------|---------|
| `REGISTRY` | Docker registry prefix | `platform` |
| `VERSION` | Image tag version | `phase1` |
| `KEEP_RUNNING` | Leave containers up after API create | `1` (set by API) |
| `LAB_SSH_ENABLED` | SSH opt-in for session | derived from lab-config |
| `DIGESTS_FILE` | Path to digests.env | `$ROOT/images/digests.env` |
| `LOCAL_TAG_FALLBACK` | Fallback to tag when digest is placeholder | `1` |

## API Endpoints

### Session Lifecycle (FR-08)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST /sessions` | Create session | `{bundle, id?}` -> creates attacker+target pair |
| `GET /sessions/:id` | Session status | Container states + health + limits |
| `DELETE /sessions/:id` | Teardown session | Removes containers + network + state files |
| `GET /sessions` | List sessions | Returns IDs of all active sessions |
| `GET /sessions/:id/events` | Audit events | WARN_LOG entries for this session |

### Benchmark Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET /benchmarks` | Get benchmark metrics | Live measurement or recorded baseline |
| `POST /benchmarks/run` | Run fresh measurement | Returns 202 + job_id, progresses asynchronously |
| `GET /benchmarks/status` | Benchmark status | `{running, last_run_at, error?, job_id}` |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET /health` | Liveness | `{ok: true, phase: 3}` |

### CORS

All endpoints include CORS headers:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

## How to Run the Demo

### Prerequisites

- Docker Desktop/Engine running
- Node.js (for the Orchestrator API)
- Python 3 (for simple HTTP server)
- `jq` (for JSON parsing in demo.sh, optional but recommended)
- Cross-platform: scripts detect OS and use appropriate commands

### macOS / Linux

```bash
# Start the demo environment
./start-demo.sh

# Or, manage sessions manually
./demo.sh
```

### Windows (Git Bash / WSL)

```bash
# Git Bash or WSL terminal
chmod +x start-demo.sh demo.sh
./start-demo.sh
```

### Building Images

```bash
# Build base image only
./images/build.sh base

# Build target image
./images/build.sh target

# Build a bundle image
./images/build.sh web-exploitation

# Build all images
./images/build.sh all

# With push (CI)
PUSH=1 ./images/build.sh all
```

### Running Benchmarks

```bash
# Start demo first
./start-demo.sh

# Run a live measurement
curl -s -X POST localhost:8080/benchmarks/run

# Check status
curl -s localhost:8080/benchmarks/status

# Get metrics (live or baseline)
curl -s localhost:8080/benchmarks
```

## Cross-Platform Considerations

The `start-demo.sh` and `demo.sh` scripts have been rewritten to support:

### Operating System Detection

```bash
case "$(uname -s)" in
  Linux*)   OS="linux";;
  Darwin*)  OS="macos";;
  *)        OS="unknown";;
esac
```

### Command Availability

- `lsof`: Used for port conflict detection (Linux/macOS). Falls gracefully if unavailable.
- `open` (macOS) / `start` (Windows) / `xdg-open` (Linux): Browser launchers.
- `pkill` (Linux/macOS) / `taskkill` (Windows): Process termination.
- `docker`: Core command, expected to be available in all environments.
- `python3 -m http.server`: Simple HTTP server, available on all platforms.

### Process Management

- **Kill detection**: Uses `pkill` on POSIX systems, `taskkill` on Windows
- **PID tracking**: API process PID is captured and used for targeted cleanup
- **Trap handler**: `trap cleanup INT TERM` ensures cleanup on interrupt/signals

### Browser Launch

- macOS: `open http://...`
- Windows: `start http://...` or PowerShell `Start-Process`
- Linux: `xdg-open http://...` with fallback

## Development & Testing

### Integration Tests

The orchestrator includes a test suite that can run without Docker via the
`PROVISION_STUB=1` environment variable:

```bash
ORCH_HOME=./orchestrator PROVISION_STUB=1 node --test orchestrator/test/
```

This sands off the Docker-dependent provisioning and uses a stub that writes
session metadata to `.state/` instead.

### Running Tests

```bash
# With Docker available
cd orchestrator
node --test

# Stubbed (no Docker)
ORCH_HOME=./orchestrator PROVISION_STUB=1 node --test
```

### Adding a New Bundle

1. Add bundle Dockerfile to `images/bundles/<name>/Dockerfile`
2. Add bundle entry to `KNOWN_BUNDLES` in `orchestrator/api.js`
3. Add lab config to `lab-configs/<name>.yaml` (include `ssh_enabled`)
4. Update `images/digests.env` with new digest values after CI publish
5. Update `IMAGE_NAMES` in `images/digests.env` if adding new image type

## License

MIT - See LICENSE file for details.