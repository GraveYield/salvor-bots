// SPDX-License-Identifier: Apache-2.0
//
// Envelope + identity + lifecycle + store unit tests (FLEET-M1).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  opportunityKey,
  parseOpportunityKey,
  deliveryIdOf,
  buildEnvelope,
  validateEnvelope,
  canTransition,
  isTerminal,
  LifecycleWalker,
  InMemoryFleetStore,
  admitDelivery,
} from "../src/index.js";

const IDENTITY = {
  cluster: "devnet" as const,
  ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  poolAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
};

describe("opportunity identity", () => {
  test("canonical key is cluster|amm|pool and round-trips", () => {
    const key = opportunityKey(IDENTITY);
    assert.equal(key, `${IDENTITY.cluster}|${IDENTITY.ammProgramId}|${IDENTITY.poolAddress}`);
    assert.deepEqual(parseOpportunityKey(key), IDENTITY);
  });

  test("malformed keys are rejected (not silently split)", () => {
    assert.throws(() => parseOpportunityKey("devnet|only-two"), /malformed opportunity key/);
    assert.throws(() => parseOpportunityKey("testnet|a|b"), /unknown cluster/);
    assert.throws(() => parseOpportunityKey("devnet||b"), /empty program or pool/);
  });

  test("delivery id is content-bound: same inputs → same id, any change → new id", () => {
    const base = { identity: IDENTITY, kind: "salvageable" as const, sourceBot: "scout", detectedAtMs: 1000 };
    const a = deliveryIdOf(base);
    const b = deliveryIdOf(base);
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, deliveryIdOf({ ...base, kind: "certification-ready" }));
    assert.notEqual(a, deliveryIdOf({ ...base, detectedAtMs: 1001 }));
    assert.notEqual(a, deliveryIdOf({ ...base, sourceBot: "other" }));
    assert.notEqual(a, deliveryIdOf({ identity: { ...IDENTITY, poolAddress: "OTHER" }, kind: "salvageable", sourceBot: "scout", detectedAtMs: 1000 }));
  });
});

describe("envelope", () => {
  test("build + validate round-trip; bigints serialize as decimal strings", () => {
    const env = buildEnvelope({
      identity: IDENTITY,
      kind: "salvageable",
      sourceBot: "scout",
      detectedAtMs: 1234,
      score: 0.77,
      firstEligibleEpoch: 10n,
      certExpiresAt: 1_800_000_360n,
      receivedAtMs: 5678,
    });
    const json = JSON.parse(JSON.stringify(env));
    const back = validateEnvelope(json);
    assert.equal(back.firstEligibleEpoch, "10");
    assert.equal(back.certExpiresAt, "1800000360");
    assert.equal(back.provenance.score, 0.77);
  });

  test("validateEnvelope rejects wrong versions and tampered delivery ids", () => {
    const env = buildEnvelope({ identity: IDENTITY, kind: "salvageable", sourceBot: "scout", detectedAtMs: 1, score: null });
    const forged = { ...JSON.parse(JSON.stringify(env)), deliveryId: "0".repeat(64) };
    assert.throws(() => validateEnvelope(forged), /deliveryId does not match/);
    const wrongVersion = { ...JSON.parse(JSON.stringify(env)), schemaVersion: 99 };
    assert.throws(() => validateEnvelope(wrongVersion), /unsupported schemaVersion/);
    const badKind = { ...JSON.parse(JSON.stringify(env)), kind: "salvage-now" };
    assert.throws(() => validateEnvelope(badKind), /invalid kind/);
  });
});

describe("lifecycle", () => {
  test("the happy path walks received → … → confirmed → reported", () => {
    const w = new LifecycleWalker("received", () => 1);
    w.to("revalidating");
    w.to("preparing");
    w.to("simulating");
    w.to("ready");
    w.to("submitting");
    w.to("submitted");
    w.to("confirmed");
    w.to("reported");
    assert.ok(isTerminal("reported"));
    assert.equal(w.transitions.length, 9);
  });

  test("duplicate suppression is a dead end", () => {
    const w = new LifecycleWalker("received");
    w.to("duplicate-suppressed");
    assert.ok(isTerminal("duplicate-suppressed"));
    assert.throws(() => w.to("preparing"), /illegal lifecycle transition/);
  });

  test("illegal transitions throw: no submission after terminal failure", () => {
    const w = new LifecycleWalker("received");
    w.to("revalidating");
    w.to("rejected-economics");
    assert.throws(() => w.to("submitting"), /illegal lifecycle transition rejected-economics → submitting/);
  });

  test("simulation-failed may retry preparation or terminate, nothing else", () => {
    assert.ok(canTransition("simulation-failed", "preparing"));
    assert.ok(canTransition("simulation-failed", "failed-terminal"));
    assert.ok(!canTransition("simulation-failed", "submitting"));
  });

  test("skipping the simulate gate is illegal", () => {
    assert.ok(!canTransition("preparing", "submitting"));
    assert.ok(!canTransition("preparing", "submitted"));
  });
});

describe("InMemoryFleetStore", () => {
  test("admitDelivery collapses at-least-once redelivery to a single admission", async () => {
    const store = new InMemoryFleetStore();
    const env = buildEnvelope({ identity: IDENTITY, kind: "salvageable", sourceBot: "scout", detectedAtMs: 5, score: null });
    const first = await admitDelivery(store, "conservative", env);
    const second = await admitDelivery(store, "conservative", env);
    assert.ok(first);
    assert.equal(second, null);
    // A different bot seeing the same delivery still consumes it itself.
    const otherBot = await admitDelivery(store, "sniper", env);
    assert.ok(otherBot);
  });

  test("execution records are per (identity, bot) and listable for the monitor", async () => {
    const store = new InMemoryFleetStore();
    const key = opportunityKey(IDENTITY);
    await store.putExecution({
      identityKey: key,
      botId: "conservative",
      state: "confirmed",
      transitions: [],
      signature: "SIG1",
      seenDeliveries: [],
      updatedAtMs: 1,
    });
    await store.putExecution({
      identityKey: key,
      botId: "sniper",
      state: "failed-terminal",
      transitions: [],
      signature: null,
      seenDeliveries: [],
      updatedAtMs: 2,
    });
    const mine = await store.getExecution(key, "conservative");
    assert.equal(mine?.signature, "SIG1");
    const all = await store.listExecutions(key);
    assert.equal(all.length, 2);
  });

  test("leases: mutual exclusion, expiry, renewal, release", async () => {
    let now = 10_000;
    const store = new InMemoryFleetStore(() => now);
    const key = opportunityKey(IDENTITY);

    const lease = await store.acquireLease(key, "conservative", 5_000);
    assert.equal(lease?.holder, "conservative");
    // Second bot denied while the lease is live.
    assert.equal(await store.acquireLease(key, "sniper", 5_000), null);
    // Holder renews (now still 10_000 → 10_000 + 5_000 = 15_000).
    const renewed = await store.renewLease(key, "conservative", 5_000);
    assert.equal(renewed?.expiresAtMs, 15_000);
    // Expiry frees the identity.
    now = 15_001;
    assert.equal(await store.getLease(key), null);
    const stolen = await store.acquireLease(key, "sniper", 5_000);
    assert.equal(stolen?.holder, "sniper");
    // Release only by the holder.
    await store.releaseLease(key, "conservative");
    assert.ok(await store.getLease(key));
    await store.releaseLease(key, "sniper");
    assert.equal(await store.getLease(key), null);
  });
});
