// SPDX-License-Identifier: Apache-2.0
//
// Raydium V4 pool discovery — the Scout's first pipeline stage.
//
// Ported from the Phase 9 indexer (`indexer/src/sources/raydiumV4.ts`,
// shipped in the GraveYield monorepo) onto the standalone SDK. Enumerates
// every 752-byte AmmInfo account owned by the Raydium V4 AMM program via
// `getProgramAccounts` with a dataSize filter.
//
// v1 discovery target: Raydium V4 only (roadmap Phase 9 + Phase 10).
// Additional sources land in Phase 15 (CLMM, Orca, PumpSwap, Meteora).

import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_V4_PROGRAM_ID,
  RAYDIUM_V4_AMM_INFO_SIZE,
  parseV4AmmInfo,
} from "@graveyield/sdk";

/** A pool discovered by a Scout source. */
export interface DiscoveredPool {
  poolAddress: PublicKey;
  /** The AMM program that owns the pool account (Raydium V4 for v1). */
  ammProgramId: PublicKey;
  pool: {
    coinVault: PublicKey;
    pcVault: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    lpMint: PublicKey;
  };
}

/**
 * RaydiumV4Source — enumerates Raydium V4 AMM pools via
 * `getProgramAccounts` with a 752-byte dataSize filter.
 */
export class RaydiumV4Source {
  readonly name = "raydium-v4";
  readonly programId = RAYDIUM_V4_PROGRAM_ID;

  constructor(private readonly opts?: { maxPools?: number }) {}

  /** Yield candidate pools (parsed canonical AmmInfo fields) for enrichment. */
  async *enumeratePools(connection: Connection): AsyncGenerator<DiscoveredPool> {
    const maxPools = this.opts?.maxPools ?? Number.POSITIVE_INFINITY;
    let count = 0;

    const accounts = await connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, {
      encoding: "base64",
      filters: [{ dataSize: RAYDIUM_V4_AMM_INFO_SIZE }],
    });

    for (const account of accounts) {
      if (count >= maxPools) break;
      const data = Buffer.from(account.account.data);
      if (data.length !== RAYDIUM_V4_AMM_INFO_SIZE) continue;

      let poolAddress: PublicKey;
      try {
        poolAddress = new PublicKey(account.pubkey);
      } catch {
        continue;
      }

      let parsed;
      try {
        parsed = parseV4AmmInfo(poolAddress, new Uint8Array(data));
      } catch {
        // Defensive — a corrupted account could still fail the parser.
        continue;
      }

      yield {
        poolAddress,
        ammProgramId: RAYDIUM_V4_PROGRAM_ID,
        pool: {
          coinVault: parsed.coinVault,
          pcVault: parsed.pcVault,
          baseMint: parsed.baseMint,
          quoteMint: parsed.quoteMint,
          lpMint: parsed.lpMint,
        },
      };
      count++;
    }
  }
}
