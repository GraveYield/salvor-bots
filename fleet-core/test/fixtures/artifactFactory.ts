// SPDX-License-Identifier: Apache-2.0
//
// D3 test fixture factory — deterministic, internally-consistent D2 v2
// claims artifacts + governed sink ledgers for the fleet-core test suite.
//
// The produced artifact mirrors the byte semantics of
// `snapshotter/src/artifact.rs` (field order = struct declaration order,
// canonical ascending-owner entries, lowercase hex hashes, base58
// pubkeys) with the SDK's byte-locked `SnapshotMerkleTree` port supplying
// leaves/proofs/roots. These are FIXTURES: they exercise the TS
// verification + subprocess integration, not the Rust build itself.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "@graveyield/sdk";

/** The UNCX locker program id the artifact provenance must carry. */
export const UNCX_LOCKER_PROGRAM_ID = "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";

export interface FixtureSinkEntry {
  owner: PublicKey;
  tokenAccount: PublicKey;
  rawBalance: bigint;
  rationale?: string;
  evidenceReferences?: string[];
  approvalIdentities?: string[];
  independentReviewer?: string;
  approvedAt?: string;
}

/** Build a governed `gy.sink-ledger.v1` ledger bound to pool/amm/mint. */
export function buildSinkLedger(opts: {
  pool: PublicKey;
  amm: PublicKey;
  lpMint: PublicKey;
  ledgerId?: string;
  entries?: FixtureSinkEntry[];
}): { text: string; bytes: Buffer; ledgerId: string } {
  const ledgerId = opts.ledgerId ?? "GY-SINK-FIXTURE-001";
  const doc = {
    schema_version: 1,
    ledger_id: ledgerId,
    pool_address: opts.pool.toBase58(),
    amm_program_id: opts.amm.toBase58(),
    lp_mint: opts.lpMint.toBase58(),
    entries: (opts.entries ?? []).map((e) => ({
      owner: e.owner.toBase58(),
      token_account: e.tokenAccount.toBase58(),
      lp_mint: opts.lpMint.toBase58(),
      raw_balance: e.rawBalance,
      rationale: e.rationale ?? "incinerator address, funds provably unrecoverable",
      evidence_references: e.evidenceReferences ?? ["gy-evidence-fixture-001"],
      approval_identities: e.approvalIdentities ?? ["owner-identity-fixture-1"],
      independent_reviewer: e.independentReviewer ?? "reviewer-identity-fixture-1",
      approved_at: e.approvedAt ?? "2026-11-27T00:00:00Z",
    })),
  };
  const text =
    JSON.stringify(doc, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v), 2) + "\n";
  return { text, bytes: Buffer.from(text, "utf8"), ledgerId };
}

export interface FixtureArtifactOptions {
  pool: PublicKey;
  ammProgramId: PublicKey;
  lpMint: PublicKey;
  snapshotSlot: number;
  /** Canonical leaf-set holders (positive balances; sinks excluded). */
  holders: Array<{ owner: PublicKey; balance: bigint }>;
  /** Explicit sink exclusions (must have a sinkLedger to be legitimate). */
  sinkExclusions?: Array<{ owner: PublicKey; balance: bigint }>;
  /** Zero-balance exclusions (owner may also appear in the leaf set). */
  zeroBalanceExclusions?: Array<{ owner: PublicKey }>;
  /** Governed ledger backing the sink exclusions (REQUIRED when present). */
  sinkLedger?: { bytes: Buffer; ledgerId: string };
  /** Locked-LP report. */
  locked?: {
    lockRecordsSeen: number;
    totalLocked: bigint;
    attributions: Array<{ owner: PublicKey; balance: bigint }>;
    custody?: { tokenAccount: PublicKey; owner: PublicKey } | null;
  };
  commitment?: string;
  lockEvidenceSource?: string;
  lockEvidenceProgramId?: string;
  formatVersion?: number;
}

/**
 * Build a deterministic, self-consistent D2 v2 claims artifact (pretty
 * JSON, Rust field order). Throws when the requested shape is internally
 * inconsistent — fixtures must be well-formed by construction.
 */
export function buildClaimsArtifact(opts: FixtureArtifactOptions): {
  text: string;
  bytes: Buffer;
  rootHex: string;
} {
  const formatVersion = opts.formatVersion ?? 2;
  const commitment = opts.commitment ?? "confirmed";
  const sinkEntries = opts.sinkExclusions ?? [];
  if (sinkEntries.length > 0 && !opts.sinkLedger) {
    throw new Error("fixture: sink exclusions require a governed ledger fixture");
  }
  const zeroEntries = (opts.zeroBalanceExclusions ?? []).map((z) => ({
    owner: z.owner.toBase58(),
    lp_balance: 0n,
    reason: "zero_balance",
  }));
  const sinkExclusions = sinkEntries.map((s) => ({
    owner: s.owner.toBase58(),
    lp_balance: s.balance,
    reason: "explicit_sink",
  }));
  const exclusions = [...zeroEntries, ...sinkExclusions].sort((a, b) =>
    compareOwners(a.owner, b.owner),
  );

  const sinkTotal = sinkEntries.reduce((acc, s) => acc + s.balance, 0n);
  const entriesTotal = opts.holders.reduce((acc, h) => acc + h.balance, 0n);
  const enumeratedTotal = entriesTotal + sinkTotal;

  const locked = opts.locked ?? {
    lockRecordsSeen: 0,
    totalLocked: 0n,
    attributions: [],
    custody: null,
  };
  const attributedSum = locked.attributions.reduce((acc, a) => acc + a.balance, 0n);
  if (attributedSum !== locked.totalLocked) {
    throw new Error("fixture: locked attributions must sum to totalLocked");
  }
  if (locked.totalLocked > 0n && !locked.custody) {
    throw new Error("fixture: locked total > 0 requires a custody resolution");
  }

  const holdersSorted = [...opts.holders].sort((a, b) =>
    compareOwners(a.owner.toBase58(), b.owner.toBase58()),
  );
  const tree = SnapshotMerkleTree.fromEntries(
    holdersSorted.map((h) => ({ owner: h.owner, lpBalance: h.balance })),
  );
  const rootHex = Buffer.from(tree.root()).toString("hex");

  const entries = holdersSorted.map((h, i) => ({
    owner: h.owner.toBase58(),
    lp_balance: h.balance,
    leaf: Buffer.from(tree.leaf(i) ?? new Uint8Array()).toString("hex"),
    proof: (tree.proof(i) ?? []).map((p) => Buffer.from(p).toString("hex")),
  }));

  const custody =
    locked.custody && locked.totalLocked > 0n
      ? {
          token_account: locked.custody.tokenAccount.toBase58(),
          owner: locked.custody.owner.toBase58(),
          balance: locked.totalLocked,
          method: "exact_balance_match",
        }
      : null;

  const provenance = {
    sink_ledger: opts.sinkLedger
      ? {
          schema_version: 1,
          ledger_id: opts.sinkLedger.ledgerId,
          input_sha256: createHash("sha256").update(opts.sinkLedger.bytes).digest("hex"),
          entry_count: sinkEntries.length,
          sink_exclusions_total: sinkTotal,
        }
      : null,
    lock_evidence: {
      source: opts.lockEvidenceSource ?? "rpc",
      program_id: opts.lockEvidenceProgramId ?? UNCX_LOCKER_PROGRAM_ID,
      commitment,
      anchor_slot: opts.snapshotSlot,
      records_seen: locked.lockRecordsSeen,
      total_locked: locked.totalLocked,
    },
  };

  const doc = {
    format_version: formatVersion,
    pool_address: opts.pool.toBase58(),
    amm_program_id: opts.ammProgramId.toBase58(),
    lp_mint: opts.lpMint.toBase58(),
    snapshot_slot: opts.snapshotSlot,
    lp_total_supply_at_snapshot: enumeratedTotal,
    merkle_root: rootHex,
    leaf_count: entries.length,
    tree_depth: tree.treeDepth(),
    entries,
    reconciliation: {
      entries_total: entriesTotal,
      sink_exclusions_total: sinkTotal,
      enumerated_total: enumeratedTotal,
    },
    exclusions,
    locked: {
      lock_records_seen: locked.lockRecordsSeen,
      total_locked: locked.totalLocked,
      attributions: locked.attributions
        .slice()
        .sort((a, b) => compareOwners(a.owner.toBase58(), b.owner.toBase58()))
        .map((a) => ({ owner: a.owner.toBase58(), lp_balance: a.balance })),
      custody,
    },
    provenance,
  };

  const text = JSON.stringify(doc, replacer, 2) + "\n";
  return { text, bytes: Buffer.from(text, "utf8"), rootHex };
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("fixture: bigint exceeds JSON-safe range");
    }
    return Number(value);
  }
  return value;
}

function compareOwners(a: string, b: string): number {
  const ab = decode58(a);
  const bb = decode58(b);
  for (let i = 0; i < 32; i++) {
    const x = ab[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

import bs58 from "bs58";
function decode58(s: string): Uint8Array {
  return bs58.decode(s);
}
