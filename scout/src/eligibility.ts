// SPDX-License-Identifier: Apache-2.0
//
// Off-chain pre-filter for the six derelict-pool criteria — the Scout's
// wide funnel (stage 5). Ported from the Phase 9 indexer
// (`indexer/src/eligibility.ts`).
//
// The pre-filter is NOT the eligibility decision. The on-chain
// GraveScanner is the only authority — the Scout never declares a pool
// abandoned; it only decides which pools are worth surfacing to the
// scanner (and, in submission mode, worth a phase1 transaction).
//
//   C1: inactivity ≥ threshold (default 90 d)
//   C2: WSOL side identified — a rough proxy; the authoritative C2 uses
//       the recorded LaunchPrice PDA (recorded by the Scout when it holds
//       the launch-price oracle key)
//   C3: TVL ≥ threshold (default 0.5 SOL)
//   C4: LP not burned (supply > dust threshold)
//   C5: no LP locked — surfaced as a flag only (LOCKER-002); the on-chain
//       adapter is authoritative and the scanner enforces 6020/6021
//   C6: multi-epoch confirmed — only checkable once a Phase 1 anchor
//       exists, so the pre-filter assumes it passes for new candidates

import type { ActivityRecord, ReserveRecord, TokenMetadata } from "./enrich.js";

/** Per-criterion bitmap — mirrors the on-chain `criteria.rs` constants. */
export const CRITERION_INACTIVITY = 0x01;
export const CRITERION_PRICE_COLLAPSE = 0x02;
export const CRITERION_MIN_TVL = 0x04;
export const CRITERION_LP_NOT_BURNED = 0x08;
export const CRITERION_NO_LOCK = 0x10;
export const CRITERION_EPOCH_CONFIRMED = 0x20;
export const ALL_CRITERIA_MASK = 0x3f;

/** Cheap pre-filter thresholds. */
export interface PreFilterThresholds {
  inactivitySeconds: bigint;
  priceCollapseBps: number;
  minTvlLamports: bigint;
  lpBurnDustThreshold: bigint;
}

/** Per-criterion pre-filter result. Cheap and non-authoritative. */
export interface PreFilterResult {
  poolAddress: import("@solana/web3.js").PublicKey;
  passed: boolean;
  failedCriteria: string[];
  /** The six-criterion bitmap (0x3F = all pass). Mirrors the on-chain bitmap. */
  criteriaBitmap: number;
}

/**
 * Evaluate the six criteria against indexed pool data.
 * `_metadata` is currently unused (the C2 proxy is reserve-based) but is
 * part of the signature so token-level filters can land without a breaking
 * change — the same convention the Phase 9 indexer shipped.
 */
export function preFilterPool(
  activity: ActivityRecord,
  reserves: ReserveRecord,
  _metadata: TokenMetadata,
  thresholds: PreFilterThresholds,
): PreFilterResult {
  const poolAddress = activity.poolAddress;
  let bitmap = 0;
  const failed: string[] = [];

  // C1 — inactivity. `noSwapFound` means the history scan found no swap
  // at all: treat the pool as very old (the scan window itself is evidence
  // of inactivity), but note the Scout refuses to ATTEST such pools (the
  // C1 attestation needs a real last-swap timestamp — see evaluate.ts).
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = activity.noSwapFound
    ? thresholds.inactivitySeconds * 10n
    : now - BigInt(activity.lastSwapUnixTs);
  if (elapsed >= thresholds.inactivitySeconds) {
    bitmap |= CRITERION_INACTIVITY;
  } else {
    failed.push("C1-inactivity");
  }

  // C2 — price collapse proxy. The pre-filter has no recorded LaunchPrice
  // PDA; a pool with a WSOL side passes the proxy and the on-chain scanner
  // makes the authoritative call at phase time.
  if (reserves.wsolSideIdentified) {
    bitmap |= CRITERION_PRICE_COLLAPSE;
  } else {
    failed.push("C2-price-collapse");
  }

  // C3 — min TVL.
  if (reserves.tvlLamports >= thresholds.minTvlLamports) {
    bitmap |= CRITERION_MIN_TVL;
  } else {
    failed.push("C3-min-tvl");
  }

  // C4 — LP not burned.
  if (reserves.lpSupply > thresholds.lpBurnDustThreshold) {
    bitmap |= CRITERION_LP_NOT_BURNED;
  } else {
    failed.push("C4-lp-not-burned");
  }

  // C5 — no lock (flag-only in v1; LOCKER-002 tracks full evidence).
  bitmap |= CRITERION_NO_LOCK;

  // C6 — multi-epoch confirmed (assumed for new candidates).
  bitmap |= CRITERION_EPOCH_CONFIRMED;

  return {
    poolAddress,
    passed: bitmap === ALL_CRITERIA_MASK,
    failedCriteria: failed,
    criteriaBitmap: bitmap,
  };
}
