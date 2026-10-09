// SPDX-License-Identifier: Apache-2.0
//
// On-chain revalidation (FLEET-M1).
//
// NOTHING an opportunity envelope says is trusted on its own. Before an
// executor may prepare anything, this module re-reads the live chain
// and re-derives the opportunity's current truth:
//
//   * the pool account exists and parses as Raydium V4 (752 bytes);
//   * the anchor exists, is not invalidated, and (for
//     certification-ready) the ≥2-epoch gap has actually elapsed;
//   * the cert (for salvageable) exists, is inside its TTL with the
//     policy's remaining-time margin, and binds the same anchor epoch;
//   * reserves + LP supply are re-read fresh for the estimator;
//   * the LP supply is > the burn dust threshold (C4 shape) and the
//     pool has exactly one WSOL side (7019 shape).
//
// The Scout event's original state is context, not authority.

import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import {
  eligibilityAnchorPda,
  eligibilityCertPda,
  fetchEligibilityAnchor,
  fetchEligibilityCert,
  fetchV4Pool,
  identifyBaseToken,
  readLpMintSupply,
  readVaultReserve,
  type GraveYieldClient,
  type ScannerProtocolConfig,
  type VaultProtocolConfig,
  WSOL_MINT,
  RAYDIUM_V4_PROGRAM_ID,
} from "@graveyield/sdk";
import type { OpportunityKind } from "./envelope.js";
import type { FailureClass } from "./events.js";

/** Fully revalidated live state for one opportunity. */
export interface RevalidatedOpportunity {
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** The CURRENT correct kind (may differ from the envelope's). */
  kind: "certification-ready" | "salvageable";
  anchor: Awaited<ReturnType<typeof fetchEligibilityAnchor>>;
  cert: Awaited<ReturnType<typeof fetchEligibilityCert>>;
  /** Live cert expiry (unix seconds) when a cert exists. */
  certExpiresAt: bigint | null;
  anchorEpoch: bigint | null;
  pool: Awaited<ReturnType<typeof fetchV4Pool>>;
  coinReserve: bigint;
  pcReserve: bigint;
  lpSupply: bigint;
  /** The memecoin (non-WSOL) mint. */
  memecoinMint: PublicKey;
  /** True when the coin side is WSOL. */
  coinIsWsol: boolean;
  scannerConfig: ScannerProtocolConfig;
  vaultConfig: VaultProtocolConfig;
  /** Slot at which the reads were served (best-effort). */
  readSlot: number;
}

/** Rejection with a fleet-taxonomy class. */
export interface RevalidationRejection {
  ok: false;
  failureClass: FailureClass;
  reason: string;
}

export type RevalidationOutcome =
  | { ok: true; opportunity: RevalidatedOpportunity }
  | RevalidationRejection;

/** Revalidation options — clock injectable for tests. */
export interface RevalidatorOptions {
  /** Now (epoch ms) — injectable for deterministic tests. */
  now?: () => number;
  /** Current epoch override (tests) — otherwise read from the connection. */
  currentEpoch?: number;
}

/**
 * Re-read everything the two executor paths need and decide whether the
 * opportunity is still actionable, and AS WHAT (the kind can change
 * between event time and now — e.g. a "certification-ready" event whose
 * cert has since been issued by another salvor becomes "salvageable",
 * and vice versa after expiry).
 */
export async function revalidateOpportunity(opts: {
  client: GraveYieldClient;
  ammProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Strategy's minimum remaining cert TTL (ms) for the salvage path. */
  minCertRemainingMs: number;
  options?: RevalidatorOptions;
}): Promise<RevalidationOutcome> {
  const now = opts.options?.now ?? Date.now;
  const nowSec = Math.floor(now() / 1000);
  const { client, ammProgramId, poolAddress } = opts;

  // --- ProtocolConfigs (live — the Charter/shares are config, not constants).
  let scannerConfig: ScannerProtocolConfig;
  let vaultConfig: VaultProtocolConfig;
  try {
    ({ scanner: scannerConfig, vault: vaultConfig } = await client.ensureConfigs());
  } catch (err) {
    return { ok: false, failureClass: "transient-rpc", reason: `protocol configs unavailable: ${String(err)}` };
  }

  // --- Pool account.
  let pool;
  try {
    pool = await fetchV4Pool(client.connection, poolAddress);
  } catch (err) {
    return { ok: false, failureClass: "missing-accounts", reason: `pool unreadable: ${String(err)}` };
  }

  // --- Orientation (7019 shape).
  let orientation: { memecoinMint: PublicKey; coinIsWsol: boolean };
  try {
    const o = identifyBaseToken(pool);
    orientation = { memecoinMint: o.memecoinMint, coinIsWsol: o.coinIsWsol };
  } catch (err) {
    return { ok: false, failureClass: "criteria-failed", reason: String(err) };
  }

  // --- Reserves + LP supply (fresh, for the estimator AND the supply pin).
  let coinReserve: bigint;
  let pcReserve: bigint;
  let lpSupply: bigint;
  try {
    coinReserve = await readVaultReserve(client.connection, pool.coinVault);
    pcReserve = await readVaultReserve(client.connection, pool.pcVault);
    lpSupply = await readLpMintSupply(client.connection, pool.lpMint);
  } catch (err) {
    return { ok: false, failureClass: "transient-rpc", reason: `reserves unreadable: ${String(err)}` };
  }
  if (lpSupply <= scannerConfig.lpBurnDustThreshold) {
    return {
      ok: false,
      failureClass: "criteria-failed",
      reason: `LP supply ${lpSupply} below burn dust threshold ${scannerConfig.lpBurnDustThreshold} — C4 shape`,
    };
  }

  // --- Anchor.
  const anchor = await fetchEligibilityAnchor(
    client.connection,
    eligibilityAnchorPda(client.graveScannerProgramId, ammProgramId, poolAddress),
  );
  if (!anchor) {
    return { ok: false, failureClass: "anchor-missing", reason: "no EligibilityAnchor on chain" };
  }
  if (anchor.invalidated) {
    return { ok: false, failureClass: "stale-anchor", reason: "anchor invalidated by multisig" };
  }

  // --- Cert.
  const cert = await fetchEligibilityCert(
    client.connection,
    eligibilityCertPda(client.graveScannerProgramId, ammProgramId, poolAddress),
  );
  const certExpiresAt = cert ? cert.expiresAt : null;
  const certLive = cert !== null && cert.expiresAt > BigInt(nowSec);
  const certRemainingMs = cert ? Number(cert.expiresAt - BigInt(nowSec)) * 1000 : 0;

  // --- Current kind from LIVE state (the envelope's kind is context).
  let currentEpoch: number;
  try {
    currentEpoch =
      opts.options?.currentEpoch ??
      (await client.connection.getEpochInfo()).epoch;
  } catch (err) {
    return { ok: false, failureClass: "transient-rpc", reason: `epoch unavailable: ${String(err)}` };
  }
  const epochsElapsed = currentEpoch - Number(anchor.firstEligibleEpoch);
  const epochGapSatisfied = epochsElapsed >= 2; // MIN_EPOCH_CONFIRMATION
  const kind: "certification-ready" | "salvageable" | "not-actionable" = certLive
    ? "salvageable"
    : epochGapSatisfied
      ? "certification-ready"
      : "not-actionable";

  if (kind === "not-actionable") {
    return {
      ok: false,
      failureClass: "stale-opportunity",
      reason: `no live cert and epoch gap not satisfied (firstEligibleEpoch ${anchor.firstEligibleEpoch}, now ${currentEpoch})`,
    };
  }
  if (kind === "salvageable" && certRemainingMs < opts.minCertRemainingMs) {
    return {
      ok: false,
      failureClass: "cert-expired",
      reason: `cert TTL window too small: ${certRemainingMs}ms remaining < ${opts.minCertRemainingMs}ms required (expiresAt ${certExpiresAt?.toString()})`,
    };
  }
  // A cert that binds a DIFFERENT anchor epoch than the live anchor is
  // suspicious — the scanner mints certs from the anchor it evaluated.
  if (cert && cert.anchorEpoch !== anchor.firstEligibleEpoch) {
    return {
      ok: false,
      failureClass: "state-changed",
      reason: `cert anchorEpoch ${cert.anchorEpoch} != anchor epoch ${anchor.firstEligibleEpoch}`,
    };
  }

  return {
    ok: true,
    opportunity: {
      ammProgramId,
      poolAddress,
      kind,
      anchor,
      cert,
      certExpiresAt,
      anchorEpoch: anchor.firstEligibleEpoch,
      pool,
      coinReserve,
      pcReserve,
      lpSupply,
      memecoinMint: orientation.memecoinMint,
      coinIsWsol: orientation.coinIsWsol,
      scannerConfig,
      vaultConfig,
      readSlot: 0, // best-effort; filled by callers that fetch a slot anyway
    },
  };
}

/** Re-exported for pipelines that need the WSOL mint without another import. */
export { WSOL_MINT, RAYDIUM_V4_PROGRAM_ID };

/** BN helper for pipelines (share one import surface). */
export function toBN(v: bigint | number): BN {
  return new BN(v.toString(10));
}
