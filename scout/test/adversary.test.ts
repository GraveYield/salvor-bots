// SPDX-License-Identifier: Apache-2.0
//
// ADV-SCOUT — the Scout's admission gate under deliberate attack
// (roadmap Phase 12). classifyEvaluation is the LAST client-side
// refusal before anything is ever signed; this matrix pins it. The
// on-chain scanner remains the authority — these tests prove the
// Scout refuses to even ASK when its assumptions aren't satisfied.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { classifyEvaluation } from "../src/evaluate.js";
import type { EvaluatePoolOutcome } from "@graveyield/sdk";

const POOL = PublicKey.default;

function outcome(failed: string[], eligible = failed.length === 0): EvaluatePoolOutcome {
  return {
    poolAddress: POOL,
    ammProgramId: POOL,
    eligible,
    criteria: {
      c1Inactivity: !failed.includes("C1-inactivity"),
      c2PriceCollapse: !failed.includes("C2-price-collapse"),
      c3MinTvl: !failed.includes("C3-min-tvl"),
      c4LpNotBurned: !failed.includes("C4-lp-not-burned"),
      c5NoLock: !failed.includes("C5-no-lock"),
      c6EpochConfirmed: !failed.includes("C6-epoch-confirmed"),
    },
    failedCriteria: failed,
  } as EvaluatePoolOutcome;
}

const cleanCheck = {
  outcome: outcome([]),
  launchPriceRecorded: false,
  anchorExists: false,
  certExists: false,
};

describe("ADV-SCOUT — the admission gate", () => {
  test("ADV-AP: an active pool (C1) is a HARD refusal — never admissible", () => {
    const v = classifyEvaluation({ ...cleanCheck, outcome: outcome(["C1-inactivity"]) }, true);
    assert.equal(v.admissible, false);
    assert.ok(v.hardFailures.includes("C1-inactivity"));
  });

  test("ADV-EC/ADV-DS: TVL (C3) and dust (C4) are HARD refusals", () => {
    for (const c of ["C3-min-tvl", "C4-lp-not-burned"]) {
      const v = classifyEvaluation({ ...cleanCheck, outcome: outcome([c]) }, true);
      assert.equal(v.admissible, false, `${c} must hard-fail`);
    }
  });

  test("ADV-LK: a locked LP pool (C5) is a HARD refusal", () => {
    const v = classifyEvaluation({ ...cleanCheck, outcome: outcome(["C5-no-lock"]) }, true);
    assert.equal(v.admissible, false);
  });

  test("ADV-MP: C2 without a recorded baseline is SOFT (record launch price first)", () => {
    const v = classifyEvaluation({ ...cleanCheck, outcome: outcome(["C2-price-collapse"]) }, true);
    assert.equal(v.admissible, true, "no baseline yet → record it, then re-decide");
    assert.deepEqual(v.softFailures, ["C2-price-collapse"]);
  });

  test("ADV-MP: C2 with a RECORDED baseline is a HARD refusal — a live price cannot be un-collapsed", () => {
    const v = classifyEvaluation(
      { ...cleanCheck, outcome: outcome(["C2-price-collapse"]), launchPriceRecorded: true },
      true,
    );
    assert.equal(v.admissible, false);
    assert.ok(v.hardFailures.includes("C2-price-collapse-recorded-baseline"));
  });

  test("ADV-FD: a pool with no attestable last swap is refused EVEN with perfect criteria", () => {
    // The fake-derelict-pool attack in its purest form: every criterion
    // passes, but there is no scan-found swap to attest. ORACLE-002:
    // the Scout refuses to fabricate inactivity evidence.
    const v = classifyEvaluation(cleanCheck, false);
    assert.equal(v.admissible, false);
    assert.ok(v.hardFailures.includes("no-attestable-last-swap"));
  });

  test("ADV-RP: existing on-chain state flips the verdict to monitor-only (never re-submit)", () => {
    const anchored = classifyEvaluation({ ...cleanCheck, anchorExists: true }, true);
    assert.equal(anchored.admissible, false);
    assert.equal(anchored.monitorOnly, true);

    const certified = classifyEvaluation({ ...cleanCheck, certExists: true }, true);
    assert.equal(certified.admissible, false);
    assert.equal(certified.monitorOnly, true);
  });

  test("ADV-RP: a hard failure DOMINATES existing chain state — no monitor-only escape", () => {
    const v = classifyEvaluation(
      { ...cleanCheck, outcome: outcome(["C1-inactivity"]), anchorExists: true, certExists: true },
      true,
    );
    assert.equal(v.admissible, false);
    assert.equal(v.monitorOnly, false, "hard failures are not monitorable opportunities");
    assert.equal(v.reason, "hard-failed: C1-inactivity");
  });

  test("ADV-FM: unknown future criteria names are ignored, not fatal (chain is the authority)", () => {
    const v = classifyEvaluation({ ...cleanCheck, outcome: outcome(["C7-hypothetical"]) }, true);
    assert.equal(v.admissible, true);
    assert.deepEqual(v.hardFailures, []);
    assert.deepEqual(v.softFailures, []);
  });

  test("ADV-MP+ADV-FD combined: a fake-derelict, unpriceable pool is refused on every axis", () => {
    const v = classifyEvaluation(
      {
        outcome: outcome(["C2-price-collapse", "C1-inactivity"]),
        launchPriceRecorded: false,
        anchorExists: false,
        certExists: false,
      },
      false, // no attestable swap either
    );
    assert.equal(v.admissible, false);
    assert.ok(v.hardFailures.includes("C1-inactivity"));
    assert.ok(v.hardFailures.includes("no-attestable-last-swap"));
  });
});
