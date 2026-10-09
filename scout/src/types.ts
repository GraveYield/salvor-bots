// SPDX-License-Identifier: Apache-2.0
//
// Scout Salvor — shared types (Phase 10).
//
// The Scout is the FIRST salvor bot in the five-bot architecture:
//
//   Scout ── candidate queue ──→ Conservative / Experimental / Sniper
//                                    ↓ shared execution policy
//                                 GraveYield SDK
//                                    ↓
//                                 GraveScanner → GraveVault → settlement
//
//   Monitor / Risk observes the entire pipeline.
//
// The Scout's boundary (owner's Phase 10 direction): discovery and
// monitoring only. It requests on-chain evaluation (GraveScanner Phase 1)
// and watches anchors/certificates progress through the lifecycle, but it
// NEVER salvages, NEVER certifies (Phase 2), and NEVER independently
// declares a pool abandoned — the on-chain GraveScanner is the only
// authority on eligibility.

import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";

import type { ActivityRecord, ReserveRecord, TokenMetadata } from "./enrich.js";
import type { PreFilterResult } from "./eligibility.js";

/**
 * Lifecycle states a tracked pool walks through inside the Scout.
 *
 * Terminal / blocking states: `filtered-out`, `evaluated-ineligible`,
 * `launch-price-blocked`, `anchor-stale`.
 * Opportunity states (reported to the next execution component):
 * `certification-ready`, `certified`.
 */
export type CandidateLifecycleState =
  /** Enumerated by a discovery source this cycle. */
  | "discovered"
  /** Failed the cheap off-chain pre-filter (recorded with the failed criteria). */
  | "filtered-out"
  /** Passed the pre-filter, scored, and enqueued. */
  | "queued"
  /** SDK read-only double-check found hard-failing criteria — never submitted. */
  | "evaluated-ineligible"
  /** SDK double-check admissible, on-chain not yet contacted (dry-run or budget). */
  | "evaluated-eligible"
  /** The pool's LaunchPrice PDA was missing and the Scout recorded it (C2 oracle tx). */
  | "launch-price-recorded"
  /** LaunchPrice PDA missing and no launch-price oracle key configured — cannot proceed. */
  | "launch-price-blocked"
  /** `evaluate_pool_phase_1` transaction submitted and confirmed. */
  | "phase1-submitted"
  /** Submission attempt failed (retryable while attempts < max). */
  | "submission-failed"
  /** EligibilityAnchor PDA read back on chain. */
  | "anchor-confirmed"
  /** Anchor exists but the ≥2-epoch confirmation gap has not elapsed. */
  | "waiting-epochs"
  /** ≥2 epochs elapsed since `first_eligible_epoch`, no cert yet — an executor bot should certify + salvage. */
  | "certification-ready"
  /** EligibilityCert PDA exists and is inside its TTL — the salvage window is open. */
  | "certified"
  /** Cert existed but is past `expires_at` (executor may re-certify). */
  | "cert-expired"
  /** Multisig invalidated the anchor before certification. */
  | "anchor-invalidated"
  /** Anchor aged past `anchor_staleness_seconds` without a cert (sweepable on chain). */
  | "anchor-stale";

/** One tracked pool's full Scout state. */
export interface TrackedCandidate {
  poolAddress: PublicKey;
  ammProgramId: PublicKey;
  state: CandidateLifecycleState;
  /** Discovery-side data (set when the pool passed discovery enrichment). */
  activity: ActivityRecord | null;
  reserves: ReserveRecord | null;
  metadata: TokenMetadata | null;
  preFilter: PreFilterResult | null;
  /** Candidate score (higher = submit first). Set when queued. */
  score: number | null;
  /** Canonical PDAs (derived once, reused everywhere). */
  anchorPda: PublicKey;
  certPda: PublicKey;
  launchPricePda: PublicKey;
  /** Anchor fields once read back on chain. */
  firstEligibleEpoch: bigint | null;
  anchorWrittenAt: bigint | null;
  anchorInvalidated: boolean;
  /** Cert field once read back on chain. */
  certExpiresAt: bigint | null;
  /** Submission bookkeeping. */
  submitAttempts: number;
  lastError: string | null;
  signatures: {
    launchPrice: string | null;
    phase1: string | null;
  };
  updatedAtMs: number;
  /** State-transition history (append-only, in-memory). */
  history: Array<{ state: CandidateLifecycleState; tsMs: number; note: string | null }>;
}

/** Scout event types emitted through every configured `ReportSink`. */
export type ScoutEventType =
  | "cycle-start"
  | "cycle-end"
  | "discovered"
  | "filtered-out"
  | "candidate"
  | "evaluated"
  | "launch-price-recorded"
  | "launch-price-blocked"
  | "phase1-submitted"
  | "phase1-failed"
  | "anchor-confirmed"
  | "waiting-epochs"
  | "opportunity:certification-ready"
  | "opportunity:salvageable"
  | "cert-expired"
  | "anchor-stale"
  | "info"
  | "error";

/** A structured Scout event — the wire format of every report sink. */
export interface ScoutEvent {
  /** Unix epoch milliseconds. */
  tsMs: number;
  type: ScoutEventType;
  /** Base58 pool address when the event is pool-scoped. */
  pool?: string;
  /** Free-form structured payload (score, failed criteria, signatures…). */
  data?: Record<string, unknown>;
}

/** Summary of one `ScoutSalvor.runOnce()` cycle. */
export interface ScoutCycleResult {
  startedAtMs: number;
  durationMs: number;
  discoveredCount: number;
  /** Pools that passed the cheap pre-filter this cycle. */
  candidateCount: number;
  /** SDK read-only double-checks performed this cycle. */
  evaluatedCount: number;
  launchPricesRecorded: number;
  phase1Submitted: number;
  phase1Failed: number;
  /** Pools currently in an opportunity state after the cycle. */
  opportunities: number;
  /** True when the cycle ran without submitting anything (dry-run or missing keys). */
  dryRun: boolean;
}

/**
 * A pool the Scout reports to the next execution component (the
 * Conservative / Experimental / Sniper bots). Opportunities are the
 * Scout's OUTPUT — the executor decides what, whether, and when to
 * salvage; the Scout conveys no salvage authority.
 */
export interface ScoutOpportunity {
  poolAddress: PublicKey;
  ammProgramId: PublicKey;
  kind: "certification-ready" | "salvageable";
  /** Anchor epoch the ≥2-epoch confirmation counts from. */
  firstEligibleEpoch: bigint;
  /** Cert expiry (unix seconds) for `salvageable` opportunities. */
  certExpiresAt: bigint | null;
  /** The Scout's last recorded score for the pool (advisory only). */
  score: number | null;
  detectedAtMs: number;
}

/** Queue-entry type: a scored candidate flowing toward submission. */
export interface ScoutScoredCandidate {
  candidate: ScoutCandidate;
  score: number;
  scoreBreakdown: {
    inactivityMargin: number;
    tvlMargin: number;
    priceCollapseMargin: number;
  };
}

/** A pool that passed the cheap pre-filter (the Scout's candidate shape). */
export interface ScoutCandidate {
  poolAddress: PublicKey;
  ammProgramId: PublicKey;
  activity: ActivityRecord;
  reserves: ReserveRecord;
  metadata: TokenMetadata;
  preFilter: PreFilterResult;
}

/** Priority-fee / compute-budget settings for Scout-submitted transactions. */
export interface FeeSettings {
  /** compute_unit_price in the SDK's canonical units (must be ≤ Charter ceiling). */
  feeLamportsPerCu: BN;
  /** Optional explicit compute-unit limit (default: leave the runtime default). */
  computeUnitLimit?: number;
}

/** An Ed25519 signing identity for oracle attestations. */
export interface OracleIdentity {
  /** 64-byte tweetnacl-compatible secret key. */
  secretKey64: Uint8Array;
  /** The matching public key. */
  publicKey: PublicKey;
}
