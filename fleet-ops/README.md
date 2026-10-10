# `@graveyield/fleet-ops` — the fleet service runner (Phase 11)

One supervised process that runs the **Scout** and the **Monitor** with
health, alerting, and JSONL trails — the roadmap Phase 11
"first Salvor running" row, plus the fleet's slice of observability.

> The protocol-side services (indexer service, GraveVault observer,
> Merkle snapshot service, the read-only vault audit scenarios) live in
> the [graveyield-protocol](https://github.com/GraveYield/graveyield-protocol)
> repo under `ops/` — runbook: `docs/OPS.md` there. This package is the
> fleet-side twin: same health/alert patterns, deliberately standalone
> (the two repos share only the SDK).

## What one process does

```text
   ┌─────────────────────────── graveyield-fleet run ───────────────────────────┐
   │                                                                            │
   │   Scout (discovery → evaluation → submission → monitoring)                 │
   │      │  events (cycle-started, candidate-evaluated, opportunity-*, …)      │
   │      ▼                                                                     │
   │   bridge sink ──► Monitor.ingest (in-process; no second feed to drift)     │
   │                     │                                                      │
   │                     ├─► fleet-state/monitor-events.jsonl                   │
   │                     └─► diagnose() sweep ─► alerts (coded, deduped)        │
   │   health: scout + monitor components, counters, JSON snapshots             │
   └────────────────────────────────────────────────────────────────────────────┘
```

- The Scout keeps its own contract: dry-run is the default, submission
  mode requires `SCOUT_DRY_RUN=0` + `ACTIVITY_ORACLE_KEY` +
  `SALVOR_KEYPAIR` exactly as before. The runner NEVER touches that
  gate.
- The Monitor stays read-only by construction (it has no submission
  path); the runner only feeds it and reads its diagnostics.
- Executor bots join the same pattern when an operator enables them —
  their events flow into the Monitor through the same bridge
  (`FleetRunner.bridgeFleetEvent`).

## CLI

```bash
graveyield-fleet run      # Scout + Monitor forever (default command)
graveyield-fleet cycle    # one Scout cycle, then exit
graveyield-fleet sweep    # one Monitor sweep, then exit
graveyield-fleet health   # health snapshot
```

SIGINT/SIGTERM stop both schedules and exit 0 (systemd-friendly).

## Environment

The Scout consumes its own documented contract (`loadScoutConfig`:
`RPC_URL`, `CLUSTER`, `SCOUT_DRY_RUN`, `ACTIVITY_ORACLE_KEY`,
`SALVOR_KEYPAIR`, `SCOUT_REPORT_FILE`, …). fleet-ops adds:

| Variable | Default | Meaning |
|---|---|---|
| `FLEET_STATE_DIR` | `fleet-state` | JSONL trails + alerts |
| `FLEET_SCOUT_POLL_MS` | `300000` | Scout cycle interval |
| `FLEET_MONITOR_POLL_MS` | `60000` | Monitor sweep interval |
| `FLEET_ALERT_DEDUP_MS` | `1800000` | same-code suppression window |

## Alert codes

`scout-cycle-failed` (critical — discovery stalled) and
`monitor-<diagnostic-code>` with the fleet Monitor's severity mapping
(`conflicting-claims`, `failed-simulation`, `receipt-mismatch` →
critical; `stale-opportunity`, `cert-expired`, `repeated-attempts`,
`failed-submission`, `unverified-confirmation`, `receipt-missing` →
warn; `receipt-verified`, `reconciled`, `cert-expiry-imminent` → info,
counted not paged).

## Health

`graveyield-fleet health` prints the JSON snapshot: per-component
status with derived staleness (silent past 3× the poll interval ⇒
`stale`), monotonic counters (`scout.cycles`, `scout.discovered`,
`scout.candidates`, `scout.phase1-submitted`, `monitor.sweeps`,
`monitor.diag-*`), overall status.

## Tests

27 offline tests: cycle observability (heartbeats, counters, degraded
vs down), monitor diagnostic → alert mapping (including bigint detail
stringification), the Scout→Monitor bridge, timer lifecycle. No
network.
