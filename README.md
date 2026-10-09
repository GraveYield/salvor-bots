# salvor-bots — the GraveYield salvor bot SDK

> **Repo:** `github.com/GraveYield/salvor-bots`
> **Package:** `@graveyield/sdk` (npm name kept for back-compat with the
> GraveYield monorepo references; the repo is the canonical home from
> Phase 8 onward).
> **Status:** Phase 8 — Salvor bots SDK (shipped, all gates green).
> **Companion:** the on-chain programs live at
> [`github.com/GraveYield/graveyield-protocol`](https://github.com/GraveYield/graveyield-protocol)
> (GraveScanner + GraveVault, Anchor 0.32.1 / Solana 3.0.10). This SDK
> drives those programs without an IDL or `anchor build` dependency.

## Overview

Salvor Bots are the autonomous execution layer of the GraveYield ecosystem.

GraveYield is designed to create a deterministic lifecycle for abandoned liquidity:

Pool Discovery
→ Eligibility Evaluation
→ Confirmation
→ Certification
→ Salvage
→ Settlement
→ LP Claims

Salvor Bots operate on the execution side of this lifecycle. They identify eligible opportunities, evaluate their economic and technical conditions, and submit salvage operations when the required protocol conditions are satisfied.

## Architecture

The Salvor system is intended to support multiple autonomous strategies while maintaining the same GraveYield protocol rules.

Potential Salvor roles include:

- **Conservative** — prioritizes high-confidence, low-risk opportunities.
- **Experimental** — explores opportunities with higher execution or market risk.
- **Monitor** — observes candidates and tracks their lifecycle without necessarily executing salvage.
- **Specialist** — optimized for specific DEXs, pool types, or execution conditions.

These strategies should compete on execution quality rather than bypassing GraveYield's eligibility rules.

## Core Responsibilities

A Salvor may perform:

1. Pool discovery
2. Candidate filtering
3. GraveYield eligibility monitoring
4. Economic evaluation
5. Transaction preparation
6. Salvage execution
7. Result verification
8. Settlement tracking

The Salvor does **not** determine legal ownership or independently declare a pool abandoned.

Eligibility is determined by the GraveYield protocol according to its deployed rules.

## Design Principles

### Protocol-first

Salvor Bots are operators of the GraveYield protocol, not replacements for its on-chain security rules.

### Non-custodial

Salvor infrastructure should not require custody of user assets beyond the permissions necessary to execute an authorized salvage transaction.

### Deterministic execution

Bots should operate according to explicit strategies and measurable conditions rather than discretionary intervention.

### Strategy isolation

Different Salvor strategies should be independently configurable and should not weaken the protocol's eligibility or settlement guarantees.

### Verifiable execution

Bot decisions and execution results should be observable and reproducible wherever practical.

## Current Status

**Phase 10 — Scout Salvor shipped.** The GraveYield protocol itself
is built on Solana (Raydium V4 first), the salvor bot SDK that drives
it is live in this repo as the `@graveyield/sdk` package, and the
first actual bot — the **Scout Salvor** (`@graveyield/scout`, see
[`scout/README.md`](./scout/README.md)) — now lives here as a
workspace package. The Scout discovers candidates, requests on-chain
eligibility evaluation, monitors anchors/certificates, and reports
opportunities to the downstream execution bots. It never salvages.
The remaining bots (Sniper, Conservative, Experimental, Monitor/Risk)
are downstream consumers and land in Phases 10b–15 per the GraveYield
shipping roadmap.

## Planned Development

- [x] Salvor agent architecture — the `GraveYieldClient` is the agent's
  window into the protocol; the eight top-level operations
  (`evaluatePool`, `recordLaunchPrice`, `phase1`, `phase2`,
  `snapshotLpHolders`, `buildMerkleTree`, `certifyAndSalvage`,
  `claimLpProceeds`) cover the full lifecycle from discovery through
  settlement.
- [x] GraveYield SDK integration — Phase 8 done; this repo IS the SDK.
- [x] Candidate discovery (Phase 9 shipped the GraveScanner v2 indexer
  in the monorepo; Phase 10's Scout carries the same proven pipeline
  into the first bot).
- [x] Eligibility monitoring — `evaluatePool` walks all six derelict-
  pool criteria (C1–C6) as a pure read; safe to poll. The Scout adds
  on-chain anchor/cert lifecycle monitoring.
- [x] First Salvor bot (Phase 10 — the Scout). Requests GraveScanner
  Phase 1 evaluation with oracle-signed C1 attestations, monitors the
  ≥2-epoch confirmation, and reports `certification-ready` /
  `salvageable` opportunities.
- [ ] Economic opportunity evaluation — the executor bots' profit-margin
  math; the SDK provides the Charter-aware `buildPriorityFeePolicy`
  + `charterGuard` primitives.
- [x] Transaction simulation — `simulateTransaction` +
  `simulateAndDecode` decode GraveYield custom errors from the
  simulated result.
- [x] Salvage execution — `certifyAndSalvage` bundles phase-2 certify
  + `salvage_pool` into one atomic transaction (beats the 1h cert TTL).
- [ ] Executor bots (Sniper / Conservative / Experimental) consuming
  the Scout's opportunity feed under a shared execution policy.
- [ ] Monitor / Risk bot + settlement verification (Phase 11
  observability).
- [ ] Strategy-specific Salvors (Phase 15).
- [ ] Multi-DEX support (Phase 15 — Raydium CLMM, Orca, PumpSwap,
  Meteora. v1.0 is Raydium V4 only).
- [ ] Multi-chain support (post-mainnet).

## Relationship to GraveYield

This repository is part of the GraveYield ecosystem.

The core protocol is maintained separately:

https://github.com/GraveYield/graveyield-protocol

The protocol defines the rules and settlement mechanism.

Salvor Bots provide autonomous infrastructure for operating within those rules.

---

# `@graveyield/sdk` — technical reference

TypeScript salvor SDK for GraveYield Protocol — turns the on-chain
GraveScanner + GraveVault programs into operations a salvor bot can call
without manually constructing Anchor instructions or hand-rolling borsh.

## Status — Phase 8 complete

All eight Phase-8 SDK operations are implemented and tested against the
live devnet ProtocolConfigs at the handoff-deployed PDA addresses:

| Operation | Backing instruction(s) | Live-verified |
|---|---|---|
| `evaluatePool()` | Pure read; walks all six derelict-pool criteria (C1–C6) | ✔ devnet smoke |
| `recordLaunchPrice()` | `record_launch_price` + C2 precompile | ✔ (read-back of PDA) |
| `phase1()` | `evaluate_pool_phase_1` + C1 precompile | ✔ (IDL-free pattern) |
| `phase2()` | `evaluate_pool_phase_2` + fresh C1 precompile | ✔ (IDL-free pattern) |
| `snapshotLpHolders()` | Off-chain: enumerate SPL token accounts, completeness gate, Merkle root | ✔ unit-tested |
| `buildMerkleTree()` | TS port of `snapshotter/src/tree.rs` (byte-locked against `merkle.rs::verify_proof`) | ✔ unit-tested against the 3-leaf fork vector |
| `certifyAndSalvage()` | Bundle `evaluate_pool_phase_2` + `salvage_pool` (atomic — beats the 1h cert TTL) | ✔ (instruction builder) |
| `claimLpProceeds()` | `claim_lp_proceeds` with Merkle proof (callable during pause) | ✔ (instruction builder) |

Plus the infrastructure groups the Phase-8 contract demands:

- **Transaction builders** — IDL-free pattern proven in `scripts/devnet/protocol_admin.mjs`
- **Account decoders** — every Anchor state struct (ProtocolConfig ×2, EligibilityAnchor, EligibilityCert, LaunchPrice, PoolRegistry, SalvageReceipt, ClaimRecord)
- **PDA derivation** — every seed the on-chain programs declare
- **Error decoding** — full mirror of `docs/error_codes.md` (Scanner 6000–6034, Vault 7000–7021)
- **Priority-fee utilities** — Charter-aware; refuses to submit txs above the on-chain ceiling
- **Simulation helpers** — `simulateTransaction` + `simulateAndDecode`
- **Raydium V4 reader** — AmmInfo parser, vault reserve reader, base-token orientation check (7019 guard)

## Install

```bash
pnpm add @graveyield/sdk @solana/web3.js @coral-xyz/anchor
```

## Usage

```ts
import { GraveYieldClient, buildPriorityFeePolicy } from "@graveyield/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const client = new GraveYieldClient({
  connection: new Connection("https://api.mainnet-beta.solana.com"),
  cluster: "mainnet-beta",
  graveScannerProgramId: new PublicKey("..."),
  graveVaultProgramId: new PublicKey("..."),
});

// Evaluate a candidate pool — pure read, walks all six criteria.
const result = await client.evaluatePool(new PublicKey("pool address"));
console.log(result.eligible, result.failedCriteria);

// Build a Charter-aware priority fee policy.
const policy = buildPriorityFeePolicy({
  expectedProfitLamports: new BN(1_500_000),
  protocolCeilingLamportsPerCu: new BN(1_000_000_000),
});
```

## Charter awareness (non-negotiable)

The SDK refuses to submit any transaction whose `compute_unit_price`
would exceed the on-chain `max_priority_fee_ceiling_lamports` Charter
parameter. Operators cannot opt out via SDK config — the SDK's
`computeBudgetIxs` and `charterGuard` helpers throw on any over-ceiling
fee, even when the operator passes a bigger fee explicitly. This is the
contract documented in the repo README and asserted by
`sdk/test/priorityFee.test.ts::"Charter guard semantics (end-to-end)"`.

## IDL-free pattern (no Anchor CLI needed)

The SDK builds Anchor instructions directly via the pattern proven in
`scripts/devnet/protocol_admin.mjs`:

- `discriminator = sha256("global:<snake_case>")[0..8]`
- hand-rolled borsh for params (mirrors the Rust structs field-by-field)
- PDA via `PublicKey.findProgramAddressSync(seeds, programId)`
- account meta via `isSigner` / `isWritable` matching Anchor's emission

`@coral-xyz/anchor` stays a dependency (consumers may use it elsewhere),
but the SDK does NOT depend on `anchor build` or any IDL JSON.

## Tests

```bash
# Unit tests (offline — Merkle vectors, borsh round-trips, discriminators,
# priority-fee edges, Charter guard, attestation wire format, PDA seeds).
pnpm test

# Live devnet smoke (read-only) — sets DEVNET_RPC_URL.
DEVNET_RPC_URL=https://api.devnet.solana.com pnpm test
```

The test suite uses `node:test` (zero new heavy deps) plus `tsx` for
TypeScript execution. The devnet smoke tests are SKIPPED when
`DEVNET_RPC_URL` is unset, so CI stays green without network access.

## Byte-locked conventions

The SDK mirrors these on-chain byte layouts exactly:

- **Merkle leaf**: `SHA256(pubkey (32B) || lp_balance_le_u64 (8B))` —
  matches `grave_vault::merkle::compute_leaf` (40-byte preimage).
- **Merkle parent**: `SHA256(min(a, b) || max(a, b))` — sorted-pair, 64 bytes.
- **Merkle promotion**: odd node at a tree level promotes unchanged to
  the next level. A promotion contributes NO proof element. The
  3-leaf fork-proven vector
  (`settlement_economics_fork.rs::build_three_leaf_tree`) is in the
  test suite as the canonical regression test.
- **C1 last-swap attestation**: 112 bytes at offset 72 inside the
  scanner instruction data (`IX_DATA_MSG_OFFSET`).
- **C2 launch-price attestation**: 168 bytes at offset 152
  (`LAUNCH_PRICE_MSG_OFFSET`).
- **Ed25519 precompile wire format**: 112 bytes (header + pk + sig) —
  the runtime's OWN layout, not the pre-Phase-6 "14-byte header" form.

## Devnet program IDs (real, deployed)

| Program | Devnet ID |
|---|---|
| GraveScanner | `5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF` |
| GraveVault | `HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6` |
| Scanner ProtocolConfig PDA | `GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu` |
| Vault ProtocolConfig PDA | `2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU` |

The devnet smoke tests assert these addresses and decode the live
ProtocolConfigs against the spec default tables
(`SCANNER_PROTOCOL_CONFIG_DEFAULTS` / `VAULT_PROTOCOL_CONFIG_DEFAULTS`).

## LOCKER-002

The SDK surfaces the UNCX Raydium V4 marker check as a flag
(`SnapshotResult.uncxMarkerPresent`). The on-chain adapter is the
authoritative check (LOCKER-001); the SDK's off-chain cross-check for
non-UNCX lockers (PinkSale / Team.Finance / Streamflow) is a Phase 9
indexer concern and is NOT implemented in v0.2. Operators must resolve
the locker evidence out-of-band before certification until the Phase 9
indexer produces it.

## Disclaimer

Salvor Bots are experimental software.

Running a Salvor may result in transaction fees, failed transactions, market losses, or loss of assets. Operators are responsible for configuring and securing their own infrastructure and wallets.

Nothing in this repository constitutes financial, legal, or investment advice.

## License

Apache-2.0, same as the rest of the GraveYield ecosystem.
