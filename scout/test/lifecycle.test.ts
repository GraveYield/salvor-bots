// SPDX-License-Identifier: Apache-2.0
//
// Lifecycle tracker + monitoring tests — the state machine and the
// anchor/cert polling derivation, against byte-exact encoded accounts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  CandidateTracker,
  monitorCandidate,
  MIN_EPOCH_CONFIRMATION,
} from "../src/index.js";
import {
  FakeConnection,
  FIXED_NOW,
  encodeAnchor,
  encodeCert,
  poolKey,
} from "./helpers.js";

const SCANNER = new PublicKey(new Uint8Array(32).fill(0x5c));
const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const WRITER = new PublicKey(new Uint8Array(32).fill(0x77));

function anchorPdaFor(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("eligibility_anchor"), AMM.toBuffer(), pool.toBuffer()],
    SCANNER,
  )[0] as PublicKey;
}

function certPdaFor(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("eligibility_cert"), AMM.toBuffer(), pool.toBuffer()],
    SCANNER,
  )[0] as PublicKey;
}

describe("CandidateTracker", () => {
  test("ensure creates a discovered record; transitions append history", () => {
    const t = new CandidateTracker();
    const pool = poolKey(0x01);
    const rec = t.ensure(pool, AMM);
    assert.equal(rec.state, "discovered");
    assert.equal(t.size(), 1);

    t.transition(pool, "queued", "first");
    t.transition(pool, "evaluated-eligible", "second");
    const after = t.get(pool);
    assert.equal(after?.state, "evaluated-eligible");
    assert.equal(after?.history.length, 2);
    assert.equal(after?.history[0]?.state, "queued");
    assert.equal(after?.history[1]?.state, "evaluated-eligible");
    assert.equal(after?.history[1]?.note, "second");
  });

  test("get of an unknown pool is undefined; transition of unknown pool is a no-op", () => {
    const t = new CandidateTracker();
    assert.equal(t.get(poolKey(0x99)), undefined);
    assert.equal(t.transition(poolKey(0x99), "queued"), undefined);
  });

  test("opportunities surfaces certification-ready and certified pools", () => {
    const t = new CandidateTracker();
    const a = poolKey(0x0a);
    const b = poolKey(0x0b);
    const c = poolKey(0x0c);
    t.ensure(a, AMM).firstEligibleEpoch = 10n;
    t.transition(a, "certification-ready");
    t.ensure(b, AMM).certExpiresAt = BigInt(FIXED_NOW) + 3600n;
    t.transition(b, "certified");
    t.ensure(c, AMM);
    t.transition(c, "waiting-epochs");

    const ops = t.opportunities();
    assert.equal(ops.length, 2);
    const kinds = ops.map((o) => o.kind).sort();
    assert.deepEqual(kinds, ["certification-ready", "salvageable"]);
    const ready = ops.find((o) => o.kind === "certification-ready");
    assert.equal(ready?.poolAddress.toBase58(), a.toBase58());
    assert.equal(ready?.firstEligibleEpoch, 10n);
  });
});

describe("monitorCandidate", () => {
  test("anchor absent → state unchanged with a note", async () => {
    const fake = new FakeConnection();
    const pool = poolKey(0x10);
    const outcome = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(pool),
      certPda: certPdaFor(pool),
      currentState: "phase1-submitted",
      anchorStalenessSeconds: 1_209_600n,
    });
    assert.equal(outcome.state, "phase1-submitted");
    assert.match(outcome.note ?? "", /not visible/);
  });

  test("anchor present, <2 epochs elapsed → waiting-epochs with a countdown note", async () => {
    const fake = new FakeConnection();
    const pool = poolKey(0x11);
    fake.currentEpoch = 10;
    fake.setAccount(
      anchorPdaFor(pool),
      encodeAnchor({
        ammProgramId: AMM,
        poolAddress: pool,
        writer: WRITER,
        firstEligibleEpoch: 9n, // needs epoch 11
        writtenAt: BigInt(FIXED_NOW - 86_400),
      }),
      SCANNER,
    );
    const outcome = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(pool),
      certPda: certPdaFor(pool),
      currentState: "phase1-submitted",
      anchorStalenessSeconds: 1_209_600n,
    });
    assert.equal(outcome.state, "waiting-epochs");
    assert.equal(outcome.currentEpoch, 10n);
    assert.match(outcome.note ?? "", /1 epoch/);
    assert.equal(MIN_EPOCH_CONFIRMATION, 2n);
  });

  test("anchor present, ≥2 epochs elapsed → certification-ready", async () => {
    const fake = new FakeConnection();
    const pool = poolKey(0x12);
    fake.currentEpoch = 13;
    fake.setAccount(
      anchorPdaFor(pool),
      encodeAnchor({
        ammProgramId: AMM,
        poolAddress: pool,
        writer: WRITER,
        firstEligibleEpoch: 10n,
        writtenAt: BigInt(FIXED_NOW - 5 * 86_400),
      }),
      SCANNER,
    );
    const outcome = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(pool),
      certPda: certPdaFor(pool),
      currentState: "waiting-epochs",
      anchorStalenessSeconds: 1_209_600n,
    });
    assert.equal(outcome.state, "certification-ready");
    assert.equal(outcome.firstEligibleEpoch, 10n);
  });

  test("live cert → certified; expired cert → cert-expired", async () => {
    const fake = new FakeConnection();
    const livePool = poolKey(0x13);
    const deadPool = poolKey(0x14);
    for (const [pool, expires] of [
      [livePool, BigInt(FIXED_NOW) + 1_800n],
      [deadPool, BigInt(FIXED_NOW) - 60n],
    ] as const) {
      fake.setAccount(
        anchorPdaFor(pool),
        encodeAnchor({ ammProgramId: AMM, poolAddress: pool, writer: WRITER, firstEligibleEpoch: 8n, writtenAt: BigInt(FIXED_NOW - 10 * 86_400) }),
        SCANNER,
      );
      fake.setAccount(
        certPdaFor(pool),
        encodeCert({ ammProgramId: AMM, poolAddress: pool, writer: WRITER, expiresAt: expires }),
        SCANNER,
      );
    }

    const live = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(livePool),
      certPda: certPdaFor(livePool),
      currentState: "waiting-epochs",
      anchorStalenessSeconds: 1_209_600n,
      nowMs: FIXED_NOW * 1000,
    });
    assert.equal(live.state, "certified");
    assert.equal(live.certExpiresAt, BigInt(FIXED_NOW) + 1_800n);

    const dead = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(deadPool),
      certPda: certPdaFor(deadPool),
      currentState: "certified",
      anchorStalenessSeconds: 1_209_600n,
      nowMs: FIXED_NOW * 1000,
    });
    assert.equal(dead.state, "cert-expired");
  });

  test("stale anchor (past anchor_staleness_seconds without a cert) → anchor-stale", async () => {
    const fake = new FakeConnection();
    const pool = poolKey(0x15);
    fake.currentEpoch = 11; // only 1 epoch past first_eligible
    fake.setAccount(
      anchorPdaFor(pool),
      encodeAnchor({
        ammProgramId: AMM,
        poolAddress: pool,
        writer: WRITER,
        firstEligibleEpoch: 10n,
        writtenAt: BigInt(FIXED_NOW - 20 * 86_400), // 20 d old vs 14 d staleness
      }),
      SCANNER,
    );
    const outcome = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(pool),
      certPda: certPdaFor(pool),
      currentState: "waiting-epochs",
      anchorStalenessSeconds: 1_209_600n,
      nowMs: FIXED_NOW * 1000,
    });
    assert.equal(outcome.state, "anchor-stale");
  });

  test("invalidated anchor → anchor-invalidated", async () => {
    const fake = new FakeConnection();
    const pool = poolKey(0x16);
    fake.setAccount(
      anchorPdaFor(pool),
      encodeAnchor({
        ammProgramId: AMM,
        poolAddress: pool,
        writer: WRITER,
        firstEligibleEpoch: 8n,
        writtenAt: BigInt(FIXED_NOW),
        invalidated: true,
      }),
      SCANNER,
    );
    const outcome = await monitorCandidate({
      connection: fake.asConnection(),
      anchorPda: anchorPdaFor(pool),
      certPda: certPdaFor(pool),
      currentState: "waiting-epochs",
      anchorStalenessSeconds: 1_209_600n,
    });
    assert.equal(outcome.state, "anchor-invalidated");
    assert.equal(outcome.anchorInvalidated, true);
  });
});
