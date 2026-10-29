// SPDX-License-Identifier: Apache-2.0
//
// W5 regression tests — the OpenBook v1 market vault-signer derivation
// (`deriveV4CpiAccounts`), against a REAL, UNMODIFIED market fixture.
//
// The fixture below mirrors the REAL mainnet SOL/USDC OpenBook v1 market
// exactly in every field this module reads (provenance: the protocol
// repo's `scripts/fetch_v4_fork_fixtures.mjs` pull of live Raydium V4
// state, cross-checked on-chain; the committed Finding E vectors in
// `graveyield-protocol/scripts/devnet/test/fixture_vault_signer.test.mjs`
// pin the same constants offline):
//
//   market            8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6
//   market program    srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX (OpenBook v1)
//   stored nonce      1 (u64 LE @ absolute offset 45 of the market data)
//   real vault signer CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7
//                     (read on-chain from BOTH market vault token
//                     accounts' owner fields — the ground truth)
//   coin/pc mints     WSOL / USDC (real mainnet mints)
//
// Unlike the W1 local-harness fixture, NOTHING is adapted for fleet-core
// here: the nonce is the real stored value and the vault owners are the
// real signer — the derivation must reproduce the real world as-is.
//
// Negative tests pin the fail-closed behavior: a tampered stored nonce,
// a re-pointed vault owner, a mis-owned market, and a truncated market
// account each abort the discovery with `MissingAccountsError`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { deriveV4CpiAccounts, toRemainingAccounts, MissingAccountsError } from "../src/index.js";
import {
  RAYDIUM_V4_AMM_INFO_SIZE,
  RAYDIUM_V4_PROGRAM_ID,
  WSOL_MINT,
  createProgramAddressSync,
} from "@graveyield/sdk";
import {
  FakeConnection,
  TOKEN_PROGRAM,
  encodeAmmInfo,
  encodeTokenAccountWithOwner,
} from "./helpers.js";

// ---- REAL mainnet constants (DO NOT MODIFY — see file docblock) -----------
const REAL_MARKET = new PublicKey("8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6");
const REAL_MARKET_PROGRAM = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
const REAL_VAULT_SIGNER = "CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7";
const REAL_STORED_NONCE = 1n;
const REAL_WSOL_MINT = WSOL_MINT;
const REAL_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// The canonical Raydium SOL/USDC V4 pool paired with that market.
const REAL_POOL = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");

// NONCE_OFFSET duplicates src/raydiumAccounts.ts MARKET_STATE_OFFSETS.
const NONCE_OFFSET = 45;

function nonceLe(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

// ----------------------------------------------------------------- fixture

interface FixtureOpts {
  storedNonce?: bigint;
  coinVaultOwner?: PublicKey;
  marketOwner?: PublicKey;
  marketDataLen?: number;
}

/** Real-market fixture (see file docblock) + the minimal AmmInfo scaffold. */
function installRealMarketFixture(rpc: FakeConnection, opts: FixtureOpts = {}) {
  const storedNonce = opts.storedNonce ?? REAL_STORED_NONCE;
  const marketOwner = opts.marketOwner ?? REAL_MARKET_PROGRAM;
  const marketDataLen = opts.marketDataLen ?? 388;

  // Deterministic synthetic scaffolding keys (vaults/open orders/... the
  // derivation validates their OWNERS, not their identities). Prefix bytes
  // are 0xc0+ so they can never collide with the market's own first byte
  // (REAL_MARKET[0] == 0x6a — a 0x6a-prefixed synth key WAS the market);
  // the loop below asserts that hard.
  const synth = (n: number) => {
    const b = new Uint8Array(32);
    b[0] = n;
    b.set(REAL_MARKET.toBytes().subarray(1), 1);
    return new PublicKey(b);
  };
  const ammCoinVault = synth(0xc1);
  const ammPcVault = synth(0xc2);
  const lpMint = synth(0xc3);
  const openOrders = synth(0xc4);
  const targetOrders = synth(0xc5);
  const marketCoinVault = synth(0xc6);
  const marketPcVault = synth(0xc7);
  const eventQ = synth(0xc8);
  const bids = synth(0xc9);
  const asks = synth(0xca);
  for (const [k, what] of [
    [ammCoinVault, "ammCoinVault"],
    [ammPcVault, "ammPcVault"],
    [lpMint, "lpMint"],
    [openOrders, "openOrders"],
    [targetOrders, "targetOrders"],
    [marketCoinVault, "marketCoinVault"],
    [marketPcVault, "marketPcVault"],
    [eventQ, "eventQ"],
    [bids, "bids"],
    [asks, "asks"],
  ] as const) {
    assert.ok(!k.equals(REAL_MARKET), `fixture key collision: ${what} == the market address`);
  }

  // AmmInfo (752 B) — the real pool pointing at the REAL market/program.
  rpc.setAccount(
    REAL_POOL,
    encodeAmmInfo({
      coinVault: ammCoinVault,
      pcVault: ammPcVault,
      baseMint: REAL_WSOL_MINT,
      quoteMint: REAL_USDC_MINT,
      lpMint,
      openOrders,
      market: REAL_MARKET,
      marketProgram: REAL_MARKET_PROGRAM,
      targetOrders,
    }),
    RAYDIUM_V4_PROGRAM_ID,
  );
  rpc.setAccount(
    ammCoinVault,
    encodeTokenAccountWithOwner(REAL_WSOL_MINT, REAL_POOL, 1n),
    TOKEN_PROGRAM,
  );
  rpc.setAccount(
    ammPcVault,
    encodeTokenAccountWithOwner(REAL_USDC_MINT, REAL_POOL, 1n),
    TOKEN_PROGRAM,
  );

  // Market account — real layout bytes; every read field real.
  const marketData = new Uint8Array(marketDataLen);
  marketData.set(Buffer.from("serum"), 0);
  if (marketDataLen >= NONCE_OFFSET + 8) {
    marketData.set(nonceLe(storedNonce), NONCE_OFFSET);
    marketData.set(REAL_MARKET.toBytes(), 13); // own_address (real value)
  }
  if (marketDataLen >= 53 + 32) marketData.set(REAL_WSOL_MINT.toBytes(), 53);
  if (marketDataLen >= 85 + 32) marketData.set(REAL_USDC_MINT.toBytes(), 85);
  if (marketDataLen >= 117 + 32) marketData.set(marketCoinVault.toBytes(), 117);
  if (marketDataLen >= 165 + 32) marketData.set(marketPcVault.toBytes(), 165);
  if (marketDataLen >= 253 + 32) marketData.set(eventQ.toBytes(), 253);
  if (marketDataLen >= 285 + 32) marketData.set(bids.toBytes(), 285);
  if (marketDataLen >= 317 + 32) marketData.set(asks.toBytes(), 317);
  rpc.setAccount(REAL_MARKET, marketData, marketOwner);

  // Market side accounts owned by the market program (as on mainnet).
  rpc.setAccount(openOrders, new Uint8Array(1664), REAL_MARKET_PROGRAM);
  rpc.setAccount(eventQ, new Uint8Array(72), REAL_MARKET_PROGRAM);
  rpc.setAccount(bids, new Uint8Array(72), REAL_MARKET_PROGRAM);
  rpc.setAccount(asks, new Uint8Array(72), REAL_MARKET_PROGRAM);

  // Serum vaults: SPL token accounts whose OWNER is the REAL signer.
  const vaultOwner = opts.coinVaultOwner ?? new PublicKey(REAL_VAULT_SIGNER);
  rpc.setAccount(
    marketCoinVault,
    encodeTokenAccountWithOwner(REAL_WSOL_MINT, vaultOwner, 1n),
    TOKEN_PROGRAM,
  );
  rpc.setAccount(
    marketPcVault,
    encodeTokenAccountWithOwner(REAL_USDC_MINT, vaultOwner, 1n),
    TOKEN_PROGRAM,
  );

  // Raydium-owned target orders.
  rpc.setAccount(targetOrders, new Uint8Array(9216), RAYDIUM_V4_PROGRAM_ID);

  return {
    pool: {
      poolAddress: REAL_POOL,
      coinVault: ammCoinVault,
      pcVault: ammPcVault,
      baseMint: REAL_WSOL_MINT,
      pcMint: REAL_USDC_MINT,
    },
  };
}

// ------------------------------------------------------------------- tests

describe("W5: OpenBook v1 vault-signer derivation (real fixture)", () => {
  test("canonical rule reproduces the REAL mainnet signer (pure math pin)", async () => {
    // Independent of the module under test: the runtime rule, the SDK's
    // sync mirror, and the real signer must agree.
    const viaRuntime = await PublicKey.createProgramAddress(
      [REAL_MARKET.toBytes(), nonceLe(REAL_STORED_NONCE)],
      REAL_MARKET_PROGRAM,
    );
    const viaSdk = createProgramAddressSync(
      [REAL_MARKET.toBytes(), nonceLe(REAL_STORED_NONCE)],
      REAL_MARKET_PROGRAM,
    );
    assert.equal(viaRuntime.toBase58(), REAL_VAULT_SIGNER);
    assert.equal(viaSdk.toBase58(), REAL_VAULT_SIGNER);

    // The removed string-seed scheme cannot describe this market.
    assert.notEqual(
      createProgramAddressSync(
        [Buffer.from("vault-signer"), REAL_MARKET.toBytes()],
        REAL_MARKET_PROGRAM,
      ).toBase58(),
      REAL_VAULT_SIGNER,
    );
    await assert.rejects(
      PublicKey.createProgramAddress(
        [Buffer.from("vault-signer"), REAL_MARKET.toBytes(), nonceLe(REAL_STORED_NONCE)],
        REAL_MARKET_PROGRAM,
      ),
      /off the ed25519 curve|Invalid seeds/i,
    );
  });

  test("full discovery path derives the REAL signer from the UNMODIFIED real market", async () => {
    const rpc = new FakeConnection();
    const { pool } = installRealMarketFixture(rpc);

    const derived = await deriveV4CpiAccounts(rpc.asConnection(), pool);
    assert.equal(derived.market.toBase58(), REAL_MARKET.toBase58());
    assert.equal(derived.marketProgram.toBase58(), REAL_MARKET_PROGRAM.toBase58());
    assert.equal(derived.marketVaultSigner.toBase58(), REAL_VAULT_SIGNER);
    // The 13-account CPI set carries the real signer at the pinned ra_idx 9
    // (programs/grave-vault/src/cpi/raydium_v4.rs MARKET_VAULT_SIGNER).
    const remaining = toRemainingAccounts(derived);
    assert.equal(remaining.length, 13);
    assert.equal(remaining[9].pubkey.toBase58(), REAL_VAULT_SIGNER);
  });

  test("NEGATIVE: tampered stored nonce fails closed at the vault owner check", async () => {
    // nonce 2 is the smallest tampered value whose derivation lands
    // OFF-curve for this market (probed offline), so the failure path is
    // the owner cross-check, deterministically — and the mismatch names
    // the signer the tampered nonce actually produced.
    const rpc = new FakeConnection();
    const { pool } = installRealMarketFixture(rpc, { storedNonce: 2n });

    await assert.rejects(deriveV4CpiAccounts(rpc.asConnection(), pool), (err: unknown) => {
      assert.ok(err instanceof MissingAccountsError, `expected MissingAccountsError, got ${err}`);
      assert.match(
        err.message,
        /market coin_vault token-account owner .* != the market vault signer/,
      );
      assert.match(err.message, /Forsp1iJcFeGJzc6YprLfDVNkzv5s9ZcdMeMyMd2CiTy/);
      return true;
    });
  });

  test("NEGATIVE: re-pointed vault owner fails closed", async () => {
    const rpc = new FakeConnection();
    const impostor = new PublicKey(new Uint8Array(32).fill(0x99));
    const { pool } = installRealMarketFixture(rpc, { coinVaultOwner: impostor });

    await assert.rejects(deriveV4CpiAccounts(rpc.asConnection(), pool), (err: unknown) => {
      assert.ok(err instanceof MissingAccountsError);
      assert.match(err.message, /market coin_vault token-account owner/);
      return true;
    });
  });

  test("NEGATIVE: market owned by a foreign program fails closed", async () => {
    const rpc = new FakeConnection();
    const foreign = new PublicKey(new Uint8Array(32).fill(0x77));
    const { pool } = installRealMarketFixture(rpc, { marketOwner: foreign });

    await assert.rejects(deriveV4CpiAccounts(rpc.asConnection(), pool), (err: unknown) => {
      assert.ok(err instanceof MissingAccountsError);
      assert.match(err.message, /market is owned by .* expected .*srmqPvym/);
      return true;
    });
  });

  test("NEGATIVE: truncated market data fails closed at the first unreadable field", async () => {
    // 50 bytes cannot even hold coin_mint@53 — the module's bounds-checked
    // readers fail closed before anything is derived (the nonce reader's
    // own bounds guard @45 is defense-in-depth behind these).
    const rpc = new FakeConnection();
    const { pool } = installRealMarketFixture(rpc, { marketDataLen: 50 });

    await assert.rejects(
      deriveV4CpiAccounts(rpc.asConnection(), pool),
      /account too short to read market coin_mint @ 53/,
    );
  });

  test("AmmInfo scaffold size matches the real layout", () => {
    // Guards accidental encoder drift against the 752-byte AmmInfo.
    assert.equal(RAYDIUM_V4_AMM_INFO_SIZE, 752);
  });
});
