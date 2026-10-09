// SPDX-License-Identifier: Apache-2.0
//
// Scout key material loading.
//
// Two inputs, two accepted formats (mirrors the Phase 9 indexer's
// conventions plus the solana-keygen file format operators already use):
//
//   * ACTIVITY_ORACLE_KEY / LAUNCH_PRICE_ORACLE_KEY — base58-encoded
//     32-byte Ed25519 seed. The full 64-byte tweetnacl secret key is
//     derived via `nacl.sign.keyPair.fromSeed` (deterministic, testable).
//
//   * SALVOR_KEYPAIR — either a path to a solana-keygen JSON file
//     (`[1,2,3,…]`, 64-byte secret-key array or 32-byte seed array) or a
//     base58-encoded 64-byte secret key / 32-byte seed. Disambiguation is
//     content-based: valid base58 of the right length ⇒ key material,
//     anything else ⇒ file path. No fragile path heuristics.
//
// Gotchas honoured (handoff §9): `Buffer.from(string, "base58")` does NOT
// work — decoding goes through the `bs58` package; signing uses
// `tweetnacl.sign.detached`, never a (nonexistent) `Keypair.sign`.

import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import type { OracleIdentity } from "./types.js";

const SEED_LEN = 32;
const SECRET_KEY_LEN = 64;

/** Decode a base58 string into bytes with a clear error message. */
function decodeBase58(raw: string, what: string): Uint8Array | null {
  try {
    return bs58.decode(raw.trim());
  } catch {
    return null;
  }
}

function assertLen(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${what} must be ${expected} bytes (got ${bytes.length})`);
  }
}

/** Normalize either a 32-byte seed or a 64-byte secret into a 64-byte secret. */
function toSecretKey64(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length === SECRET_KEY_LEN) return bytes;
  if (bytes.length === SEED_LEN) {
    return nacl.sign.keyPair.fromSeed(bytes).secretKey;
  }
  throw new Error(`${what} must be 32 (seed) or 64 (secret key) bytes (got ${bytes.length})`);
}

/**
 * Load an oracle identity from a base58-encoded 32-byte Ed25519 seed.
 * Returns the tweetnacl-compatible 64-byte secret plus the public key.
 */
export function loadOracleIdentity(rawBase58Seed: string, what: string): OracleIdentity {
  const bytes = decodeBase58(rawBase58Seed, what);
  if (!bytes) throw new Error(`${what} is not valid base58`);
  assertLen(bytes, SEED_LEN, what);
  const kp = nacl.sign.keyPair.fromSeed(bytes);
  return {
    secretKey64: kp.secretKey,
    publicKey: new PublicKey(kp.publicKey),
  };
}

function keypairFromBytes(bytes: Uint8Array, what: string): Keypair {
  const secret64 = toSecretKey64(bytes, what);
  return Keypair.fromSecretKey(Buffer.from(secret64));
}

/**
 * Load the Scout's operator (writer/payer) keypair from either a
 * solana-keygen JSON file path or a base58-encoded secret. Content-based
 * disambiguation: anything that decodes as base58 is key material (a
 * wrong length is a hard error); anything else is treated as a file path.
 */
export function loadSalvorKeypair(raw: string, what = "SALVOR_KEYPAIR"): Keypair {
  const asBase58 = decodeBase58(raw, what);
  if (asBase58) {
    // Decodable base58 ⇒ key material; a wrong length is fatal, never a
    // file-path fallback (paths that decode as base58 are absurd).
    return keypairFromBytes(asBase58, what);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(raw, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`${what}: not valid base58 key material and could not read as a keypair file (${raw}): ${String(err)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
    throw new Error(`${what}: keypair file must contain a JSON array of numbers`);
  }
  return keypairFromBytes(new Uint8Array(parsed as number[]), what);
}
