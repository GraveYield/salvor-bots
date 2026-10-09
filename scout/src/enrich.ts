// SPDX-License-Identifier: Apache-2.0
//
// Discovery enrichment: last-swap activity indexing, reserve/TVL reading,
// and token metadata — the Scout's pipeline stages 2–4.
//
// Ported from the Phase 9 indexer (`indexer/src/activity.ts`,
// `reserves.ts`, `metadata.ts`) onto the standalone SDK, with the three
// modules consolidated into one file: each stage is a pure wrapper over
// SDK primitives (`deriveLastSwapV4`, `readVaultReserve`, `readLpMintSupply`,
// `identifyBaseToken`) and they always run together per pool.

import { Connection, PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import {
  deriveLastSwapV4,
  RAYDIUM_V4_PROGRAM_ID,
  readLpMintSupply,
  readVaultReserve,
  identifyBaseToken,
} from "@graveyield/sdk";

// ------------------------------------------------------------ activity

/** Last-swap activity record from signature history. */
export interface ActivityRecord {
  poolAddress: PublicKey;
  /** Unix timestamp (seconds) of the pool's most recent swap. */
  lastSwapUnixTs: number;
  /** Slot of the most recent swap. */
  lastSwapSlot: number;
  /** Signature of the most recent swap transaction (audit anchor). */
  lastSwapSignature: string;
  /** True if the scan exhausted all signatures without finding a swap. */
  noSwapFound: boolean;
}

interface ActivityCacheEntry {
  record: ActivityRecord;
  cachedAtMs: number;
}

/**
 * ActivityIndexer — caches last-swap derivations per pool address
 * (default TTL 1 h). A pool that has not swapped in 90+ days is unlikely
 * to swap within the TTL, and freshly-swapped pools fail C1 anyway.
 */
export class ActivityIndexer {
  private readonly cache = new Map<string, ActivityCacheEntry>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 3_600_000;
  }

  /** Index last-swap activity for a pool (cached within the TTL). */
  async indexActivity(
    connection: Connection,
    poolAddress: PublicKey,
    opts?: { scanLimit?: number },
  ): Promise<ActivityRecord> {
    const key = poolAddress.toBase58();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.cachedAtMs < this.ttlMs) {
      return cached.record;
    }

    const derivation = await deriveLastSwapV4(connection, RAYDIUM_V4_PROGRAM_ID, poolAddress, {
      scanLimit: opts?.scanLimit ?? 1_000,
    });

    const record: ActivityRecord = derivation
      ? {
          poolAddress,
          lastSwapUnixTs: derivation.lastSwapUnixTs,
          lastSwapSlot: derivation.slot,
          lastSwapSignature: derivation.signature,
          noSwapFound: false,
        }
      : {
          poolAddress,
          lastSwapUnixTs: 0,
          lastSwapSlot: 0,
          lastSwapSignature: "",
          noSwapFound: true,
        };

    this.cache.set(key, { record, cachedAtMs: now });
    return record;
  }

  /** Invalidate one pool's cached activity (e.g. after a failed C1). */
  invalidate(poolAddress: PublicKey): void {
    this.cache.delete(poolAddress.toBase58());
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// ------------------------------------------------------------ reserves

/** Vault reserves + LP supply read from SPL token accounts. */
export interface ReserveRecord {
  poolAddress: PublicKey;
  coinReserve: bigint;
  pcReserve: bigint;
  lpSupply: bigint;
  /** True if exactly one of coin/pc is WSOL (the 7019 guard). */
  wsolSideIdentified: boolean;
  /** The WSOL-side reserve in lamports (TVL proxy). */
  tvlLamports: bigint;
}

/**
 * Read vault reserves + LP supply. Returns `null` when any account is
 * missing or unreadable, so the caller can skip the pool this cycle.
 */
export async function readReserves(
  connection: Connection,
  poolAddress: PublicKey,
  pool: { coinVault: PublicKey; pcVault: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; lpMint: PublicKey },
): Promise<ReserveRecord | null> {
  try {
    const coinReserve = await readVaultReserve(connection, pool.coinVault);
    const pcReserve = await readVaultReserve(connection, pool.pcVault);
    const lpSupply = await readLpMintSupply(connection, pool.lpMint);

    let wsolSideIdentified = true;
    let tvlLamports = 0n;
    try {
      // 7019 guard: exactly one side must be WSOL for v1.0.
      identifyBaseToken({
        poolAddress,
        coinVault: pool.coinVault,
        pcVault: pool.pcVault,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        lpMint: pool.lpMint,
      });
      tvlLamports = pool.baseMint.equals((await import("@graveyield/sdk")).WSOL_MINT)
        ? coinReserve
        : pcReserve;
    } catch {
      wsolSideIdentified = false;
      tvlLamports = 0n;
    }

    return { poolAddress, coinReserve, pcReserve, lpSupply, wsolSideIdentified, tvlLamports };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ metadata

/** Token metadata for the pool's three mints. */
export interface TokenMetadata {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  baseDecimals: number;
  baseSupply: bigint;
  quoteMint: PublicKey;
  quoteDecimals: number;
  quoteSupply: bigint;
  lpMint: PublicKey;
  lpDecimals: number;
  lpSupply: bigint;
}

/**
 * Read mint accounts (supply, decimals) for a pool's three mints.
 * Returns `null` when any mint is missing or uninitialized.
 */
export async function readTokenMetadata(
  connection: Connection,
  poolAddress: PublicKey,
  pool: { baseMint: PublicKey; quoteMint: PublicKey; lpMint: PublicKey },
): Promise<TokenMetadata | null> {
  try {
    const [baseInfo, quoteInfo, lpInfo] = await Promise.all([
      connection.getAccountInfo(pool.baseMint),
      connection.getAccountInfo(pool.quoteMint),
      connection.getAccountInfo(pool.lpMint),
    ]);
    if (!baseInfo || !quoteInfo || !lpInfo) return null;

    const baseMint = unpackMint(pool.baseMint, baseInfo);
    const quoteMint = unpackMint(pool.quoteMint, quoteInfo);
    const lpMint = unpackMint(pool.lpMint, lpInfo);
    if (!baseMint.isInitialized || !quoteMint.isInitialized || !lpMint.isInitialized) {
      return null;
    }

    return {
      poolAddress,
      baseMint: pool.baseMint,
      baseDecimals: baseMint.decimals,
      baseSupply: baseMint.supply,
      quoteMint: pool.quoteMint,
      quoteDecimals: quoteMint.decimals,
      quoteSupply: quoteMint.supply,
      lpMint: pool.lpMint,
      lpDecimals: lpMint.decimals,
      lpSupply: lpMint.supply,
    };
  } catch {
    return null;
  }
}
