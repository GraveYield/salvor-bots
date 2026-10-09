// SPDX-License-Identifier: Apache-2.0
//
// Scout test helpers — account encoders (byte-exact against the SDK
// decoders) plus a FakeConnection that implements the exact Connection
// surface the Scout and the SDK touch, with no network.

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  AccountDisc,
  RAYDIUM_V4_PROGRAM_ID,
  RAYDIUM_V4_AMM_INFO_SIZE,
  WSOL_MINT,
  writer,
} from "@graveyield/sdk";

// ------------------------------------------------------------- fixed clock

/**
 * Fixed "now" for deterministic tests — captured once at module load so
 * every fixture (swap ages, anchor timestamps, cert TTLs) is relative to
 * the SAME instant the production code's Date.now() comparisons see.
 * (A far-future constant would silently flip C1/staleness comparisons.)
 */
export const FIXED_NOW = Math.floor(Date.now() / 1000);

/** Fixed current slot / epoch for the fake connection. */
export const FIXED_SLOT = 1_000_000;

// -------------------------------------------------------- account encoders

/** Encode a GraveScanner ProtocolConfig account (layout: accountDecoders.ts). */
export function encodeScannerConfig(opts: {
  authority: PublicKey;
  inactivitySeconds?: bigint;
  priceCollapseBps?: number;
  minTvlLamports?: bigint;
  anchorStalenessSeconds?: bigint;
  lpBurnDustThreshold?: bigint;
  certTtlSeconds?: bigint;
  activityOracle: PublicKey;
  launchPriceOracle: PublicKey;
  paused?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 1)
    .bytes(AccountDisc.ProtocolConfig)
    .bytes(opts.authority.toBytes())
    .bytes(PublicKey.default.toBytes()) // pendingAuthority
    .i64(0n) // pendingAuthorityEta
    .u64(opts.inactivitySeconds ?? 7_776_000n)
    .u16(opts.priceCollapseBps ?? 9_900)
    .u64(opts.minTvlLamports ?? 500_000_000n)
    .u64(opts.anchorStalenessSeconds ?? 1_209_600n)
    .u64(opts.lpBurnDustThreshold ?? 1_000n)
    .i64(opts.certTtlSeconds ?? 3_600n)
    .bool(opts.paused ?? false)
    .bytes(opts.activityOracle.toBytes())
    .bytes(opts.launchPriceOracle.toBytes())
    .u8(255) // bump
    .done();
}

/** Encode a GraveVault ProtocolConfig account (layout: accountDecoders.ts). */
export function encodeVaultConfig(opts: {
  authority: PublicKey;
  maxPriorityFeeCeilingLamports?: bigint;
  paused?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 8 + 2 + 2 + 2 + 8 + 2 + 8 + 8 + 1 + 1)
    .bytes(AccountDisc.ProtocolConfig)
    .bytes(opts.authority.toBytes())
    .bytes(PublicKey.default.toBytes()) // pendingAuthority
    .i64(0n) // pendingAuthorityEta
    .u16(4_000) // lpHolderShareBps
    .u16(4_000) // salvorShareBps
    .u16(2_000) // protocolShareBps
    .u64(opts.maxPriorityFeeCeilingLamports ?? 1_000_000_000n)
    .u16(300) // maxSlippageBps
    .u64(666_666n) // jupiterDustThresholdLamports
    .i64(259_200n) // timelockSeconds
    .bool(opts.paused ?? false)
    .u8(255) // bump
    .done();
}

/** Encode an EligibilityAnchor account (layout: accountDecoders.ts). */
export function encodeAnchor(opts: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  writer: PublicKey;
  firstEligibleEpoch: bigint;
  writtenAt: bigint;
  invalidated?: boolean;
}): Uint8Array {
  return writer(8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1)
    .bytes(AccountDisc.EligibilityAnchor)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(opts.writer.toBytes())
    .u64(opts.firstEligibleEpoch)
    .i64(opts.writtenAt)
    .bool(opts.invalidated ?? false)
    .u8(0x3f) // criteriaBitmap — all six
    .u8(254) // bump
    .done();
}

/** Encode an EligibilityCert account (layout: accountDecoders.ts). */
export function encodeCert(opts: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  writer: PublicKey;
  expiresAt: bigint;
}): Uint8Array {
  return writer(8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 8 + 1)
    .bytes(AccountDisc.EligibilityCert)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(opts.writer.toBytes())
    .u64(10n) // anchorEpoch
    .u64(12n) // certEpoch
    .i64(opts.expiresAt - 3_600n) // issuedAt
    .i64(opts.expiresAt)
    .u8(0x3f) // criteriaBitmap
    .u64(0n) // reissueGeneration
    .u8(253) // bump
    .done();
}

/** Encode a LaunchPrice account (layout: accountDecoders.ts). */
export function encodeLaunchPriceAccount(opts: {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  launchPriceQ64x64: bigint;
}): Uint8Array {
  return writer(8 + 32 * 4 + 16 + 8 + 8 + 8 + 8 + 1)
    .bytes(AccountDisc.LaunchPrice)
    .bytes(opts.ammProgramId.toBytes())
    .bytes(opts.poolAddress.toBytes())
    .bytes(opts.baseMint.toBytes())
    .bytes(opts.quoteMint.toBytes())
    .u128(opts.launchPriceQ64x64)
    .u64(1n) // firstSwapSlot
    .i64(1_700_000_000n) // firstSwapUnixTs
    .u64(2n) // recordedSlot
    .i64(1_700_000_100n) // recordedAt
    .u8(252) // bump
    .done();
}

/** Encode a canonical 165-byte SPL token account. */
export function encodeTokenAccount(mint: PublicKey, amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  buf.set(mint.toBytes(), 0);
  buf.set(PublicKey.default.toBytes(), 32); // owner (unused by the SDK)
  const view = new DataView(buf.buffer);
  view.setBigUint64(64, amount, true);
  view.setUint8(108, 1); // state = initialized
  return buf;
}

/** Encode a canonical 82-byte SPL mint account. */
export function encodeMint(decimals: number, supply: bigint): Uint8Array {
  const buf = new Uint8Array(82);
  const view = new DataView(buf.buffer);
  view.setBigUint64(36, supply, true);
  view.setUint8(44, decimals);
  view.setUint8(45, 1); // isInitialized
  return buf;
}

/** Encode a canonical 752-byte Raydium V4 AmmInfo with the SDK-parsed fields. */
export function encodeAmmInfo(opts: {
  coinVault: PublicKey;
  pcVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
}): Uint8Array {
  const buf = new Uint8Array(RAYDIUM_V4_AMM_INFO_SIZE);
  buf.set(opts.coinVault.toBytes(), 336);
  buf.set(opts.pcVault.toBytes(), 368);
  buf.set(opts.baseMint.toBytes(), 400);
  buf.set(opts.quoteMint.toBytes(), 432);
  buf.set(opts.lpMint.toBytes(), 464);
  return buf;
}

// --------------------------------------------------------- transaction-like

/** A getTransaction() response that satisfies deriveLastSwapV4 + deriveLaunchPriceV4. */
export function makeSwapTxLike(opts: {
  programId: PublicKey;
  poolAddress: PublicKey;
  coinVault: PublicKey;
  pcVault: PublicKey;
  blockTime: number;
  slot: number;
  signature: string;
  /** Pre/post vault balances (raw base units). */
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

interface SignatureInfoLike {
  signature: string;
  slot: number;
  err: null;
  blockTime: number;
}

/**
 * The Connection subset the Scout + SDK touch. Cast with
 * `fake.asConnection()` at the boundary — everything actually called is
 * implemented here.
 */
export class FakeConnection {
  readonly accounts = new Map<string, AccountInfo<Uint8Array>>();
  readonly signaturesByPool = new Map<string, SignatureInfoLike[]>();
  readonly transactions = new Map<string, unknown>();
  currentSlot = FIXED_SLOT;
  currentEpoch = 10;
  blockTime = FIXED_NOW;
  blockhash = bs58.encode(new Uint8Array(32).fill(7));
  /** Every transaction handed to the injectable sender. */
  readonly sentTransactions: import("@solana/web3.js").Transaction[] = [];
  rpcEndpoint = "fake://local";

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

  /** Install a swap history entry for a pool (also installs the tx). */
  setSwapHistory(
    poolAddress: PublicKey,
    programId: PublicKey,
    pool: { coinVault: PublicKey; pcVault: PublicKey },
    opts?: { lastSwapAgeSeconds?: number; neverSwapped?: boolean },
  ): void {
    const age = opts?.lastSwapAgeSeconds ?? 100 * 86_400; // 100 days stale
    if (opts?.neverSwapped) {
      this.signaturesByPool.set(poolAddress.toBase58(), []);
      return;
    }
    const blockTime = this.blockTime - age;
    const signature = `SWAP_SIG_${poolAddress.toBase58().slice(0, 8)}_${blockTime}`;
    this.signaturesByPool.set(poolAddress.toBase58(), [
      { signature, slot: 99_000, err: null, blockTime },
    ]);
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

  asConnection(): Connection {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as unknown as Connection;
  }

  // ---- Connection surface (subset) ----

  async getAccountInfo(address: PublicKey): Promise<AccountInfo<Uint8Array> | null> {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  async getProgramAccounts(
    programId: PublicKey,
    opts?: { filters?: Array<{ dataSize?: number; memcmp?: unknown }>; encoding?: string },
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Uint8Array> }>> {
    const out: Array<{ pubkey: PublicKey; account: AccountInfo<Uint8Array> }> = [];
    const dataSize = opts?.filters?.find((f) => f.dataSize !== undefined)?.dataSize;
    for (const [addr, account] of this.accounts) {
      if (!account.owner.equals(programId)) continue;
      if (dataSize !== undefined && account.data.length !== dataSize) continue;
      out.push({ pubkey: new PublicKey(addr), account });
    }
    return out;
  }

  async getSignaturesForAddress(
    address: PublicKey,
    opts?: { limit?: number; before?: string },
  ): Promise<SignatureInfoLike[]> {
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
}

// ------------------------------------------------------------- fixtures

/** Raydium V4 program id (re-exported for fixtures). */
export const V4 = RAYDIUM_V4_PROGRAM_ID;
export { WSOL_MINT };

/** Deterministic pool address from a single byte pattern. */
export function poolKey(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

/** A funded Raydium V4 pool fixture with WSOL on the pc side. */
export interface PoolFixture {
  poolAddress: PublicKey;
  coinVault: PublicKey;
  pcVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
}

/** Derive a fixture-unique key from a pool address (vaults/mints must be per-pool). */
function derivedKey(prefixByte: number, poolAddress: PublicKey): PublicKey {
  const bytes = poolAddress.toBytes();
  const out = new Uint8Array(32);
  out[0] = prefixByte;
  out.set(bytes.subarray(1), 1);
  return new PublicKey(out);
}

export function installPool(
  fake: FakeConnection,
  opts: {
    poolAddress: PublicKey;
    /** WSOL-side reserve in lamports. */
    tvlLamports: bigint;
    /** Memecoin-side reserve (base units). */
    coinReserve?: bigint;
    lpSupply?: bigint;
    /** Coin side is WSOL instead of pc side. */
    coinIsWsol?: boolean;
    lastSwapAgeSeconds?: number;
    neverSwapped?: boolean;
  },
): PoolFixture {
  const baseMint = derivedKey(0xb1, opts.poolAddress); // memecoin
  const quoteMint = WSOL_MINT;
  const lpMint = derivedKey(0x11, opts.poolAddress);
  const coinVault = derivedKey(0xc1, opts.poolAddress);
  const pcVault = derivedKey(0xc2, opts.poolAddress);

  const coinIsWsol = opts.coinIsWsol ?? false;
  // Default memecoin reserve: 1e12 base units against a 2 SOL quote side —
  // quote-per-base ≈ 0.002, i.e. a ~99.8% collapse. Fixtures must LOOK
  // derelict: the C2 proxy margin (and hence the candidate score) is zero
  // for pools whose reserve ratio implies an uncollapsed price.
  const coinReserve = coinIsWsol ? opts.tvlLamports : (opts.coinReserve ?? 1_000_000_000_000n);
  const pcReserve = coinIsWsol ? (opts.coinReserve ?? 1_000_000_000_000n) : opts.tvlLamports;

  fake.setAccount(
    opts.poolAddress,
    encodeAmmInfo({
      coinVault,
      pcVault,
      baseMint: coinIsWsol ? quoteMint : baseMint,
      quoteMint: coinIsWsol ? baseMint : quoteMint,
      lpMint,
    }),
    V4,
  );
  fake.setAccount(coinVault, encodeTokenAccount(coinIsWsol ? quoteMint : baseMint, coinReserve), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  fake.setAccount(pcVault, encodeTokenAccount(coinIsWsol ? baseMint : quoteMint, pcReserve), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  fake.setAccount(lpMint, encodeMint(6, opts.lpSupply ?? 1_000_000_000n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  fake.setAccount(baseMint, encodeMint(9, 10_000_000_000n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  fake.setAccount(quoteMint, encodeMint(9, 10_000_000_000n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));

  fake.setSwapHistory(opts.poolAddress, V4, { coinVault, pcVault }, {
    lastSwapAgeSeconds: opts.lastSwapAgeSeconds,
    neverSwapped: opts.neverSwapped,
  });

  return { poolAddress: opts.poolAddress, coinVault, pcVault, baseMint, quoteMint, lpMint };
}
