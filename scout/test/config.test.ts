// SPDX-License-Identifier: Apache-2.0
//
// Scout config tests — defaults, env overrides, and the dry-run gating
// contract (discovery + monitoring is the default mode; submission mode
// must be explicit and requires key material).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { loadScoutConfig, resolveDryRun, SCOUT_SPEC_DEFAULTS } from "../src/index.js";

describe("resolveDryRun", () => {
  test("dry-run by default without an activity oracle key", () => {
    assert.equal(resolveDryRun(undefined, false), true);
  });

  test("submission mode by default with an activity oracle key", () => {
    assert.equal(resolveDryRun(undefined, true), false);
  });

  test("explicit SCOUT_DRY_RUN=1 forces dry-run even with keys", () => {
    assert.equal(resolveDryRun("1", true), true);
    assert.equal(resolveDryRun("true", true), true);
  });

  test("explicit SCOUT_DRY_RUN=0 forces submission mode", () => {
    assert.equal(resolveDryRun("0", true), false);
    assert.equal(resolveDryRun("false", true), false);
  });
});

describe("loadScoutConfig", () => {
  test("spec defaults with an empty env", () => {
    const cfg = loadScoutConfig({});
    assert.equal(cfg.rpcUrl, "https://api.devnet.solana.com");
    assert.equal(cfg.cluster, "devnet");
    assert.equal(cfg.inactivitySeconds, SCOUT_SPEC_DEFAULTS.inactivitySeconds);
    assert.equal(cfg.priceCollapseBps, SCOUT_SPEC_DEFAULTS.priceCollapseBps);
    assert.equal(cfg.minTvlLamports, SCOUT_SPEC_DEFAULTS.minTvlLamports);
    assert.equal(cfg.lpBurnDustThreshold, SCOUT_SPEC_DEFAULTS.lpBurnDustThreshold);
    assert.equal(cfg.maxCandidatesPerCycle, 5);
    assert.equal(cfg.pollIntervalMs, 300_000);
    assert.equal(cfg.maxPoolsPerScan, 1_000);
    assert.equal(cfg.signatureScanLimit, 1_000);
    assert.equal(cfg.launchPriceMaxPages, 50);
    assert.equal(cfg.maxSubmitAttempts, 3);
    assert.equal(cfg.dryRun, true, "no keys ⇒ dry-run");
    assert.equal(cfg.runOnce, false);
    assert.equal(cfg.activityOracleKey, null);
    assert.equal(cfg.launchPriceOracleKey, null);
    assert.equal(cfg.salvorKeypair, null);
    assert.equal(cfg.reportFile, null);
    assert.equal(cfg.feeLamportsPerCu.toString(), "10000");
    assert.equal(cfg.computeUnitLimit, null);
  });

  test("env overrides are honoured", () => {
    const cfg = loadScoutConfig({
      RPC_URL: "https://api.mainnet-beta.solana.com",
      CLUSTER: "mainnet-beta",
      MIN_TVL_LAMPORTS: "1000000000",
      INACTIVITY_SECONDS: "7776000",
      PRICE_COLLAPSE_BPS: "9000",
      MAX_CANDIDATES_PER_CYCLE: "2",
      POLL_INTERVAL_MS: "60000",
      MAX_POOLS_PER_SCAN: "500",
      SIGNATURE_SCAN_LIMIT: "200",
      LAUNCH_PRICE_MAX_PAGES: "10",
      PRIORITY_FEE_LAMPORTS_PER_CU: "50000",
      COMPUTE_UNIT_LIMIT: "200000",
      SCOUT_MAX_SUBMIT_ATTEMPTS: "5",
      SCOUT_REPORT_FILE: "/tmp/scout.jsonl",
      SCOUT_RUN_ONCE: "1",
      SCOUT_DRY_RUN: "1",
    });
    assert.equal(cfg.cluster, "mainnet-beta");
    assert.equal(cfg.rpcUrl, "https://api.mainnet-beta.solana.com");
    assert.equal(cfg.minTvlLamports, 1_000_000_000n);
    assert.equal(cfg.priceCollapseBps, 9_000);
    assert.equal(cfg.maxCandidatesPerCycle, 2);
    assert.equal(cfg.pollIntervalMs, 60_000);
    assert.equal(cfg.maxPoolsPerScan, 500);
    assert.equal(cfg.signatureScanLimit, 200);
    assert.equal(cfg.launchPriceMaxPages, 10);
    assert.equal(cfg.feeLamportsPerCu.toString(), "50000");
    assert.equal(cfg.computeUnitLimit, 200_000);
    assert.equal(cfg.maxSubmitAttempts, 5);
    assert.equal(cfg.reportFile, "/tmp/scout.jsonl");
    assert.equal(cfg.runOnce, true);
  });

  test("submission mode requires ACTIVITY_ORACLE_KEY", () => {
    assert.throws(
      () => loadScoutConfig({ SCOUT_DRY_RUN: "0", SALVOR_KEYPAIR: "x" }),
      /ACTIVITY_ORACLE_KEY/,
    );
  });

  test("submission mode requires SALVOR_KEYPAIR", () => {
    assert.throws(
      () => loadScoutConfig({ SCOUT_DRY_RUN: "0", ACTIVITY_ORACLE_KEY: "x" }),
      /SALVOR_KEYPAIR/,
    );
  });

  test("negative / garbage integers throw", () => {
    assert.throws(() => loadScoutConfig({ MAX_CANDIDATES_PER_CYCLE: "0" }), RangeError);
    assert.throws(() => loadScoutConfig({ POLL_INTERVAL_MS: "abc" }), RangeError);
    assert.throws(() => loadScoutConfig({ MIN_TVL_LAMPORTS: "-1" }), RangeError);
  });
});
