// SPDX-License-Identifier: Apache-2.0
//
// The shared execution-policy interface (FLEET-M1).
//
// Conservative / Sniper / Experimental each supply a policy; the shared
// pipeline enforces the GLOBAL invariants no strategy can override:
// on-chain eligibility + certificate checks, freshness revalidation,
// the Charter fee ceiling via the D3 fee plan, verified transaction
// construction, simulation before submission, snapshot completeness,
// idempotency, and lease coordination. Strategy knobs only ever TIGHTEN.

import { derivePriorityFeePlan, type PriorityFeePlan } from "@graveyield/sdk";
import type BN from "bn.js";
import type { FleetCluster } from "./envelope.js";

/** Execution mode — the ladder from observation to real money. */
export type ExecutionMode =
  /** Prepare only. No simulation, no submission, no network writes. */
  | "dry-run"
  /** Prepare + simulate. Still never submits. */
  | "simulation"
  /** Prepare + simulate + submit + confirm. Requires explicit enablement. */
  | "live";

/**
 * Which opportunities this strategy will act on. Both kinds are legal;
 * strategies may narrow.
 */
export type OpportunityFilter = {
  kinds: ReadonlyArray<"certification-ready" | "salvageable">;
};

/** Strategy-specific tunables. All integer money fields are bigint. */
export interface StrategyTunables {
  /** Minimum acceptable net profit (lamports) — below this, reject. */
  minNetProfitLamports: bigint;
  /** Share of expected profit spendable on priority fees (D3 margin). */
  feeMarginRatio: number;
  /** Compute-unit limit declared for the salvage-family transactions. */
  computeUnitLimit: number;
  /**
   * Per-tx slippage override in bps. OPTIONAL; must be ≤ the live
   * config max at use time (the pipeline enforces — a strategy can
   * tighten the protocol ceiling, never widen it).
   */
  slippageBpsOverride?: number | null;
  /** Maximum submission attempts per opportunity. */
  maxSubmitAttempts: number;
  /** Lease TTL (ms) while preparing/submitting. */
  leaseTtlMs: number;
  /** Quote freshness window (ms) — older quotes are re-fetched. */
  quoteMaxAgeMs: number;
  /**
   * Re-check window (ms): the minimum remaining cert TTL to attempt a
   * salvage-only path (protects against landing after expiry).
   */
  minCertRemainingMs: number;
  /** Maximum opportunity age (ms) since the source detected it. */
  maxOpportunityAgeMs: number;
  /** Expected cost of failed attempts (lamports) fed to the estimator. */
  expectedFailureCostLamports?: bigint;
  /** Fronted rent the salvor does not recover (lamports). */
  frontedRentLamports?: bigint;
}

/** The full execution policy a bot runs under. */
export interface ExecutionPolicy extends StrategyTunables {
  /** Bot identity for events, leases, and records. */
  botId: string;
  /** Target cluster. */
  cluster: FleetCluster;
  /** Dry-run by default; `live` requires operator enablement. */
  mode: ExecutionMode;
  /** Which opportunity kinds this strategy accepts. */
  accepts: OpportunityFilter;
  /** Retry backoff base (ms) for retryable failures. */
  retryBackoffMs: number;
}

/** Explicit enablement for live mode — without it, `live` is rejected. */
export interface LiveEnablement {
  /** The operator's explicit acknowledgement (must be true). */
  enabled: boolean;
  /** Free-form operator trace (who/when/why). */
  acknowledgedBy: string;
}

/** Validate + normalize a policy; throws on any global-invariant breach. */
export function validatePolicy(
  policy: ExecutionPolicy,
  live: LiveEnablement | null,
): ExecutionPolicy {
  if (!policy.botId || policy.botId.trim().length === 0) {
    throw new Error("policy: botId is required");
  }
  if (policy.mode === "live" && live?.enabled !== true) {
    throw new Error(
      "policy: mode 'live' requires explicit operator enablement (LiveEnablement.enabled = true) — refusing to default to live execution",
    );
  }
  if (!Number.isInteger(policy.computeUnitLimit) || policy.computeUnitLimit <= 0) {
    throw new Error("policy: computeUnitLimit must be a positive integer");
  }
  if (policy.feeMarginRatio < 0 || policy.feeMarginRatio > 1) {
    throw new Error("policy: feeMarginRatio must be in [0, 1]");
  }
  if (policy.minNetProfitLamports < 0n) {
    throw new Error("policy: minNetProfitLamports must be non-negative");
  }
  if (policy.maxSubmitAttempts < 1) {
    throw new Error("policy: maxSubmitAttempts must be ≥ 1");
  }
  if (policy.leaseTtlMs < 1_000) {
    throw new Error("policy: leaseTtlMs must be ≥ 1000 (clock-skew floor)");
  }
  if (policy.quoteMaxAgeMs < 0 || policy.minCertRemainingMs < 0 || policy.maxOpportunityAgeMs < 0) {
    throw new Error("policy: time windows must be non-negative");
  }
  if (
    policy.slippageBpsOverride !== undefined &&
    policy.slippageBpsOverride !== null &&
    (!Number.isInteger(policy.slippageBpsOverride) || policy.slippageBpsOverride < 0 || policy.slippageBpsOverride > 10_000)
  ) {
    throw new Error("policy: slippageBpsOverride must be an integer in [0, 10_000]");
  }
  if (policy.accepts.kinds.length === 0) {
    throw new Error("policy: accepts.kinds must list at least one opportunity kind");
  }
  return policy;
}

/**
 * Derive this policy's D3 fee plan for one operation. Pure wrapper over
 * the SDK's `derivePriorityFeePlan` (FLEET-M0 F1) — the ONLY fee path
 * executors may use. The returned plan's `maxMicroLamportsPerCu` is the
 * hard ceiling for any fee the pipeline attaches; `charterGuard` runs
 * again at submission time as belt-and-braces.
 */
export function planFees(opts: {
  policy: ExecutionPolicy;
  expectedProfitLamports: BN;
  protocolCeilingMicroLamportsPerCu: BN;
}): PriorityFeePlan {
  return derivePriorityFeePlan({
    expectedProfitLamports: opts.expectedProfitLamports,
    computeUnitLimit: opts.policy.computeUnitLimit,
    protocolCeilingMicroLamportsPerCu: opts.protocolCeilingMicroLamportsPerCu,
    marginRatio: opts.policy.feeMarginRatio,
  });
}

/** Shared defaults for executors — strategies override via spread. */
export const DEFAULT_TUNABLES: Omit<StrategyTunables, "minNetProfitLamports"> = {
  feeMarginRatio: 0.25,
  computeUnitLimit: 1_400_000,
  slippageBpsOverride: null, // use the live config max (300 bps default)
  maxSubmitAttempts: 3,
  leaseTtlMs: 120_000,
  quoteMaxAgeMs: 15_000,
  minCertRemainingMs: 120_000,
  maxOpportunityAgeMs: 6 * 3_600_000,
  frontedRentLamports: 1_000_000n,
};
