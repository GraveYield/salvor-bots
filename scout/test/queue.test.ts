// SPDX-License-Identifier: Apache-2.0
//
// Candidate queue tests — priority ordering, dedup, drain semantics
// (ported from the Phase 9 indexer's queue.test.ts).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { CandidateQueue } from "../src/index.js";
import type { ScoutCandidate, ScoutScoredCandidate } from "../src/index.js";

function makeScored(poolByte: number, score: number): ScoutScoredCandidate {
  const pool = new PublicKey(new Uint8Array(32).fill(poolByte));
  const candidate: ScoutCandidate = {
    poolAddress: pool,
    ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    activity: {
      poolAddress: pool,
      lastSwapUnixTs: 0,
      lastSwapSlot: 0,
      lastSwapSignature: "",
      noSwapFound: true,
    },
    reserves: {
      poolAddress: pool,
      coinReserve: 0n,
      pcReserve: 0n,
      lpSupply: 0n,
      wsolSideIdentified: true,
      tvlLamports: 0n,
    },
    metadata: {
      poolAddress: pool,
      baseMint: PublicKey.default,
      baseDecimals: 0,
      baseSupply: 0n,
      quoteMint: PublicKey.default,
      quoteDecimals: 0,
      quoteSupply: 0n,
      lpMint: PublicKey.default,
      lpDecimals: 0,
      lpSupply: 0n,
    },
    preFilter: { poolAddress: pool, passed: true, failedCriteria: [], criteriaBitmap: 0x3f },
  };
  return {
    candidate,
    score,
    scoreBreakdown: { inactivityMargin: 1, tvlMargin: 1, priceCollapseMargin: 1 },
  };
}

describe("CandidateQueue", () => {
  test("empty queue drains to empty array", () => {
    const q = new CandidateQueue();
    assert.deepEqual(q.drain(5), []);
    assert.equal(q.size(), 0);
  });

  test("enqueue + drain returns by score descending", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x10, 1.0));
    q.enqueue(makeScored(0x20, 3.0));
    q.enqueue(makeScored(0x30, 2.0));
    const drained = q.drain(3);
    assert.equal(drained[0]?.candidate.poolAddress.toBase58(), new PublicKey(new Uint8Array(32).fill(0x20)).toBase58());
    assert.equal(drained[1]?.candidate.poolAddress.toBase58(), new PublicKey(new Uint8Array(32).fill(0x30)).toBase58());
    assert.equal(drained[2]?.candidate.poolAddress.toBase58(), new PublicKey(new Uint8Array(32).fill(0x10)).toBase58());
    assert.equal(q.size(), 0);
  });

  test("drain(n) removes only the drained candidates", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x01, 1.0));
    q.enqueue(makeScored(0x02, 2.0));
    q.enqueue(makeScored(0x03, 3.0));
    const top = q.drain(2);
    assert.equal(top.length, 2);
    assert.equal(q.size(), 1);
    const rest = q.drain(2);
    assert.equal(rest.length, 1);
    assert.equal(rest[0]?.candidate.poolAddress.toBase58(), new PublicKey(new Uint8Array(32).fill(0x01)).toBase58());
  });

  test("re-enqueueing a pool keeps the higher score (dedup by address)", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x42, 5.0));
    q.enqueue(makeScored(0x42, 1.0));
    assert.equal(q.size(), 1);
    q.enqueue(makeScored(0x42, 9.0));
    const drained = q.drain(1);
    assert.equal(drained[0]?.score, 9.0);
  });

  test("peek does not remove", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x01, 1.0));
    q.enqueue(makeScored(0x02, 2.0));
    assert.equal(q.peek(1).length, 1);
    assert.equal(q.size(), 2);
    assert.equal(q.has(new PublicKey(new Uint8Array(32).fill(0x01)).toBase58()), true);
    assert.equal(q.remove(new PublicKey(new Uint8Array(32).fill(0x01)).toBase58()), true);
    assert.equal(q.size(), 1);
  });

  test("clear empties the queue", () => {
    const q = new CandidateQueue();
    q.enqueue(makeScored(0x01, 1.0));
    q.clear();
    assert.equal(q.size(), 0);
  });
});
