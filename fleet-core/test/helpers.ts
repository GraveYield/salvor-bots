// SPDX-License-Identifier: Apache-2.0
//
// Fleet-core test helpers — in-memory encoders (byte-exact against the
// SDK decoders) + a FakeConnection covering everything the pipeline
// touches: accounts, getProgramAccounts (with memcmp), swap history for
// the C1 derivation, slot hashes, simulation, and the epoch clock.
// NO NETWORK. No keys beyond throwaway test keypairs.

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  AccountDisc,
  RAYDIUM_V4_AMM_INFO_SIZE,
  WSOL_MINT,
  writer,
} from "@graveyield/sdk";

// ------------------------------------------------------------- constants

export const FIXED_NOW_MS = 1_800_000_000_000;
export const FIXED_NOW_SEC = BigInt(Math.floor(FIXED_NOW_MS / 1000));
export const FIXED_SLOT = 1_000_000;
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export const AUTHORITY = new PublicKey(new Uint8Array(32).fill(0xa1));
export const SCANNER_ID = new PublicKey(new Uint8Array(32).fill(0x5c));
export const VAULT_ID = new PublicKey(new Uint8Array(32).fill(0x76));
export const TEST_ORACLE = bs58.encode(new Uint8Array(32).fill(0x07));

// -------------------------------------------------------- account encoders

export function encodeScannerConfig(opts: {
  inactivitySeconds?: bigint;
  priceCollapseBps?: number;
  minTvlLamports?: bigint;
  anchorStalenessSeconds?: bigint;
  lpBurnDustThreshold?: bigint;
  certTtlSeconds?: bigint;
  activityOracle?: PublicKey;
  launchPriceOracle?: PublicKey;
  paused?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 1)
    .bytes(AccountDisc.ProtocolConfig)
    .bytes(AUTHORITY.toBytes())
    .bytes(PublicKey.default.toBytes())
    .i64(0n)
    .u64(opts.inactivitySeconds ?? 7_776_000n)
    .u16(opts.priceCollapseBps ?? 9_900)
    .u64(opts.minTvlLamports ?? 500_000_000n)
    .u64(opts.anchorStalenessSeconds ?? 1_209_600n)
    .u64(opts.lpBurnDustThreshold ?? 1_000n)
    .i64(opts.certTtlSeconds ?? 3_600n)
    .bool(opts.paused ?? false)
    .bytes((opts.activityOracle ?? AUTHORITY).toBytes())
    .bytes((opts.launchPriceOracle ?? AUTHORITY).toBytes())
    .u8(255)
    .done();
}

export function encodeVaultConfig(opts: {
  maxPriorityFeeCeilingLamports?: bigint;
  salvorShareBps?: number;
  maxSlippageBps?: number;
  jupiterDustThresholdLamports?: bigint;
  paused?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 + 2 + 2 + 2 + 8 + 2 + 8 + 8 + 1 + 1)
    .bytes(AccountDisc.ProtocolConfig)
    .bytes(AUTHORITY.toBytes())
    .bytes(PublicKey.default.toBytes())
    .i64(0n)
    .u16(4_000) // lpHolderShareBps
    .u16(opts.salvorShareBps ?? 4_000)
    .u16(2_000) // protocolShareBps
    .u64(opts.maxPriorityFeeCeilingLamports ?? 1_000_000_000n)
    .u16(opts.maxSlippageBps ?? 300)
    .u64(opts.jupiterDustThresholdLamports ?? 666_666n)
    .i64(259_200n)
    .bool(opts.paused ?? false)
    .u8(255)
    .done();
}

export function encodeAnchor(opts: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  firstEligibleEpoch: bigint;
  writtenAt?: bigint;
  invalidated?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1)
    .bytes(AccountDisc.EligibilityAnchor)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(AUTHORITY.toBytes())
    .u64(opts.firstEligibleEpoch)
    .i64(opts.writtenAt ?? FIXED_NOW_SEC - 10_000n)
    .bool(opts.invalidated ?? false)
    .u8(0x3f)
    .u8(254)
    .done();
}

export function encodeCert(opts: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  anchorEpoch: bigint;
  /** Unix SECONDS when the cert expires. */
  expiresAt: bigint;
}): Uint8Array {
  return writer(8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 1)
    .bytes(AccountDisc.EligibilityCert)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(AUTHORITY.toBytes())
    .u64(opts.anchorEpoch)
    .u64(opts.anchorEpoch + 2n)
    .i64(opts.expiresAt - 3_600n)
    .i64(opts.expiresAt)
    .u8(0x3f)
    .u64(0n)
    .u8(253)
    .done();
}

export function encodeTokenAccount(mint: PublicKey, amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  buf.set(mint.toBytes(), 0);
  buf.set(PublicKey.default.toBytes(), 32);
  const view = new DataView(buf.buffer);
  view.setBigUint64(64, amount, true);
  view.setUint8(108, 1);
  return buf;
}

export function encodeMint(supply: bigint): Uint8Array {
  const buf = new Uint8Array(82);
  const view = new DataView(buf.buffer);
  view.setBigUint64(36, supply, true);
  view.setUint8(44, 9);
  view.setUint8(45, 1);
  return buf;
}

export function encodeAmmInfo(opts: {
  coinVault: PublicKey;
  pcVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  openOrders: PublicKey;
  market: PublicKey;
  marketProgram: PublicKey;
  targetOrders: PublicKey;
}): Uint8Array {
  const buf = new Uint8Array(RAYDIUM_V4_AMM_INFO_SIZE);
  buf.set(opts.coinVault.toBytes(), 336);
  buf.set(opts.pcVault.toBytes(), 368);
  buf.set(opts.baseMint.toBytes(), 400);
  buf.set(opts.quoteMint.toBytes(), 432);
  buf.set(opts.lpMint.toBytes(), 464);
  buf.set(opts.openOrders.toBytes(), 496);
  buf.set(opts.market.toBytes(), 528);
  buf.set(opts.marketProgram.toBytes(), 560);
  buf.set(opts.targetOrders.toBytes(), 592);
  return buf;
}

/** Serum MarketState — only the offsets the derivation validates. */
export function encodeMarketState(opts: {
  coinMint: PublicKey;
  pcMint: PublicKey;
  coinVault: PublicKey;
  pcVault: PublicKey;
  eventQ: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
}): Uint8Array {
  const buf = new Uint8Array(388);
  buf.set(Buffer.from("serum"), 0);
  buf.set(opts.coinMint.toBytes(), 53);
  buf.set(opts.pcMint.toBytes(), 85);
  buf.set(opts.coinVault.toBytes(), 117);
  buf.set(opts.pcVault.toBytes(), 165);
  buf.set(opts.eventQ.toBytes(), 253);
  buf.set(opts.bids.toBytes(), 285);
  buf.set(opts.asks.toBytes(), 317);
  return buf;
}

export function encodeSalvageReceipt(opts: {
  poolAddress: PublicKey;
  salvor: PublicKey;
  lpHolderAmountLamports: bigint;
  salvorAmountLamports: bigint;
  protocolAmountLamports: bigint;
  totalProceedsLamports: bigint;
  memecoinMint: PublicKey;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 * 4 + 8 + 8 + 32 + 8 + 8 + 1 + 32)
    .bytes(AccountDisc.SalvageReceipt)
    .bytes(opts.poolAddress.toBytes())
    .bytes(opts.salvor.toBytes())
    .u64(opts.lpHolderAmountLamports)
    .u64(opts.salvorAmountLamports)
    .u64(opts.protocolAmountLamports)
    .u64(opts.totalProceedsLamports)
    .u64(1_000_050n) // issuedAtSlot
    .i64(FIXED_NOW_SEC) // issuedAtTs
    .bytes(opts.memecoinMint.toBytes())
    .u64(0n) // dust
    .i64(0n)
    .u8(251)
    .bytes(new Uint8Array(32))
    .done();
}

// ------------------------------------------------------------- fixtures

/** Derive a fixture-unique key from a pool address. */
export function derivedKey(prefixByte: number, poolAddress: PublicKey): PublicKey {
  const bytes = poolAddress.toBytes();
  const out = new Uint8Array(32);
  out[0] = prefixByte;
  out.set(bytes.subarray(1), 1);
  return new PublicKey(out);
}

/** A transaction shape satisfying deriveLastSwapV4 (SDK's swap extractor). */
export function makeSwapTxLike(opts: {
  programId: PublicKey;
  poolAddress: PublicKey;
  coinVault: PublicKey;
  pcVault: PublicKey;
  blockTime: number;
  slot: number;
  signature: string;
  coinPre: string;
  coinPost: string;
  pcPre: string;
  pcPost: string;
}): unknown {
  return {
    transaction: {
      message: {
        getAccountKeys: () => ({
          keySegments: () => [[opts.programId, opts.poolAddress, opts.coinVault, opts.pcVault]],
        }),
        compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [1] }],
      },
    },
    meta: {
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [
        { accountIndex: 2, mint: opts.poolAddress.toBase58(), uiTokenAmount: { amount: opts.coinPre } },
        { accountIndex: 3, mint: opts.poolAddress.toBase58(), uiTokenAmount: { amount: opts.pcPre } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: opts.poolAddress.toBase58(), uiTokenAmount: { amount: opts.coinPost } },
        { accountIndex: 3, mint: opts.poolAddress.toBase58(), uiTokenAmount: { amount: opts.pcPost } },
      ],
    },
    blockTime: opts.blockTime,
    slot: opts.slot,
  };
}

// --------------------------------------------------------- FakeConnection

interface SigInfo {
  signature: string;
  slot: number;
  err: null;
  blockTime: number;
}

/** Everything the fleet-core pipeline + revalidator touch, in memory. */
export class FakeConnection {
  readonly accounts = new Map<string, AccountInfo<Uint8Array>>();
  readonly signaturesByPool = new Map<string, SigInfo[]>();
  readonly transactions = new Map<string, unknown>();
  /** Simulation results keyed by "the tx's last instruction program id" — or a default. */
  simulationResult: { err: unknown; logs: string[]; unitsConsumed: number } = {
    err: null,
    logs: ["sim ok"],
    unitsConsumed: 424_242,
  };
  currentEpoch = 12;
  currentSlot = FIXED_SLOT;
  blockTime = Math.floor(FIXED_NOW_MS / 1000);
  blockhash = bs58.encode(new Uint8Array(32).fill(9));
  /** Transactions the injected "sender" saw (tests assert on these). */
  readonly sentTransactions: import("@solana/web3.js").Transaction[] = [];
  /** Next signature the fake sender returns. */
  nextSignature = "FAKE_SIG_0000000000000000000000000000000000000000000000000000000000000000";
  /** Failure to inject into the fake sender. */
  sendError: Error | null = null;

  setAccount(address: PublicKey, data: Uint8Array, owner: PublicKey): void {
    this.accounts.set(address.toBase58(), {
      lamports: 1_000_000,
      data: Buffer.from(data),
      owner,
      executable: false,
      rentEpoch: 0n,
    } as AccountInfo<Uint8Array>);
  }

  deleteAccount(address: PublicKey): void {
    this.accounts.delete(address.toBase58());
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }

  /** Install a recent swap for a pool (feeds deriveLastSwapV4 / C1). */
  setSwapHistory(
    poolAddress: PublicKey,
    programId: PublicKey,
    pool: { coinVault: PublicKey; pcVault: PublicKey },
    opts?: { lastSwapAgeSeconds?: number; neverSwapped?: boolean },
  ): void {
    const age = opts?.lastSwapAgeSeconds ?? 100 * 86_400;
    if (opts?.neverSwapped) {
      this.signaturesByPool.set(poolAddress.toBase58(), []);
      return;
    }
    const blockTime = this.blockTime - age;
    const signature = `SWAP_SIG_${blockTime}_${poolAddress.toBase58().slice(0, 6)}`;
    this.signaturesByPool.set(poolAddress.toBase58(), [{ signature, slot: 99_000, err: null, blockTime }]);
    this.transactions.set(
      signature,
      makeSwapTxLike({
        programId,
        poolAddress,
        coinVault: pool.coinVault,
        pcVault: pool.pcVault,
        blockTime,
        slot: 99_000,
        signature,
        coinPre: "1000000",
        coinPost: "1100000",
        pcPre: "100000",
        pcPost: "90000",
      }),
    );
  }

  /** Fake "sender" — records the tx, returns a signature (or throws). */
  async fakeSend(connection: Connection, tx: import("@solana/web3.js").Transaction): Promise<string> {
    void connection;
    if (this.sendError) throw this.sendError;
    this.sentTransactions.push(tx);
    const sig = this.nextSignature;
    // Rotate so multiple sends are distinguishable.
    this.nextSignature = `FAKE_SIG_${this.sentTransactions.length.toString().padStart(4, "0")}${"0".repeat(56)}`;
    return sig;
  }

  // ---- Connection surface ----

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  async getProgramAccounts(
    programId: PublicKey,
    opts?: {
      filters?: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }>;
      encoding?: string;
    },
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Uint8Array> }>> {
    const out: Array<{ pubkey: PublicKey; account: AccountInfo<Uint8Array> }> = [];
    const dataSize = opts?.filters?.find((f) => f.dataSize !== undefined)?.dataSize;
    const memcmp = opts?.filters?.find((f) => f.memcmp !== undefined)?.memcmp;
    for (const [addr, account] of this.accounts) {
      if (!account.owner.equals(programId)) continue;
      if (dataSize !== undefined && account.data.length !== dataSize) continue;
      if (memcmp) {
        const target = new PublicKey(bs58.decode(memcmp.bytes));
        const slice = account.data.subarray(memcmp.offset, memcmp.offset + 32);
        if (!target.equals(new PublicKey(slice))) continue;
      }
      out.push({ pubkey: new PublicKey(addr), account });
    }
    return out;
  }

  async getSignaturesForAddress(
    address: PublicKey,
    opts?: { limit?: number; before?: string },
  ): Promise<SigInfo[]> {
    const all = this.signaturesByPool.get(address.toBase58()) ?? [];
    const limit = opts?.limit ?? all.length;
    let out = all;
    if (opts?.before !== undefined) {
      const idx = all.findIndex((s) => s.signature === opts.before);
      out = idx >= 0 ? all.slice(idx + 1) : [];
    }
    return out.slice(0, limit);
  }

  async getTransaction(signature: string): Promise<unknown> {
    return this.transactions.get(signature) ?? null;
  }

  async getSlot(): Promise<number> {
    return this.currentSlot;
  }

  async getBlock(): Promise<{ blockhash: string; blockTime: number } | null> {
    return { blockhash: this.blockhash, blockTime: this.blockTime };
  }

  async getEpochInfo(): Promise<{
    epoch: number;
    absoluteSlot: number;
    blockHeight: number;
    slotIndex: number;
    slotsInEpoch: number;
    transactionCount: bigint;
  }> {
    return {
      epoch: this.currentEpoch,
      absoluteSlot: this.currentSlot,
      blockHeight: this.currentSlot,
      slotIndex: 0,
      slotsInEpoch: 432_000,
      transactionCount: 0n,
    };
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    return { blockhash: this.blockhash, lastValidBlockHeight: 10_000n };
  }

  async simulateTransaction(_tx: unknown, _opts?: unknown): Promise<{ value: { err: unknown; logs: string[]; unitsConsumed: number } }> {
    return { value: { ...this.simulationResult } };
  }
}
