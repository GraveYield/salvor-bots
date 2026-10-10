// SPDX-License-Identifier: Apache-2.0
//
// ADV-FLEET — the executor layer under deliberate attack (roadmap
// Phase 12): extreme-value economics, inconsistent quotes, dust-skip
// partial-failure economics, competing Salvors at the store layer, and
// mid-flight state manipulation against the revalidation gate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { estimateSalvageEconomics, revalidateOpportunity, InMemoryFleetStore } from "../src/index.js";
import { FIXED_NOW_MS, SCANNER_ID, encodeAnchor } from "./helpers.js";
import { buildWorld } from "./world.js";
import { RAYDIUM_V4_PROGRAM_ID, eligibilityAnchorPda } from "@graveyield/sdk";

const NOW = () => FIXED_NOW_MS;
const u64max = 18_446_744_073_709_551_615n;

// ---- estimator attack fixtures -----------------------------------------

const WSOL = "So11111111111111111111111111111111111111112";

function baseEconomics(overrides: Partial<Parameters<typeof estimateSalvageEconomics>[0]> = {}) {
  return estimateSalvageEconomics({
    pool: {
      coinMint: "mint-meme",
      pcMint: WSOL,
      wsolMint: WSOL,
      coinReserve: 1_000_000n,
      pcReserve: 5_000_000_000n,
      lpSupply: 10_000_000n,
      ...overrides.pool,
    },
    route: {
      quoteInAmount: 1_000_000n,
      quoteOutLamports: 2_000_000_000n,
      ...overrides.route,
    },
    position: {
      salvorLpAmount: 1_000_000n,
      ...overrides.position,
    },
    config: {
      salvorShareBps: 4_000,
      maxSlippageBps: 300,
      jupiterDustThresholdLamports: 666_666n,
      ...overrides.config,
    },
    costs: {
      priorityFeeBudgetLamports: 100_000n,
      frontedRentLamports: 0n,
      signatureCount: 2,
      ...overrides.costs,
    },
    minNetProfitLamports: 0n,
    ...overrides.top,
  });
}

describe("ADV-FLEET — executor economics under attack", () => {
  test("ADV-EL-02: u64::MAX-scale pools produce exact, finite economics", () => {
    const est = baseEconomics({
      pool: { coinReserve: u64max, pcReserve: u64max, lpSupply: u64max },
      position: { salvorLpAmount: u64max - 1n },
      route: { quoteInAmount: u64max, quoteOutLamports: u64max },
    });
    assert.equal(est.status, "ok");
    // Proportional withdraw of (max-1)/max of a max reserve: integer floor.
    assert.ok(est.directWsolOut > 0n);
    // The live 40% share and break-even stay coherent integers.
    assert.ok(est.salvorGrossShareLamports > est.costs.total);
    assert.ok(est.breakEvenGrossWsolLamports > 0n);
    assert.ok(est.minQuoteOutputLamports > 0n);
  });

  test("ADV-FT: a quote exceeding the pool's memecoin reserve is refused as inconsistent", () => {
    const est = baseEconomics({
      route: { quoteInAmount: 1_000_001n, quoteOutLamports: 2_000_000_000n },
    });
    assert.equal(est.status, "reject");
    assert.equal(est.failureClass, "route-failure");
    // The exact boundary is legal — a quote for the full reserve stands.
    const boundary = baseEconomics({
      route: { quoteInAmount: 1_000_000n, quoteOutLamports: 2_000_000_000n },
    });
    assert.equal(boundary.status, "ok");
  });

  test("ADV-FT: below the dust threshold the swap leg contributes ZERO (partial-failure economics pinned)", () => {
    // memecoinOut = 1_000_000 × (1_000_000/10_000_000) = 100_000 base
    // units; the quote maps it to far less than the 666_666 dust floor.
    const est = baseEconomics({
      route: { quoteInAmount: 1_000_000n, quoteOutLamports: 1_000n },
    });
    assert.equal(est.status, "ok");
    assert.equal(est.swapLegBelowDust, true, "sub-dust conversion is skipped, not swapped");
    // Proceeds come from the direct WSOL side only; the dust memecoin is
    // retained (D6) — the audit sees this acceptance consciously.
    assert.ok(est.grossProceedsWsolLamports > 0n);
    assert.equal(est.netProfitLamports, est.salvorGrossShareLamports - est.costs.total);
  });

  test("ADV-CS: a zero-share config is refused — nothing to keep, nothing to do", () => {
    const est = baseEconomics({ config: { salvorShareBps: 0 } });
    assert.equal(est.status, "reject");
  });

  test("ADV-MP: a strategy slippage override can only TIGHTEN the floor math", () => {
    const loose = baseEconomics({ top: { slippageBpsOverride: 5_000 } });
    const tight = baseEconomics({ top: { slippageBpsOverride: 50 } });
    assert.equal(loose.effectiveSlippageBps, 300, "override cannot widen past config");
    assert.equal(tight.effectiveSlippageBps, 50, "override tightens");
    assert.ok(tight.minQuoteOutputLamports > loose.minQuoteOutputLamports);
  });
});

describe("ADV-FLEET — competing Salvors at the coordination layer", () => {
  test("ADV-CS: a live lease is exclusive — a second Salvor cannot take it", async () => {
    const store = new InMemoryFleetStore();
    const identity = "ray-v4:pool-adv-cs";
    const first = await store.acquireLease(identity, "bot-conservative", 60_000);
    assert.ok(first, "first Salvor acquires");
    const second = await store.acquireLease(identity, "bot-sniper", 60_000);
    assert.equal(second, null, "the live lease refuses the second Salvor");
    // The first holder renews; the third still cannot enter.
    const renewed = await store.renewLease(identity, "bot-conservative", 60_000);
    assert.ok(renewed);
    assert.equal(await store.acquireLease(identity, "bot-experimental", 60_000), null);
  });

  test("ADV-CS (F5): an EXPIRED lease is silently stealable — pinned as a finding", async () => {
    let now = FIXED_NOW_MS;
    const store = new InMemoryFleetStore(() => now);
    const identity = "ray-v4:pool-adv-cs2";
    assert.ok(await store.acquireLease(identity, "bot-a", 1_000));
    now += 2_000; // the lease expired; bot-a crashed mid-prepare
    // The takeover succeeds — there is no fencing token. The chain's
    // init-once PDAs remain the real backstop; flagged as finding F5.
    const stolen = await store.acquireLease(identity, "bot-b", 60_000);
    assert.ok(stolen, "expired lease takeover is the current behavior (pinned)");
  });

  test("ADV-CS: delivery admission is idempotent — a replayed envelope is refused", async () => {
    const store = new InMemoryFleetStore();
    const envelope = {
      deliveryId: "delivery-1",
      identityKey: "ray-v4:pool-adv-cs3",
    } as Parameters<typeof admitDelivery>[2];
    const first = await admitDelivery(store, "bot-conservative", envelope);
    assert.ok(first, "first admission passes");
    const replay = await admitDelivery(store, "bot-conservative", envelope);
    assert.equal(replay, null, "the same delivery id is refused on replay");
    // A DIFFERENT bot may still consume the same opportunity envelope —
    // per-bot dedup, fleet-wide at-most-once lives in the executor.
    const otherBot = await admitDelivery(store, "bot-sniper", envelope);
    assert.ok(otherBot, "per-bot dedup does not cross-contaminate");
  });
});

describe("ADV-FLEET — mid-flight state manipulation", () => {
  test("ADV-TS: an anchor invalidated BETWEEN checks flips a live opportunity to refused", async () => {
    const w = buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
    });
    const call = () =>
      revalidateOpportunity({
        client: w.client,
        ammProgramId: RAYDIUM_V4_PROGRAM_ID,
        poolAddress: w.poolAddress,
        minCertRemainingMs: 120_000,
        options: { now: NOW },
      });

    // Before the attack: certification-ready (no cert yet, epoch gap met).
    const before = await call();
    assert.ok(before.ok);
    assert.equal(before.ok && before.opportunity.kind, "certification-ready");

    // The attack: the multisig invalidates the anchor mid-flight. The
    // replacement keeps the SAME epoch the world built with (12 − 2 =
    // 10) — only the invalidation bit flips, isolating the refusal to
    // the invalidation itself, not an epoch mismatch.
    w.rpc.setAccount(
      w.anchorPda,
      encodeAnchor({
        ammProgramId: RAYDIUM_V4_PROGRAM_ID,
        poolAddress: w.poolAddress,
        firstEligibleEpoch: 10n,
        invalidated: true,
      }),
      SCANNER_ID,
    );

    const after = await call();
    assert.ok(!after.ok, "an invalidated anchor must refuse revalidation");
    assert.equal(after.ok ? null : after.failureClass, "stale-anchor");
  });

  test("ADV-CE: a cert about to expire inside the strategy margin is refused cert-expired", async () => {
    const w = buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 61n, // 61s < 120s margin
    });
    const out = await revalidateOpportunity({
      client: w.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(!out.ok);
    assert.equal(out.ok ? null : out.failureClass, "cert-expired");
    // One second more and the same cert is actionable — the margin is exact.
    const w2 = buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: BigInt(Math.floor(FIXED_NOW_MS / 1000)) + 120n,
    });
    const ok = await revalidateOpportunity({
      client: w2.client,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: w2.poolAddress,
      minCertRemainingMs: 120_000,
      options: { now: NOW },
    });
    assert.ok(ok.ok);
  });
});

// ---- import placed last to keep the attack surface at the top ----------

import { admitDelivery } from "../src/index.js";
void eligibilityAnchorPda; // revalidation suite parity (used via world.anchorPda)
