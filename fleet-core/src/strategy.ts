// SPDX-License-Identifier: Apache-2.0
//
// The shared strategy executor (FLEET-M1, generalized in FLEET-M4/M5).
//
// ONE orchestration for ALL executor strategies: idempotent admission,
// age check, lease, prepare → (retry transient) → simulate →
// (live: submit with retries) → report → persist. Conservative,
// Sniper, and Experimental all run THIS loop; a strategy is only its
// policy numbers + optional hooks:
//
//   * `comparator` — batch ordering for runOnce (Sniper's urgency sort).
//   * `postPrepareGuard` — a strategy risk gate over the prepared
//     outcome (Experimental's risk caps). Returning a string rejects
//     the opportunity BEFORE any simulation/submission.
//   * `attribution` — extra fields stamped on every event this bot
//     emits (Experimental's experiment id).
//
// There is deliberately NO hook that can bypass the global gates: the
// hooks run BEFORE/AFTER the pipeline's fixed prepare/simulate/submit
// path, and no hook receives a transaction it could submit itself.

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  InMemoryFleetStore,
  LifecycleWalker,
  MemoryEventSink,
  admitDelivery,
  makeEvent,
  opportunityKey,
  validatePolicy,
  type ExecutionPipeline,
  type ExecutionPolicy,
  type FleetEventSink,
  type FleetStore,
  type LiveEnablement,
  type OpportunityEnvelope,
  type AttestationSource,
  type PipelineOutcome,
} from "./index.js";

/** Optional strategy hooks. */
export interface StrategyHooks {
  /**
   * Batch ordering for `runOnce` — receive the envelopes, return the
   * processing order. Snipers sort by urgency; conservative bots keep
   * arrival order (undefined = arrival order).
   */
  comparator?: (envelopes: OpportunityEnvelope[]) => OpportunityEnvelope[];
  /**
   * Risk gate over the prepared outcome — runs AFTER prepare succeeds
   * and BEFORE simulation/submission. Return a reason string to reject
   * (classified `risk-cap-exceeded`), `null` to proceed.
   */
  postPrepareGuard?: (outcome: PipelineOutcome & { ok: true }) => string | null;
  /** Extra fields stamped onto every event this strategy emits. */
  attribution?: Record<string, unknown>;
}

export interface StrategyExecutorOptions {
  policy: ExecutionPolicy;
  pipeline: ExecutionPipeline;
  /** Operator enablement for live mode (required when policy.mode = live). */
  liveEnablement?: LiveEnablement | null;
  store?: FleetStore;
  sink?: FleetEventSink;
  /** Salvor keypair — REQUIRED only for live mode. */
  signer?: Keypair;
  /** C1 oracle attestation source for certification-ready envelopes. */
  attestationSource?: AttestationSource;
  now?: () => number;
  /** Strategy hooks (see above). */
  hooks?: StrategyHooks;
  /** Retry backoff base (ms). */
  retryBackoffMs?: number;
}

/** Summary of one runOnce() batch. */
export interface StrategyCycleResult {
  startedAtMs: number;
  durationMs: number;
  received: number;
  duplicates: number;
  processed: number;
  passed: number;
  failed: number;
  dryRun: boolean;
}

/** Outcome of processing ONE envelope. */
export interface StrategyOutcome {
  identityKey: string;
  admitted: boolean;
  state: string;
  ok: boolean;
  signature?: string;
  failureClass?: string;
  reason?: string;
}

/**
 * The fleet's single executor orchestration. Instantiate one per bot;
 * process envelopes through `runOnce` or `processEnvelope`.
 */
export class StrategyExecutor {
  readonly policy: ExecutionPolicy;
  protected readonly pipeline: ExecutionPipeline;
  protected readonly store: FleetStore;
  protected readonly sink: FleetEventSink;
  protected readonly signer: Keypair | null;
  protected readonly attestationSource: AttestationSource | null;
  protected readonly now: () => number;
  protected readonly hooks: StrategyHooks;
  protected readonly retryBackoffMs: number;

  constructor(opts: StrategyExecutorOptions) {
    this.policy = validatePolicy(opts.policy, opts.liveEnablement ?? null);
    this.pipeline = opts.pipeline;
    this.store = opts.store ?? new InMemoryFleetStore();
    this.sink = opts.sink ?? new MemoryEventSink();
    this.signer = opts.signer ?? null;
    this.attestationSource = opts.attestationSource ?? null;
    this.now = opts.now ?? Date.now;
    this.hooks = opts.hooks ?? {};
    this.retryBackoffMs = opts.retryBackoffMs ?? 2_000;
    if (this.policy.mode === "live" && !this.signer) {
      throw new Error(`${this.policy.botId}: live mode requires a signer keypair`);
    }
  }

  protected emit(type: Parameters<typeof makeEvent>[0]["type"], identityKey: string, data: Record<string, unknown>): void {
    this.sink.emit(
      makeEvent({
        botId: this.policy.botId,
        type,
        identity: identityKey,
        data: this.hooks.attribution ? { ...data, ...this.hooks.attribution } : data,
      }),
    );
  }

  /** Process ONE envelope end-to-end through the shared gates. */
  async processEnvelope(envelope: OpportunityEnvelope): Promise<StrategyOutcome> {
    const identityKey = opportunityKey(envelope.identity);
    const walker = new LifecycleWalker("received", this.now);

    // 1. Idempotent admission.
    const admitted = await admitDelivery(this.store, this.policy.botId, envelope);
    if (!admitted) {
      walker.to("duplicate-suppressed");
      await this.persist(identityKey, walker, null);
      return { identityKey, admitted: false, state: walker.state, ok: true, reason: "duplicate delivery suppressed" };
    }

    // 1b. Fleet-level at-most-once: if ANY bot (including a previous
    // incarnation of this one) already SUBMITTED a transaction for this
    // identity, do not race it again. Dry-run records carry no
    // signature, so observation-only passes never suppress others.
    const priorRecords = await this.store.listExecutions(identityKey);
    const executedBy = priorRecords.find((r) => r.signature !== null);
    if (executedBy) {
      walker.to("duplicate-suppressed", `already executed by ${executedBy.botId}`);
      this.emit("opportunity-duplicate", identityKey, { executedBy: executedBy.botId, signature: executedBy.signature });
      await this.persist(identityKey, walker, null);
      return { identityKey, admitted: true, state: walker.state, ok: true, reason: `opportunity already executed by ${executedBy.botId}` };
    }
    this.emit("opportunity-received", identityKey, { kind: envelope.kind, deliveryId: envelope.deliveryId });

    // 2. Opportunity age.
    if (this.now() - envelope.provenance.detectedAtMs > this.policy.maxOpportunityAgeMs) {
      walker.to("revalidating");
      walker.to("rejected-stale", "opportunity older than maxOpportunityAgeMs");
      this.emit("opportunity-rejected", identityKey, { reason: "stale opportunity" });
      await this.persist(identityKey, walker, null);
      return { identityKey, admitted: true, state: walker.state, ok: false, failureClass: "stale-opportunity", reason: "stale opportunity" };
    }

    // 3. Lease.
    const lease = await this.store.acquireLease(identityKey, this.policy.botId, this.policy.leaseTtlMs);
    if (!lease) {
      walker.to("revalidating");
      walker.to("lease-waiting");
      const holder = await this.store.getLease(identityKey);
      this.emit("lease-denied", identityKey, { holder: holder?.holder ?? "unknown" });
      await this.persist(identityKey, walker, null);
      return { identityKey, admitted: true, state: walker.state, ok: false, failureClass: "lease-conflict", reason: "another bot holds the lease" };
    }
    this.emit("lease-acquired", identityKey, { expiresAtMs: lease.expiresAtMs });

    try {
      // 4. Prepare via the SHARED pipeline.
      walker.to("revalidating");
      walker.to("preparing");
      const prepareArgs: {
        envelope: OpportunityEnvelope;
        salvor: PublicKey;
        attestationSource?: AttestationSource;
      } = { envelope, salvor: this.salvorKey() };
      if (this.attestationSource) prepareArgs.attestationSource = this.attestationSource;
      let prepared = await this.pipeline.prepare(prepareArgs);
      this.emit("revalidated", identityKey, { ok: prepared.ok });

      // Retry ONLY transient classes within the attempt cap.
      if (!prepared.ok && isRetryableClass(prepared.failureClass)) {
        for (let attempt = 1; attempt <= this.policy.maxSubmitAttempts && !prepared.ok; attempt++) {
          this.emit("info", identityKey, { retry: attempt, reason: prepared.reason });
          prepared = await this.pipeline.prepare(prepareArgs);
        }
      }
      if (!prepared.ok) {
        const terminalClass = prepared.failureClass ?? "unknown";
        if (terminalClass === "economic-insufficient" || terminalClass === "economic-unresolvable") {
          walker.to("rejected-economics");
        } else if (terminalClass === "simulation-failed") {
          walker.to("simulation-failed");
        } else {
          walker.to("failed-terminal");
        }
        this.emit(terminalClass.startsWith("economic") ? "economic-reject" : "execution-failed", identityKey, {
          failureClass: terminalClass,
          ...(prepared.reason !== undefined ? { reason: prepared.reason } : {}),
        });
        await this.persist(identityKey, walker, null);
        const outcome: StrategyOutcome = { identityKey, admitted: true, state: walker.state, ok: false, failureClass: terminalClass };
        if (prepared.reason !== undefined) outcome.reason = prepared.reason;
        return outcome;
      }

      // 4b. Strategy risk gate (Experimental's caps) — before anything
      // expensive or risky happens downstream.
      if (this.hooks.postPrepareGuard) {
        const risk = this.hooks.postPrepareGuard(prepared as PipelineOutcome & { ok: true });
        if (risk !== null) {
          walker.to("rejected-economics");
          this.emit("economic-reject", identityKey, { failureClass: "risk-cap-exceeded", reason: risk });
          await this.persist(identityKey, walker, null);
          return { identityKey, admitted: true, state: walker.state, ok: false, failureClass: "risk-cap-exceeded", reason: risk };
        }
      }

      walker.to("simulating");
      this.emit("prepared", identityKey, { kind: prepared.prepared!.kind });

      // 5. Simulate.
      const sim = await this.pipeline.simulate(prepared.prepared!, envelope.identity);
      if (!sim.ok) {
        walker.to("simulation-failed");
        this.emit("simulation-failed", identityKey, { reason: sim.reason, failureClass: sim.failureClass });
        await this.persist(identityKey, walker, null);
        const outcome: StrategyOutcome = { identityKey, admitted: true, state: walker.state, ok: false };
        if (sim.failureClass !== undefined) outcome.failureClass = sim.failureClass;
        if (sim.reason !== undefined) outcome.reason = sim.reason;
        return outcome;
      }
      walker.to("ready");

      // 6. Submission — LIVE ONLY.
      if (this.policy.mode !== "live") {
        await this.persist(identityKey, walker, null);
        this.emit("reported", identityKey, { dryRun: true, wouldSubmit: true, mode: this.policy.mode });
        return { identityKey, admitted: true, state: walker.state, ok: true, reason: `dry-run complete (mode=${this.policy.mode}) — nothing submitted` };
      }

      walker.to("submitting");
      const signer = this.signer!;
      let submitted: PipelineOutcome | null = null;
      let lastError: string | null = null;
      for (let attempt = 1; attempt <= this.policy.maxSubmitAttempts; attempt++) {
        try {
          submitted = await this.pipeline.submit({ prepared: prepared.prepared!, signer, identity: envelope.identity });
          break;
        } catch (err) {
          lastError = String(err);
          this.emit("execution-failed", identityKey, { attempt, reason: lastError, failureClass: "submission-failed" });
          if (attempt < this.policy.maxSubmitAttempts) {
            await sleep(this.retryBackoffMs * attempt);
          }
        }
      }
      if (!submitted || !submitted.ok) {
        walker.to("failed-terminal");
        this.emit("execution-failed", identityKey, { reason: lastError ?? "submission failed", failureClass: "submission-failed" });
        await this.persist(identityKey, walker, null);
        return { identityKey, admitted: true, state: walker.state, ok: false, failureClass: "submission-failed", reason: lastError ?? "submission failed" };
      }
      walker.to("submitted");
      if (submitted.signature) {
        walker.to("confirmed");
        this.emit("confirmed", identityKey, {
          signature: submitted.signature,
          totalProceedsLamports: submitted.receipt?.totalProceedsLamports.toString(),
          salvorAmountLamports: submitted.receipt?.salvorAmountLamports.toString(),
          lpHolderAmountLamports: submitted.receipt?.lpHolderAmountLamports.toString(),
          protocolAmountLamports: submitted.receipt?.protocolAmountLamports.toString(),
        });
      }
      walker.to("reported");
      this.emit("reported", identityKey, { signature: submitted.signature });
      await this.persist(identityKey, walker, submitted.signature ?? null);
      const done: StrategyOutcome = { identityKey, admitted: true, state: walker.state, ok: true };
      if (submitted.signature !== undefined) done.signature = submitted.signature;
      return done;
    } finally {
      await this.store.releaseLease(identityKey, this.policy.botId).catch(() => {});
    }
  }

  /** Process a batch (one cycle), ordered by the strategy's comparator. */
  async runOnce(envelopes: OpportunityEnvelope[]): Promise<StrategyCycleResult> {
    const startedAtMs = this.now();
    const ordered = this.hooks.comparator ? this.hooks.comparator([...envelopes]) : envelopes;
    const results: StrategyOutcome[] = [];
    for (const env of ordered) {
      results.push(await this.processEnvelope(env));
    }
    return {
      startedAtMs,
      durationMs: this.now() - startedAtMs,
      received: envelopes.length,
      duplicates: results.filter((r) => !r.admitted).length,
      processed: results.filter((r) => r.admitted).length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => r.admitted && !r.ok).length,
      dryRun: this.policy.mode !== "live",
    };
  }

  protected salvorKey(): PublicKey {
    if (this.signer) return this.signer.publicKey;
    // Dry-run still needs a pubkey for derivation — a fixed placeholder
    // (nothing is ever submitted in dry-run).
    return new PublicKey(new Uint8Array(32).fill(0xee));
  }

  protected async persist(identityKey: string, walker: LifecycleWalker, signature: string | null): Promise<void> {
    const existing = await this.store.getExecution(identityKey, this.policy.botId);
    await this.store.putExecution({
      identityKey,
      botId: this.policy.botId,
      state: walker.state,
      transitions: [...(existing?.transitions ?? []), ...walker.transitions],
      signature: signature ?? existing?.signature ?? null,
      seenDeliveries: existing?.seenDeliveries ?? [],
      updatedAtMs: this.now(),
    });
  }
}

function isRetryableClass(cls: PipelineOutcome["failureClass"]): boolean {
  return cls === "transient-rpc" || cls === "transient-route" || cls === "transient-blockhash";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
