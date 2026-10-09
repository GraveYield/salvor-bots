// SPDX-License-Identifier: Apache-2.0
//
// Conservative — the REFERENCE executor bot (FLEET-M3).
//
// Role (fleet mandate §3.C): the first complete executor over the
// shared fleet-core engine. Its strategy prioritises stronger
// economics (a HIGH minimum net profit), execution headroom (tighter
// slippage than the protocol ceiling), lower execution uncertainty
// (fewer aggressive retries), and conservative fee limits (a lower
// margin share than the D3 default allows).
//
// ALL orchestration lives in fleet-core's StrategyExecutor — this file
// is the strategy definition (policy numbers + wiring) and nothing
// else. No transaction construction, no private pipeline path.
//
// Documentation gap note (recorded, not invented): the roadmap names
// the Conservative role but does not define numerical thresholds. The
// defaults below are PROPOSED, configurable via
// `ConservativeConfig.tunables`, and validated by `validatePolicy`.

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
} from "@graveyield/fleet-core";

/** Conservative strategy defaults — PROPOSED values, documented in README. */
export const CONSERVATIVE_TUNABLES = {
  ...DEFAULT_TUNABLES,
  /** Strong economics: require ≥ 0.05 SOL net (configurable). */
  minNetProfitLamports: 50_000_000n,
  /** Headroom: tighter slippage than the 300 bps protocol default. */
  slippageBpsOverride: 150 as number | null,
  /** Conservative fee share: 15% of expected profit (≤ D3 default 25%). */
  feeMarginRatio: 0.15,
  /** Lower uncertainty: three attempts, no more. */
  maxSubmitAttempts: 3,
};

export interface ConservativeConfig {
  cluster: Cluster;
  /** Execution mode — DRY-RUN IS THE DEFAULT. */
  mode?: "dry-run" | "simulation" | "live";
  /** Operator enablement for live mode (ignored otherwise). */
  liveEnablement?: LiveEnablement | null;
  scannerProgramId?: string;
  vaultProgramId?: string;
  /** Strategy tunables — spread over CONSERVATIVE_TUNABLES. */
  tunables?: Partial<Record<string, unknown>>;
  /** Which opportunity kinds this bot accepts (default: both). */
  accepts?: ReadonlyArray<"certification-ready" | "salvageable">;
  retryBackoffMs?: number;
}

export interface ConservativeOptions {
  config: ConservativeConfig;
  client: GraveYieldClient;
  pipeline: ExecutionPipeline;
  store?: FleetStore;
  sink?: FleetEventSink;
  /** Salvor keypair — REQUIRED only for live mode. */
  signer?: Keypair;
  /** C1 oracle attestation source for certification-ready envelopes. */
  attestationSource?: AttestationSource;
  now?: () => number;
}

/**
 * The Conservative executor: a StrategyExecutor with the conservative
 * policy. Every behavioral guarantee (idempotency, leases, lifecycle,
 * simulation gate, dry-run gating) is inherited from fleet-core.
 */
export class ConservativeSalvor extends StrategyExecutor {
  constructor(opts: ConservativeOptions) {
    const cfg = opts.config;
    const tunables = { ...CONSERVATIVE_TUNABLES, ...(cfg.tunables ?? {}) };
    const policy: ExecutionPolicy = {
      botId: "conservative",
      cluster: cfg.cluster,
      // Default: DRY-RUN. The only way out is an explicit config.
      mode: cfg.mode ?? "dry-run",
      accepts: { kinds: cfg.accepts ?? ["certification-ready", "salvageable"] },
      retryBackoffMs: cfg.retryBackoffMs ?? 2_000,
      ...DEFAULT_TUNABLES,
      ...tunables,
    } as ExecutionPolicy;
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
    });
  }
}

// Wire the default devnet program ids as named exports for configs.
export { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID };
