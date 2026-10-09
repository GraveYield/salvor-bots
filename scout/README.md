# `@graveyield/scout` — the Scout Salvor (Phase 10)

> The first GraveYield salvor bot. **Discovery and monitoring only.**
> The Scout finds derelict-pool candidates, asks the on-chain GraveScanner
> to evaluate them, watches the eligibility lifecycle progress, and hands
> opportunities to the downstream execution bots. It never salvages.

## The Scout's boundary (non-negotiable)

- The Scout **never** builds salvage instructions, never runs phase 2,
  and never moves funds. Certify-and-salvage belongs to the executor bots
  (Sniper / Conservative / Experimental) under a shared execution policy.
- The Scout **never** declares a pool abandoned. GraveScanner is the only
  eligibility authority: the Scout's pre-filter and SDK double-check only
  decide what is worth surfacing.
- The Scout **never** fabricates evidence. A C1 attestation must carry a
  REAL last-swap timestamp derived from Raydium V4 history — a pool whose
  history scan found no swap is refused (`no-attestable-last-swap`),
  never attested with a made-up one.
- Every Scout-submitted transaction passes the SDK's **Charter guard**
  (`computeBudgetIxs` → `charterGuard`): an over-ceiling priority fee is
  rejected before anything reaches the network. Operators cannot opt out.

## Lifecycle (what one cycle does)

```text
1. DISCOVER      Raydium V4 enumeration (752-byte AmmInfo getProgramAccounts)
2. ENRICH        last-swap activity (cached) → reserves/TVL → mint metadata
3. PRE-FILTER    the six derelict-pool criteria, cheaply (wide funnel)
4. SCORE + QUEUE score = inactivityMargin × tvlMargin × priceCollapseMargin
5. DOUBLE-CHECK  SDK evaluatePool (read-only) + LaunchPrice/Anchor/Cert
                 existence + the admission policy (see below)
6. SUBMIT*       record_launch_price (C2 oracle, when missing)
                 then evaluate_pool_phase_1 (C1 attestation, dynamic
                 precompile index, Charter-guarded)
7. MONITOR       poll EligibilityAnchor / EligibilityCert across every
                 tracked pool; transition states; emit opportunity events
```

`*` only in submission mode. Dry-run is the default.

### Tracking states

```text
discovered → filtered-out                (cheap pre-filter said no)
discovered → queued → evaluated-ineligible   (SDK double-check said no)
           → evaluated-eligible          (dry-run stops here)
           → launch-price-recorded → phase1-submitted
                                    → waiting-epochs
                                    → certification-ready   ← OPPORTUNITY
                                    → certified             ← OPPORTUNITY
                                    → cert-expired / anchor-stale
           → launch-price-blocked        (no C2 oracle configured)
           → submission-failed           (retried up to maxSubmitAttempts)
```

`certification-ready` means the ≥2-epoch confirmation gap has elapsed and
no cert exists — an executor bot should certify + salvage.
`certified` means the EligibilityCert is inside its 1-hour TTL — the
salvage window is open.

### The admission policy (why evaluatePool's verdict is not used raw)

`GraveYieldClient.evaluatePool()` reports two criteria as failed for
every fresh candidate:

- **C2** — without a recorded LaunchPrice PDA the SDK cannot compare
  prices. That is the state the Scout fixes (record_launch_price) before
  phase 1. If the launch price IS recorded and C2 still fails, the pool
  genuinely has not collapsed against its on-chain baseline — hard fail.
- **C6** — the ≥2-epoch confirmation can only pass once an anchor exists.
  Fresh candidates always fail it; phase 1 is exactly what starts the clock.

Hard failures (never submitted): `C1-inactivity`, `C3-min-tvl`,
`C4-lp-not-burned`, `C5-no-lock` (LOCKER-002 flag), plus
`no-attestable-last-swap`. An existing anchor/cert switches the pool to
monitor-only.

## Modes

| Mode | When | Behaviour |
|---|---|---|
| dry-run | default (no `ACTIVITY_ORACLE_KEY`, or `SCOUT_DRY_RUN=1`) | discover → pre-filter → double-check → monitor; zero submissions |
| submission | `SCOUT_DRY_RUN=0` + `ACTIVITY_ORACLE_KEY` + `SALVOR_KEYPAIR` | the full cycle incl. record_launch_price + phase1 |

> **Devnet note:** the deployed devnet ProtocolConfigs' activity and
> launch-price oracles point at the since-wiped deployer key. Attestation-
> signed submissions cannot verify against that cluster until the owner
> re-points the oracles. Every devnet run is therefore effectively
> read-only, which the smoke tests cover.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | devnet | Solana RPC endpoint |
| `CLUSTER` | `devnet` | `devnet` / `mainnet-beta` / `localnet` |
| `SCANNER_PROGRAM_ID` | devnet GraveScanner | GraveScanner program |
| `VAULT_PROGRAM_ID` | devnet GraveVault | GraveVault program |
| `ACTIVITY_ORACLE_KEY` | — | base58 32-byte Ed25519 seed (C1). Absent ⇒ dry-run |
| `LAUNCH_PRICE_ORACLE_KEY` | — | base58 32-byte seed (C2). Absent ⇒ pools without a LaunchPrice PDA are reported, not recorded |
| `SALVOR_KEYPAIR` | — | writer/payer: solana-keygen JSON file path or base58 secret |
| `SCOUT_DRY_RUN` | auto | `1` forces dry-run; `0` forces submission mode (validates keys) |
| `SCOUT_RUN_ONCE` | — | `1` = one cycle then exit |
| `MIN_TVL_LAMPORTS` | 500000000 | C3 pre-filter floor |
| `INACTIVITY_SECONDS` | 7776000 | C1 pre-filter window (90 d) |
| `PRICE_COLLAPSE_BPS` | 9900 | C2 threshold |
| `LP_BURN_DUST_THRESHOLD` | 1000 | C4 threshold |
| `MAX_CANDIDATES_PER_CYCLE` | 5 | submission budget per cycle |
| `POLL_INTERVAL_MS` | 300000 | re-scan interval |
| `MAX_POOLS_PER_SCAN` | 1000 | discovery cap |
| `SIGNATURE_SCAN_LIMIT` | 1000 | last-swap scan depth |
| `LAUNCH_PRICE_MAX_PAGES` | 50 | genesis pagination cap (×1000 sigs) |
| `PRIORITY_FEE_LAMPORTS_PER_CU` | 10000 | compute_unit_price (Charter-guarded) |
| `COMPUTE_UNIT_LIMIT` | — | optional explicit CU limit |
| `SCOUT_MAX_SUBMIT_ATTEMPTS` | 3 | per-pool retry budget |
| `SCOUT_REPORT_FILE` | — | optional JSONL event file |

## Running

```bash
# from the repo root
pnpm install
pnpm --filter @graveyield/scout build

# dry-run discovery + monitoring against devnet (one cycle)
RPC_URL=https://api.devnet.solana.com SCOUT_RUN_ONCE=1 \
  node scout/dist/cli.js

# submission mode (needs funded keys + an oracle the ProtocolConfig knows)
RPC_URL=… CLUSTER=mainnet-beta SCOUT_DRY_RUN=0 \
  ACTIVITY_ORACLE_KEY=… SALVOR_KEYPAIR=./operator.json \
  SCOUT_REPORT_FILE=./scout-events.jsonl \
  node scout/dist/cli.js
```

The CLI emits one JSON line per Scout event (`opportunity:*` events are
the formal hand-off to the next execution component). Programmatic use:

```ts
import { buildScout, MemoryReportSink } from "@graveyield/scout";

const sink = new MemoryReportSink();
const scout = buildScout(config, { sinks: [sink] });
await scout.runOnce();          // one cycle
scout.opportunities();          // certification-ready / salvageable pools
await scout.start();            // or loop forever on POLL_INTERVAL_MS
```

## Tests

```bash
# offline suite (no network)
pnpm --filter @graveyield/scout test

# + live devnet smoke (read-only)
DEVNET_RPC_URL=https://api.devnet.solana.com pnpm --filter @graveyield/scout test
```

77 offline tests cover the pre-filter, scoring, queue, admission policy,
tracker/monitor state machine, transaction assembly (dynamic precompile
indexing + Charter guard), key loading, reporters, and the full cycle
against a fake RPC. 4 env-gated smoke tests cover live devnet read-back.

## Transaction shape (for reviewers)

```text
0..k   compute-budget ixs (limit, price) — Charter-guarded
k+1    ed25519_program verify (oracle attestation precompile)
k+2    GraveScanner ix (evaluate_pool_phase_1 | record_launch_price)
```

The precompile's `message_instruction_index` is pinned to the GraveScanner
instruction's ACTUAL transaction index — the on-chain validator
(`attestation.rs::load_instruction_pair`) requires it, and the SDK's
convenience builders hardcode index 1, so the Scout assembles with the
underlying parameterised precompile builders.

## Known limitations (tracked, not bugs)

- **LOCKER-002**: C5 (no LP lock) is flag-only here; the on-chain adapter
  is authoritative and the scanner enforces 6020/6021.
- **Oracle-003**: the hosted-oracle operational runbook starts from this
  bot's submission path.
- **In-memory tracker**: persistence (queue store, event history) lands
  with Phase 11 observability.
- **Raydium V4 only** (Phase 15 adds CLMM, Orca, PumpSwap, Meteora).
