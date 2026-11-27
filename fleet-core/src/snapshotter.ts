// SPDX-License-Identifier: Apache-2.0
//
// Claims-grade snapshot production (D3) — the Rust `grave-snapshotter-cli`
// is the SOLE production claims-snapshot producer.
//
// The live salvage-preparation path consumes LP-holder snapshots ONLY
// through this module. It runs the Rust CLI as a local subprocess (no
// shell, explicit argv, bounded time + output), then verifies the sealed
// artifact CLAIMS-GRADE before the salvage root is accepted:
//
//   * schema/format gate (exactly `format_version: 2`);
//   * pool / AMM / LP-mint identity binding (an artifact from another
//     pool can never be accepted);
//   * full Merkle re-derivation: the tree rebuilt from the artifact's
//     holder rows must reproduce every leaf, every proof, the root, the
//     depth, and the count (the SDK tree is the byte-locked TS port of
//     `snapshotter/src/tree.rs`);
//   * the closing reconciliation identity
//     `entries + sink_exclusions == enumerated == lp_total_supply`;
//   * the exclusion ledger and locked-LP report (canonical order, sums,
//     custody rules — mirroring `snapshotter/src/artifact.rs`);
//   * CLAIMS-GRADE provenance: complete governed-input provenance is
//     REQUIRED (a provenance-less artifact is never claims-grade — D2),
//     the lock-evidence block must name the wired UNCX RPC source, and
//     the sink-ledger block must hash to the EXACT ledger bytes this
//     run supplied (the governed ledger is bound to the artifact, not
//     merely referenced);
//   * the ledger file itself must be `gy.sink-ledger.v1` and scoped to
//     the exact pool / AMM / mint being prepared.
//
// FAILURE MODEL: every failure is a terminal `ClaimsSnapshotterError`
// carrying a machine-readable category. There is NO TypeScript fallback,
// NO silent retry that changes the evidence package, and NO empty
// sink-ledger or empty lock-list convenience default — the sink ledger
// path is a REQUIRED configuration item, and `--lock-evidence rpc` is
// always supplied (the CLI hard-fails without real locker evidence).
//
// SECRET HYGIENE: the RPC URL (which may carry provider credentials) is
// passed to the subprocess as a single argv element and is NEVER logged,
// NEVER included in error messages, and NEVER embedded in events. The
// spawn uses `shell: false`, so no shell ever interpolates it.
//
// TRUST BOUNDARY (unchanged): total LP supply is pinned on-chain; the
// complete holder set and root are supplied through this authorized
// off-chain snapshot process. This verifier establishes artifact-internal
// integrity and governed-input binding — it does NOT prove owner ledger
// approval (D-04-D process control) or locker-statement truthfulness.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";

/** The artifact format this integration accepts — exactly the D2 v2 shape. */
export const CLAIMS_ARTIFACT_FORMAT_VERSION = 2;

/** The only locker program this integration accepts (UNCX Raydium AMM V4). */
export const UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID = "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";

/** The sink-ledger schema the governed input must carry (`gy.sink-ledger.v1`). */
export const SINK_LEDGER_SCHEMA_VERSION = 1;

/** Supported commitment levels (mirrors the CLI's `--commitment` gate). */
export const SNAPSHOTTER_COMMITMENTS = ["confirmed", "finalized"] as const;
export type SnapshotterCommitment = (typeof SNAPSHOTTER_COMMITMENTS)[number];

// ------------------------------------------------------------------ errors

/**
 * Machine-readable failure categories for the claims-snapshot producer.
 * Every category is TERMINAL for the current preparation attempt: none
 * is retryable-with-a-different-evidence-package, and none permits a
 * TypeScript fallback.
 */
export type SnapshotterFailureCategory =
  | "config-invalid"
  | "missing-executable"
  | "spawn-failed"
  | "timeout"
  | "nonzero-exit"
  | "signal-terminated"
  | "artifact-unreadable"
  | "artifact-too-large"
  | "malformed-output"
  | "schema-invalid"
  | "pool-mismatch"
  | "amm-mismatch"
  | "mint-mismatch"
  | "tree-mismatch"
  | "reconciliation-invalid"
  | "exclusion-ledger-invalid"
  | "locked-report-invalid"
  | "provenance-invalid"
  | "lock-evidence-invalid"
  | "sink-ledger-mismatch"
  | "ledger-unreadable";

/** Structured failure context — safe for events (never contains the RPC URL). */
export interface SnapshotterFailureContext {
  pool?: string;
  snapshotSlot?: number;
  artifactSha256?: string;
  exitCode?: number | null;
  signal?: string | null;
}

/** Terminal claims-snapshot production failure. NEVER embeds the RPC URL. */
export class ClaimsSnapshotterError extends Error {
  readonly category: SnapshotterFailureCategory;
  readonly context: SnapshotterFailureContext;

  constructor(
    category: SnapshotterFailureCategory,
    detail: string,
    context: SnapshotterFailureContext = {},
  ) {
    super(`claims snapshotter failure [${category}]: ${detail}`);
    this.name = "ClaimsSnapshotterError";
    this.category = category;
    this.context = context;
  }
}

// ------------------------------------------------------------------ shapes

/** What the salvage-preparation path asks the producer for. */
export interface SnapshotterRequest {
  pool: PublicKey;
  ammProgramId: PublicKey;
  lpMint: PublicKey;
}

/** The verified snapshot material the pipeline consumes. */
export interface VerifiedClaimsSnapshot {
  /** The Merkle root to submit to `salvage_pool` (32 bytes). */
  root: Uint8Array;
  /** Pre-salvage LP supply pinned by the artifact. */
  totalSupply: bigint;
  /** The anchored consistent-state slot. */
  snapshotSlot: number;
  /** Canonical holder count in the leaf set. */
  holderCount: number;
  /** SHA-256 over the EXACT artifact bytes this root came from. */
  artifactSha256: string;
  /** SHA-256 over the EXACT governed sink-ledger bytes supplied to the run. */
  sinkLedgerSha256: string;
  /** The governed ledger's declared identity. */
  sinkLedgerId: string;
}

/** The claims-snapshot producer seam (D3). Production: RustCliClaimsSnapshotter. */
export interface ClaimsSnapshotter {
  produceSnapshot(req: SnapshotterRequest): Promise<VerifiedClaimsSnapshot>;
}

/** Configuration for the Rust CLI subprocess producer. */
export interface RustCliSnapshotterConfig {
  /** Path to the `grave-snapshotter-cli` executable. */
  executablePath: string;
  /**
   * The RPC endpoint (may carry provider credentials). Passed to the CLI
   * as one argv element; never logged or echoed anywhere.
   */
  rpcUrl: string;
  /** Commitment for every read of the run (CLI + evidence share it). */
  commitment: SnapshotterCommitment;
  /**
   * REQUIRED path to the governed sink-exclusion ledger (`gy.sink-ledger.v1`)
   * for the pool. An explicit schema-valid empty ledger is the correct
   * input for a pool with no approved sinks; a MISSING configuration is a
   * hard error — there is no empty-ledger convenience default.
   */
  sinkLedgerPath: string;
  /** Wall-clock budget for one CLI run (default 120_000 ms). */
  timeoutMs?: number;
  /** Artifact size cap in bytes (default 64 MiB). */
  maxArtifactBytes?: number;
  /** Combined stdout+stderr capture cap in bytes (default 1 MiB). */
  maxLogBytes?: number;
  /**
   * The subprocess environment. Defaults to `process.env` (PATH is needed
   * by the CLI's runtime). Operators may pass an explicit allow-list; the
   * environment is never logged.
   */
  env?: Record<string, string | undefined>;
}

export const DEFAULT_SNAPSHOTTER_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

// ------------------------------------------------------- artifact JSON types

/** Exact-TS-shape of the D2 v2 artifact (u64 fields are exact bigints). */
export interface ClaimsArtifactJson {
  format_version: number;
  pool_address: string;
  amm_program_id: string;
  lp_mint: string;
  snapshot_slot: bigint;
  lp_total_supply_at_snapshot: bigint;
  merkle_root: string;
  leaf_count: bigint;
  tree_depth: bigint;
  entries: Array<{
    owner: string;
    lp_balance: bigint;
    leaf: string;
    proof: string[];
  }>;
  reconciliation: {
    entries_total: bigint;
    sink_exclusions_total: bigint;
    enumerated_total: bigint;
  };
  exclusions: Array<{ owner: string; lp_balance: bigint; reason: string }>;
  locked: {
    lock_records_seen: bigint;
    total_locked: bigint;
    attributions: Array<{ owner: string; lp_balance: bigint }>;
    custody: {
      token_account: string;
      owner: string;
      balance: bigint;
      method: string;
    } | null;
  };
  provenance: {
    sink_ledger: {
      schema_version: bigint;
      ledger_id: string;
      input_sha256: string;
      entry_count: bigint;
      sink_exclusions_total: bigint;
    } | null;
    lock_evidence: {
      source: string;
      program_id: string;
      commitment: string;
      anchor_slot: bigint;
      records_seen: bigint;
      total_locked: bigint;
    };
  } | null;
}

/**
 * u64 JSON fields that must be parsed EXACTLY (they can exceed Number's
 * safe-integer range). The reviver uses the JSON.parse source-text access
 * (Node ≥ 21 `context.source`) to build exact bigints; if a runtime
 * without source access supplies an unsafe magnitude the field is
 * REFUSED (fail-closed) rather than silently rounded.
 */
const U64_ARTIFACT_KEYS = new Set([
  "snapshot_slot",
  "lp_total_supply_at_snapshot",
  "leaf_count",
  "tree_depth",
  "lp_balance",
  "entries_total",
  "sink_exclusions_total",
  "enumerated_total",
  "lock_records_seen",
  "total_locked",
  "balance",
  "entry_count",
  "anchor_slot",
  "records_seen",
  "schema_version",
]);

function parseArtifactJson(text: string): ClaimsArtifactJson {
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown => {
    if (U64_ARTIFACT_KEYS.has(key) && typeof value === "number") {
      const source = context?.source;
      if (typeof source === "string" && /^\d+$/.test(source)) {
        return BigInt(source);
      }
      if (!Number.isSafeInteger(value)) {
        throw new ClaimsSnapshotterError(
          "schema-invalid",
          `field "${key}" exceeded the exact-integer JSON parse capability of this runtime`,
        );
      }
      return BigInt(value);
    }
    return value;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
  } catch (err) {
    if (err instanceof ClaimsSnapshotterError) throw err;
    throw new ClaimsSnapshotterError(
      "malformed-output",
      `artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsed as ClaimsArtifactJson;
}

/**
 * Exact-integer parse of a claims artifact document: every u64 field
 * becomes a bigint (via the JSON.parse source-text access, Node ≥ 21);
 * an unsafe magnitude on a runtime without source access is refused.
 * Exported for consumers that must inspect the artifact before calling
 * {@link verifyClaimsArtifact}.
 */
export function parseClaimsArtifactJson(text: string): ClaimsArtifactJson {
  return parseArtifactJson(text);
}

// ------------------------------------------------------------- verification

export interface VerifyClaimsArtifactOptions {
  /**
   * The exact governed sink-ledger bytes this run supplied. When given,
   * the artifact's sink-ledger provenance must hash to exactly these
   * bytes (byte-level binding of the governed input).
   */
  sinkLedgerBytes?: Uint8Array;
  /** The commitment the run was requested with (artifact must agree). */
  commitment?: SnapshotterCommitment;
}

function compareOwnerBytes(a: string, b: string): number {
  const ab = BS58_DECODE(a);
  const bb = BS58_DECODE(b);
  for (let i = 0; i < 32; i++) {
    const x = ab[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** bs58 decode with a precise claims-snapshotter failure category. */
function BS58_DECODE(s: string): Uint8Array {
  try {
    return bs58.decode(s);
  } catch {
    throw new ClaimsSnapshotterError("schema-invalid", `invalid base58 pubkey string`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertHex32(value: string, what: string): Uint8Array {
  // Readers accept either case (mirrors artifact.rs's decode_hex32);
  // the producer is deterministic lowercase.
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new ClaimsSnapshotterError("schema-invalid", `${what} is not a 64-character hex hash`);
  }
  return Buffer.from(value, "hex");
}

function bigintEqual(a: bigint, b: number | bigint): boolean {
  return a === (typeof b === "bigint" ? b : BigInt(b));
}

/**
 * CLAIMS-GRADE artifact verification (the TS mirror of
 * `SnapshotArtifact::verify_integrity`, plus the D3 run-level bindings):
 * the root consumed for salvage is accepted ONLY when every check below
 * passes. Throws `ClaimsSnapshotterError` with a precise category on any
 * failure.
 *
 * Takes the EXACT artifact bytes: the digest is computed over them, and
 * the u64 fields are parsed exactly (bigints) — a caller cannot slip a
 * float-rounded document past this gate.
 */
export function verifyClaimsArtifact(
  bytes: Uint8Array,
  req: SnapshotterRequest,
  opts: VerifyClaimsArtifactOptions = {},
): { root: Uint8Array; totalSupply: bigint; snapshotSlot: number; holderCount: number } {
  const a = parseArtifactJson(Buffer.from(bytes).toString("utf8"));
  // A `function` declaration with an explicit `never` return type: TS
  // narrows control flow across calls to it (the null-gates below rely on
  // that), unlike an inferred arrow.
  function fail(category: SnapshotterFailureCategory, detail: string): never {
    const context: SnapshotterFailureContext = { artifactSha256: sha256Hex(bytes) };
    if (typeof a.pool_address === "string") context.pool = a.pool_address;
    if (
      typeof a.snapshot_slot === "bigint" &&
      a.snapshot_slot > 0n &&
      a.snapshot_slot <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      context.snapshotSlot = Number(a.snapshot_slot);
    }
    throw new ClaimsSnapshotterError(category, detail, context);
  }

  // 1. Format gate — exactly the D2 v2 shape.
  if (a.format_version !== CLAIMS_ARTIFACT_FORMAT_VERSION) {
    fail(
      "schema-invalid",
      `unsupported artifact format_version ${String(a.format_version)} (this integration accepts exactly ${CLAIMS_ARTIFACT_FORMAT_VERSION})`,
    );
  }

  // 2. Identity binding — pool, AMM, and LP mint must be the ones being prepared.
  if (a.pool_address !== req.pool.toBase58()) {
    fail(
      "pool-mismatch",
      `artifact pool ${a.pool_address} != requested pool ${req.pool.toBase58()}`,
    );
  }
  if (a.amm_program_id !== req.ammProgramId.toBase58()) {
    fail(
      "amm-mismatch",
      `artifact amm ${a.amm_program_id} != requested amm ${req.ammProgramId.toBase58()}`,
    );
  }
  if (a.lp_mint !== req.lpMint.toBase58()) {
    fail(
      "mint-mismatch",
      `artifact lp_mint ${a.lp_mint} != requested lp_mint ${req.lpMint.toBase58()}`,
    );
  }
  if (typeof a.snapshot_slot !== "bigint" || a.snapshot_slot <= 0n) {
    fail("schema-invalid", "snapshot_slot must be a positive integer");
  }
  if (typeof a.lp_total_supply_at_snapshot !== "bigint" || a.lp_total_supply_at_snapshot <= 0n) {
    fail("schema-invalid", "lp_total_supply_at_snapshot must be a positive integer");
  }

  // 3. Entries: non-empty, strictly positive, canonical ascending-owner
  //    byte order, unique owners.
  const entries = a.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(
      "schema-invalid",
      "artifact carries no entries — an empty leaf set has no legitimate root",
    );
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (typeof e.owner !== "string" || typeof e.lp_balance !== "bigint") {
      fail("schema-invalid", `entry ${i} is structurally invalid`);
    }
    if (e.lp_balance <= 0n) {
      fail("schema-invalid", `entry ${i} (owner ${e.owner}) carries a non-positive balance`);
    }
    if (i > 0) {
      const prev = entries[i - 1]!;
      const cmp = compareOwnerBytes(prev.owner, e.owner);
      if (cmp === 0) fail("schema-invalid", `duplicate owner at entry ${i} (${e.owner})`);
      if (cmp > 0)
        fail("schema-invalid", `entries are not in canonical ascending-owner order at ${i}`);
    }
  }

  // 4. Full Merkle re-derivation from the persisted rows.
  const rebuilt = (() => {
    try {
      return SnapshotMerkleTree.fromEntries(
        entries.map((e) => ({
          owner: new PublicKey(BS58_DECODE(e.owner)),
          lpBalance: e.lp_balance,
        })),
      );
    } catch (err) {
      throw new ClaimsSnapshotterError(
        "tree-mismatch",
        `entry set failed canonical tree construction: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  const artifactRoot = assertHex32(a.merkle_root, "merkle_root");
  const rebuiltRootHex = Buffer.from(rebuilt.root()).toString("hex");
  if (rebuiltRootHex !== a.merkle_root.toLowerCase()) {
    fail(
      "tree-mismatch",
      `root does not derive from the persisted entries (stored ${a.merkle_root.slice(0, 16)}…, rebuilt ${rebuiltRootHex.slice(0, 16)}…)`,
    );
  }
  if (
    !bigintEqual(a.leaf_count, entries.length) ||
    !bigintEqual(a.leaf_count, rebuilt.leafCount())
  ) {
    fail("tree-mismatch", "leaf_count disagrees with the persisted entries");
  }
  if (!bigintEqual(a.tree_depth, rebuilt.treeDepth())) {
    fail("tree-mismatch", "tree_depth disagrees with the persisted entries");
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const leafHex = Buffer.from(rebuilt.leaf(i) ?? new Uint8Array()).toString("hex");
    if (leafHex !== e.leaf) {
      fail("tree-mismatch", `leaf mismatch at entry ${i} (owner ${e.owner})`);
    }
    const proofHex = (rebuilt.proof(i) ?? []).map((p) => Buffer.from(p).toString("hex"));
    if (proofHex.length !== e.proof.length || proofHex.some((p, j) => p !== e.proof[j])) {
      fail("tree-mismatch", `proof mismatch at entry ${i} (owner ${e.owner})`);
    }
  }

  // 5. Closing reconciliation identity.
  const rec = a.reconciliation;
  if (!rec || typeof rec.entries_total !== "bigint") {
    fail("reconciliation-invalid", "reconciliation block is missing or malformed");
  }
  let entriesSum = 0n;
  for (const e of entries) entriesSum += e.lp_balance;
  if (entriesSum !== rec.entries_total) {
    fail(
      "reconciliation-invalid",
      `Σ persisted balances (${entriesSum}) != reconciliation.entries_total (${rec.entries_total})`,
    );
  }
  if (rec.entries_total + rec.sink_exclusions_total !== rec.enumerated_total) {
    fail("reconciliation-invalid", "reconciliation identity entries + sinks != enumerated broken");
  }
  if (rec.enumerated_total !== a.lp_total_supply_at_snapshot) {
    fail(
      "reconciliation-invalid",
      "reconciliation.enumerated_total != lp_total_supply_at_snapshot",
    );
  }

  // 6. Exclusion ledger (canonical order, reasons, sink total).
  const exclusions = a.exclusions;
  if (!Array.isArray(exclusions)) fail("schema-invalid", "exclusions block is missing");
  let sinkTotal = 0n;
  let previousOwner: string | null = null;
  for (const x of exclusions) {
    if (
      typeof x.owner !== "string" ||
      typeof x.lp_balance !== "bigint" ||
      typeof x.reason !== "string"
    ) {
      fail("exclusion-ledger-invalid", "exclusion row is structurally invalid");
    }
    if (previousOwner !== null && compareOwnerBytes(previousOwner, x.owner) >= 0) {
      fail("exclusion-ledger-invalid", "exclusions are not in canonical ascending-owner order");
    }
    previousOwner = x.owner;
    if (x.reason === "zero_balance") {
      if (x.lp_balance !== 0n) {
        fail(
          "exclusion-ledger-invalid",
          `zero_balance exclusion for ${x.owner} carries a nonzero balance`,
        );
      }
    } else if (x.reason === "explicit_sink") {
      sinkTotal += x.lp_balance;
    } else {
      fail("exclusion-ledger-invalid", `unknown exclusion reason "${x.reason}"`);
    }
  }
  if (sinkTotal !== rec.sink_exclusions_total) {
    fail(
      "exclusion-ledger-invalid",
      "Σ explicit sink exclusions != reconciliation.sink_exclusions_total",
    );
  }

  // 7. Locked-LP report.
  const locked = a.locked;
  if (!locked || typeof locked.total_locked !== "bigint") {
    fail("locked-report-invalid", "locked report is missing or malformed");
  }
  let attributed = 0n;
  let prevAttribution: string | null = null;
  for (const at of locked.attributions) {
    if (typeof at.owner !== "string" || typeof at.lp_balance !== "bigint") {
      fail("locked-report-invalid", "locked attribution row is structurally invalid");
    }
    if (prevAttribution !== null && compareOwnerBytes(prevAttribution, at.owner) >= 0) {
      fail(
        "locked-report-invalid",
        "locked attributions are not in canonical ascending-owner order",
      );
    }
    prevAttribution = at.owner;
    attributed += at.lp_balance;
  }
  if (attributed !== locked.total_locked) {
    fail("locked-report-invalid", "Σ locked attributions != locked.total_locked");
  }
  if (locked.custody !== null) {
    if (locked.total_locked === 0n) {
      fail("locked-report-invalid", "custody resolution present with zero locked total");
    }
    if (locked.custody.balance !== locked.total_locked) {
      fail("locked-report-invalid", "custody balance != locked.total_locked");
    }
    if (entries.some((e) => e.owner === locked.custody!.owner)) {
      fail(
        "locked-report-invalid",
        "custody owner also holds a claimable leaf; attributing to a PDA would strand the claim",
      );
    }
  } else if (locked.total_locked !== 0n) {
    fail("locked-report-invalid", "locked total > 0 but no custody resolution");
  }

  // 8. CLAIMS-GRADE provenance — REQUIRED. A provenance-less artifact is
  //    never claims-grade (D2); this integration never accepts one.
  const provenance = a.provenance;
  if (!provenance || !provenance.lock_evidence) {
    fail(
      "provenance-invalid",
      "claims-grade verification requires complete governed-input provenance: the artifact carries none",
    );
  }
  const lock = provenance.lock_evidence;
  if (lock.source !== "rpc") {
    fail(
      "lock-evidence-invalid",
      `unsupported lock_evidence.source "${lock.source}" (supported: "rpc")`,
    );
  }
  if (lock.program_id !== UNCX_RAYDIUM_AMM_V4_LOCKER_PROGRAM_ID) {
    fail(
      "lock-evidence-invalid",
      `unsupported lock_evidence.program_id ${lock.program_id} (this implementation supports exactly the UNCX locker)`,
    );
  }
  if (opts.commitment !== undefined && lock.commitment !== opts.commitment) {
    fail(
      "lock-evidence-invalid",
      `lock_evidence.commitment "${lock.commitment}" != the commitment this run used ("${opts.commitment}")`,
    );
  }
  if (typeof lock.anchor_slot !== "bigint" || lock.anchor_slot <= 0n) {
    fail("lock-evidence-invalid", "lock_evidence.anchor_slot must be a positive integer");
  }
  if (lock.anchor_slot !== a.snapshot_slot) {
    fail("lock-evidence-invalid", "provenance lock_evidence.anchor_slot != snapshot_slot");
  }
  if (lock.records_seen !== locked.lock_records_seen) {
    fail(
      "lock-evidence-invalid",
      "provenance lock_evidence.records_seen != locked.lock_records_seen",
    );
  }
  if (lock.total_locked !== locked.total_locked) {
    fail("lock-evidence-invalid", "provenance lock_evidence.total_locked != locked.total_locked");
  }

  // 9. Governed sink-ledger binding. When this run supplied ledger bytes,
  //    the provenance must exist AND hash to exactly those bytes.
  const explicitSinks = exclusions.filter((x) => x.reason === "explicit_sink").length;
  if (opts.sinkLedgerBytes !== undefined) {
    const ledgerProv = provenance.sink_ledger;
    if (!ledgerProv) {
      fail(
        "sink-ledger-mismatch",
        "this run supplied a governed sink ledger but the artifact carries no sink-ledger provenance",
      );
    }
    if (!bigintEqual(ledgerProv.schema_version, SINK_LEDGER_SCHEMA_VERSION)) {
      fail("sink-ledger-mismatch", "unsupported sink_ledger provenance schema_version");
    }
    if (typeof ledgerProv.ledger_id !== "string" || ledgerProv.ledger_id.trim().length === 0) {
      fail(
        "sink-ledger-mismatch",
        "sink_ledger.ledger_id is empty — the governed ledger identity is required",
      );
    }
    const ledgerDigest = sha256Hex(opts.sinkLedgerBytes);
    if (ledgerProv.input_sha256 !== ledgerDigest) {
      fail(
        "sink-ledger-mismatch",
        `sink_ledger.input_sha256 does not match the exact ledger bytes this run supplied (artifact ${ledgerProv.input_sha256.slice(0, 16)}…, supplied ${ledgerDigest.slice(0, 16)}…)`,
      );
    }
    if (!bigintEqual(ledgerProv.entry_count, explicitSinks)) {
      fail(
        "sink-ledger-mismatch",
        "provenance sink_ledger.entry_count != explicit sink exclusions",
      );
    }
    if (ledgerProv.sink_exclusions_total !== rec.sink_exclusions_total) {
      fail(
        "sink-ledger-mismatch",
        "provenance sink_ledger.sink_exclusions_total != reconciliation.sink_exclusions_total",
      );
    }
  } else if (explicitSinks > 0 && !provenance.sink_ledger) {
    fail(
      "provenance-invalid",
      "artifact contains explicit sink exclusions but the provenance carries no governed sink ledger",
    );
  }

  return {
    root: new Uint8Array(artifactRoot),
    totalSupply: a.lp_total_supply_at_snapshot,
    snapshotSlot: Number(a.snapshot_slot),
    holderCount: entries.length,
  };
}

/**
 * Structural validation of the governed sink-ledger FILE before the run:
 * schema id/version and pool/AMM/mint binding to the exact request. The
 * CLI re-validates authoritatively; this pre-check fails fast with a
 * precise category and binds the ledger to the prepared pool.
 */
export function verifySinkLedgerBinding(
  bytes: Uint8Array,
  req: SnapshotterRequest,
): { ledgerId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (err) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      `governed sink ledger is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const ledger = parsed as {
    schema_version?: unknown;
    ledger_id?: unknown;
    pool_address?: unknown;
    amm_program_id?: unknown;
    lp_mint?: unknown;
    entries?: unknown;
  };
  if (ledger.schema_version !== SINK_LEDGER_SCHEMA_VERSION) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      `unsupported sink ledger schema_version ${String(ledger.schema_version)} (expected ${SINK_LEDGER_SCHEMA_VERSION})`,
    );
  }
  if (typeof ledger.ledger_id !== "string" || ledger.ledger_id.trim().length === 0) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      "governed sink ledger has an empty ledger_id",
    );
  }
  if (!Array.isArray(ledger.entries)) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      "governed sink ledger has no entries array",
    );
  }
  if (ledger.pool_address !== req.pool.toBase58()) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      `sink ledger is scoped to pool ${String(ledger.pool_address)}, not the prepared pool ${req.pool.toBase58()}`,
    );
  }
  if (ledger.amm_program_id !== req.ammProgramId.toBase58()) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      `sink ledger amm_program_id ${String(ledger.amm_program_id)} does not match the prepared pool's AMM`,
    );
  }
  if (ledger.lp_mint !== req.lpMint.toBase58()) {
    throw new ClaimsSnapshotterError(
      "sink-ledger-mismatch",
      `sink ledger lp_mint ${String(ledger.lp_mint)} does not match the prepared pool's LP mint`,
    );
  }
  return { ledgerId: ledger.ledger_id };
}

// ------------------------------------------------------------ subprocess run

/**
 * The production claims-snapshot producer: the Rust
 * `grave-snapshotter-cli`, run as a local subprocess with explicit argv
 * (no shell), bounded time and output, controlled temp-file handling,
 * and full claims-grade verification of the sealed artifact.
 */
export class RustCliClaimsSnapshotter implements ClaimsSnapshotter {
  private readonly cfg: Required<
    Pick<RustCliSnapshotterConfig, "executablePath" | "rpcUrl" | "commitment" | "sinkLedgerPath">
  > &
    Pick<RustCliSnapshotterConfig, "timeoutMs" | "maxArtifactBytes" | "maxLogBytes" | "env">;

  constructor(cfg: RustCliSnapshotterConfig) {
    if (typeof cfg.executablePath !== "string" || cfg.executablePath.length === 0) {
      throw new ClaimsSnapshotterError("config-invalid", "executablePath must be a non-empty path");
    }
    if (typeof cfg.rpcUrl !== "string" || cfg.rpcUrl.length === 0) {
      throw new ClaimsSnapshotterError("config-invalid", "rpcUrl must be a non-empty string");
    }
    if (!SNAPSHOTTER_COMMITMENTS.includes(cfg.commitment)) {
      throw new ClaimsSnapshotterError(
        "config-invalid",
        `unsupported commitment "${String(cfg.commitment)}" (supported: ${SNAPSHOTTER_COMMITMENTS.join(", ")})`,
      );
    }
    if (typeof cfg.sinkLedgerPath !== "string" || cfg.sinkLedgerPath.length === 0) {
      throw new ClaimsSnapshotterError(
        "config-invalid",
        "sinkLedgerPath is REQUIRED — the governed ledger (possibly an explicit empty ledger) must be configured; there is no empty-ledger default",
      );
    }
    this.cfg = cfg;
  }

  async produceSnapshot(req: SnapshotterRequest): Promise<VerifiedClaimsSnapshot> {
    // Executable check up front — a missing/incompatible binary is a
    // terminal configuration failure, never a fallback.
    try {
      accessSync(this.cfg.executablePath, fsConstants.X_OK);
    } catch {
      throw new ClaimsSnapshotterError(
        "missing-executable",
        `grave-snapshotter-cli not found or not executable at the configured path`,
        { pool: req.pool.toBase58() },
      );
    }

    // Governed ledger: read the exact bytes and bind them to the pool
    // BEFORE any RPC work. Missing/invalid ledger is terminal.
    let ledgerBytes: Uint8Array;
    try {
      ledgerBytes = readFileSync(this.cfg.sinkLedgerPath);
    } catch (err) {
      throw new ClaimsSnapshotterError(
        "ledger-unreadable",
        `governed sink ledger unreadable: ${err instanceof Error ? err.message : String(err)}`,
        { pool: req.pool.toBase58() },
      );
    }
    const ledgerId = verifySinkLedgerBinding(ledgerBytes, req).ledgerId;
    const ledgerDigest = sha256Hex(ledgerBytes);

    // Unique temp dir per invocation: the artifact is bound to THIS run —
    // a stale artifact from another attempt can never be consumed, and
    // the directory is always cleaned up.
    const dir = mkdtempSync(join(tmpdir(), "gy-claims-snapshot-"));
    const outPath = join(dir, "artifact.json");
    try {
      const { stdout, stderr, code, signal, timedOut, spawnError } = await this.runCli(
        req,
        outPath,
      );
      if (spawnError) {
        throw new ClaimsSnapshotterError(
          "spawn-failed",
          `could not invoke grave-snapshotter-cli: ${spawnError}`,
          { pool: req.pool.toBase58() },
        );
      }
      if (timedOut) {
        throw new ClaimsSnapshotterError(
          "timeout",
          `grave-snapshotter-cli exceeded the ${this.timeoutMs()}ms budget and was killed`,
          { pool: req.pool.toBase58(), signal },
        );
      }
      if (code !== 0) {
        throw new ClaimsSnapshotterError(
          signal ? "signal-terminated" : "nonzero-exit",
          `grave-snapshotter-cli exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderr ? `: ${stderr}` : ""}`,
          { pool: req.pool.toBase58(), exitCode: code, signal },
        );
      }

      // Bounded artifact read: stat first, refuse oversize before reading.
      let size: number;
      try {
        size = statSync(outPath).size;
      } catch {
        throw new ClaimsSnapshotterError(
          "artifact-unreadable",
          "the CLI reported success but wrote no artifact file",
          { pool: req.pool.toBase58() },
        );
      }
      if (size > this.maxArtifactBytes()) {
        throw new ClaimsSnapshotterError(
          "artifact-too-large",
          `artifact (${size} bytes) exceeds the ${this.maxArtifactBytes()}-byte cap`,
          { pool: req.pool.toBase58() },
        );
      }
      const bytes = readFileSync(outPath);

      const verified = verifyClaimsArtifact(bytes, req, {
        sinkLedgerBytes: ledgerBytes,
        commitment: this.cfg.commitment,
      });
      void stdout;
      return {
        root: verified.root,
        totalSupply: verified.totalSupply,
        snapshotSlot: verified.snapshotSlot,
        holderCount: verified.holderCount,
        artifactSha256: sha256Hex(bytes),
        sinkLedgerSha256: ledgerDigest,
        sinkLedgerId: ledgerId,
      };
    } finally {
      // Controlled cleanup — the temp artifact never outlives the attempt.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort; the tmpdir is reaped by the OS */
      }
    }
  }

  /** Spawn the CLI. Explicit argv, shell:false, bounded time + output. */
  private runCli(
    req: SnapshotterRequest,
    outPath: string,
  ): Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    timedOut: boolean;
    spawnError: string | null;
  }> {
    void req; // identity binding happens in verification; args carry it
    const args = [
      "--url",
      this.cfg.rpcUrl, // one argv element; no shell ever sees it
      "--pool",
      req.pool.toBase58(),
      "--amm",
      req.ammProgramId.toBase58(),
      "--lp-mint",
      req.lpMint.toBase58(),
      "--out",
      outPath,
      "--commitment",
      this.cfg.commitment,
      "--lock-evidence",
      "rpc",
      "--sink-ledger",
      this.cfg.sinkLedgerPath,
    ];
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let spawnError: string | null = null;
      const maxLog = this.maxLogBytes();
      const child = spawn(this.cfg.executablePath, args, {
        shell: false, // no shell-string interpolation, ever
        stdio: ["ignore", "pipe", "pipe"],
        // PATH is needed by the CLI runtime; tests may pass an explicit
        // environment. Never logged.
        env: this.cfg.env ?? process.env,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Escalate if the CLI ignores SIGTERM.
        const grace = setTimeout(() => child.kill("SIGKILL"), 5_000);
        grace.unref?.();
      }, this.timeoutMs());
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxLog) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxLog) stderr += chunk.toString("utf8");
      });
      const settle = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, maxLog),
          stderr: stderr.slice(0, maxLog),
          code,
          signal,
          timedOut,
          spawnError,
        });
      };
      child.on("error", (err) => {
        // A spawn failure (e.g. ENOENT, EACCES) may never be followed by a
        // "close" event — settle immediately; a later close is ignored.
        spawnError = err.message;
        settle(null, null);
      });
      child.on("close", (code, signal) => settle(code, signal));
    });
  }

  private timeoutMs(): number {
    return this.cfg.timeoutMs ?? DEFAULT_SNAPSHOTTER_TIMEOUT_MS;
  }
  private maxArtifactBytes(): number {
    return this.cfg.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }
  private maxLogBytes(): number {
    return this.cfg.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  }
}

// --------------------------------------------------------------- env wiring

/**
 * Standard operator wiring from environment variables (names documented
 * in docs/ops/CLAIMS-SNAPSHOT-PRODUCTION.md). Throws
 * `ClaimsSnapshotterError` ("config-invalid") when a required variable is
 * absent — there is no default RPC URL and no default ledger path.
 *
 *   GY_SNAPSHOTTER_BIN          path to grave-snapshotter-cli
 *   GY_SNAPSHOTTER_RPC_URL      RPC endpoint (may carry credentials; never logged)
 *   GY_SNAPSHOTTER_COMMITMENT   confirmed | finalized
 *   GY_SNAPSHOTTER_SINK_LEDGER  path to the governed gy.sink-ledger.v1 file
 */
export function snapshotterConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RustCliSnapshotterConfig {
  const missing = (name: string): never => {
    throw new ClaimsSnapshotterError(
      "config-invalid",
      `required environment variable ${name} is not set`,
    );
  };
  const bin = env["GY_SNAPSHOTTER_BIN"] ?? missing("GY_SNAPSHOTTER_BIN");
  const rpcUrl = env["GY_SNAPSHOTTER_RPC_URL"] ?? missing("GY_SNAPSHOTTER_RPC_URL");
  const commitmentRaw = env["GY_SNAPSHOTTER_COMMITMENT"] ?? missing("GY_SNAPSHOTTER_COMMITMENT");
  if (!SNAPSHOTTER_COMMITMENTS.includes(commitmentRaw as SnapshotterCommitment)) {
    throw new ClaimsSnapshotterError(
      "config-invalid",
      `GY_SNAPSHOTTER_COMMITMENT "${commitmentRaw}" is not one of ${SNAPSHOTTER_COMMITMENTS.join(", ")}`,
    );
  }
  const ledger = env["GY_SNAPSHOTTER_SINK_LEDGER"] ?? missing("GY_SNAPSHOTTER_SINK_LEDGER");
  return {
    executablePath: bin,
    rpcUrl,
    commitment: commitmentRaw as SnapshotterCommitment,
    sinkLedgerPath: ledger,
  };
}
