// SPDX-License-Identifier: Apache-2.0
//
// Candidate lifecycle tracking + on-chain monitoring (the Scout's stages
// 8–9, generalised from the Phase 9 indexer's `tracking.ts`).
//
// The CandidateTracker is the in-memory source of truth for every pool
// the Scout has seen this process lifetime; `monitorCandidate` polls the
// EligibilityAnchor / EligibilityCert PDAs and derives the state the pool
// SHOULD be in. The orchestrator applies transitions and reports:
//
//   anchor written ──→ waiting-epochs ──→ certification-ready
//        │                                     (opportunity: an executor
//        │                                      bot certifies + salvages)
//        ├──→ anchor-invalidated (multisig)
//        └──→ anchor-stale (past anchor_staleness_seconds, sweepable)
//
//   cert written ──→ certified (opportunity: salvage window open)
//        └──→ cert-expired
//
// The Scout applies NO transitions beyond these observations: it never
// certifies (phase 2) and never salvages — those belong to the
// downstream execution bots under the shared execution policy.

import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchEligibilityAnchor,
  fetchEligibilityCert,
} from "@graveyield/sdk";

import type { CandidateLifecycleState, ScoutOpportunity, TrackedCandidate } from "./types.js";

/** Minimum epoch confirmation (spec C6 — mirrors the on-chain constant). */
export const MIN_EPOCH_CONFIRMATION = 2n;

/** States the monitoring pass polls on every cycle. */
export const MONITORABLE_STATES: ReadonlySet<CandidateLifecycleState> = new Set([
  "phase1-submitted",
  "anchor-confirmed",
  "waiting-epochs",
  "certification-ready",
  "certified",
  "cert-expired",
]);

/** The result of one monitoring pass over a tracked candidate. */
export interface MonitorOutcome {
  /** The state the pool should be in after this pass. */
  state: CandidateLifecycleState;
  note: string | null;
  firstEligibleEpoch: bigint | null;
  anchorWrittenAt: bigint | null;
  anchorInvalidated: boolean;
  certExpiresAt: bigint | null;
  /** Current Solana epoch at monitoring time (when known). */
  currentEpoch: bigint | null;
}

/**
 * Poll the anchor + cert PDAs for one pool and derive its on-chain
 * lifecycle state. Read-only — never transitions anything itself.
 */
export async function monitorCandidate(opts: {
  connection: Connection;
  anchorPda: PublicKey;
  certPda: PublicKey;
  /** The tracker's current state (used when the anchor is not yet visible). */
  currentState: CandidateLifecycleState;
  anchorStalenessSeconds: bigint;
  nowMs?: number;
}): Promise<MonitorOutcome> {
  const [anchor, cert] = await Promise.all([
    fetchEligibilityAnchor(opts.connection, opts.anchorPda),
    fetchEligibilityCert(opts.connection, opts.certPda),
  ]);

  const base = {
    firstEligibleEpoch: anchor ? anchor.firstEligibleEpoch : null,
    anchorWrittenAt: anchor ? anchor.writtenAt : null,
    anchorInvalidated: anchor ? anchor.invalidated : false,
    certExpiresAt: cert ? cert.expiresAt : null,
    currentEpoch: null as bigint | null,
  };

  if (!anchor) {
    // Anchor not (yet) visible — phase-1 txs land within one slot, so a
    // submitted-but-unconfirmed tx is the common cause; report the
    // current state unchanged with a note.
    return { ...base, state: opts.currentState, note: "anchor not visible on chain" };
  }

  if (anchor.invalidated) {
    return { ...base, state: "anchor-invalidated", note: "anchor invalidated by protocol authority" };
  }

  // A cert dominates the anchor state (it is the phase-2 product).
  const nowSec = BigInt(Math.floor((opts.nowMs ?? Date.now()) / 1000));
  if (cert) {
    if (cert.expiresAt > nowSec) {
      return { ...base, state: "certified", note: "cert inside TTL — salvage window open" };
    }
    return { ...base, state: "cert-expired", note: "cert past expires_at" };
  }

  const epochInfo = await opts.connection.getEpochInfo();
  const currentEpoch = BigInt(epochInfo.epoch);
  base.currentEpoch = currentEpoch;

  if (currentEpoch >= anchor.firstEligibleEpoch + MIN_EPOCH_CONFIRMATION) {
    return {
      ...base,
      state: "certification-ready",
      note: `epoch ${currentEpoch} ≥ first_eligible ${anchor.firstEligibleEpoch} + ${MIN_EPOCH_CONFIRMATION}`,
    };
  }

  const stale = nowSec - anchor.writtenAt > opts.anchorStalenessSeconds;
  if (stale) {
    return {
      ...base,
      state: "anchor-stale",
      note: "anchor aged past anchor_staleness_seconds without a cert (sweepable on chain)",
    };
  }

  const epochsRemaining = anchor.firstEligibleEpoch + MIN_EPOCH_CONFIRMATION - currentEpoch;
  return {
    ...base,
    state: "waiting-epochs",
    note: `${epochsRemaining} epoch(s) until certification-ready`,
  };
}

/**
 * CandidateTracker — in-memory lifecycle records for every pool the Scout
 * has seen. Append-only history per record; Phase 11 observability will
 * add persistence.
 */
export class CandidateTracker {
  private readonly records = new Map<string, TrackedCandidate>();

  /** Get (creating if absent) the record for a pool. */
  ensure(poolAddress: PublicKey, ammProgramId: PublicKey): TrackedCandidate {
    const key = poolAddress.toBase58();
    let record = this.records.get(key);
    if (!record) {
      record = {
        poolAddress,
        ammProgramId,
        state: "discovered",
        activity: null,
        reserves: null,
        metadata: null,
        preFilter: null,
        score: null,
        anchorPda: PublicKey.default,
        certPda: PublicKey.default,
        launchPricePda: PublicKey.default,
        firstEligibleEpoch: null,
        anchorWrittenAt: null,
        anchorInvalidated: false,
        certExpiresAt: null,
        submitAttempts: 0,
        lastError: null,
        signatures: { launchPrice: null, phase1: null },
        updatedAtMs: Date.now(),
        history: [],
      };
      this.records.set(key, record);
    }
    return record;
  }

  get(poolAddress: PublicKey): TrackedCandidate | undefined {
    return this.records.get(poolAddress.toBase58());
  }

  /** Move a pool to a new lifecycle state (history is appended). */
  transition(poolAddress: PublicKey, nextState: CandidateLifecycleState, note?: string): TrackedCandidate | undefined {
    const record = this.records.get(poolAddress.toBase58());
    if (!record) return undefined;
    record.state = nextState;
    record.updatedAtMs = Date.now();
    record.history.push({ state: nextState, tsMs: record.updatedAtMs, note: note ?? null });
    return record;
  }

  /** Attach a note without changing state. */
  note(poolAddress: PublicKey, note: string): void {
    const record = this.records.get(poolAddress.toBase58());
    if (!record) return;
    record.lastError = note;
    record.updatedAtMs = Date.now();
  }

  /** All tracked records (insertion order). */
  all(): TrackedCandidate[] {
    return [...this.records.values()];
  }

  /** Pools currently in an opportunity state, as `ScoutOpportunity` values. */
  opportunities(nowMs?: number): ScoutOpportunity[] {
    const out: ScoutOpportunity[] = [];
    for (const record of this.records.values()) {
      if (record.state === "certification-ready" || record.state === "certified") {
        out.push({
          poolAddress: record.poolAddress,
          ammProgramId: record.ammProgramId,
          kind: record.state === "certification-ready" ? "certification-ready" : "salvageable",
          firstEligibleEpoch: record.firstEligibleEpoch ?? 0n,
          certExpiresAt: record.certExpiresAt,
          score: record.score,
          detectedAtMs: nowMs ?? Date.now(),
        });
      }
    }
    return out;
  }

  /** Number of tracked pools. */
  size(): number {
    return this.records.size;
  }
}
