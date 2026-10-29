// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 account derivation for the salvage CPI (FLEET-M1).
//
// Derives the 13 `remaining_accounts` the GraveVault salvage_pool CPI
// forwards to Raydium V4 — from the LIVE AmmInfo bytes and the live
// Serum market account, NOT from caller-supplied addresses.
//
// Offset provenance (all fork-proven against real mainnet state by
// `scripts/fetch_v4_fork_fixtures.mjs` + `programs/grave-vault/tests/
// raydium_v4_fork.rs`, which execute a real LP burn against live
// AmmInfo/market state and reject scrambled orderings):
//
//   AmmInfo (752 bytes, raydium-amm program/src/state.rs):
//     coin_vault@336  pc_vault@368  coin_mint@400  pc_mint@432
//     lp_mint@464  open_orders@496  market@528  market_program@560
//     target_orders@592
//
//   Serum MarketState (absolute offsets in the account data,
//   project-serum/serum-dex dex/src/state.rs, 5-byte "serum" head):
//     coin_mint@53  pc_mint@85  coin_vault@117  pc_vault@165
//     event_q@253  bids@285  asks@317
//     vault_signer_nonce@45 (u64 LE)
//
//   market vault signer (W5, canonical OpenBook v1 rule):
//     create_program_address([market.to_bytes(), nonce_u64_le], market_program)
//   — Serum DEX v3 / OpenBook v1 `MarketState::vault_signer_key`: the
//   nonce is the u64 LE field STORED in the market account at absolute
//   offset 45; there are NO string seeds and NO bump search. Empirically
//   pinned against the REAL mainnet SOL/USDC market 8BnEg..XTh6 (program
//   srmqPvym..tPX, stored nonce 1): this rule reproduces the real signer
//   CTz5UMLQ..DfF7 that owns both market vault token accounts, while the
//   former string-seed PDA scheme does not (and with the real nonce its
//   seeds do not even form a valid program address — see
//   test/raydiumAccounts.test.ts and the protocol repo's committed
//   Finding E vectors). Only serum-family MarketState programs (Serum
//   v3 / OpenBook v1 — the only market programs Raydium V4 AmmInfo
//   instances pair with) are supported; any other program fails closed
//   at the vault-token-account owner cross-check below.
//
// EVERYTHING read from chain is untrusted until validated below: owner
// programs, mint binding between AmmInfo and the market, vault-signer
// re-derivation, and account existence. A single mismatch fails
// closed with a `MissingAccountsError` naming the offender.

import { PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_V4_AMM_AUTHORITY,
  RAYDIUM_V4_PROGRAM_ID,
  createProgramAddressSync,
  raydiumV4RemainingAccounts,
  type V4PoolAccount,
} from "@graveyield/sdk";

/** AmmInfo offsets for the CPI-relevant pubkeys (see module docblock). */
export const AMM_INFO_OFFSETS = {
  COIN_VAULT: 336,
  PC_VAULT: 368,
  COIN_VAULT_MINT: 400,
  PC_VAULT_MINT: 432,
  LP_MINT: 464,
  OPEN_ORDERS: 496,
  MARKET: 528,
  MARKET_PROGRAM: 560,
  TARGET_ORDERS: 592,
} as const;

/** Serum MarketState absolute offsets (see module docblock). */
export const MARKET_STATE_OFFSETS = {
  VAULT_SIGNER_NONCE: 45,
  COIN_MINT: 53,
  PC_MINT: 85,
  COIN_VAULT: 117,
  PC_VAULT: 165,
  EVENT_Q: 253,
  BIDS: 285,
  ASKS: 317,
} as const;

const PUBKEY_LEN = 32;

/** Read a pubkey at an offset, validating bounds. */
function readPubkey(data: Uint8Array, offset: number, what: string): PublicKey {
  if (data.length < offset + PUBKEY_LEN) {
    throw new Error(`account too short to read ${what} @ ${offset} (len ${data.length})`);
  }
  return new PublicKey(data.slice(offset, offset + PUBKEY_LEN));
}

/** Read a u64 LE at an offset, validating bounds. */
function readU64LE(data: Uint8Array, offset: number, what: string): bigint {
  if (data.length < offset + 8) {
    throw new Error(`account too short to read ${what} @ ${offset} (len ${data.length})`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

/** Fail-closed error naming the offending account. */
export class MissingAccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingAccountsError";
  }
}

/** The derived, validated 13-account set (also returned expanded for tests). */
export interface DerivedV4Accounts {
  ammAuthority: PublicKey;
  ammOpenOrders: PublicKey;
  ammTargetOrders: PublicKey;
  ammCoinVault: PublicKey;
  ammPcVault: PublicKey;
  marketProgram: PublicKey;
  market: PublicKey;
  marketCoinVault: PublicKey;
  marketPcVault: PublicKey;
  marketVaultSigner: PublicKey;
  marketEventQueue: PublicKey;
  marketBids: PublicKey;
  marketAsks: PublicKey;
}

/** Fetch an account, failing closed with a named error. */
async function fetchAccount(
  connection: import("@solana/web3.js").Connection,
  address: PublicKey,
  what: string,
): Promise<{ data: Uint8Array; owner: PublicKey }> {
  const info = await connection.getAccountInfo(address);
  if (!info) {
    throw new MissingAccountsError(`${what} ${address.toBase58()} not found on chain`);
  }
  return { data: info.data, owner: info.owner };
}

function requireOwner(owner: PublicKey, expected: PublicKey, what: string): void {
  if (!owner.equals(expected)) {
    throw new MissingAccountsError(
      `${what} is owned by ${owner.toBase58()}, expected ${expected.toBase58()}`,
    );
  }
}

/**
 * Derive + validate the full 13-account set for a pool. Throws
 * `MissingAccountsError` on ANY inconsistency — the caller must treat
 * that as terminal for this attempt (re-derivation on retry).
 */
export async function deriveV4CpiAccounts(
  connection: import("@solana/web3.js").Connection,
  pool: V4PoolAccount,
): Promise<DerivedV4Accounts> {
  const poolInfo = await fetchAccount(connection, pool.poolAddress, "pool");
  requireOwner(poolInfo.owner, RAYDIUM_V4_PROGRAM_ID, "pool");

  // --- AmmInfo fields.
  const openOrders = readPubkey(poolInfo.data, AMM_INFO_OFFSETS.OPEN_ORDERS, "amm_open_orders");
  const market = readPubkey(poolInfo.data, AMM_INFO_OFFSETS.MARKET, "market");
  const marketProgram = readPubkey(
    poolInfo.data,
    AMM_INFO_OFFSETS.MARKET_PROGRAM,
    "market_program",
  );
  const targetOrders = readPubkey(
    poolInfo.data,
    AMM_INFO_OFFSETS.TARGET_ORDERS,
    "amm_target_orders",
  );

  // --- Serum market state.
  const marketInfo = await fetchAccount(connection, market, "market");
  requireOwner(marketInfo.owner, marketProgram, "market");
  const serumCoinMint = readPubkey(
    marketInfo.data,
    MARKET_STATE_OFFSETS.COIN_MINT,
    "market coin_mint",
  );
  const serumPcMint = readPubkey(marketInfo.data, MARKET_STATE_OFFSETS.PC_MINT, "market pc_mint");
  const marketCoinVault = readPubkey(
    marketInfo.data,
    MARKET_STATE_OFFSETS.COIN_VAULT,
    "market coin_vault",
  );
  const marketPcVault = readPubkey(
    marketInfo.data,
    MARKET_STATE_OFFSETS.PC_VAULT,
    "market pc_vault",
  );
  const eventQueue = readPubkey(marketInfo.data, MARKET_STATE_OFFSETS.EVENT_Q, "market event_q");
  const bids = readPubkey(marketInfo.data, MARKET_STATE_OFFSETS.BIDS, "market bids");
  const asks = readPubkey(marketInfo.data, MARKET_STATE_OFFSETS.ASKS, "market asks");

  // Bind the market to the pool's mints (AmmInfo coin/pc mints @400/@432).
  const ammCoinMint = readPubkey(poolInfo.data, AMM_INFO_OFFSETS.COIN_VAULT_MINT, "amm coin mint");
  const ammPcMint = readPubkey(poolInfo.data, AMM_INFO_OFFSETS.PC_VAULT_MINT, "amm pc mint");
  if (!serumCoinMint.equals(ammCoinMint) || !serumPcMint.equals(ammPcMint)) {
    throw new MissingAccountsError(
      `market mints (${serumCoinMint.toBase58()}/${serumPcMint.toBase58()}) do not bind ` +
        `the pool's AmmInfo mints (${ammCoinMint.toBase58()}/${ammPcMint.toBase58()})`,
    );
  }

  // --- Market-owned side accounts.
  // OpenBook v1 vault signer (W5): create_program_address([market,
  // nonce_le], market_program) with the nonce STORED in the market
  // account (u64 LE @45). Not a PDA — no string seeds, no bump search.
  const vaultSignerNonce = readU64LE(
    marketInfo.data,
    MARKET_STATE_OFFSETS.VAULT_SIGNER_NONCE,
    "market vault_signer_nonce",
  );
  const nonceSeed = Buffer.alloc(8);
  nonceSeed.writeBigUInt64LE(vaultSignerNonce);
  let marketVaultSigner: PublicKey;
  try {
    marketVaultSigner = createProgramAddressSync([market.toBytes(), nonceSeed], marketProgram);
  } catch (err) {
    throw new MissingAccountsError(
      `market ${market.toBase58()} vault-signer derivation failed for stored nonce ` +
        `${vaultSignerNonce} under ${marketProgram.toBase58()}: ${(err as Error).message}`,
    );
  }
  // OpenOrders / event queue / bids / asks are owned by the MARKET program.
  for (const [address, what] of [
    [openOrders, "amm_open_orders"],
    [eventQueue, "market event_q"],
    [bids, "market bids"],
    [asks, "market asks"],
  ] as const) {
    const acc = await fetchAccount(connection, address, what);
    requireOwner(acc.owner, marketProgram, what);
  }
  // Serum coin/pc vaults are SPL TOKEN accounts whose token-account
  // OWNER field is the market vault signer (fork-fixture-proven: both
  // vaults share one owner == the vault signer). This cross-check is the
  // ground truth that pins the derivation above: a market with a
  // tampered nonce, a foreign market program, or re-pointed vaults
  // fails closed HERE.
  const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  for (const [address, what] of [
    [marketCoinVault, "market coin_vault"],
    [marketPcVault, "market pc_vault"],
  ] as const) {
    const acc = await fetchAccount(connection, address, what);
    requireOwner(acc.owner, SPL_TOKEN_PROGRAM_ID, what);
    const ownerField = readPubkey(acc.data, 32, `${what} owner`);
    if (!ownerField.equals(marketVaultSigner)) {
      throw new MissingAccountsError(
        `${what} token-account owner ${ownerField.toBase58()} != the market vault signer ${marketVaultSigner.toBase58()}`,
      );
    }
  }

  // --- Raydium-owned side accounts.
  const targetInfo = await fetchAccount(connection, targetOrders, "amm_target_orders");
  requireOwner(targetInfo.owner, RAYDIUM_V4_PROGRAM_ID, "amm_target_orders");

  // Coin/pc vault tokens belong to the SPL token program and carry the
  // AmmInfo mints (the SDK already binds them in fetchV4Pool, but this
  // module re-asserts against the LIVE bytes it read itself).
  const vaultChecks: Array<{ address: PublicKey; what: string; expectedMint: PublicKey }> = [
    { address: pool.coinVault, what: "amm coin vault", expectedMint: ammCoinMint },
    { address: pool.pcVault, what: "amm pc vault", expectedMint: ammPcMint },
  ];
  for (const { address, what, expectedMint } of vaultChecks) {
    const acc = await fetchAccount(connection, address, what);
    requireOwner(acc.owner, SPL_TOKEN_PROGRAM_ID, what);
    const mint = readPubkey(acc.data, 0, `${what} mint`);
    if (!mint.equals(expectedMint)) {
      throw new MissingAccountsError(
        `${what} holds mint ${mint.toBase58()}, expected ${expectedMint.toBase58()}`,
      );
    }
  }

  return {
    ammAuthority: RAYDIUM_V4_AMM_AUTHORITY,
    ammOpenOrders: openOrders,
    ammTargetOrders: targetOrders,
    ammCoinVault: pool.coinVault,
    ammPcVault: pool.pcVault,
    marketProgram,
    market,
    marketCoinVault,
    marketPcVault,
    marketVaultSigner,
    marketEventQueue: eventQueue,
    marketBids: bids,
    marketAsks: asks,
  };
}

/**
 * Convert the derived set into the SDK's canonical 13 remaining
 * accounts (exact ra_idx order — see `salvagePool.ts`).
 */
export function toRemainingAccounts(
  d: DerivedV4Accounts,
): ReturnType<typeof raydiumV4RemainingAccounts> {
  return raydiumV4RemainingAccounts(
    { coinVault: d.ammCoinVault, pcVault: d.ammPcVault },
    {
      ammOpenOrders: d.ammOpenOrders,
      ammTargetOrders: d.ammTargetOrders,
      marketProgram: d.marketProgram,
      market: d.market,
      marketCoinVault: d.marketCoinVault,
      marketPcVault: d.marketPcVault,
      marketVaultSigner: d.marketVaultSigner,
      marketEventQueue: d.marketEventQueue,
      marketBids: d.marketBids,
      marketAsks: d.marketAsks,
    },
  );
}
