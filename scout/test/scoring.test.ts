// SPDX-License-Identifier: Apache-2.0
//
// Scoring tests — margin product ordering (ported from the Phase 9
// indexer's scoring.test.ts).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { scoreCandidate } from "../src/index.js";
import type { ScoutCandidate } from "../src/index.js";
import type { ActivityRecord, ReserveRecord, TokenMetadata } from "../src/index.js";

const SPEC = {
  inactivitySeconds: 7_776_000n,
  minTvlLamports: 500_000_000n,
  priceCollapseBps: 9_900,
};

const POOL = new PublicKey(new Uint8Array(32).fill(2));

function candidate(overrides?: {
  activity?: Partial<ActivityRecord>;
  reserves?: Partial<ReserveRecord>;
}): ScoutCandidate {
  const activity: ActivityRecord = {
    poolAddress: POOL,
    lastSwapUnixTs: Math.floor(Date.now() / 1000) - 200 * 86_400, // 200 d stale → margin ≈ 2
    lastSwapSlot: 1,
    lastSwapSignature: "sig",
    noSwapFound: false,
    ...overrides?.activity,
  };
  const reserves: ReserveRecord = {
    poolAddress: POOL,
    coinReserve: 10_000_000_000n,
    pcReserve: 100_000_000n, // quote-per-base ≈ 0.01 → ~9900 bps drop vs nominal 1.0
    lpSupply: 10_000_000n,
    wsolSideIdentified: true,
    tvlLamports: 1_000_000_000n, // margin 2.0
    ...overrides?.reserves,
  };
  const metadata: TokenMetadata = {
    poolAddress: POOL,
    baseMint: PublicKey.default,
    baseDecimals: 9,
    baseSupply: 1n,
    quoteMint: PublicKey.default,
    quoteDecimals: 9,
    quoteSupply: 1n,
    lpMint: PublicKey.default,
    lpDecimals: 6,
    lpSupply: 1n,
  };
  return {
    poolAddress: POOL,
    ammProgramId: PublicKey.default,
    activity,
    reserves,
    metadata,
    preFilter: { poolAddress: POOL, passed: true, failedCriteria: [], criteriaBitmap: 0x3f },
  };
}

describe("scoreCandidate", () => {
  test("higher margins give a higher score", () => {
    const s1 = scoreCandidate(candidate(), SPEC).score;
    const s2 = scoreCandidate(
      candidate({ reserves: { tvlLamports: 4_000_000_000n } }),
      SPEC,
    ).score;
    assert.ok(s2 > s1, `tvl x4 must score higher: ${s2} > ${s1}`);
  });

  test("the 10x no-swap heuristic feeds the inactivity margin", () => {
    const withSwap = scoreCandidate(candidate(), SPEC).scoreBreakdown.inactivityMargin;
    const noSwap = scoreCandidate(
      candidate({ activity: { noSwapFound: true, lastSwapUnixTs: 0 } }),
      SPEC,
    ).scoreBreakdown.inactivityMargin;
    assert.equal(noSwap, 10);
    assert.ok(withSwap > 1);
    assert.ok(withSwap < 10);
  });

  test("a collapsed-looking pool scores above 1 on the C2 proxy", () => {
    const breakdown = scoreCandidate(
      candidate({ reserves: { coinReserve: 10_000_000_000n, pcReserve: 100_000_000n } }),
      SPEC,
    ).scoreBreakdown;
    // quote-per-base ≈ 0.01 → ~9900 bps drop vs nominal 1.0 → margin ≈ 1.0
    assert.ok(breakdown.priceCollapseMargin > 0.99, String(breakdown.priceCollapseMargin));
    assert.ok(breakdown.priceCollapseMargin <= 1.02, String(breakdown.priceCollapseMargin));
  });

  test("zero reserves zero out the C2 proxy margin", () => {
    const breakdown = scoreCandidate(
      candidate({ reserves: { coinReserve: 0n, pcReserve: 0n } }),
      SPEC,
    ).scoreBreakdown;
    assert.equal(breakdown.priceCollapseMargin, 0);
    assert.equal(scoreCandidate(candidate({ reserves: { coinReserve: 0n, pcReserve: 0n } }), SPEC).score, 0);
  });

  test("score is the product of the three margins", () => {
    const b = scoreCandidate(candidate(), SPEC).scoreBreakdown;
    const s = scoreCandidate(candidate(), SPEC).score;
    assert.ok(Math.abs(s - b.inactivityMargin * b.tvlMargin * b.priceCollapseMargin) < 1e-9);
  });
});
