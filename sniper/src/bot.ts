// SPDX-License-Identifier: Apache-2.0
//
// Sniper — the latency-sensitive executor bot (FLEET-M4).
//
// Role (fleet mandate §3.D): timely processing of actionable
// opportunities, particularly when a certificate is already valid and
// the remaining execution window matters. The Sniper's ENTIRE strategy
// layer is:
//
//   1. URGENCY ORDERING — batches are processed soonest-cert-expiry
//      first (ties broken by higher source score, then freshness), so
//      the cert clock decides priority, not arrival order.
//   2. TIGHTER TIME WINDOWS — a 5s quote-freshness window and a short
//      retry backoff; stale quotes and slow paths are rejected early.
//   3. HIGHER FEE SHARE — 30% of expected profit (still hard-capped by
//      the D3 plan and the on-chain Charter ceiling).
//
// What the Sniper MUST NOT do (and cannot, by construction): bypass
// eligibility checks, stale-state revalidation, simulation, fee
// ceilings, profitability minimums, or any other global gate. All of
// those live in the shared StrategyExecutor/ExecutionPipeline path
// this bot inherits unchanged.
//
// Role-definition note: the roadmap's Sniper description is a proposed
// interpretation (urgency-priority execution); the authoritative spec
// does not define it more specifically (recorded gap, FLEET-M4).

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
  type OpportunityEnvelope,
} from "@graveyield/fleet-core";

/** Sniper strategy defaults — PROPOSED values, documented in README. */
export const SNIPER_TUNABLES = {
  ...DEFAULT_TUNABLES,
  /** Fast mover: a lower floor than Conservative (0.02 SOL). */
  minNetProfitLamports: 20_000_000n,
  /** Still tighter than the protocol ceiling (never widens). */
  slippageBpsOverride: 200 as number | null,
  /** Higher fee share than Conservative — capped by the D3 plan. */
  feeMarginRatio: 0.3,
  /** Speed over persistence: two attempts. */
  maxSubmitAttempts: 2,
  /** Fresh quotes ONLY — 5 seconds. */
  quoteMaxAgeMs: 5_000,
  /** Fast retry cadence. */
  retryBackoffMs: 250,
};

export interface SniperConfig {
  cluster: Cluster;
  /** Execution mode — DRY-RUN IS THE DEFAULT. */
  mode?: "dry-run" | "simulation" | "live";
  liveEnablement?: LiveEnablement | null;
  scannerProgramId?: string;
  vaultProgramId?: string;
  tunables?: Partial<Record<string, unknown>>;
  retryBackoffMs?: number;
}

export interface SniperOptions {
  config: SniperConfig;
  client: GraveYieldClient;
  pipeline: ExecutionPipeline;
  store?: FleetStore;
  sink?: FleetEventSink;
  signer?: Keypair;
  attestationSource?: AttestationSource;
  now?: () => number;
}

/**
 * Urgency comparator: soonest cert expiry first (salvageable windows
 * are the clock that matters), then higher source score, then fresher
 * sightings. Certification-ready opportunities (no clock) sort last.
 */
export function byCertUrgency(a: OpportunityEnvelope, b: OpportunityEnvelope): number {
  const expiryOf = (e: OpportunityEnvelope): number =>
    e.certExpiresAt !== null ? Number(e.certExpiresAt) : Number.MAX_SAFE_INTEGER;
  const ea = expiryOf(a);
  const eb = expiryOf(b);
  if (ea !== eb) return ea - eb;
  const scoreA = a.provenance.score ?? 0;
  const scoreB = b.provenance.score ?? 0;
  if (scoreA !== scoreB) return scoreB - scoreA;
  return b.provenance.detectedAtMs - a.provenance.detectedAtMs;
}

/**
 * The Sniper executor: the shared StrategyExecutor + urgency ordering
 * + the sniper time/fee windows. No other behavioral delta.
 */
export class SniperSalvor extends StrategyExecutor {
  constructor(opts: SniperOptions) {
    const cfg = opts.config;
    const tunables = { ...SNIPER_TUNABLES, ...(cfg.tunables ?? {}) };
    const policy: ExecutionPolicy = {
      botId: "sniper",
      cluster: cfg.cluster,
      mode: cfg.mode ?? "dry-run",
      accepts: { kinds: ["certification-ready", "salvageable"] },
      ...DEFAULT_TUNABLES,
      ...tunables,
      retryBackoffMs: cfg.retryBackoffMs ?? SNIPER_TUNABLES.retryBackoffMs,
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
      retryBackoffMs: cfg.retryBackoffMs ?? SNIPER_TUNABLES.retryBackoffMs,
      hooks: { comparator: (envelopes) => envelopes.sort(byCertUrgency) },
    });
  }
}

export { DEVNET_SCANNER_PROGRAM_ID, DEVNET_VAULT_PROGRAM_ID };
