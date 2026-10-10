# Changelog

All notable changes to the `salvor-bots` repository are documented here.
The GraveYield protocol (on-chain programs + monorepo tooling) lives at
[`github.com/GraveYield/graveyield-protocol`](https://github.com/GraveYield/graveyield-protocol)
and has its own changelog.

## [Unreleased — Phase 12 (security + economic testnet): the fleet under attack — admission-gate matrix, competing-Salvor coordination, extreme-value economics, mid-flight state manipulation]

> Roadmap Phase 12, verbatim goal: "Prove that GraveYield refuses to
> act when its assumptions aren't satisfied." The fleet-side battery
> complements the protocol repo's battery (catalogue:
> `graveyield-protocol/docs/ADVERSARY.md`).

### Added

- **`fleet-core/test/adversary.test.ts` — 10 attack tests.** The
  estimator under extreme-value attacks (u64::MAX reserves/supplies
  stay exact and finite; inconsistent quotes refused at the exact
  reserve boundary; sub-dust conversion contributes zero and is
  flagged — partial-failure economics pinned; slippage overrides can
  only tighten; zero-share configs refused). Competing Salvors at the
  coordination layer: live leases are exclusive, replayed envelopes
  are refused per bot, and an EXPIRED lease takeover is pinned as
  finding F5 (no fencing token; the chain's init-once PDAs are the
  backstop). Mid-flight state manipulation: an anchor invalidated
  between checks flips a live opportunity to `stale-anchor`, and the
  cert-TTL margin boundary is exact (61 s refused `cert-expired`,
  120 s actionable).
- **`scout/test/adversary.test.ts` — 10 attack tests.** The admission
  gate matrix: C1/C3/C4/C5 are hard refusals; C2 without a recorded
  baseline is soft (record launch price first) but C2 WITH a recorded
  baseline is hard (a live price cannot be un-collapsed); a pool with
  no attestable last swap is refused even with perfect criteria
  (ORACLE-002 anti-fabrication); existing on-chain state flips the
  verdict to monitor-only and a hard failure dominates it; unknown
  future criteria names are ignored (the chain stays the authority).

## [Unreleased — Phase 11 (ops): the fleet as a running service — health, alerting, JSONL trails, publish-ready SDK]

> Naming note: the five-bot fleet shipped earlier under the working
> title "Phase 11" (the entry below). In the canonical shipping roadmap,
> Phase 11 is the **devnet launch**; this entry closes the fleet's rows
> of that scope — "first Salvor running" + the fleet's slice of
> observability. The protocol-side rows (indexer service, vault
> observer, Merkle service, SDK publication, the read-only scenarios)
> ship in the graveyield-protocol repo under `ops/` at the same time.

### Added

- **`@graveyield/fleet-ops` v0.1.0 — the fleet service runner
  (`fleet-ops/`).** One supervised process running the Scout and the
  Monitor with full observability:
  - **Scout cycles** (`runScoutCycle`) — heartbeats, per-stage counters
    (discovered / candidates / evaluated / launch prices / phase-1
    submitted / failed), degraded on phase-1 failures, critical
    `scout-cycle-failed` alert when a cycle throws.
  - **Monitor sweeps** (`runMonitorSweep`) — every fleet Monitor
    diagnostic mapped to a coded alert with the diagnostic's severity
    (`conflicting-claims` / `failed-simulation` / `receipt-mismatch` →
    critical; stale/expired/repeat/unverified → warn; verified/reconciled
    → counted only). Bigint detail fields are stringified into alert
    context.
  - **The Scout→Monitor bridge** — the Scout's event sink fanouts into
    `Monitor.observeScoutEvent` in-process: the fleet's read-only
    observer sees exactly what the Scout emits, with no second feed to
    drift. Executor bots join via the same bridge when an operator
    enables them.
  - **Health + alerts** — the same pattern as the protocol-side ops
    package: derived staleness (silent past 3× poll ⇒ `stale`),
    monotonic counters, deterministic JSON snapshots; coded alerts with
    dedup windows over console / JSONL / webhook sinks. Deliberately
    standalone copies (the repos share only the SDK).
  - **CLI** (`graveyield-fleet`) — `run` (forever, SIGINT/SIGTERM
    graceful), `cycle`, `sweep`, `health`. The runner never touches the
    Scout's dry-run gate: submission still requires the operator's
    explicit environment.
  - **27 offline tests.**

- **`sdk/PUBLISH.md` — the npm publication checklist** (mirrors the
  protocol repo's; the packed tarball passed `npm publish --dry-run`).

### Changed

- **`pnpm-workspace.yaml`** — `fleet-ops` added as the seventh package.
- **Root `README.md`** — architecture section gains the fleet runner;
  status line moves to Phase 11 (ops).

## [Unreleased — Phase 11 — the Salvor Fleet]

### Added — the shared execution foundation (`@graveyield/fleet-core` v0.1.0)

The ONE execution substrate every executor bot runs on. Built from the
owner's fleet mandate: versioned opportunity envelopes and identity keys
(`cluster|amm|pool`), a 15-state executor lifecycle with enforced
transitions, idempotent delivery admission + lease coordination
(`FleetStore`; the shipped in-memory backend coordinates ONE PROCESS
ONLY — multi-process deployments must provide a shared backend), the
fleet event taxonomy with failure classification and replayable sinks,
the integer economic estimator (proportional withdraw → route
conversion → D6 dust skip → live-share split → costs → break-even; no
floats ever), the D3 fee plan (`derivePriorityFeePlan` fixes the Phase 8
unit mismatch — total fee budget = margin × profit, per-CU price =
budget / cuLimit capped at the Charter ceiling), the `RouteAdapter` seam
(Jupiter v6 HTTP adapter + fakes; quotes are untrusted until validated),
live on-chain revalidation (kind re-derivation, cert-TTL margins,
anchor-epoch binding), fork-proven Raydium V4 CPI account derivation
(AmmInfo 496/528/560/592 + Serum 53/85/117/165/253/285/317 from
`fetch_v4_fork_fixtures.mjs`), and the common
prepare → simulate → submit → confirm pipeline with the Charter guard
at assembly AND submit, dynamically pinned attestation indices inside
the atomic certify+salvage bundle, snapshot→live-supply re-pinning, and
a hard dry-run gate (`submit()` throws unless mode = live with explicit
operator enablement).

### Added — Monitor/Risk (`@graveyield/monitor` v0.1.0)

The fleet observer and verification layer. Consumes Scout + executor
events (replay-safe), tracks opportunity age / cert expiry / attempts /
signatures, verifies confirmed salvage transactions against the
GraveVault SalvageReceipt (sum + 40/40/20 shares + reported-vs-chain
mismatch), detects stale opportunities, repeated attempts, conflicting
claims, and unverified confirmations, and emits machine-readable
diagnostics. Has NO keypair, NO builder, NO submission path — read-only
by construction.

### Added — Conservative (`@graveyield/conservative` v0.1.0)

The reference executor: stronger economics (default min net profit
0.05 SOL), execution headroom (150 bps slippage override — tighter than
the 300 bps protocol default), conservative fee share (15% of expected
profit), three submission attempts. Dry-run by default; live requires
explicit enablement + signer.

### Added — Sniper (`@graveyield/sniper` v0.1.0)

The latency-sensitive executor: urgency-ordered batches (soonest cert
expiry first), 5 s quote-freshness window, 30% fee share — all through
the SAME shared gates as every other executor (no safety bypass).

### Added — Experimental (`@graveyield/experimental` v0.1.0)

The isolated strategy sandbox: hard risk caps (per-attempt priority-fee
budget, max LP-position fraction of live supply) enforced by a
fail-closed guard BEFORE simulation, full event attribution
(`experimentId` + `riskCaps` on every strategy event), and its own
defaults object — zero influence on Conservative/Sniper behavior.

### Fixed — SDK defects found by the fleet audit (FLEET-M0)

- `priorityFee.ts`: `derivePriorityFeePlan` added (D3-exact fee math);
  `computeOperationalMaxLamportsPerCu` deprecated with a hazard note —
  it returned margin × TOTAL profit as a per-CU price, permitting
  over-budget fees at large compute limits (and starving them at small
  ones).
- `client.ts` `evaluatePool` C2: the current-price comparison used mint
  base58 string ordering to pick the base reserve, inverting the price
  for pools whose coin-side mint sorts after the pc-side mint. The
  on-chain adapter maps base=coin/quote=pc unconditionally; the SDK now
  mirrors that exactly.
- `snapshot.ts`: holder keys are now sorted by pubkey BYTES (the Rust
  `BTreeMap<Pubkey>` order the Merkle tree enforces) instead of base58
  string order — the two diverge for a few percent of key pairs and
  made snapshots intermittently fail the tree's canonical-order check.

### Test counts (offline, node:test)

Root SDK 116 · fleet-core 64 · Scout 77 · Conservative 13 · Sniper 7 ·
Experimental 9 · Monitor 21 (incl. 8 whole-fleet integration scenarios:
duplicates, replay, lease races, stale certs, failed simulations,
restarts, live settlement reconciliation) = **307 tests, 0 failures,
0 skipped**, plus `pnpm -r typecheck`/`build` clean.

## [Unreleased — Phase 10]

### Added — the Scout Salvor (`@graveyield/scout` v0.1.0)

The first GraveYield salvor bot, per the owner's five-bot architecture
(Scout / Sniper / Conservative / Experimental / Monitor-Risk). The Scout
is the discovery-and-monitoring bot; salvage execution belongs to the
downstream executor bots under a shared execution policy.

- `scout/` workspace package (peer to the root `@graveyield/sdk`
  package, which it consumes as `workspace:*`). The repo gains a
  `pnpm-workspace.yaml`; the SDK remains the root package so
  install-from-git behavior is unchanged.
- **Pipeline (per cycle):** Raydium V4 discovery (752-byte AmmInfo
  `getProgramAccounts`) → last-swap activity indexing (1 h cache over the
  SDK's `deriveLastSwapV4`) → reserve/TVL reading with the 7019 WSOL guard
  → mint metadata → six-criterion pre-filter (bitmap mirrors the on-chain
  `criteria.rs`) → candidate scoring
  (`inactivityMargin × tvlMargin × priceCollapseMargin`) → in-memory
  priority queue with per-address dedup.
- **Admission policy** (`classifyEvaluation`): the SDK's read-only
  `evaluatePool` double-check plus LaunchPrice/Anchor/Cert existence
  checks. Hard failures (C1/C3/C4/C5, recorded-baseline C2,
  no-attestable-last-swap) never submit; expected pre-phase1 failures
  (C2 without a record, C6 without an anchor) admit; an existing
  anchor/cert switches to monitor-only.
- **Submissions** (submission mode only): `record_launch_price`
  (168-byte C2 attestation, when the pool's LaunchPrice PDA is missing —
  phase 1 hard-requires that account) then `evaluate_pool_phase_1`
  (112-byte C1 attestation + SlotHashes freshness). Both are assembled as
  `[compute-budget…, ed25519 precompile, GraveScanner ix]` with the
  precompile's `message_instruction_index` pinned to the GraveScanner
  instruction's ACTUAL transaction index (the on-chain
  `load_instruction_pair` validator requires it; the SDK's convenience
  builders hardcode index 1, so the Scout uses the underlying
  parameterised precompile builders). Every transaction passes the SDK's
  Charter guard — over-ceiling fees are refused before any send.
- **Lifecycle monitoring:** `CandidateTracker` state machine
  (discovered → … → certification-ready / certified, with
  cert-expired / anchor-stale / anchor-invalidated / launch-price-blocked
  / submission-failed paths) and `monitorCandidate` polling of the
  EligibilityAnchor / EligibilityCert PDAs with epoch math
  (`MIN_EPOCH_CONFIRMATION = 2`) and anchor-staleness detection from the
  live ProtocolConfig.
- **Reporting:** structured `ScoutEvent` JSON lines to console + optional
  JSONL file (`SCOUT_REPORT_FILE`); `opportunity:certification-ready` and
  `opportunity:salvageable` events plus the in-process
  `ScoutSalvor.opportunities()` accessor are the formal hand-off to the
  next execution component. Sinks fail open.
- **Key material:** `ACTIVITY_ORACLE_KEY` / `LAUNCH_PRICE_ORACLE_KEY`
  (base58 32-byte seeds via `nacl.sign.keyPair.fromSeed`),
  `SALVOR_KEYPAIR` (solana-keygen JSON file or base58 secret,
  content-based disambiguation). Dry-run is the default mode;
  `SCOUT_DRY_RUN=0` without key material throws at config load.
- **CLI:** `graveyield-scout` bin (`scout/src/cli.ts`), env-driven,
  `SCOUT_RUN_ONCE=1` for single-cycle operation.
- **Tests:** 77 offline tests (`node:test` + `tsx`, zero new heavy deps)
  covering the pre-filter, scoring, queue, admission policy,
  tracker/monitor state machine, transaction assembly (instruction order,
  dynamic precompile indexing, attestation binding, Charter-guard
  rejection), key loading, reporters, and the full multi-cycle lifecycle
  against a fake RPC (dry-run → submit → certification-ready → certified,
  plus blocking/failure/retry paths). 4 env-gated devnet smoke tests
  (`DEVNET_RPC_URL`) verify the deployed ProtocolConfigs against the
  Charter-locked spec defaults, live Raydium V4 discovery, and a full
  read-only dry-run cycle — all green against live devnet.
  `pnpm -r --include-workspace-root test`: SDK 102 + Scout 77 = 179.

### Notes

- Phase 10 is a pure off-chain consumer of the Phase 8 SDK: **zero SDK
  changes, zero on-chain changes.**
- Devnet caveat: the deployed ProtocolConfigs' activity/launch-price
  oracles point at the since-wiped deployer key, so attestation-signed
  submissions cannot verify on devnet until the owner re-points them.
  Devnet runs are read-only (dry-run), which the smoke tests cover.
- Terminology follows the project canon (salvage / salvor /
  SalvageReceipt; the forbidden synonym family is banned project-wide).

## [Phase 8 — Salvor bots SDK] — 2026-10-09

- `@graveyield/sdk` v0.2.0 shipped at the repo root (commit `5ea79ba`,
  mirrored to the monorepo as `64b1338`): the eight top-level operations,
  IDL-free instruction builders, byte-locked Merkle tree, Charter guard,
  attestation wire formats, account decoders, PDA derivation, error
  decoding, simulation helpers. 102 offline tests + 6 devnet smoke.
