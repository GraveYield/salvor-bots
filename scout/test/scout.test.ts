// SPDX-License-Identifier: Apache-2.0
//
// End-to-end Scout wiring tests — the full lifecycle against a
// FakeConnection (no network), driven through `runOnce()`:
//
//   cycle 1 (dry-run)   discover → pre-filter → queue → SDK double-check
//                       → evaluated-eligible, NOTHING submitted
//   cycle 2 (submit)    record_launch_price → evaluate_pool_phase_1
//                       → anchor materialized → waiting-epochs
//   cycle 3 (monitor)   epoch crosses first+2 → certification-ready
//   cycle 4 (monitor)   cert materialized → certified (salvage window)
//
// Plus the boundary paths: hard-failed pools never submit, launch-price
// blocking without the C2 oracle, submission-failure retry limits, and
// the Charter guard firing inside a live cycle.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import nacl from "tweetnacl";
import {
  ScannerIx,
  eligibilityAnchorPda,
  eligibilityCertPda,
  launchPricePda,
} from "@graveyield/sdk";

import {
  ScoutSalvor,
  buildScout,
  MemoryReportSink,
  type ScoutOptions,
  type ScoutConfig,
  type TxSender,
  type OracleIdentity,
} from "../src/index.js";
import {
  FakeConnection,
  encodeAnchor,
  encodeCert,
  encodeLaunchPriceAccount,
  encodeScannerConfig,
  encodeVaultConfig,
  installPool,
  poolKey,
} from "./helpers.js";

const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const SCANNER = new PublicKey(new Uint8Array(32).fill(0x66));
const VAULT = new PublicKey(new Uint8Array(32).fill(0x67));

const ACTIVITY_ORACLE: OracleIdentity = (() => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).map((_, i) => (i * 13 + 1) & 0xff));
  return { secretKey64: new Uint8Array(kp.secretKey), publicKey: new PublicKey(kp.publicKey) };
})();
const LP_ORACLE: OracleIdentity = (() => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).map((_, i) => (i * 17 + 2) & 0xff));
  return { secretKey64: new Uint8Array(kp.secretKey), publicKey: new PublicKey(kp.publicKey) };
})();
const OPERATOR = Keypair.generate();

const realNowSec = () => BigInt(Math.floor(Date.now() / 1000));

function scannerPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], SCANNER)[0] as PublicKey;
}
function vaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], VAULT)[0] as PublicKey;
}

function baseOptions(
  fake: FakeConnection,
  sinks: MemoryReportSink[],
  overrides?: Partial<ScoutOptions>,
): ScoutOptions {
  fake.setAccount(
    scannerPda(),
    encodeScannerConfig({
      authority: PublicKey.default,
      activityOracle: ACTIVITY_ORACLE.publicKey,
      launchPriceOracle: LP_ORACLE.publicKey,
    }),
    SCANNER,
  );
  fake.setAccount(
    vaultPda(),
    encodeVaultConfig({ authority: PublicKey.default }),
    VAULT,
  );
  return {
    connection: fake.asConnection(),
    cluster: "devnet",
    scannerProgramId: SCANNER,
    vaultProgramId: VAULT,
    thresholds: {
      inactivitySeconds: 7_776_000n,
      priceCollapseBps: 9_900,
      minTvlLamports: 500_000_000n,
      lpBurnDustThreshold: 1_000n,
    },
    maxCandidatesPerCycle: 5,
    maxPoolsPerScan: 100,
    signatureScanLimit: 100,
    launchPriceMaxPages: 50,
    dryRun: true,
    activityOracle: null,
    launchPriceOracle: null,
    operatorKeypair: null,
    fee: { feeLamportsPerCu: new BN(10_000), computeUnitLimit: 300_000 },
    maxSubmitAttempts: 3,
    pollIntervalMs: 60_000,
    sinks,
    ...overrides,
  };
}

/** A fresh fixture: poolA passes everything; poolB is active; poolC is below TVL. */
function makeFixture(): { fake: FakeConnection; poolA: PublicKey; poolB: PublicKey; poolC: PublicKey } {
  const fake = new FakeConnection();
  // Install the ProtocolConfig accounts (spec defaults) — baseOptions
  // re-installs them with real oracle keys when a test goes through it.
  fake.setAccount(
    scannerPda(),
    encodeScannerConfig({
      authority: PublicKey.default,
      activityOracle: ACTIVITY_ORACLE.publicKey,
      launchPriceOracle: LP_ORACLE.publicKey,
    }),
    SCANNER,
  );
  fake.setAccount(vaultPda(), encodeVaultConfig({ authority: PublicKey.default }), VAULT);
  installPool(fake, { poolAddress: poolKey(0xa1), tvlLamports: 2_000_000_000n });
  installPool(fake, { poolAddress: poolKey(0xb2), tvlLamports: 2_000_000_000n, lastSwapAgeSeconds: 3_600 });
  installPool(fake, { poolAddress: poolKey(0xc3), tvlLamports: 100_000_000n });
  return { fake, poolA: poolKey(0xa1), poolB: poolKey(0xb2), poolC: poolKey(0xc3) };
}

/**
 * The fake sender: captures transactions, "confirms" them, and
 * materializes the resulting on-chain state (LaunchPrice PDA on the C2
 * tx, EligibilityAnchor on the phase1 tx) the way the real programs would.
 */
function makeSender(fake: FakeConnection): { sender: TxSender; sent: Transaction[] } {
  const sent: Transaction[] = [];
  const sender: TxSender = async (_connection, tx) => {
    sent.push(tx);
    const lastIx = tx.instructions[tx.instructions.length - 1];
    if (!lastIx || !lastIx.programId.equals(SCANNER)) return `FAKE_SIG_${sent.length}`;
    const data = Buffer.from(lastIx.data);
    const pool = new PublicKey(data.subarray(40, 72)); // disc(8) + amm(32) → pool
    const isRecordLaunchPrice =
      Buffer.compare(data.subarray(0, 8), Buffer.from(ScannerIx.recordLaunchPrice)) === 0;
    if (isRecordLaunchPrice) {
      // record_launch_price data: disc(8) amm(32) pool(32) base(32) quote(32) price(u128) msg(168)
      fake.setAccount(
        launchPricePda(SCANNER, AMM, pool),
        encodeLaunchPriceAccount({
          ammProgramId: AMM,
          poolAddress: pool,
          baseMint: new PublicKey(data.subarray(72, 104)),
          quoteMint: new PublicKey(data.subarray(104, 136)),
          launchPriceQ64x64: readU128(data, 152),
        }),
        SCANNER,
      );
    } else {
      fake.setAccount(
        eligibilityAnchorPda(SCANNER, AMM, pool),
        encodeAnchor({
          ammProgramId: AMM,
          poolAddress: pool,
          writer: OPERATOR.publicKey,
          firstEligibleEpoch: BigInt(fake.currentEpoch),
          writtenAt: realNowSec(),
        }),
        SCANNER,
      );
    }
    return `FAKE_SIG_${sent.length}`;
  };
  return { sender, sent };
}

function readU128(data: Buffer, offset: number): bigint {
  let out = 0n;
  for (let i = 15; i >= 0; i--) {
    out = (out << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return out;
}

describe("ScoutSalvor end-to-end (fake RPC)", () => {
  test("dry-run: full discovery pipeline with zero submissions", async () => {
    const { fake, poolA, poolB, poolC } = makeFixture();
    const sinks = [new MemoryReportSink()];
    const scout = new ScoutSalvor(baseOptions(fake, sinks, { dryRun: true }));

    const result = await scout.runOnce();

    assert.equal(result.discoveredCount, 3);
    assert.equal(result.candidateCount, 1, "only poolA passes the pre-filter");
    assert.equal(result.evaluatedCount, 1);
    assert.equal(result.phase1Submitted, 0);
    assert.equal(result.launchPricesRecorded, 0);
    assert.equal(result.dryRun, true);

    const record = scout.snapshot().find((r) => r.poolAddress.equals(poolA));
    assert.equal(record?.state, "evaluated-eligible");
    assert.ok((record?.score ?? 0) > 0);

    const filteredB = scout.snapshot().find((r) => r.poolAddress.equals(poolB));
    assert.equal(filteredB?.state, "filtered-out");
    assert.deepEqual(filteredB?.preFilter?.failedCriteria, ["C1-inactivity"]);
    const filteredC = scout.snapshot().find((r) => r.poolAddress.equals(poolC));
    assert.equal(filteredC?.state, "filtered-out");

    const mem = sinks[0] as MemoryReportSink;
    assert.ok(mem.ofType("cycle-start").length >= 1);
    assert.ok(mem.ofType("discovered").length >= 3);
    assert.equal(mem.ofType("phase1-submitted").length, 0);
    assert.equal(mem.ofType("evaluated").length, 1);
    assert.equal(mem.ofType("cycle-end").length, 1);
  });

  test("submission mode: record_launch_price → phase1 → anchor → waiting-epochs", async () => {
    const { fake, poolA } = makeFixture();
    const sinks = [new MemoryReportSink()];
    const { sender, sent } = makeSender(fake);
    const scout = new ScoutSalvor(
      baseOptions(fake, sinks, {
        dryRun: false,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: LP_ORACLE,
        operatorKeypair: OPERATOR,
        txSender: sender,
      }),
    );

    const result = await scout.runOnce();

    assert.equal(result.launchPricesRecorded, 1);
    assert.equal(result.phase1Submitted, 1);
    assert.equal(result.phase1Failed, 0);
    assert.equal(sent.length, 2, "one C2 tx + one C1 tx");

    // Both transactions are Charter-guarded, attestation-prefixed pairs:
    // [cuLimit, cuPrice, precompile, scannerIx], with the precompile's
    // message_instruction_index pinned to the scanner ix's actual index.
    for (const tx of sent) {
      assert.equal(tx.instructions.length, 4);
      const precompile = tx.instructions[2];
      const scannerIx = tx.instructions[3];
      assert.ok(scannerIx?.programId.equals(SCANNER));
      assert.equal(precompile?.data.readUInt16LE(14), 3);
    }

    // The anchor was materialized at the canonical PDA.
    const anchor = await fake.getAccountInfo(eligibilityAnchorPda(SCANNER, AMM, poolA));
    assert.ok(anchor, "phase1 sender must materialize the EligibilityAnchor");

    // The launch price was materialized too (the C2 tx ran first).
    const lp = await fake.getAccountInfo(launchPricePda(SCANNER, AMM, poolA));
    assert.ok(lp, "record_launch_price sender must materialize the LaunchPrice PDA");

    const record = scout.snapshot().find((r) => r.poolAddress.equals(poolA));
    assert.equal(record?.state, "waiting-epochs", "epoch 10 < first_eligible 10 + 2");
    assert.equal(record?.signatures.launchPrice, "FAKE_SIG_1");
    assert.equal(record?.signatures.phase1, "FAKE_SIG_2");
    assert.equal(record?.firstEligibleEpoch, 10n);

    const mem = sinks[0] as MemoryReportSink;
    assert.equal(mem.ofType("launch-price-recorded").length, 1);
    assert.equal(mem.ofType("phase1-submitted").length, 1);
    assert.equal(mem.ofType("waiting-epochs").length, 1);
  });

  test("monitoring: epoch crossing yields certification-ready, then a live cert yields certified", async () => {
    const { fake, poolA } = makeFixture();
    const sinks = [new MemoryReportSink()];
    const { sender } = makeSender(fake);
    const scout = new ScoutSalvor(
      baseOptions(fake, sinks, {
        dryRun: false,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: LP_ORACLE,
        operatorKeypair: OPERATOR,
        txSender: sender,
      }),
    );

    await scout.runOnce(); // submit path (as above)
    assert.equal(scout.opportunities().length, 0);

    // Cycle 2: epochs advance past the confirmation gap. The pool is in a
    // monitoring state — it must NOT be re-evaluated or re-submitted.
    fake.currentEpoch = 12;
    const second = await scout.runOnce();
    assert.equal(second.phase1Submitted, 0);
    assert.equal(second.launchPricesRecorded, 0);
    assert.equal(scout.opportunities().length, 1);
    const ready = scout.opportunities()[0];
    assert.equal(ready?.kind, "certification-ready");
    assert.equal(ready?.firstEligibleEpoch, 10n);
    assert.equal(
      (sinks[0] as MemoryReportSink).ofType("opportunity:certification-ready").length,
      1,
    );

    // Cycle 3: an executor bot would now certify; materialize the cert.
    fake.setAccount(
      eligibilityCertPda(SCANNER, AMM, poolA),
      encodeCert({
        ammProgramId: AMM,
        poolAddress: poolA,
        writer: OPERATOR.publicKey,
        expiresAt: realNowSec() + 1_800n,
      }),
      SCANNER,
    );
    await scout.runOnce();
    const salvageable = scout.opportunities().find((o) => o.kind === "salvageable");
    assert.ok(salvageable, "cert inside TTL ⇒ salvageable opportunity");
    assert.equal(salvageable?.certExpiresAt, realNowSec() + 1_800n);
    assert.equal(
      (sinks[0] as MemoryReportSink).ofType("opportunity:salvageable").length,
      1,
    );
  });

  test("pools without an attestable last swap are hard-failed and never submitted", async () => {
    const fake = new FakeConnection();
    installPool(fake, { poolAddress: poolKey(0xd4), tvlLamports: 2_000_000_000n, neverSwapped: true });
    const sinks = [new MemoryReportSink()];
    const { sender, sent } = makeSender(fake);
    const scout = new ScoutSalvor(
      baseOptions(fake, sinks, {
        dryRun: false,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: LP_ORACLE,
        operatorKeypair: OPERATOR,
        txSender: sender,
      }),
    );

    const result = await scout.runOnce();
    assert.equal(result.phase1Submitted, 0);
    assert.equal(sent.length, 0);
    const record = scout.snapshot().find((r) => r.state === "evaluated-ineligible");
    assert.ok(record, "the never-swapped pool must be evaluated-ineligible");
    const notes = record?.history.map((h) => h.note).filter((n) => n !== null) ?? [];
    assert.ok(
      notes.some((n) => n !== null && /no-attestable-last-swap/.test(n)),
      `expected a no-attestable note in history, got: ${JSON.stringify(notes)}`,
    );
  });

  test("launch-price blocking: missing LaunchPrice PDA without a C2 oracle never submits phase1", async () => {
    const { fake } = makeFixture();
    const sinks = [new MemoryReportSink()];
    const { sender, sent } = makeSender(fake);
    const scout = new ScoutSalvor(
      baseOptions(fake, sinks, {
        dryRun: false,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: null, // ← the Scout cannot record the launch price
        operatorKeypair: OPERATOR,
        txSender: sender,
      }),
    );

    const result = await scout.runOnce();
    assert.equal(result.phase1Submitted, 0);
    assert.equal(result.launchPricesRecorded, 0);
    assert.equal(sent.length, 0);
    const record = scout.snapshot().find((r) => r.state === "launch-price-blocked");
    assert.ok(record, "pool must be parked in launch-price-blocked");
    assert.equal((sinks[0] as MemoryReportSink).ofType("launch-price-blocked").length, 1);
  });

  test("submission failures retry up to maxSubmitAttempts, then stop re-queueing", async () => {
    const { fake } = makeFixture();
    const sinks = [new MemoryReportSink()];
    let attempts = 0;
    const failingSender: TxSender = async () => {
      attempts += 1;
      throw new Error("rpc blip");
    };
    const scout = new ScoutSalvor(
      baseOptions(fake, sinks, {
        dryRun: false,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: LP_ORACLE,
        operatorKeypair: OPERATOR,
        maxSubmitAttempts: 2,
        txSender: failingSender,
      }),
    );

    await scout.runOnce(); // attempt 1 (C2 tx fails)
    assert.equal(attempts, 1);
    assert.equal(scout.snapshot().find((r) => r.state === "submission-failed")?.submitAttempts, 1);

    await scout.runOnce(); // attempt 2
    assert.equal(attempts, 2);

    await scout.runOnce(); // attempts exhausted — no third send
    assert.equal(attempts, 2, "no re-queue after max attempts");
    const mem = sinks[0] as MemoryReportSink;
    assert.ok(mem.ofType("phase1-failed").length >= 2);
  });

  test("an over-ceiling fee is refused by the Charter guard inside the cycle", async () => {
    const { fake } = makeFixture();
    const sinks = [new MemoryReportSink()];
    const { sender, sent } = makeSender(fake);
    const scout = new ScoutSalvor(
      baseOptions(fake, sinks, {
        dryRun: false,
        activityOracle: ACTIVITY_ORACLE,
        launchPriceOracle: LP_ORACLE,
        operatorKeypair: OPERATOR,
        txSender: sender,
      }),
    );
    // Rewrite the vault config with a tiny Charter ceiling AFTER the scout
    // exists — the client caches configs lazily on first ensureConfigs(),
    // i.e. inside runOnce(), so it must observe the new ceiling.
    fake.setAccount(
      vaultPda(),
      encodeVaultConfig({ authority: PublicKey.default, maxPriorityFeeCeilingLamports: 5_000n }),
      VAULT,
    );

    const result = await scout.runOnce();
    assert.equal(result.phase1Submitted, 0);
    assert.equal(sent.length, 0, "nothing reaches the network");
    assert.equal(result.phase1Failed, 1);
    const record = scout.snapshot().find((r) => r.state === "submission-failed");
    assert.match(record?.lastError ?? "", /Charter guard/);
  });

  test("buildScout wires a ScoutConfig into a working ScoutSalvor (effective dry-run without keys)", async () => {
    const { fake } = makeFixture();
    const sinks = [new MemoryReportSink()];
    const config: ScoutConfig = {
      rpcUrl: "fake://local",
      cluster: "devnet",
      scannerProgramId: SCANNER,
      vaultProgramId: VAULT,
      inactivitySeconds: 7_776_000n,
      priceCollapseBps: 9_900,
      minTvlLamports: 500_000_000n,
      lpBurnDustThreshold: 1_000n,
      maxCandidatesPerCycle: 5,
      pollIntervalMs: 60_000,
      maxPoolsPerScan: 100,
      signatureScanLimit: 100,
      launchPriceMaxPages: 50,
      dryRun: false,
      activityOracleKey: null,
      launchPriceOracleKey: null,
      salvorKeypair: null,
      feeLamportsPerCu: new BN(10_000),
      computeUnitLimit: null,
      maxSubmitAttempts: 3,
      reportFile: null,
      runOnce: true,
    };
    const scout = buildScout(config, {
      connection: fake.asConnection(),
      sinks: sinks as never,
    });
    assert.ok(scout instanceof ScoutSalvor);
    const result = await scout.runOnce();
    assert.equal(result.dryRun, true, "no keys ⇒ effective dry-run even with dryRun=false");
    assert.equal(result.discoveredCount, 3);
  });
});
