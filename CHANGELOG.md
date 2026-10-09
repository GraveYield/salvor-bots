# Changelog

All notable changes to the `salvor-bots` repository are documented here.
The GraveYield protocol (on-chain programs + monorepo tooling) lives at
[`github.com/GraveYield/graveyield-protocol`](https://github.com/GraveYield/graveyield-protocol)
and has its own changelog.

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
