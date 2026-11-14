// SPDX-License-Identifier: Apache-2.0
//
// ActivityIndexer tests — the IMPL-001 Correction 001 §1 legacy-contract
// mapping as consumed by the Scout:
//
//   verified        → record with the swap fields, noSwapFound=false,
//                     unresolved=false, CACHED
//   no_swap_in_scan → record with noSwapFound=TRUE (definitive: complete
//                     scan, every candidate provably not an economic
//                     swap), unresolved=false, CACHED
//   incomplete      → record with unresolved=TRUE and noSwapFound=FALSE —
//                     NEVER noSwapFound=true, NEVER cached (the next call
//                     re-scans; the evidence may be complete by then)
//
// Non-evidence RPC failures still propagate (operators must see them).
// Synthetic fixtures only — the SDK's real-evidence fixtures live in
// graveyield-protocol sdk/test/fixtures/lastSwap (see PROVENANCE.md).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { ActivityIndexer } from "../src/index.js";
import { FakeConnection, installPool, poolKey, V4, type PoolFixture } from "./helpers.js";

function installedPool(byte: number): {
  fake: FakeConnection;
  poolAddress: PublicKey;
  fixture: PoolFixture;
} {
  const fake = new FakeConnection();
  const poolAddress = poolKey(byte);
  const fixture = installPool(fake, { poolAddress, tvlLamports: 2_000_000_000n });
  return { fake, poolAddress, fixture };
}

function installedSignature(fake: FakeConnection, poolAddress: PublicKey): string {
  const sigs = fake.signaturesByPool.get(poolAddress.toBase58());
  assert.ok(sigs && sigs.length === 1, "fixture must have exactly one history signature");
  return sigs[0].signature;
}

describe("ActivityIndexer — Correction 001 legacy contract", () => {
  test("a verified swap yields the swap fields, unresolved=false, and is cached", async () => {
    const { fake, poolAddress } = installedPool(0xe1);
    const indexer = new ActivityIndexer();

    const record = await indexer.indexActivity(fake.asConnection(), poolAddress);
    assert.equal(record.unresolved, false);
    assert.equal(record.noSwapFound, false);
    assert.ok(record.lastSwapUnixTs > 0);
    assert.equal(record.lastSwapSignature, installedSignature(fake, poolAddress));

    // Cached: even if the evidence were destroyed after the first scan,
    // the TTL cache still serves the resolved record.
    fake.transactions.delete(installedSignature(fake, poolAddress));
    const again = await indexer.indexActivity(fake.asConnection(), poolAddress);
    assert.equal(again, record, "a resolved record must be served from cache");
  });

  test("a DEFINITIVE no-swap scan yields noSwapFound=true, unresolved=false", async () => {
    const fake = new FakeConnection();
    const poolAddress = poolKey(0xe2);
    // Liquidity-only history: a complete scan whose every candidate is
    // provably not an economic swap (an empty response would be INCOMPLETE).
    installPool(fake, { poolAddress, tvlLamports: 2_000_000_000n, liquidityOnly: true });
    const indexer = new ActivityIndexer();

    const record = await indexer.indexActivity(fake.asConnection(), poolAddress);
    assert.equal(record.unresolved, false);
    assert.equal(record.noSwapFound, true, "definitive no-swap is the only noSwapFound=true case");
    assert.equal(record.lastSwapUnixTs, 0);
  });

  test("INCOMPLETE evidence never becomes noSwapFound=true and is never cached", async () => {
    const { fake, poolAddress, fixture } = installedPool(0xe3);
    const indexer = new ActivityIndexer();

    // Destroy the candidate's transaction data: the signature resolves but
    // the transaction cannot be verified — an unresolved candidate ⇒ the
    // scan is incomplete (transaction_data_missing).
    fake.transactions.delete(installedSignature(fake, poolAddress));

    const record = await indexer.indexActivity(fake.asConnection(), poolAddress);
    assert.equal(record.unresolved, true, "incomplete evidence must be explicitly unresolved");
    assert.equal(
      record.noSwapFound,
      false,
      "incomplete evidence must NEVER be reported as noSwapFound=true",
    );
    assert.equal(record.lastSwapUnixTs, 0);

    // Not cached: restore the evidence; the next call must RE-SCAN and
    // resolve (a cached unresolved record would have frozen the state).
    fake.setSwapHistory(poolAddress, V4, {
      coinVault: fixture.coinVault,
      pcVault: fixture.pcVault,
    });
    const rescanned = await indexer.indexActivity(fake.asConnection(), poolAddress);
    assert.equal(rescanned.unresolved, false);
    assert.equal(rescanned.noSwapFound, false);
    assert.ok(rescanned.lastSwapUnixTs > 0, "the re-scan must see the restored verified swap");
  });

  test("non-evidence RPC failures still propagate", async () => {
    const { fake, poolAddress } = installedPool(0xe4);
    const indexer = new ActivityIndexer();
    fake.getSignaturesForAddress = async () => {
      throw new Error("rpc unavailable");
    };
    await assert.rejects(
      () => indexer.indexActivity(fake.asConnection(), poolAddress),
      /rpc unavailable/,
    );
    assert.equal(indexer.size(), 0, "failed scans must not be cached");
  });
});
