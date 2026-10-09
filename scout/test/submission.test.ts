// SPDX-License-Identifier: Apache-2.0
//
// Submission assembly tests — the transaction shape the on-chain
// attestation validator accepts:
//
//   * instruction order [compute…, precompile, scanner ix]
//   * precompile `message_instruction_index` == the scanner ix's ACTUAL
//     transaction index (dynamic — this is what lets compute-budget ixs
//     precede the attestation pair)
//   * the signed message IS the 112/168-byte attestation embedded in the
//     scanner ix data at the canonical offset (72 for C1, 152 for C2)
//   * the signature verifies against the oracle public key (tweetnacl)
//   * the Charter guard refuses over-ceiling compute-unit prices before
//     anything reaches the network
//
// The negative paths here mirror the on-chain tests in
// programs/grave-scanner/src/attestation.rs — the Scout must produce
// transactions those tests would accept.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import BN from "bn.js";
import {
  ED25519_PROGRAM_ID,
  GraveYieldClient,
  IX_DATA_MSG_OFFSET,
  LAUNCH_PRICE_MSG_OFFSET,
  buildAttestationMessage,
  parseAttestationMessage,
} from "@graveyield/sdk";

import {
  buildPhase1Transaction,
  buildRecordLaunchPriceTransaction,
  signAttestation,
  defaultTxSender,
} from "../src/index.js";
import { FakeConnection, encodeScannerConfig, encodeVaultConfig } from "./helpers.js";

const SCANNER = new PublicKey(new Uint8Array(32).fill(0x5d));
const VAULT = new PublicKey(new Uint8Array(32).fill(0x5e));
const POOL = new PublicKey(new Uint8Array(32).fill(0x2a));
const AMM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

const ORACLE_SEED = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
const oracle = {
  secretKey64: new Uint8Array(nacl.sign.keyPair.fromSeed(ORACLE_SEED).secretKey),
  publicKey: new PublicKey(nacl.sign.keyPair.fromSeed(ORACLE_SEED).publicKey),
};

function clientFor(fake: FakeConnection, feeCeiling = 1_000_000_000n): GraveYieldClient {
  fake.setAccount(
    PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], SCANNER)[0] as PublicKey,
    encodeScannerConfig({ authority: PublicKey.default, activityOracle: oracle.publicKey, launchPriceOracle: oracle.publicKey }),
    SCANNER,
  );
  fake.setAccount(
    PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], VAULT)[0] as PublicKey,
    encodeVaultConfig({ authority: PublicKey.default, maxPriorityFeeCeilingLamports: feeCeiling }),
    VAULT,
  );
  return new GraveYieldClient({
    connection: fake.asConnection(),
    cluster: "devnet",
    graveScannerProgramId: SCANNER,
    graveVaultProgramId: VAULT,
  });
}

function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

const FEE = { feeLamportsPerCu: new BN(10_000), computeUnitLimit: 300_000 };

describe("buildPhase1Transaction", () => {
  test("assembles [cuLimit, cuPrice, precompile, phase1] with the dynamic index pinned", async () => {
    const fake = new FakeConnection();
    const client = clientFor(fake);
    const writer = PublicKey.default;

    const bundle = await buildPhase1Transaction({
      connection: fake.asConnection(),
      client,
      scannerProgramId: SCANNER,
      poolAddress: POOL,
      lastSwapUnixTs: 1_700_000_000,
      oracle,
      writer,
      fee: FEE,
    });

    assert.equal(bundle.tx.instructions.length, 4);
    const [ix0, ix1, ix2, ix3] = bundle.tx.instructions as [
      TransactionInstruction,
      TransactionInstruction,
      TransactionInstruction,
      TransactionInstruction,
    ];

    // Compute budget: limit first, then price.
    assert.ok(ix0.programId.equals(ComputeBudgetProgram.programId));
    assert.equal(ix0.data[0], 2); // SetComputeUnitLimit tag
    assert.ok(ix1.programId.equals(ComputeBudgetProgram.programId));
    assert.equal(ix1.data[0], 3); // SetComputeUnitPrice tag

    // Precompile immediately precedes the scanner ix.
    assert.ok(ix2.programId.equals(ED25519_PROGRAM_ID));
    assert.ok(ix3.programId.equals(SCANNER));

    // The precompile's message_instruction_index points AT the phase1 ix.
    assert.equal(bundle.phase1IxIndex, 3);
    assert.equal(readU16LE(ix2.data, 14), 3);

    // The precompile covers exactly the 112 bytes embedded in the phase1
    // ix data at offset 72 (the canonical C1 span).
    assert.equal(readU16LE(ix2.data, 10), IX_DATA_MSG_OFFSET);
    assert.equal(readU16LE(ix2.data, 12), 112);
    const embedded = ix3.data.subarray(IX_DATA_MSG_OFFSET, IX_DATA_MSG_OFFSET + 112);
    assert.deepEqual(Buffer.from(embedded), Buffer.from(bundle.attestationMessage));

    // The attestation message round-trips and binds pool + timestamp.
    const parsed = parseAttestationMessage(bundle.attestationMessage);
    assert.equal(parsed.lastSwapUnixTs, 1_700_000_000);
    assert.equal(parsed.issuedSlot, bundle.issuedSlot);
    assert.ok(parsed.poolAddress.equals(POOL));

    // The signature verifies against the oracle key (tweetnacl).
    assert.equal(
      nacl.sign.detached.verify(
        Buffer.from(bundle.attestationMessage),
        Buffer.from(bundle.attestationSignature),
        Buffer.from(oracle.publicKey.toBytes()),
      ),
      true,
    );
  });

  test("without compute-budget ixs the index degenerates to the canonical 1", async () => {
    const fake = new FakeConnection();
    const client = clientFor(fake);
    const bundle = await buildPhase1Transaction({
      connection: fake.asConnection(),
      client,
      scannerProgramId: SCANNER,
      poolAddress: POOL,
      lastSwapUnixTs: 1_700_000_000,
      oracle,
      writer: PublicKey.default,
      fee: { feeLamportsPerCu: new BN(0) },
    });
    assert.equal(bundle.tx.instructions.length, 2);
    assert.equal(bundle.phase1IxIndex, 1);
    const precompile = bundle.tx.instructions[0] as TransactionInstruction;
    assert.equal(readU16LE(precompile.data, 14), 1);
  });

  test("the attested timestamp flows from the activity record into the message", async () => {
    const fake = new FakeConnection();
    const client = clientFor(fake);
    const bundle = await buildPhase1Transaction({
      connection: fake.asConnection(),
      client,
      scannerProgramId: SCANNER,
      poolAddress: POOL,
      lastSwapUnixTs: 1_234_567_890,
      oracle,
      writer: PublicKey.default,
      fee: { feeLamportsPerCu: new BN(0) },
    });
    const parsed = parseAttestationMessage(bundle.attestationMessage);
    assert.equal(parsed.lastSwapUnixTs, 1_234_567_890);
    // The slot hash embedded is the fake blockhash of the issuance slot.
    assert.deepEqual(
      Buffer.from(parsed.slotHash),
      Buffer.from(new PublicKey(fake.blockhash).toBytes()),
    );
  });
});

describe("buildRecordLaunchPriceTransaction", () => {
  test("assembles the C2 pair with the message at the canonical 152 offset", async () => {
    const fake = new FakeConnection();
    const client = clientFor(fake);
    const derivation = {
      launchPriceQ64x64: (10_000_000n << 64n) / 1_000_000n,
      firstSwapSlot: 42,
      firstSwapUnixTs: 1_700_000_001,
      baseMint: new PublicKey(new Uint8Array(32).fill(0xb2)),
      quoteMint: new PublicKey(new Uint8Array(32).fill(0xb3)),
      signature: "FIRST_SWAP_SIG",
    };

    const bundle = await buildRecordLaunchPriceTransaction({
      connection: fake.asConnection(),
      client,
      scannerProgramId: SCANNER,
      poolAddress: POOL,
      derivation,
      oracle,
      payer: PublicKey.default,
      fee: FEE,
    });

    assert.equal(bundle.tx.instructions.length, 4);
    assert.equal(bundle.recordIxIndex, 3);
    const [ix0, ix1, ix2, ix3] = bundle.tx.instructions as [
      TransactionInstruction,
      TransactionInstruction,
      TransactionInstruction,
      TransactionInstruction,
    ];
    assert.equal(ix0.data[0], 2); // SetComputeUnitLimit
    assert.equal(ix1.data[0], 3); // SetComputeUnitPrice
    assert.ok(ix2.programId.equals(ED25519_PROGRAM_ID));
    assert.ok(ix3.programId.equals(SCANNER));
    assert.equal(readU16LE(ix2.data, 14), 3);
    assert.equal(readU16LE(ix2.data, 10), LAUNCH_PRICE_MSG_OFFSET);
    assert.equal(readU16LE(ix2.data, 12), 168);

    // The embedded 168-byte message matches what the oracle signed.
    const embedded = ix3.data.subarray(LAUNCH_PRICE_MSG_OFFSET, LAUNCH_PRICE_MSG_OFFSET + 168);
    assert.deepEqual(Buffer.from(embedded), Buffer.from(bundle.attestationMessage));

    assert.equal(
      nacl.sign.detached.verify(
        Buffer.from(bundle.attestationMessage),
        Buffer.from(bundle.attestationSignature),
        Buffer.from(oracle.publicKey.toBytes()),
      ),
      true,
    );
  });
});

describe("Charter guard", () => {
  test("an over-ceiling compute-unit price is rejected BEFORE any send", async () => {
    const fake = new FakeConnection();
    // Vault Charter ceiling: 5_000 — the requested 10_000 must be refused.
    const client = clientFor(fake, 5_000n);
    await assert.rejects(
      buildPhase1Transaction({
        connection: fake.asConnection(),
        client,
        scannerProgramId: SCANNER,
        poolAddress: POOL,
        lastSwapUnixTs: 1_700_000_000,
        oracle,
        writer: PublicKey.default,
        fee: FEE,
      }),
      /Charter guard/,
    );
    assert.equal(fake.sentTransactions.length, 0, "nothing may reach the network");
  });

  test("an at-ceiling fee passes the guard", async () => {
    const fake = new FakeConnection();
    const client = clientFor(fake, 10_000n);
    const bundle = await buildPhase1Transaction({
      connection: fake.asConnection(),
      client,
      scannerProgramId: SCANNER,
      poolAddress: POOL,
      lastSwapUnixTs: 1_700_000_000,
      oracle,
      writer: PublicKey.default,
      fee: { feeLamportsPerCu: new BN(10_000), computeUnitLimit: 300_000 },
    });
    assert.equal(bundle.tx.instructions.length, 4);
  });

  test("signAttestation produces a verifiable detached signature", () => {
    const msg = buildAttestationMessage({
      ammProgramId: AMM,
      poolAddress: POOL,
      lastSwapUnixTs: 1,
      issuedSlot: 2,
      slotHash: new Uint8Array(32).fill(9),
    });
    const sig = signAttestation(msg, oracle);
    assert.equal(
      nacl.sign.detached.verify(Buffer.from(msg), Buffer.from(sig), Buffer.from(oracle.publicKey.toBytes())),
      true,
    );
  });
});

describe("defaultTxSender", () => {
  test("is a passthrough over web3.js sendAndConfirmTransaction (smoke: shape only)", () => {
    assert.equal(typeof defaultTxSender, "function");
  });
});
