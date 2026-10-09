// SPDX-License-Identifier: Apache-2.0
//
// Candidate scoring — the Scout's pipeline stage 6. Ported from the
// Phase 9 indexer (`indexer/src/scoring.ts`).
//
// The score is NOT the eligibility decision; it only prioritizes which
// candidates the Scout evaluates and submits first (the per-cycle budget
// is `maxCandidatesPerCycle`).
//
//   score = inactivityMargin * tvlMargin * priceCollapseMargin
//
//   inactivityMargin    = elapsedSeconds / inactivityThreshold
//   tvlMargin           = tvlLamports / minTvlLamports
//   priceCollapseMargin = dropBps / priceCollapseBps   (proxy-based in v1)
//
// The product rewards pools exceeding ALL quantitative thresholds by the
// widest combined margin — those are the most likely to stay eligible
// through the multi-epoch confirmation gap and to carry meaningful
// salvage proceeds. C4/C5/C6 are binary gates and affect admission only.

import type { ScoutCandidate, ScoutScoredCandidate } from "./types.js";

/** Thresholds for the margin computation. */
export interface ScoringThresholds {
  inactivitySeconds: bigint;
  minTvlLamports: bigint;
  priceCollapseBps: number;
}

/** Compute the Q64.64 price-drop in bps from launch price to current price. */
function computeDropBps(launchQ64x64: bigint, currentQ64x64: bigint): number {
  if (launchQ64x64 <= 0n) return 0;
  if (currentQ64x64 >= launchQ64x64) return 0;
  const delta = launchQ64x64 - currentQ64x64;
  const dropBps = Number((delta * 10_000n) / launchQ64x64);
  return Math.min(dropBps, 10_000);
}

/** Compute the current pool price as quote-per-base in Q64.64. */
function quotePerBaseQ64x64(baseReserve: bigint, quoteReserve: bigint): bigint {
  if (baseReserve <= 0n) return 0n;
  return (quoteReserve << 64n) / baseReserve;
}

/**
 * Score a pre-filtered candidate. Returns the score plus the
 * per-criterion margin breakdown for observability.
 */
export function scoreCandidate(
  candidate: ScoutCandidate,
  thresholds: ScoringThresholds,
): ScoutScoredCandidate {
  // C1 inactivity margin.
  const elapsedSeconds: bigint = candidate.activity.noSwapFound
    ? thresholds.inactivitySeconds * 10n
    : BigInt(Math.floor(Date.now() / 1000)) - BigInt(candidate.activity.lastSwapUnixTs);
  const inactivityMargin = Number(elapsedSeconds) / Number(thresholds.inactivitySeconds);

  // C3 TVL margin.
  const tvlMargin = Number(candidate.reserves.tvlLamports) / Number(thresholds.minTvlLamports);

  // C2 price-collapse margin — reserve-ratio proxy (the real C2 needs the
  // recorded LaunchPrice PDA; a high base/quote ratio suggests collapse).
  let priceCollapseMargin: number;
  const baseReserve = candidate.reserves.coinReserve;
  const quoteReserve = candidate.reserves.pcReserve;
  if (baseReserve > 0n && quoteReserve > 0n) {
    const currentPrice = quotePerBaseQ64x64(baseReserve, quoteReserve);
    const nominalLaunch = 1n << 64n; // assume launch price 1.0 for the proxy
    const dropBps = computeDropBps(nominalLaunch, currentPrice);
    priceCollapseMargin = dropBps / thresholds.priceCollapseBps;
  } else {
    priceCollapseMargin = 0;
  }

  const score = inactivityMargin * tvlMargin * priceCollapseMargin;

  return {
    candidate,
    score,
    scoreBreakdown: { inactivityMargin, tvlMargin, priceCollapseMargin },
  };
}
