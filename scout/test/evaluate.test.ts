// SPDX-License-Identifier: Apache-2.0
//
// Admission policy tests — the Scout's pre-phase1 gate semantics:
// hard failures block, expected pre-phase1 soft failures (C2 without a
// recorded baseline, C6 without an anchor) admit, on-chain state
// (anchor/cert) switches to monitor-only, and pools without an
// attestable last swap are refused (ORACLE-002 anti-fabrication).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { classifyEvaluation, type EvaluationCheck } from "../src/index.js";
import type { EvaluatePoolOutcome } from "@graveyield/sdk";

const POOL = new PublicKey(new Uint8Array(32).fill(9));

function outcome(overrides?: Partial<EvaluatePoolOutcome>): EvaluatePoolOutcome {
  return {
    poolAddress: POOL,
    ammProgramId: PublicKey.default,
    eligible: true,
    criteria: {
      c1Inactivity: true,
      c2PriceCollapse: true,
      c3MinTvl: true,
      c4LpNotBurned: true,
      c5NoLock: true,
      c6EpochConfirmed: true,
    },
    failedCriteria: [],
    anchorPda: PublicKey.default,
    certPda: PublicKey.default,
    launchPricePda: PublicKey.default,
    pool: {
      coinVault: PublicKey.default,
      pcVault: PublicKey.default,
      baseMint: PublicKey.default,
      quoteMint: PublicKey.default,
      lpMint: PublicKey.default,
      coinReserve: 0n,
      pcReserve: 0n,
      lpSupply: 0n,
    },
    uncxMarkerPresent: false,
    ...overrides,
  };
}

function check(overrides?: {
  outcome?: EvaluatePoolOutcome;
  launchPriceRecorded?: boolean;
  anchorExists?: boolean;
  certExists?: boolean;
}): EvaluationCheck {
  return {
    outcome: overrides?.outcome ?? outcome(),
    launchPriceRecorded: overrides?.launchPriceRecorded ?? false,
    anchorExists: overrides?.anchorExists ?? false,
    certExists: overrides?.certExists ?? false,
  };
}

describe("classifyEvaluation", () => {
  test("a fresh C1/C2-passing candidate without launch price or anchor is admissible", () => {
    // Fresh pool: no LaunchPrice PDA and no anchor ⇒ SDK reports C2+C6 failed.
    const c = check({
      outcome: outcome({ failedCriteria: ["C2-price-collapse", "C6-epoch-confirmed"] }),
      launchPriceRecorded: false,
      anchorExists: false,
    });
    const v = classifyEvaluation(c, true);
    assert.equal(v.admissible, true);
    assert.equal(v.monitorOnly, false);
    assert.deepEqual(v.hardFailures, []);
    assert.deepEqual(v.softFailures.sort(), ["C2-price-collapse", "C6-epoch-confirmed"]);
  });

  test("C1 failure blocks submission", () => {
    const v = classifyEvaluation(
      check({ outcome: outcome({ failedCriteria: ["C1-inactivity"] }) }),
      true,
    );
    assert.equal(v.admissible, false);
    assert.deepEqual(v.hardFailures, ["C1-inactivity"]);
  });

  test("C3/C4 failures block submission", () => {
    const v = classifyEvaluation(
      check({ outcome: outcome({ failedCriteria: ["C3-min-tvl", "C4-lp-not-burned"] }) }),
      true,
    );
    assert.equal(v.admissible, false);
    assert.equal(v.hardFailures.length, 2);
  });

  test("C2 failure with a RECORDED baseline blocks (pool genuinely has not collapsed)", () => {
    const v = classifyEvaluation(
      check({
        outcome: outcome({ failedCriteria: ["C2-price-collapse"] }),
        launchPriceRecorded: true,
      }),
      true,
    );
    assert.equal(v.admissible, false);
    assert.deepEqual(v.hardFailures, ["C2-price-collapse-recorded-baseline"]);
  });

  test("an existing anchor switches to monitor-only", () => {
    const v = classifyEvaluation(
      check({
        outcome: outcome({ failedCriteria: ["C6-epoch-confirmed"] }),
        anchorExists: true,
      }),
      true,
    );
    assert.equal(v.admissible, false);
    assert.equal(v.monitorOnly, true);
  });

  test("an existing cert switches to monitor-only", () => {
    const v = classifyEvaluation(check({ certExists: true }), true);
    assert.equal(v.monitorOnly, true);
    assert.match(v.reason ?? "", /cert/);
  });

  test("a pool without an attestable last swap is refused (no fabricated attestations)", () => {
    const v = classifyEvaluation(check(), false);
    assert.equal(v.admissible, false);
    assert.deepEqual(v.hardFailures, ["no-attestable-last-swap"]);
  });

  test("hard failures dominate monitor-only", () => {
    const v = classifyEvaluation(
      check({ outcome: outcome({ failedCriteria: ["C1-inactivity"] }), anchorExists: true }),
      true,
    );
    assert.equal(v.monitorOnly, false);
    assert.equal(v.admissible, false);
  });

  test("unknown criterion names neither block nor soft-fail (future-proofing)", () => {
    const v = classifyEvaluation(
      check({ outcome: outcome({ failedCriteria: ["C7-hypothetical"] }) }),
      true,
    );
    assert.equal(v.admissible, true);
    assert.deepEqual(v.hardFailures, []);
    assert.deepEqual(v.softFailures, []);
  });
});
