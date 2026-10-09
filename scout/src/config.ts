// SPDX-License-Identifier: Apache-2.0
//
// Scout Salvor configuration — environment-driven with safe defaults
// (the same convention the Phase 9 indexer established).
//
// Modes (important — the Scout's boundary is discovery + monitoring):
//
//   * `SCOUT_DRY_RUN` unset:
//       - ACTIVITY_ORACLE_KEY present  → submission mode (phase1 txs ON)
//       - ACTIVITY_ORACLE_KEY absent   → dry-run (discovery/monitor only)
//   * `SCOUT_DRY_RUN=1`  → forced dry-run even with keys present.
//   * `SCOUT_DRY_RUN=0`  → submission mode requires ACTIVITY_ORACLE_KEY +
//     SALVOR_KEYPAIR; loadScoutConfig throws if they are missing.
//
// On devnet the deployed ProtocolConfig's activity/launch-price oracles
// point at the (since-wiped) deployer key — attestation-signed submissions
// against that cluster can only verify once the owner re-points the
// oracles. Until then every devnet Scout run is effectively read-only, and
// this config surfaces the mode explicitly instead of failing mid-cycle.

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import {
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
} from "@graveyield/sdk";

/** Spec defaults (Charter-locked at devnet launch) — mirrors the SDK constants. */
export const SCOUT_SPEC_DEFAULTS = {
  inactivitySeconds: 7_776_000n, // 90 d
  priceCollapseBps: 9_900, // 99 %
  minTvlLamports: 500_000_000n, // 0.5 SOL
  lpBurnDustThreshold: 1_000n,
} as const;

/** Scout configuration. */
export interface ScoutConfig {
  rpcUrl: string;
  cluster: "localnet" | "devnet" | "mainnet-beta";
  scannerProgramId: PublicKey;
  vaultProgramId: PublicKey;

  /** Cheap pre-filter thresholds (defaults = spec). */
  inactivitySeconds: bigint;
  priceCollapseBps: number;
  minTvlLamports: bigint;
  lpBurnDustThreshold: bigint;

  /** Max candidates submitted per cycle (indexer convention: 5). */
  maxCandidatesPerCycle: number;
  /** Re-scan interval in milliseconds (default 5 min). */
  pollIntervalMs: number;
  /** Max pools enumerated per scan (Raydium V4 has thousands). */
  maxPoolsPerScan: number;
  /** Signature scan limit for last-swap derivations. */
  signatureScanLimit: number;
  /** Max pages for the launch-price genesis pagination (50 × 1000 sigs). */
  launchPriceMaxPages: number;

  /** True when the Scout must not submit anything. */
  dryRun: boolean;

  /** Base58 32-byte Ed25519 secret — absent ⇒ no phase1 submissions. */
  activityOracleKey: string | null;
  /** Base58 32-byte Ed25519 secret — absent ⇒ pools without a LaunchPrice PDA are reported, not recorded. */
  launchPriceOracleKey: string | null;
  /** Operator keypair: path to a solana-keygen JSON file or a base58 secret. */
  salvorKeypair: string | null;

  /** compute_unit_price for Scout-submitted txs (SDK units; Charter-guarded). */
  feeLamportsPerCu: BN;
  /** Optional explicit compute-unit limit for Scout-submitted txs. */
  computeUnitLimit: number | null;
  /** Max attempts per pool before the Scout stops retrying submissions. */
  maxSubmitAttempts: number;

  /** Optional JSONL report file path (opportunities + lifecycle events). */
  reportFile: string | null;

  /** Run exactly one cycle and exit (SCOUT_RUN_ONCE=1). */
  runOnce: boolean;
}

function parseBigint(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw === "") return fallback;
  const v = BigInt(raw);
  if (v < 0n) throw new RangeError(`negative bigint env value: ${raw}`);
  return v;
}

function parseIntEnv(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw === "") return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min) {
    throw new RangeError(`env int value out of range (min ${min}): ${raw}`);
  }
  return v;
}

/**
 * Resolve the Scout's run mode from the env. Kept pure so tests can pin
 * the dry-run gating without touching `process.env`.
 */
export function resolveDryRun(
  scoutDryRun: string | undefined,
  hasActivityOracleKey: boolean,
): boolean {
  if (scoutDryRun === "1" || scoutDryRun === "true") return true;
  if (scoutDryRun === "0" || scoutDryRun === "false") return false;
  // Unset: submissions only make sense with an activity oracle key.
  return !hasActivityOracleKey;
}

/**
 * Load the Scout configuration from an env-like record (defaults to
 * `process.env`). Throws on values that would silently mis-run the bot.
 */
export function loadScoutConfig(env: NodeJS.ProcessEnv = process.env): ScoutConfig {
  const rpcUrl = env.RPC_URL ?? "https://api.devnet.solana.com";
  const clusterEnv = env.CLUSTER ?? "devnet";
  const cluster: ScoutConfig["cluster"] =
    clusterEnv === "mainnet-beta"
      ? "mainnet-beta"
      : clusterEnv === "localnet"
        ? "localnet"
        : "devnet";

  const scannerProgramId = env.SCANNER_PROGRAM_ID
    ? new PublicKey(env.SCANNER_PROGRAM_ID)
    : new PublicKey(DEVNET_SCANNER_PROGRAM_ID);
  const vaultProgramId = env.VAULT_PROGRAM_ID
    ? new PublicKey(env.VAULT_PROGRAM_ID)
    : new PublicKey(DEVNET_VAULT_PROGRAM_ID);

  const activityOracleKey = env.ACTIVITY_ORACLE_KEY ?? null;
  const launchPriceOracleKey = env.LAUNCH_PRICE_ORACLE_KEY ?? null;
  const salvorKeypair = env.SALVOR_KEYPAIR ?? null;

  const dryRun = resolveDryRun(env.SCOUT_DRY_RUN, activityOracleKey !== null);
  if (!dryRun) {
    if (!activityOracleKey) {
      throw new Error(
        "SCOUT_DRY_RUN=0 requires ACTIVITY_ORACLE_KEY — phase1 submissions need a C1 attestation signer",
      );
    }
    if (!salvorKeypair) {
      throw new Error(
        "SCOUT_DRY_RUN=0 requires SALVOR_KEYPAIR — submissions need a writer to pay rent and sign",
      );
    }
  }

  return {
    rpcUrl,
    cluster,
    scannerProgramId,
    vaultProgramId,
    inactivitySeconds: parseBigint(env.INACTIVITY_SECONDS, SCOUT_SPEC_DEFAULTS.inactivitySeconds),
    priceCollapseBps: parseIntEnv(env.PRICE_COLLAPSE_BPS, SCOUT_SPEC_DEFAULTS.priceCollapseBps, 0),
    minTvlLamports: parseBigint(env.MIN_TVL_LAMPORTS, SCOUT_SPEC_DEFAULTS.minTvlLamports),
    lpBurnDustThreshold: parseBigint(
      env.LP_BURN_DUST_THRESHOLD,
      SCOUT_SPEC_DEFAULTS.lpBurnDustThreshold,
    ),
    maxCandidatesPerCycle: parseIntEnv(env.MAX_CANDIDATES_PER_CYCLE, 5, 1),
    pollIntervalMs: parseIntEnv(env.POLL_INTERVAL_MS, 300_000, 1_000),
    maxPoolsPerScan: parseIntEnv(env.MAX_POOLS_PER_SCAN, 1_000, 1),
    signatureScanLimit: parseIntEnv(env.SIGNATURE_SCAN_LIMIT, 1_000, 1),
    launchPriceMaxPages: parseIntEnv(env.LAUNCH_PRICE_MAX_PAGES, 50, 1),
    dryRun,
    activityOracleKey,
    launchPriceOracleKey,
    salvorKeypair,
    feeLamportsPerCu: new BN(parseIntEnv(env.PRIORITY_FEE_LAMPORTS_PER_CU, 10_000, 0)),
    computeUnitLimit: env.COMPUTE_UNIT_LIMIT
      ? parseIntEnv(env.COMPUTE_UNIT_LIMIT, 300_000, 1)
      : null,
    maxSubmitAttempts: parseIntEnv(env.SCOUT_MAX_SUBMIT_ATTEMPTS, 3, 1),
    reportFile: env.SCOUT_REPORT_FILE ?? null,
    runOnce: env.SCOUT_RUN_ONCE === "1" || env.SCOUT_RUN_ONCE === "true",
  };
}
