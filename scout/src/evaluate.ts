// SPDX-License-Identifier: Apache-2.0
//
// SDK read-only double-check + admission policy (the Scout's gate before
// any on-chain contact).
//
// `GraveYieldClient.evaluatePool()` walks all six criteria against live
// chain state. Its raw verdict is NOT directly usable as a pre-phase1
// gate, because two criteria are expected to "fail" for fresh candidates:
//
//   * C2 — without a recorded LaunchPrice PDA the SDK cannot compare
//     prices and reports C2 as failed. That is exactly the state the
//     Scout fixes (record_launch_price) before requesting phase 1.
//     If the launch price IS recorded and C2 still fails, the pool
//     genuinely has not collapsed against its on-chain baseline and the
//     Scout must not waste a submission (the scanner would revert).
//
//   * C6 — the ≥2-epoch confirmation can only pass once a Phase 1 anchor
//     exists. For fresh candidates C6 failure is the normal pre-phase1
//     state; phase 1 is precisely the step that starts that clock.
//
// Hard failures (never submitted): C1 (pool still active — and the Scout
// refuses to attest a fabricated timestamp), C3 (TVL below floor), C4
// (LP burned), C5 (LOCKER-002 flag), plus the no-attestable-last-swap
// guard: ORACLE-002 attestations must carry a REAL last-swap timestamp —
// a pool whose history scan found no swap cannot be attested honestly,
// so the Scout fails closed instead of minting evidence.

import type { EvaluatePoolOutcome } from "@graveyield/sdk";

/** Everything needed to classify one candidate. */
export interface EvaluationCheck {
  outcome: EvaluatePoolOutcome;
  /** LaunchPrice PDA exists on chain. */
  launchPriceRecorded: boolean;
  /** EligibilityAnchor PDA exists on chain. */
  anchorExists: boolean;
  /** EligibilityCert PDA exists on chain. */
  certExists: boolean;
}

/** The Scout's admission verdict for a candidate. */
export interface EvaluationVerdict {
  /** Proceed toward phase 1 (recording the launch price first if needed). */
  admissible: boolean;
  /** On-chain evaluation state already exists — monitor, do not submit. */
  monitorOnly: boolean;
  /** Criteria whose failure blocks submission outright. */
  hardFailures: string[];
  /** Expected pre-phase1 failures (C2-without-record, C6-without-anchor). */
  softFailures: string[];
  /** The pool has an attestable (nonzero, scan-found) last swap. */
  attestableLastSwap: boolean;
  /** Human-readable reason when not admissible. */
  reason: string | null;
}

const HARD_FAIL_CRITERIA = new Set([
  "C1-inactivity",
  "C3-min-tvl",
  "C4-lp-not-burned",
  "C5-no-lock",
]);

const SOFT_FAIL_CRITERIA = new Set(["C2-price-collapse", "C6-epoch-confirmed"]);

/**
 * Classify an SDK evaluation into the Scout's admission verdict.
 *
 * @param check the SDK outcome plus the three on-chain existence flags
 * @param attestableLastSwap true when the activity record carries a real
 *        (scan-found, nonzero) last-swap timestamp usable in a C1
 *        attestation
 */
export function classifyEvaluation(
  check: EvaluationCheck,
  attestableLastSwap: boolean,
): EvaluationVerdict {
  const hardFailures: string[] = [];
  const softFailures: string[] = [];

  for (const failed of check.outcome.failedCriteria) {
    if (HARD_FAIL_CRITERIA.has(failed)) {
      hardFailures.push(failed);
    } else if (SOFT_FAIL_CRITERIA.has(failed)) {
      if (failed === "C2-price-collapse") {
        // A recorded baseline that has not collapsed is authoritative.
        if (check.launchPriceRecorded) {
          hardFailures.push("C2-price-collapse-recorded-baseline");
        } else {
          softFailures.push(failed);
        }
      } else {
        softFailures.push(failed);
      }
    }
    // Unknown criterion names (future spec additions) are ignored here —
    // the on-chain scanner remains the authority for anything the SDK
    // does not yet classify.
  }

  if (!attestableLastSwap) {
    hardFailures.push("no-attestable-last-swap");
  }

  const monitorOnly =
    hardFailures.length === 0 && (check.anchorExists || check.certExists);

  let reason: string | null = null;
  if (hardFailures.length > 0) {
    reason = `hard-failed: ${hardFailures.join(", ")}`;
  } else if (monitorOnly) {
    reason = check.certExists
      ? "cert already exists on chain — monitoring only"
      : "anchor already exists on chain — monitoring only";
  }

  return {
    admissible: hardFailures.length === 0 && !monitorOnly,
    monitorOnly,
    hardFailures,
    softFailures,
    attestableLastSwap,
    reason,
  };
}
