// SPDX-License-Identifier: Apache-2.0
//
// The fleet's common economic estimator (FLEET-M1).
//
// ONE estimator, shared by Conservative / Sniper / Experimental — the
// mandate's rule that no executor maintains a private economics path.
// All amounts are exact integers (lamports / base units); no floating
// point ever touches a monetary quantity.
//
// The economic chain of a salvage (mirrors grave-vault salvage_pool):
//
//   1. The salvor burns `salvorLpAmount` LP against the pool.
//   2. Raydium V4 withdraw returns proportional coin+pc reserves —
//      the memecoin side and the WSOL side.
//   3. The vault converts the retained memecoin to WSOL over the
//      supplied Jupiter route; the delivered WSOL must clear
//      `min_quote_output_lamports`.
//   4. Total WSOL proceeds split lpHolder / salvor / protocol by the
//      LIVE ProtocolConfig shares (default 4000 / 4000 / 2000 bps).
//   5. The salvor keeps `salvorShareBps` of proceeds MINUS its costs:
//      transaction base fees, the priority-fee budget (D3 plan), and
//      the rent it fronts for PDAs / ATAs created by salvage_pool.
//
// Scout's score is NEVER an input — the mandate is explicit that the
// score is advisory prioritization, not executable economics.

import BN from "bn.js";
import type { FailureClass } from "./events.js";

/** The pool-side facts the estimator consumes (all live, freshly read). */
export interface EstimatorPoolInputs {
  /** Coin-side vault balance (raw base units). */
  coinReserve: bigint;
  /** Pc-side vault balance (raw base units). */
  pcReserve: bigint;
  /** LIVE LP mint supply (raw base units) — pinned on chain at salvage. */
  lpSupply: bigint;
  /** The pool's coin-side (AmmInfo @400) mint. */
  coinMint: string;
  /** The pool's pc-side (AmmInfo @432) mint. */
  pcMint: string;
  /** WSOL mint (base58) — orientation is derived, not assumed. */
  wsolMint: string;
}

/** The route quote the estimator consumes (from a RouteAdapter). */
export interface EstimatorRouteInputs {
  /** Memecoin → WSOL quote: input amount (memecoin base units). */
  quoteInAmount: bigint;
  /** Memecoin → WSOL quote: WSOL out (lamports) BEFORE slippage. */
  quoteOutLamports: bigint;
}

/** Salvor-side facts. */
export interface EstimatorPositionInputs {
  /** LP amount the salvor will burn (raw base units). */
  salvorLpAmount: bigint;
}

/** Live protocol configuration facts (fetched, not assumed). */
export interface EstimatorConfigInputs {
  /** Salvor share of proceeds, bps (live Vault config; default 4000). */
  salvorShareBps: number;
  /** Max allowed slippage, bps (live Vault config; default 300). */
  maxSlippageBps: number;
  /** Jupiter dust threshold below which the swap leg is skipped (lamports). */
  jupiterDustThresholdLamports: bigint;
}

/** Strategy cost assumptions (all integers). */
export interface EstimatorCostInputs {
  /** Priority-fee budget for the WHOLE operation (lamports) — from the D3 fee plan. */
  priorityFeeBudgetLamports: bigint;
  /** Number of signatures across the operation's transactions (base fee each). */
  signatureCount: number;
  /** Lamports of rent the salvor fronts and does not recover (PDAs + ATAs). */
  frontedRentLamports: bigint;
  /** Base fee per signature (default 5_000 lamports). */
  lamportsPerSignature?: bigint;
  /**
   * Expected cost of failed attempts (lamports) — fees burned on
   * retries at the observed/assumed failure rate.
   */
  expectedFailureCostLamports?: bigint;
}

/** The estimator's full verdict. */
export interface EconomicEstimate {
  /** OK when the estimate was computable; `reject` carries the class. */
  status: "ok" | "reject";
  failureClass?: FailureClass;
  reason?: string;
  // ---- computable only when status === "ok" ----
  /** LP-proportional memecoin out (base units). */
  memecoinOut?: bigint;
  /** LP-proportional WSOL out (lamports) — the direct withdraw share. */
  directWsolOut?: bigint;
  /** Total expected WSOL proceeds before split (lamports). */
  grossProceedsWsolLamports?: bigint;
  /** Salvor's share of gross proceeds (lamports). */
  salvorGrossShareLamports?: bigint;
  /** Total cost breakdown (lamports). */
  costs?: {
    priorityFeeBudget: bigint;
    baseFees: bigint;
    frontedRent: bigint;
    expectedFailureCost: bigint;
    total: bigint;
  };
  /** Net expected profit for the salvor (lamports) — share minus costs. */
  netProfitLamports?: bigint;
  /** Break-even gross proceeds (lamports): gross at which net = 0. */
  breakEvenGrossWsolLamports?: bigint;
  /**
   * Minimum acceptable `min_quote_output_lamports` for the salvage tx:
   * the quoted out × (1 − effectiveSlippageBps / 10_000), floored.
   */
  minQuoteOutputLamports?: bigint;
  /** The slippage actually applied to that floor (bps). */
  effectiveSlippageBps?: number;
  /** True when the memecoin→WSOL leg converts less than the dust threshold (skip-leg economics). */
  swapLegBelowDust?: boolean;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Compute the salvage economics for one opportunity. Pure — no RPC, no
 * clock, no floats. Throws RangeError on malformed inputs (negative
 * amounts), returns `status: "reject"` for economically-unusable shapes.
 */
export function estimateSalvageEconomics(opts: {
  pool: EstimatorPoolInputs;
  route: EstimatorRouteInputs;
  position: EstimatorPositionInputs;
  config: EstimatorConfigInputs;
  costs: EstimatorCostInputs;
  /** Strategy slippage override — may tighten, never widen, the config max. */
  slippageBpsOverride?: number | null;
  /** Strategy minimum net profit (lamports) for the opportunity to pass. */
  minNetProfitLamports: bigint;
}): EconomicEstimate {
  const { pool, route, position, config, costs } = opts;

  for (const [name, v] of [
    ["coinReserve", pool.coinReserve],
    ["pcReserve", pool.pcReserve],
    ["lpSupply", pool.lpSupply],
    ["salvorLpAmount", position.salvorLpAmount],
    ["quoteInAmount", route.quoteInAmount],
    ["quoteOutLamports", route.quoteOutLamports],
    ["priorityFeeBudget", costs.priorityFeeBudgetLamports],
    ["frontedRent", costs.frontedRentLamports],
  ] as const) {
    if (v < 0n) throw new RangeError(`${name} must be non-negative`);
  }
  if (pool.lpSupply === 0n) {
    return reject("economic-unresolvable", "lp supply is zero — pool is dead beyond salvage");
  }
  if (position.salvorLpAmount === 0n) {
    return reject("economic-unresolvable", "salvor holds no LP to burn");
  }
  if (position.salvorLpAmount > pool.lpSupply) {
    return reject("economic-unresolvable", "salvor LP exceeds live supply — inconsistent state");
  }
  if (config.salvorShareBps <= 0) {
    return reject("economic-unresolvable", "salvor share is 0 bps — nothing to keep, never salvageable");
  }
  if (opts.minNetProfitLamports < 0n) {
    throw new RangeError("minNetProfitLamports must be non-negative");
  }

  // Orientation: exactly one side must be WSOL (the 7019 guard). The
  // estimator derives it from the mints rather than trusting callers.
  const coinIsWsol = pool.coinMint === pool.wsolMint;
  const pcIsWsol = pool.pcMint === pool.wsolMint;
  if (coinIsWsol === pcIsWsol) {
    return reject("economic-unresolvable", "pool does not have exactly one WSOL side (7019 shape)");
  }
  const memecoinReserve = coinIsWsol ? pool.pcReserve : pool.coinReserve;
  const wsolReserve = coinIsWsol ? pool.coinReserve : pool.pcReserve;

  // 1-2. Proportional withdraw (Raydium V4 remove-liquidity is linear
  // in the burned share; the OpenBook side is not modeled — a derelict
  // pool's market side is empty in the target domain, and the salvage
  // tx's own floor re-check is the final anchor).
  const burn = position.salvorLpAmount;
  const memecoinOut = (memecoinReserve * burn) / pool.lpSupply;
  const directWsolOut = (wsolReserve * burn) / pool.lpSupply;

  // 3. Route conversion of the memecoin side. The quote MUST cover the
  // memecoin we will actually hold: quoteInAmount is the adapter's
  // quoted input; we scale its output linearly to our amount (integer).
  let convertedWsol = 0n;
  let swapLegBelowDust = false;
  if (memecoinOut > 0n) {
    if (route.quoteInAmount === 0n || route.quoteOutLamports === 0n) {
      return reject("route-failure", "route quote is empty — no executable conversion");
    }
    if (route.quoteInAmount > memecoinReserve) {
      return reject(
        "route-failure",
        "route quote input exceeds the pool's memecoin reserve — inconsistent quote",
      );
    }
    convertedWsol = (memecoinOut * route.quoteOutLamports) / route.quoteInAmount;
  }
  if (convertedWsol < config.jupiterDustThresholdLamports) {
    // Below dust the ON-CHAIN leg is skipped and the memecoin is
    // retained as dust (D6) — NOT part of distributed proceeds.
    swapLegBelowDust = true;
    convertedWsol = 0n;
  }

  // 4. Gross proceeds + the LIVE salvor share.
  const grossProceeds = directWsolOut + convertedWsol;
  const salvorShare = (grossProceeds * BigInt(config.salvorShareBps)) / BPS_DENOMINATOR;

  // 5. Costs — integers only.
  const perSignature = costs.lamportsPerSignature ?? 5_000n;
  const baseFees = perSignature * BigInt(Math.max(1, costs.signatureCount));
  const expectedFailureCost = costs.expectedFailureCostLamports ?? 0n;
  const totalCosts =
    costs.priorityFeeBudgetLamports + baseFees + costs.frontedRentLamports + expectedFailureCost;
  const netProfit = salvorShare - totalCosts;

  // Break-even gross: gross at which share == costs (integer ceil).
  const shareBps = BigInt(config.salvorShareBps);
  const breakEvenGross =
    (totalCosts * BPS_DENOMINATOR + shareBps - 1n) / (shareBps === 0n ? 1n : shareBps);

  // Slippage floor for the salvage tx: effective = min(config, override).
  const effectiveSlippageBps =
    opts.slippageBpsOverride !== undefined && opts.slippageBpsOverride !== null
      ? Math.min(opts.slippageBpsOverride, config.maxSlippageBps)
      : config.maxSlippageBps;
  const minQuoteOutput =
    (convertedWsol * BigInt(BPS_DENOMINATOR - BigInt(effectiveSlippageBps))) / BPS_DENOMINATOR;

  const estimate: EconomicEstimate = {
    status: "ok",
    memecoinOut,
    directWsolOut,
    grossProceedsWsolLamports: grossProceeds,
    salvorGrossShareLamports: salvorShare,
    costs: {
      priorityFeeBudget: costs.priorityFeeBudgetLamports,
      baseFees,
      frontedRent: costs.frontedRentLamports,
      expectedFailureCost,
      total: totalCosts,
    },
    netProfitLamports: netProfit,
    breakEvenGrossWsolLamports: breakEvenGross,
    minQuoteOutputLamports: minQuoteOutput,
    effectiveSlippageBps,
    swapLegBelowDust,
  };
  if (netProfit < opts.minNetProfitLamports) {
    estimate.failureClass = "economic-insufficient";
    estimate.reason = `net ${netProfit.toString()} < minimum ${opts.minNetProfitLamports.toString()}`;
  }
  return estimate;
}

function reject(failureClass: FailureClass, reason: string): EconomicEstimate {
  return { status: "reject", failureClass, reason };
}

/**
 * Scale a BN lamport amount by bps with integer floor — shared helper
 * for strategy polish (e.g. "leave 1% headroom") that still never
 * touches floats.
 */
export function scaleByBpsFloor(amount: BN, bps: number): BN {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("bps must be a non-negative integer");
  return amount.mul(new BN(bps)).div(new BN(10_000));
}

/** Orientation helper for pipelines (memecoin side of a pool). */
export function memecoinSideOf(pool: EstimatorPoolInputs): {
  memecoinMint: string;
  wsolMint: string;
  coinIsWsol: boolean;
} {
  const coinIsWsol = pool.coinMint === pool.wsolMint;
  const pcIsWsol = pool.pcMint === pool.wsolMint;
  if (coinIsWsol === pcIsWsol) {
    throw new Error("pool does not have exactly one WSOL side (7019 shape)");
  }
  return {
    memecoinMint: coinIsWsol ? pool.pcMint : pool.coinMint,
    wsolMint: pool.wsolMint,
    coinIsWsol,
  };
}
