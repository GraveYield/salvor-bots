// SPDX-License-Identifier: Apache-2.0
//
// Scout key-loading tests — base58 seeds, base58 secret keys,
// solana-keygen JSON files, content-based disambiguation, and the
// tweetnacl sign/verify round-trip that the C1/C2 attestation paths
// depend on (handoff §9 gotchas 10 + 11).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { loadOracleIdentity, loadSalvorKeypair } from "../src/index.js";

const SEED = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

describe("loadOracleIdentity", () => {
  test("32-byte base58 seed → tweetnacl-compatible 64-byte secret + matching public key", () => {
    const id = loadOracleIdentity(bs58.encode(SEED), "TEST_ORACLE");
    assert.equal(id.secretKey64.length, 64);
    const kp = nacl.sign.keyPair.fromSeed(SEED);
    assert.deepEqual(Buffer.from(id.secretKey64), Buffer.from(kp.secretKey));
    assert.deepEqual(Buffer.from(id.publicKey.toBytes()), Buffer.from(kp.publicKey));
  });

  test("derived key signs and verifies (detached)", () => {
    const id = loadOracleIdentity(bs58.encode(SEED), "TEST_ORACLE");
    const msg = new Uint8Array(112).fill(0xab);
    const sig = nacl.sign.detached(Buffer.from(msg), Buffer.from(id.secretKey64));
    assert.equal(sig.length, 64);
    assert.equal(
      nacl.sign.detached.verify(Buffer.from(msg), sig, Buffer.from(id.publicKey.toBytes())),
      true,
    );
  });

  test("rejects non-base58 input", () => {
    assert.throws(() => loadOracleIdentity("!!!not-base58!!!", "TEST_ORACLE"), /not valid base58/);
  });

  test("rejects wrong-length keys", () => {
    assert.throws(() => loadOracleIdentity(bs58.encode(new Uint8Array(16)), "TEST_ORACLE"), /32 bytes/);
    assert.throws(() => loadOracleIdentity(bs58.encode(new Uint8Array(64)), "TEST_ORACLE"), /32 bytes/);
  });
});

describe("loadSalvorKeypair", () => {
  test("base58 64-byte secret key", () => {
    const kp = nacl.sign.keyPair.fromSeed(SEED);
    const loaded = loadSalvorKeypair(bs58.encode(kp.secretKey), "TEST_KP");
    assert.deepEqual(
      Buffer.from(loaded.secretKey),
      Buffer.from(kp.secretKey),
    );
  });

  test("base58 32-byte seed", () => {
    const loaded = loadSalvorKeypair(bs58.encode(SEED), "TEST_KP");
    const expected = nacl.sign.keyPair.fromSeed(SEED);
    assert.deepEqual(Buffer.from(loaded.secretKey), Buffer.from(expected.secretKey));
  });

  test("solana-keygen JSON file (64-byte array)", () => {
    const kp = nacl.sign.keyPair.fromSeed(SEED);
    const dir = mkdtempSync(join(tmpdir(), "scout-keys-"));
    const file = join(dir, "kp.json");
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    const loaded = loadSalvorKeypair(file, "TEST_KP");
    assert.deepEqual(Buffer.from(loaded.publicKey.toBytes()), Buffer.from(kp.publicKey));
  });

  test("solana-keygen JSON file (32-byte seed array)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-keys-"));
    const file = join(dir, "seed.json");
    writeFileSync(file, JSON.stringify(Array.from(SEED)));
    const loaded = loadSalvorKeypair(file, "TEST_KP");
    const expected = nacl.sign.keyPair.fromSeed(SEED);
    assert.deepEqual(Buffer.from(loaded.secretKey), Buffer.from(expected.secretKey));
  });

  test("rejects garbage files", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-keys-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }));
    assert.throws(() => loadSalvorKeypair(file, "TEST_KP"), /JSON array of numbers/);
  });

  test("rejects wrong-length base58", () => {
    assert.throws(() => loadSalvorKeypair(bs58.encode(new Uint8Array(10)), "TEST_KP"), /32 \(seed\) or 64/);
  });
});
