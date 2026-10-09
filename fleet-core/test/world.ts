// SPDX-License-Identifier: Apache-2.0
//
// Fleet-core test "world" — installs a complete, internally-consistent
// pool universe into a FakeConnection: pool + vaults + mints + OpenBook
// market set + ProtocolConfigs + anchor/cert + LP holders (including
// the salvor's ATA) + swap history. Every fleet test builds on this.

import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  GraveYieldClient,
  eligibilityAnchorPda,
  eligibilityCertPda,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
} from "@graveyield/sdk";

import {
  AUTHORITY,
  FakeConnection,
  FIXED_NOW_MS,
  SCANNER_ID,
  TOKEN_PROGRAM,
  VAULT_ID,
  encodeAmmInfo,
  encodeAnchor,
  encodeCert,
  encodeMint,
  encodeMarketState,
  encodeScannerConfig,
  encodeTokenAccount,
  encodeVaultConfig,
  derivedKey,
} from "./helpers.js";

/** Deterministic OpenBook market program id for fixtures. */
export const MARKET_PROGRAM = new PublicKey(new Uint8Array(32).fill(0x5e));

export interface WorldOptions {
  /** Deterministic pool-address seed byte (default 0x42) — use distinct seeds for distinct identities in one test. */
  poolSeed?: number;
  /** WSOL reserve (lamports) — placed on the pc side by default. */
  wsolReserve: bigint;
  /** Memecoin reserve (base units) — coin side. */
  memecoinReserve: bigint;
  /** LP supply. Holders are generated so Σ balances == supply exactly. */
  lpSupply: bigint;
  /** The salvor's LP balance (must be ≤ lpSupply and < lpSupply for a second holder). */
  salvorLpAmount: bigint;
  /** Anchor epoch; defaults to (currentEpoch − 2) so the gap is satisfied. */
  firstEligibleEpoch?: bigint;
  /** Install a live cert with this expiry (unix SECONDS). */
  certExpiresAt?: bigint | null;
  invalidatedAnchor?: boolean;
  currentEpoch?: number;
  /** Coin side holds WSOL instead (mirror orientation). */
  coinIsWsol?: boolean;
}

export interface World {
  rpc: FakeConnection;
  client: GraveYieldClient;
  poolAddress: PublicKey;
  coinVault: PublicKey;
  pcVault: PublicKey;
  lpMint: PublicKey;
  memecoinMint: PublicKey;
  salvor: Keypair;
  salvorLpAta: PublicKey;
  anchorPda: PublicKey;
  certPda: PublicKey;
}

/** Build the world. Returns everything a test needs. */
export function buildWorld(opts: WorldOptions): World {
  const rpc = new FakeConnection();
  rpc.currentEpoch = opts.currentEpoch ?? 12;

  const poolAddress = new PublicKey(new Uint8Array(32).fill(opts.poolSeed ?? 0x42));
  const coinVault = derivedKey(0xc1, poolAddress);
  const pcVault = derivedKey(0xc2, poolAddress);
  const lpMint = derivedKey(0x11, poolAddress);
  const memecoinMint = derivedKey(0xb1, poolAddress);
  const openOrders = derivedKey(0x21, poolAddress);
  const market = derivedKey(0x22, poolAddress);
  const targetOrders = derivedKey(0x23, poolAddress);
  const marketCoinVault = derivedKey(0x31, poolAddress);
  const marketPcVault = derivedKey(0x32, poolAddress);
  const eventQ = derivedKey(0x33, poolAddress);
  const bids = derivedKey(0x34, poolAddress);
  const asks = derivedKey(0x35, poolAddress);

  const wsolMint = WSOL_MINT();
  const coinMint = opts.coinIsWsol ? wsolMint : memecoinMint;
  const pcMint = opts.coinIsWsol ? memecoinMint : wsolMint;

  // Pool + vaults + LP mint.
  rpc.setAccount(
    poolAddress,
    encodeAmmInfo({ coinVault, pcVault, baseMint: coinMint, quoteMint: pcMint, lpMint, openOrders, market, marketProgram: MARKET_PROGRAM, targetOrders }),
    RAYDIUM_V4(),
  );
  rpc.setAccount(coinVault, encodeTokenAccount(coinMint, opts.coinIsWsol ? opts.wsolReserve : opts.memecoinReserve), TOKEN_PROGRAM);
  rpc.setAccount(pcVault, encodeTokenAccount(pcMint, opts.coinIsWsol ? opts.memecoinReserve : opts.wsolReserve), TOKEN_PROGRAM);
  rpc.setAccount(lpMint, encodeMint(opts.lpSupply), TOKEN_PROGRAM);

  // Market + side accounts (owner programs are validated by the derivation).
  rpc.setAccount(market, encodeMarketState({ coinMint, pcMint, coinVault: marketCoinVault, pcVault: marketPcVault, eventQ, bids, asks }), MARKET_PROGRAM);
  // The market vault signer PDA (what the serum vaults' owner field must hold).
  const [marketVaultSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-signer"), market.toBytes()],
    MARKET_PROGRAM,
  );
  for (const [addr, what] of [
    [openOrders, "openOrders"],
    [marketCoinVault, "marketCoinVault"],
    [marketPcVault, "marketPcVault"],
    [eventQ, "eventQ"],
    [bids, "bids"],
    [asks, "asks"],
  ] as const) {
    if (what === "openOrders") {
      rpc.setAccount(addr, new Uint8Array(1664), MARKET_PROGRAM); // OpenOrders layout size (not parsed)
    } else if (what === "marketCoinVault" || what === "marketPcVault") {
      // Serum vaults are token accounts whose OWNER is the vault signer.
      const mint = what === "marketCoinVault" ? coinMint : pcMint;
      rpc.setAccount(addr, encodeTokenAccountWithOwner(mint, marketVaultSigner, 1_000n), TOKEN_PROGRAM);
    } else {
      rpc.setAccount(addr, new Uint8Array(72), MARKET_PROGRAM); // eventQ/bids/asks (not parsed)
    }
  }
  rpc.setAccount(targetOrders, new Uint8Array(9216), RAYDIUM_V4());

  // ProtocolConfigs.
  rpc.setAccount(scannerProtocolConfigPda(SCANNER_ID), encodeScannerConfig({}), SCANNER_ID);
  rpc.setAccount(vaultProtocolConfigPda(VAULT_ID), encodeVaultConfig({}), VAULT_ID);

  // Anchor + optional cert.
  const firstEligibleEpoch = BigInt(opts.firstEligibleEpoch ?? rpc.currentEpoch - 2);
  const anchorPda = eligibilityAnchorPda(SCANNER_ID, RAYDIUM_V4(), poolAddress);
  rpc.setAccount(
    anchorPda,
    encodeAnchor({ ammProgramId: RAYDIUM_V4(), poolAddress, firstEligibleEpoch, invalidated: opts.invalidatedAnchor ?? false }),
    SCANNER_ID,
  );
  const certPda = eligibilityCertPda(SCANNER_ID, RAYDIUM_V4(), poolAddress);
  if (opts.certExpiresAt !== undefined && opts.certExpiresAt !== null) {
    rpc.setAccount(
      certPda,
      encodeCert({ ammProgramId: RAYDIUM_V4(), poolAddress, anchorEpoch: firstEligibleEpoch, expiresAt: opts.certExpiresAt }),
      SCANNER_ID,
    );
  }

  // Salvor first, then holders whose Σ == lpSupply exactly (the
  // snapshot completeness gate hard-fails otherwise).
  const salvor = Keypair.generate();
  const salvorLpAta = getAssociatedTokenAddressSync(lpMint, salvor.publicKey);
  const secondHolder = Keypair.generate().publicKey;
  const restBalance = opts.lpSupply - opts.salvorLpAmount;
  const holders: Array<{ owner: PublicKey; balance: bigint }> = [
    { owner: salvor.publicKey, balance: opts.salvorLpAmount },
    ...(restBalance > 0n ? [{ owner: secondHolder, balance: restBalance }] : []),
  ];
  for (const h of holders) {
    const ata = getAssociatedTokenAddressSync(lpMint, h.owner);
    rpc.setAccount(ata, encodeTokenAccountWithOwner(lpMint, h.owner, h.balance), TOKEN_PROGRAM);
  }

  // Swap history 100 days back (C1 satisfied at the SDK level).
  rpc.setSwapHistory(poolAddress, RAYDIUM_V4(), { coinVault, pcVault }, { lastSwapAgeSeconds: 100 * 86_400 });

  const client = new GraveYieldClient({
    connection: rpc.asConnection(),
    cluster: "localnet",
    graveScannerProgramId: SCANNER_ID,
    graveVaultProgramId: VAULT_ID,
  });

  return {
    rpc,
    client,
    poolAddress,
    coinVault,
    pcVault,
    lpMint,
    memecoinMint,
    salvor,
    salvorLpAta,
    anchorPda,
    certPda,
  };
}

// Local shims to avoid circular imports in the helper.
import { RAYDIUM_V4_PROGRAM_ID } from "@graveyield/sdk";
function RAYDIUM_V4(): PublicKey {
  return RAYDIUM_V4_PROGRAM_ID;
}
function WSOL_MINT(): PublicKey {
  return WSOL_MINT_LOCAL;
}
import { WSOL_MINT as WSOL_MINT_LOCAL } from "@graveyield/sdk";
import type BN from "bn.js";
export type { BN };
export { AUTHORITY, FIXED_NOW_MS };

/** Token account with a real owner field (snapshot aggregation needs it). */
function encodeTokenAccountWithOwner(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  buf.set(mint.toBytes(), 0);
  buf.set(owner.toBytes(), 32);
  const view = new DataView(buf.buffer);
  view.setBigUint64(64, amount, true);
  view.setUint8(108, 1);
  return buf;
}
