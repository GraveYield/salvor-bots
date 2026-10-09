// SPDX-License-Identifier: Apache-2.0
//
// Economic estimator unit tests (FLEET-M1) — exact integer semantics.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { estimateSalvageEconomics, memecoinSideOf, scaleByBpsFloor } from "../src/index.js";

// A healthy derelict fixture: 10M LP supply; salvor burns 1M (10%).
const POOL = {
  coinReserve: 1_000_000n, // memecoin, coin side
  pcReserve: 5_000_000_000n, // 5 WSOL, pc side
  lpSupply: 10_000_000n,
  coinMint: "MEME11111111111111111111111111111111111111",
  pcMint: "So11111111111111111111111111111111111111112",
  wsolMint: "So11111111111111111111111111111111111111112",
};
const ROUTE = { quoteInAmount: 1_000_000n, quoteOutLamports: 4_000_000_000n }; // 1 meme → 4 WSOL
const POSITION = { salvorLpAmount: 1_000_000n };
const CONFIG = { salvorShareBps: 4_000, maxSlippageBps: 300, jupiterDustThresholdLamports: 666_666n };
const COSTS_ZERO = { priorityFeeBudgetLamports: 0n, signatureCount: 1, frontedRentLamports: 0n, lamportsPerSignature: 0n };
const COSTS_BASE_FEE = { priorityFeeBudgetLamports: 0n, signatureCount: 1, frontedRentLamports: 0n }; // 1 × 5_000 lamports

describe("estimateSalvageEconomics", () => {
  test("proportional withdraw + route conversion + live 40% share (integer exact)", () => {
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: COSTS_ZERO,
      minNetProfitLamports: 0n,
    });
    assert.equal(est.status, "ok");
    // memecoin out = 10% of 1M = 100_000 base units.
    assert.equal(est.memecoinOut, 100_000n);
    // direct WSOL = 10% of 5 WSOL = 0.5 WSOL = 500_000_000 lamports.
    assert.equal(est.directWsolOut, 500_000_000n);
    // converted = (100_000 × 4_000_000_000) / 1_000_000 = 400_000_000 lamports.
    assert.equal(est.grossProceedsWsolLamports, 900_000_000n);
    // salvor share 40% = 360_000_000.
    assert.equal(est.salvorGrossShareLamports, 360_000_000n);
    assert.equal(est.netProfitLamports, 360_000_000n);
  });

  test("the default base fee (5_000 lamports per signature) is priced in", () => {
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: COSTS_BASE_FEE,
      minNetProfitLamports: 0n,
    });
    assert.equal(est.costs?.baseFees, 5_000n);
    assert.equal(est.netProfitLamports, 359_995_000n);
  });

  test("break-even gross and min-output floor are integer-exact", () => {
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: { priorityFeeBudgetLamports: 100_000n, signatureCount: 2, frontedRentLamports: 50_000n, lamportsPerSignature: 5_000n, expectedFailureCostLamports: 10_000n },
      minNetProfitLamports: 0n,
    });
    assert.equal(est.status, "ok");
    // costs = 100_000 + 2×5_000 + 50_000 + 10_000 = 170_000.
    assert.equal(est.costs?.total, 170_000n);
    // break-even gross = ceil(170_000 × 10_000 / 4_000) = 425_000.
    assert.equal(est.breakEvenGrossWsolLamports, 425_000n);
    // floor = 400_000_000 × (10000−300)/10000 = 388_000_000.
    assert.equal(est.minQuoteOutputLamports, 388_000_000n);
    assert.equal(est.effectiveSlippageBps, 300);
  });

  test("strategy slippage override TIGHTENS below the config max, never widens", () => {
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: COSTS_ZERO,
      slippageBpsOverride: 100, // tighter
      minNetProfitLamports: 0n,
    });
    assert.equal(est.effectiveSlippageBps, 100);
    assert.equal(est.minQuoteOutputLamports, 396_000_000n);

    const widened = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: COSTS_ZERO,
      slippageBpsOverride: 5_000, // attempts to widen past 300
      minNetProfitLamports: 0n,
    });
    assert.equal(widened.effectiveSlippageBps, 300, "override above the config max must clamp to the config max");
  });

  test("net below the configured minimum is flagged economic-insufficient (status still ok)", () => {
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: { priorityFeeBudgetLamports: 500_000_000n, signatureCount: 1, frontedRentLamports: 0n },
      minNetProfitLamports: 0n,
    });
    assert.equal(est.status, "ok");
    assert.equal(est.failureClass, "economic-insufficient");
  });

  test("dust: conversion below the dust threshold is excluded from proceeds and flagged", () => {
    const tinyRoute = { quoteInAmount: 1_000_000n, quoteOutLamports: 5_000_000n }; // 10% → 500_000 lamports < 666_666 dust
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: tinyRoute,
      position: POSITION,
      config: CONFIG,
      costs: COSTS_ZERO,
      minNetProfitLamports: 0n,
    });
    assert.equal(est.status, "ok");
    assert.equal(est.swapLegBelowDust, true);
    // Only the direct WSOL side counts: 500_000_000.
    assert.equal(est.grossProceedsWsolLamports, 500_000_000n);
    assert.equal(est.minQuoteOutputLamports, 0n, "no swap leg → no floor");
  });

  test("mirror orientation (WSOL on the coin side) computes symmetric economics", () => {
    const mirror = { ...POOL, coinMint: POOL.wsolMint, pcMint: POOL.coinMint, coinReserve: POOL.pcReserve, pcReserve: POOL.coinReserve };
    const est = estimateSalvageEconomics({
      pool: mirror,
      route: ROUTE,
      position: POSITION,
      config: CONFIG,
      costs: COSTS_ZERO,
      minNetProfitLamports: 0n,
    });
    assert.equal(est.status, "ok");
    assert.equal(est.grossProceedsWsolLamports, 900_000_000n, "the same reserves must price identically after mirroring");
  });

  test("rejects: no WSOL side, zero supply, zero LP, LP > supply, empty quote", () => {
    const badOrientation = { ...POOL, pcMint: "USDC11111111111111111111111111111111111111" };
    assert.equal(estimateSalvageEconomics({ pool: badOrientation, route: ROUTE, position: POSITION, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: 0n }).failureClass, "economic-unresolvable");
    assert.equal(estimateSalvageEconomics({ pool: { ...POOL, lpSupply: 0n }, route: ROUTE, position: POSITION, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: 0n }).failureClass, "economic-unresolvable");
    assert.equal(estimateSalvageEconomics({ pool: POOL, route: ROUTE, position: { salvorLpAmount: 0n }, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: 0n }).failureClass, "economic-unresolvable");
    assert.equal(estimateSalvageEconomics({ pool: POOL, route: ROUTE, position: { salvorLpAmount: 10_000_001n }, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: 0n }).failureClass, "economic-unresolvable");
    assert.equal(estimateSalvageEconomics({ pool: POOL, route: { quoteInAmount: 0n, quoteOutLamports: 0n }, position: POSITION, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: 0n }).failureClass, "route-failure");
  });

  test("validation: negative amounts and negative minimums throw RangeError", () => {
    assert.throws(
      () => estimateSalvageEconomics({ pool: { ...POOL, coinReserve: -1n }, route: ROUTE, position: POSITION, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: 0n }),
      RangeError,
    );
    assert.throws(
      () => estimateSalvageEconomics({ pool: POOL, route: ROUTE, position: POSITION, config: CONFIG, costs: COSTS_ZERO, minNetProfitLamports: -1n }),
      RangeError,
    );
  });

  test("zero salvor share is never salvageable (no keep, no work)", () => {
    const est = estimateSalvageEconomics({
      pool: POOL,
      route: ROUTE,
      position: POSITION,
      config: { ...CONFIG, salvorShareBps: 0 },
      costs: COSTS_ZERO,
      minNetProfitLamports: 0n,
    });
    assert.equal(est.status, "reject");
  });
});

describe("helpers", () => {
  test("scaleByBpsFloor is integer-floor", () => {
    assert.equal(scaleByBpsFloor(new BN(999), 50).toString(10), "4"); // 999 × 50/10_000 = 4.995 → 4
    assert.equal(scaleByBpsFloor(new BN(1_000_000), 10_000).toString(10), "1000000");
    assert.throws(() => scaleByBpsFloor(new BN(1), -1), RangeError);
  });

  test("memecoinSideOf derives orientation from the mints", () => {
    const side = memecoinSideOf(POOL);
    assert.equal(side.memecoinMint, POOL.coinMint);
    assert.equal(side.coinIsWsol, false);
    assert.throws(() => memecoinSideOf({ ...POOL, pcMint: "USDC11111111111111111111111111111111111111" }), /7019/);
  });
});
