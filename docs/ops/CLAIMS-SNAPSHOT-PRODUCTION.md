# D3 — Claims-Snapshot Production via the Rust Snapshotter

Status: **implemented** (fleet-core). Applies to every executor
(Conservative / Sniper / Experimental) and any future consumer of the
shared `ExecutionPipeline`.

## Policy statement

**The Rust `grave-snapshotter-cli` is the SOLE production
claims-snapshot producer.** The TypeScript SDK's `snapshotLpHolders()`
is **NOT an authorized production claims-snapshot producer**. It remains
available only for independent verification, debugging, and rehearsal
tooling; it must never generate a substitute claims root in the live
salvage-preparation path.

Enforcement is structural, not advisory:

* `ExecutionPipeline` **requires** a `snapshotter` at construction —
  there is no default producer.
* `fleet-core/src/pipeline.ts` contains no reference to
  `snapshotLpHolders` / `SnapshotResult` (enforced by a static source
  test, `pipeline.test.ts` — "static source gate").
* The salvage root baked into `salvage_pool` comes **exclusively** from
  `VerifiedClaimsSnapshot.root`, which is returned only after full
  claims-grade verification of the Rust artifact.
* Every producer failure is **terminal** for that preparation attempt
  (failure class `snapshot-producer`, not in `RETRYABLE_FAILURE_CLASSES`):
  no TypeScript fallback, no retry that changes the evidence package, no
  root regeneration under the same attempt identity.

## Rust binary build and packaging

Build the CLI from the protocol workspace (`GraveYield/graveyield-protocol`):

```sh
cd graveyield-protocol
cargo build --release -p grave-snapshotter --bin grave-snapshotter-cli
# binary: target/release/grave-snapshotter-cli
```

Deployment requirements:

* Ship the **exact binary built from the merged protocol `main`** that
  the Fleet runtime was validated against; record its commit + digest in
  the operator runbook for the deployment.
* Place it at a stable path on the salvage host (e.g.
  `/usr/local/bin/grave-snapshotter-cli`) and point
  `GY_SNAPSHOTTER_BIN` at it. The binary must be executable by the Fleet
  process user.
* Supported runtime platforms are the platforms the protocol workspace
  builds for (Linux x86_64/aarch64). There is no Node-side fallback and
  no network service: the CLI is invoked as a **local subprocess**.
* The Fleet does NOT vendor the binary in the repository; packaging
  (image bake or release artifact) is a deployment concern and must pin
  the protocol commit.

## Runtime invocation and configuration

`RustCliClaimsSnapshotter` (fleet-core/src/snapshotter.ts) spawns:

```
grave-snapshotter-cli \
  --url <rpc> --pool <P> --amm <A> --lp-mint <M> \
  --out <tmpdir>/artifact.json \
  --commitment confirmed|finalized \
  --lock-evidence rpc \
  --sink-ledger <file>
```

* **Explicit argv, `shell: false`** — no shell-string interpolation of
  any value (test-proven with a credential-bearing URL containing shell
  metacharacters).
* **Bounded execution**: default wall-clock budget 120 s
  (`timeoutMs`), SIGTERM → SIGKILL escalation after 5 s.
* **Bounded output**: artifact capped at 64 MiB (`maxArtifactBytes`),
  captured CLI stdout/stderr capped at 1 MiB (`maxLogBytes`).
* **Controlled temp files**: each invocation writes to a fresh
  `mkdtemp` directory, read back, and removed in a `finally` block — an
  artifact from another run or attempt can never be consumed.
* **Secret hygiene**: the RPC URL is passed as a single argv element and
  is never logged, never embedded in errors or events, never echoed by
  the CLI (the CLI's log line structurally cannot contain it). Operator
  environment variables are never logged.

Operator environment (see `snapshotterConfigFromEnv`):

| Variable | Meaning |
| --- | --- |
| `GY_SNAPSHOTTER_BIN` | path to `grave-snapshotter-cli` |
| `GY_SNAPSHOTTER_RPC_URL` | RPC endpoint (may carry credentials; never logged) |
| `GY_SNAPSHOTTER_COMMITMENT` | `confirmed` or `finalized` (no default) |
| `GY_SNAPSHOTTER_SINK_LEDGER` | path to the governed `gy.sink-ledger.v1` file for the pool |

All four variables are **required**; an absent one is a hard
`config-invalid` failure.

## Governed inputs (D2 contract — unchanged)

* **Sink ledger**: a per-pool `gy.sink-ledger.v1` file. The Fleet reads
  the exact bytes, validates the schema + pool/AMM/mint binding, and the
  artifact's `sink_ledger.input_sha256` must equal SHA-256 of those exact
  bytes. An **explicit empty ledger** (`entries: []`) is the correct
  input for a pool with no approved sinks; a **missing ledger file or
  missing configuration is a hard error** — there is no empty-ledger
  default. A schema-valid ledger is not proof of owner approval (D-04-D
  process control, outside this binary).
* **Locker evidence**: always `--lock-evidence rpc` — the CLI queries
  real UNCX Raydium AMM V4 locker evidence from the same RPC at the same
  commitment, pinned to the enumeration's anchor slot. Unavailable,
  malformed, or ambiguous evidence fails closed in the CLI; the artifact's
  `lock_evidence` provenance is re-validated by the Fleet (source `rpc`,
  UNCX program id, commitment match, anchor slot = snapshot slot,
  records/totals agreement).
* UNCX adapter and manual screening requirements in
  `docs/ops/GY-OPS-RB-05.md` (protocol repo) are **unchanged**.

## Artifact validation (claims-grade, in the Fleet)

Before a root is accepted, `verifyClaimsArtifact` re-derives everything
from the artifact bytes (TS mirror of `SnapshotArtifact::verify_integrity`):

1. `format_version` must be exactly `2`.
2. `pool_address` / `amm_program_id` / `lp_mint` must equal the pool
   being prepared (wrong-pool artifacts are refused).
3. Full Merkle re-derivation: entries (canonical ascending-owner, unique,
   positive) → rebuilt tree must reproduce the root, leaf count, depth,
   every leaf, and every proof. u64 fields are parsed **exactly**
   (bigints; no float rounding above 2^53).
4. Closing identity: `entries + sink_exclusions == enumerated ==
   lp_total_supply_at_snapshot`; exclusion ledger and locked-LP report
   (sums, custody rules) re-checked.
5. Claims-grade provenance **required**: complete governed-input
   provenance; lock-evidence supported values; sink-ledger digest bound
   to the run's ledger bytes.
6. The live LP supply is re-pinned against
   `lp_total_supply_at_snapshot` before the transaction is assembled.

The root handed to `salvage_pool` is `VerifiedClaimsSnapshot.root` —
nothing else. The `prepared` fleet event carries the pool, snapshot
slot, and `artifactSha256` (SHA-256 over the exact artifact bytes) for
operational correlation.

## Failure behavior and troubleshooting

Every failure is a terminal `ClaimsSnapshotterError` with a
machine-readable category, surfaced as failure class
`snapshot-producer` with `{producer, producerFailureCategory, pool,
snapshotSlot, artifactSha256}` event data:

| Category | Meaning | Operator action |
| --- | --- | --- |
| `missing-executable` | binary absent / not executable at `GY_SNAPSHOTTER_BIN` | deploy the binary; check permissions |
| `spawn-failed` | present but unspawnable (permissions, format) | check arch/libc compatibility |
| `timeout` | run exceeded the wall-clock budget | check RPC latency/health; raise `timeoutMs` deliberately |
| `nonzero-exit` / `signal-terminated` | CLI aborted (see its stderr in the event reason) | read CLI stderr; fix the underlying RPC/input issue |
| `ledger-unreadable` | governed ledger file missing | supply the ledger; **never** substitute an empty ledger as a workaround |
| `sink-ledger-mismatch` | ledger unscoped/wrong-version, or artifact provenance does not hash to the run's ledger bytes | publish the correct per-pool ledger |
| `pool-mismatch` / `amm-mismatch` / `mint-mismatch` | artifact not for this pool | investigate the producer/config binding |
| `schema-invalid` / `tree-mismatch` / `reconciliation-invalid` / `exclusion-ledger-invalid` / `locked-report-invalid` | artifact failed claims-grade re-derivation | treat as a producer integrity incident; do not retry |
| `provenance-invalid` / `lock-evidence-invalid` | provenance missing/unsupported | producer/deployment misconfiguration; escalate |
| `artifact-too-large` / `malformed-output` / `artifact-unreadable` | output boundary breach | check disk/executable behavior |
| `config-invalid` | missing/bad configuration (incl. all env vars) | fix operator config |

A failing attempt must NOT be retried under the same attempt identity
with a changed evidence package; the normal fleet revalidation cycle
will re-enter preparation as a NEW attempt when appropriate.

## Test evidence (what is proven where)

* `fleet-core/test/snapshotter.test.ts` — verification + subprocess
  boundary against fixture artifacts and a mock CLI executable
  (fail-closed matrix, argv/secret hygiene, governed inputs).
* `fleet-core/test/pipeline.test.ts` — end-to-end prepare through the
  CLI boundary with a valid artifact; terminal-failure semantics; the
  static "no TypeScript producer" source gate.
* Fixture tests use a mock executable; they do **not** exercise the real
  Rust binary (no Rust toolchain in the test environment). Protocol-repo
  CI builds and tests the Rust crate itself.

## Production composition point (review finding D3-3, recorded 2026-11-27)

Where does a production deployment actually construct
`RustCliClaimsSnapshotter` and inject it into `ExecutionPipeline`?

**The composition point is external to this repository.** In this repo:

* `ExecutionPipeline` requires a `ClaimsSnapshotter` at construction
  (`PipelineOptions.snapshotter` — required, no default, no fallback).
* The bots (`ConservativeSalvor` / `SniperSalvor` / `ExperimentalSalvor`)
  RECEIVE a constructed pipeline as a constructor argument; none of them
  builds one.
* `snapshotterConfigFromEnv()` provides the standard operator wiring from
  `GY_SNAPSHOTTER_*` variables, and `RustCliClaimsSnapshotter` validates
  that configuration fail-closed.

Evidence available: repository-wide inspection (2026-11-27, branch
`d3-rust-claims-snapshotter`) shows no production binary or service in
this repo that constructs `ExecutionPipeline` outside tests — the fleet
is a library consumed by an external runtime/deployment. What therefore
REMAINS UNVERIFIED here:

* the external runtime's wiring of `snapshotterConfigFromEnv()` /
  `new RustCliClaimsSnapshotter(...)` into `new ExecutionPipeline({...})`;
* that the deployed `GY_SNAPSHOTTER_BIN` is the built CLI from the merged
  protocol `main` and is on the salvage hosts;
* that the governed per-pool ledger files are deployed at the configured
  paths.

No production integration is invented or claimed by this repository;
the required wiring is documented above and in the
`snapshotterConfigFromEnv` contract, and the library enforces the
invariant regardless of the caller: a pipeline cannot be constructed
without a claims snapshotter, and the claims snapshotter cannot be
constructed without a full fail-closed configuration.
