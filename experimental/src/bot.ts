// SPDX-License-Identifier: Apache-2.0
//
// Experimental — the isolated strategy sandbox bot (FLEET-M5).
//
// Role (fleet mandate §3.E): evaluate alternative economic strategies
// within EXPLICITLY configured limits. Its distinguishing features,
// all additive to the shared StrategyExecutor:
//
//   1. RISK CAPS (hard, fail-closed): a per-attempt priority-fee
//      budget cap and a max LP-position fraction of the live supply.
//      The `postPrepareGuard` hook enforces both against the prepared
//      outcome BEFORE simulation/submission — over-cap plans are
//      rejected `risk-cap-exceeded`.
//   2. FULL EVENT ATTRIBUTION: every event carries an `experimentId`
//      + `riskCaps` block, so its outcomes are measurable and
//      attributable in the Monitor's feed.
//   3. ISOLATION: Experimental ships its OWN defaults object; nothing
//      it does mutates Conservative's or Sniper's defaults, and it
//      runs under its own botId + store namespace. It can NEVER
//      weaken protocol rules — eligibility, Charter guard, cert
//      validity, snapshot integrity, slippage limits, and mandatory
//      checks are all enforced upstream in the shared engine and are
//      not hook-accessible.
//
// Roadmap note: Experimental is the LAST executor per the mandate; a
// further "Specialist" bot is explicitly OUT OF SCOPE for this fleet.

import { Keypair } from "@solana/web3.js";
import { GraveYieldClient, DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID, type Cluster } from "@graveyield/sdk";
import {
  DEFAULT_TUNABLES,
  StrategyExecutor,
  type ExecutionPipeline,
  type ExecutionPolicy,
  type FleetEventSink,
  type FleetStore,
  type LiveEnablement,
  type AttestationSource,
  type StrategyHooks,
} from "@graveyield/fleet-core";

/**
 * Experimental risk caps — hard, measurable, observable. Defaults are
 * PROPOSED (the roadmap defines no numbers); all configurable.
 */
export interface RiskCaps {
  /**
   * Max priority-fee budget per attempt (lamports). The D3 fee plan
   * may compute more for a high-profit opportunity — anything above
   * this cap is rejected instead of spent.
   */
  maxPriorityFeeBudgetLamports: bigint;
  /**
   * Max LP position as a fraction of the live supply (bps; 2000 = 20%).
   * Limits blast radius on unproven strategies.
   */
  maxLpFractionBps: number;
}

/** Experimental strategy defaults — PROPOSED values. */
export const EXPERIMENTAL_TUNABLES = {
  ...DEFAULT_TUNABLES,
  minNetProfitLamports: 10_000_000n, // 0.01 SOL — exploratory floor
  slippageBpsOverride: null as number | null, // use the live config max (no widening — the engine clamps)
  feeMarginRatio: 0.2,
  maxSubmitAttempts: 2,
};

export const DEFAULT_RISK_CAPS: RiskCaps = {
  maxPriorityFeeBudgetLamports: 20_000_000n, // 0.02 SOL per attempt
  maxLpFractionBps: 2_000, // 20% of live supply
};

export interface ExperimentalConfig {
  cluster: Cluster;
  /** Execution mode — DRY-RUN IS THE DEFAULT. */
  mode?: "dry-run" | "simulation" | "live";
  liveEnablement?: LiveEnablement | null;
  scannerProgramId?: string;
  vaultProgramId?: string;
  tunables?: Partial<Record<string, unknown>>;
  /** Risk caps — set to the operator's chosen experiment envelope. */
  riskCaps?: Partial<RiskCaps>;
  /** Experiment identifier stamped on every event. */
  experimentId: string;
  retryBackoffMs?: number;
}

export interface ExperimentalOptions {
  config: ExperimentalConfig;
  client: GraveYieldClient;
  pipeline: ExecutionPipeline;
  store?: FleetStore;
  sink?: FleetEventSink;
  signer?: Keypair;
  attestationSource?: AttestationSource;
  now?: () => number;
}

/**
 * The Experimental executor: the shared StrategyExecutor + hard risk
 * caps + experiment attribution. Isolated by construction.
 */
export class ExperimentalSalvor extends StrategyExecutor {
  readonly riskCaps: RiskCaps;
  readonly experimentId: string;

  constructor(opts: ExperimentalOptions) {
    const cfg = opts.config;
    const caps: RiskCaps = { ...DEFAULT_RISK_CAPS, ...(cfg.riskCaps ?? {}) };
    const tunables = { ...EXPERIMENTAL_TUNABLES, ...(cfg.tunables ?? {}) };
    const policy: ExecutionPolicy = {
      botId: "experimental",
      cluster: cfg.cluster,
      mode: cfg.mode ?? "dry-run",
      accepts: { kinds: ["certification-ready", "salvageable"] },
      ...DEFAULT_TUNABLES,
      ...tunables,
      retryBackoffMs: cfg.retryBackoffMs ?? 2_000,
    } as ExecutionPolicy;

    const hooks: StrategyHooks = {
      postPrepareGuard: (outcome) => {
        const estimate = outcome.estimate;
        if (!estimate || estimate.status !== "ok") return "economics not fully resolved — risk caps cannot be evaluated";
        if (estimate.costs && estimate.costs.priorityFeeBudget > caps.maxPriorityFeeBudgetLamports) {
          return `priority-fee budget ${estimate.costs.priorityFeeBudget.toString()} exceeds the experiment cap ${caps.maxPriorityFeeBudgetLamports.toString()}`;
        }
        const lpFractionBps = outcome.prepared
          ? (outcome.prepared.snapshotSummary.salvorLpAmount * 10_000n) / outcome.prepared.snapshotSummary.totalSupply
          : 0n;
        if (lpFractionBps > BigInt(caps.maxLpFractionBps)) {
          return `LP position ${lpFractionBps} bps of supply exceeds the experiment cap ${caps.maxLpFractionBps} bps`;
        }
        return null;
      },
      attribution: {
        experimentId: cfg.experimentId,
        riskCaps: {
          maxPriorityFeeBudgetLamports: caps.maxPriorityFeeBudgetLamports.toString(),
          maxLpFractionBps: caps.maxLpFractionBps,
        },
      },
    };

    super({
      policy,
      pipeline: opts.pipeline,
      liveEnablement: cfg.liveEnablement ?? null,
      ...(opts.store ? { store: opts.store } : {}),
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signer ? { signer: opts.signer } : {}),
      ...(opts.attestationSource ? { attestationSource: opts.attestationSource } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      retryBackoffMs: cfg.retryBackoffMs ?? 2_000,
      hooks,
    });
    this.riskCaps = caps;
    this.experimentId = cfg.experimentId;
  }
}

export { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID };
