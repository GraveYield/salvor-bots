// SPDX-License-Identifier: Apache-2.0
//
// Revalidation tests (FLEET-M1) — the live-state authority: kind flips,
// cert TTL margins, anchor invalidation, orientation, dust-threshold C4.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { revalidateOpportunity } from "../src/index.js";
import { FIXED_NOW_MS, SCANNER_ID, VAULT_ID, encodeCert, encodeAnchor } from "./helpers.js";
import { buildWorld, type WorldOptions } from "./world.js";
import { eligibilityCertPda, eligibilityAnchorPda, RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";

const NOW = () => FIXED_NOW_MS;

function world(overrides?: Partial<WorldOptions>) {
  return buildWorld({
    wsolReserve: 5_000_000_000n,
    memecoinReserve: 1_000_000n,
    lpSupply: 10_000_000n,
    salvorLpAmount: 1_000_000n,
    ...overrides,
  });
}

describe("revalidateOpportunity", () => {
  test("certification-ready: no cert + ≥2 epochs elapsed → kind flips to certification-ready", async () => {
    const w = world({});
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(out.ok);
    assert.equal(out.ok && out.opportunity.kind, "certification-ready");
    assert.equal(out.ok && out.opportunity.cert, null);
  });

  test("salvageable: live cert with enough remaining TTL", async () => {
    const w = world({ certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 3_600n });
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(out.ok);
    assert.equal(out.ok && out.opportunity.kind, "salvageable");
    assert.equal(out.ok && out.opportunity.certExpiresAt, BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 3_600n);
  });

  test("cert inside TTL but under the strategy margin is rejected cert-expired", async () => {
    const w = world({ certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 60n }); // 60s < 120s margin
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "cert-expired");
  });

  test("expired cert flips back to certification-ready (epoch gap still satisfied)", async () => {
    const w = world({ certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) - 10n });
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(out.ok);
    assert.equal(out.ok && out.opportunity.kind, "certification-ready");
  });

  test("epoch gap NOT satisfied + no cert → stale-opportunity", async () => {
    // currentEpoch defaults to 12 → an anchor firstEligibleEpoch of 11
    // leaves only 1 epoch elapsed (MIN_EPOCH_CONFIRMATION = 2).
    const w = world({ firstEligibleEpoch: 11n });
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "stale-opportunity");
  });

  test("invalidated anchor is rejected stale-anchor", async () => {
    const w = world({ invalidatedAnchor: true });
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "stale-anchor");
  });

  test("missing anchor is rejected anchor-missing", async () => {
    const w = world({});
    w.rpc.deleteAccount(w.anchorPda);
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "anchor-missing");
  });

  test("a cert binding a different anchor epoch is rejected state-changed", async () => {
    const w = world({ certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 3_600n });
    // Overwrite the cert with a WRONG anchor epoch.
    w.rpc.setAccount(
      w.certPda,
      encodeCert({ ammProgramId: RAYDIUM_V4_PROGRAM_ID, poolAddress: w.poolAddress, anchorEpoch: 999n, expiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 3_600n }),
      SCANNER_ID,
    );
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "state-changed");
  });

  test("anchor epoch correct but the LIVE anchor moved → state-changed (cert vs anchor mismatch)", async () => {
    const w = world({ certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 3_600n });
    // Overwrite the ANCHOR with a different epoch; cert now mismatches.
    w.rpc.setAccount(
      eligibilityAnchorPda(SCANNER_ID, RAYDIUM_V4_PROGRAM_ID, w.poolAddress),
      encodeAnchor({ ammProgramId: RAYDIUM_V4_PROGRAM_ID, poolAddress: w.poolAddress, firstEligibleEpoch: 5n }),
      SCANNER_ID,
    );
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "state-changed");
  });

  test("fresh reserves + LP supply flow into the revalidated snapshot", async () => {
    const w = world({});
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(out.ok);
    if (out.ok) {
      assert.equal(out.opportunity.coinReserve, 1_000_000n);
      assert.equal(out.opportunity.pcReserve, 5_000_000_000n);
      assert.equal(out.opportunity.lpSupply, 10_000_000n);
      assert.equal(out.opportunity.memecoinMint.toBase58(), w.memecoinMint.toBase58());
      assert.equal(out.opportunity.coinIsWsol, false);
    }
  });

  test("missing pool account is rejected missing-accounts", async () => {
    const w = world({});
    w.rpc.deleteAccount(w.poolAddress);
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "missing-accounts");
  });
});

// helper used in one test above (epoch without a fixed world)
function opts_currentEpoch(w: { rpc: { currentEpoch: number } }): number {
  return w.rpc.currentEpoch;
}
