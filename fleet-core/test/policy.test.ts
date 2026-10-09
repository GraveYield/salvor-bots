// SPDX-License-Identifier: Apache-2.0
//
// Execution policy tests (FLEET-M1) — validation gates + live-mode
// enablement + the D3 fee-plan wiring.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import {
  validatePolicy,
  planFees,
  DEFAULT_TUNABLES,
  type ExecutionPolicy,
} from "../src/index.js";

function basePolicy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    botId: "test-executor",
    cluster: "devnet",
    mode: "dry-run",
    accepts: { kinds: ["certification-ready", "salvageable"] },
    retryBackoffMs: 500,
    minNetProfitLamports: 1_000_000n,
    ...DEFAULT_TUNABLES,
    ...overrides,
  };
}

describe("validatePolicy", () => {
  test("dry-run is the default-legal mode with no enablement", () => {
    assert.doesNotThrow(() => validatePolicy(basePolicy(), null));
    assert.doesNotThrow(() => validatePolicy(basePolicy({ mode: "simulation" }), null));
  });

  test("live mode WITHOUT explicit enablement is rejected — never defaults to live", () => {
    assert.throws(() => validatePolicy(basePolicy({ mode: "live" }), null), /explicit operator enablement/);
    assert.throws(() => validatePolicy(basePolicy({ mode: "live" }), { enabled: false, acknowledgedBy: "op" }), /explicit operator enablement/);
    assert.doesNotThrow(() => validatePolicy(basePolicy({ mode: "live" }), { enabled: true, acknowledgedBy: "operator@host" }));
  });

  test("global invariants: margins, units, minimums, windows", () => {
    assert.throws(() => validatePolicy(basePolicy({ botId: "" }), null), /botId/);
    assert.throws(() => validatePolicy(basePolicy({ computeUnitLimit: 0 }), null), /computeUnitLimit/);
    assert.throws(() => validatePolicy(basePolicy({ computeUnitLimit: 1.5 }), null), /computeUnitLimit/);
    assert.throws(() => validatePolicy(basePolicy({ feeMarginRatio: 1.2 }), null), /feeMarginRatio/);
    assert.throws(() => validatePolicy(basePolicy({ minNetProfitLamports: -1n }), null), /minNetProfitLamports/);
    assert.throws(() => validatePolicy(basePolicy({ maxSubmitAttempts: 0 }), null), /maxSubmitAttempts/);
    assert.throws(() => validatePolicy(basePolicy({ leaseTtlMs: 10 }), null), /leaseTtlMs/);
    assert.throws(() => validatePolicy(basePolicy({ slippageBpsOverride: 20_000 }), null), /slippageBpsOverride/);
    assert.throws(() => validatePolicy(basePolicy({ accepts: { kinds: [] } }), null), /accepts.kinds/);
  });
});

describe("planFees (D3 wiring)", () => {
  const policy = basePolicy({ feeMarginRatio: 0.25, computeUnitLimit: 1_400_000 });

  test("derives the per-CU price from the TOTAL budget, capped by the ceiling", () => {
    const plan = planFees({
      policy,
      expectedProfitLamports: new BN(2_000_000_000), // 2 SOL
      protocolCeilingMicroLamportsPerCu: new BN(1_000_000_000),
    });
    // budget = 0.5 SOL = 5e8 lamports = 5e14 µL; price = floor(5e14/1.4e6) = 357_142_857.
    assert.equal(plan.maxTotalFeeLamports.toString(10), "500000000");
    assert.equal(plan.maxMicroLamportsPerCu.toString(10), "357142857");
    assert.equal(plan.binding, "profit-margin");
  });

  test("the ceiling binds when the strategy is aggressive and the config is tight", () => {
    const plan = planFees({
      policy,
      expectedProfitLamports: new BN(10_000_000_000),
      protocolCeilingMicroLamportsPerCu: new BN(50_000),
    });
    assert.equal(plan.binding, "charter-ceiling");
    assert.equal(plan.maxMicroLamportsPerCu.toString(10), "50000");
  });
});
