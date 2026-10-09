// SPDX-License-Identifier: Apache-2.0
//
// Pre-filter tests — the six-criterion bitmap funnel (ported from the
// Phase 9 indexer's preFilter.test.ts, adapted to the Scout's shapes).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  preFilterPool,
  ALL_CRITERIA_MASK,
  CRITERION_INACTIVITY,
  CRITERION_MIN_TVL,
  type PreFilterThresholds,
} from "../src/index.js";
import type { ActivityRecord, ReserveRecord, TokenMetadata } from "../src/index.js";

const POOL = new PublicKey(new Uint8Array(32).fill(1));

const SPEC: PreFilterThresholds = {
  inactivitySeconds: 7_776_000n,
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n,
  lpBurnDustThreshold: 1_000n,
};

function activity(overrides?: Partial<ActivityRecord>): ActivityRecord {
  return {
    poolAddress: POOL,
    lastSwapUnixTs: Math.floor(Date.now() / 1000) - 100 * 86_400,
    lastSwapSlot: 1,
    lastSwapSignature: "sig",
    noSwapFound: false,
    ...overrides,
  };
}

function reserves(overrides?: Partial<ReserveRecord>): ReserveRecord {
  return {
    poolAddress: POOL,
    coinReserve: 1_000_000n,
    pcReserve: 600_000_000n,
    lpSupply: 10_000_000n,
    wsolSideIdentified: true,
    tvlLamports: 600_000_000n,
    ...overrides,
  };
}

function metadata(): TokenMetadata {
  return {
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
}

describe("preFilterPool", () => {
  test("a stale, funded pool with a WSOL side passes all six", () => {
    const result = preFilterPool(activity(), reserves(), metadata(), SPEC);
    assert.equal(result.passed, true);
    assert.equal(result.criteriaBitmap, ALL_CRITERIA_MASK);
    assert.deepEqual(result.failedCriteria, []);
  });

  test("C1 fails for a recently active pool", () => {
    const result = preFilterPool(
      activity({ lastSwapUnixTs: Math.floor(Date.now() / 1000) - 3_600 }),
      reserves(),
      metadata(),
      SPEC,
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCriteria, ["C1-inactivity"]);
    assert.equal(result.criteriaBitmap & CRITERION_INACTIVITY, 0);
  });

  test("C1 passes with a 10x heuristic when no swap was found at all", () => {
    const result = preFilterPool(activity({ noSwapFound: true, lastSwapUnixTs: 0 }), reserves(), metadata(), SPEC);
    assert.equal(result.passed, true);
  });

  test("C3 fails below the TVL floor", () => {
    const result = preFilterPool(
      activity(),
      reserves({ tvlLamports: 400_000_000n }),
      metadata(),
      SPEC,
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCriteria, ["C3-min-tvl"]);
    assert.equal(result.criteriaBitmap & CRITERION_MIN_TVL, 0);
  });

  test("C4 fails when LP supply is burned to dust", () => {
    const result = preFilterPool(
      activity(),
      reserves({ lpSupply: 500n }),
      metadata(),
      SPEC,
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCriteria, ["C4-lp-not-burned"]);
  });

  test("C2 proxy fails without an identified WSOL side (7019 guard)", () => {
    const result = preFilterPool(
      activity(),
      reserves({ wsolSideIdentified: false, tvlLamports: 0n }),
      metadata(),
      SPEC,
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCriteria, ["C2-price-collapse", "C3-min-tvl"]);
  });

  test("multiple failures are collected in order", () => {
    const result = preFilterPool(
      activity({ lastSwapUnixTs: Math.floor(Date.now() / 1000) - 60 }),
      reserves({ lpSupply: 0n, tvlLamports: 0n, wsolSideIdentified: false }),
      metadata(),
      SPEC,
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCriteria, [
      "C1-inactivity",
      "C2-price-collapse",
      "C3-min-tvl",
      "C4-lp-not-burned",
    ]);
  });
});
