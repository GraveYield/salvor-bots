// SPDX-License-Identifier: Apache-2.0
//
// ScoutSalvor — the Phase 10 Scout orchestrator.
//
// One cycle (`runOnce`):
//
//   1. DISCOVER      Raydium V4 enumeration (752-byte AmmInfo filter)
//   2. ENRICH        last-swap activity (cached) → reserves/TVL → metadata
//   3. PRE-FILTER    the six criteria, cheaply (the wide funnel)
//   4. SCORE + QUEUE score = inactivity × tvl × price-collapse margins
//   5. DOUBLE-CHECK  SDK `evaluatePool` (read-only) + LaunchPrice/Anchor/
//                    Cert existence + the admission policy (evaluate.ts)
//   6. SUBMIT*       record_launch_price (C2, when missing + oracle held)
//                    then evaluate_pool_phase_1 (C1 attestation) —
//                    Charter-guarded, dynamic precompile indexing
//   7. MONITOR       poll anchors/certs across every tracked pool; apply
//                    lifecycle transitions; emit opportunity events
//
//   * only in submission mode (dryRun=false AND activity oracle AND
//     operator keypair all present). Dry-run is the default mode.
//
// The Scout NEVER runs phase 2, NEVER builds salvage instructions, and
// NEVER declares a pool abandoned — GraveScanner is the only eligibility
// authority, and the certify/salvage steps belong to the downstream
// execution bots (Phase 10 boundary, owner direction).

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  GraveYieldClient,
  SCANNER_PROTOCOL_CONFIG_DEFAULTS,
  deriveLaunchPriceV4,
  eligibilityAnchorPda,
  eligibilityCertPda,
  fetchEligibilityAnchor,
  fetchEligibilityCert,
  fetchLaunchPrice,
  launchPricePda,
  type EvaluatePoolOutcome,
} from "@graveyield/sdk";

import type {
  ScoutCandidate,
  ScoutCycleResult,
  ScoutOpportunity,
  ScoutScoredCandidate,
  TrackedCandidate,
  FeeSettings,
  OracleIdentity,
} from "./types.js";
import type { ScoutConfig } from "./config.js";
import { RaydiumV4Source } from "./source.js";
import { ActivityIndexer, readReserves, readTokenMetadata } from "./enrich.js";
import { preFilterPool, type PreFilterThresholds } from "./eligibility.js";
import { scoreCandidate } from "./scoring.js";
import { CandidateQueue } from "./queue.js";
import { CandidateTracker, monitorCandidate, MONITORABLE_STATES } from "./lifecycle.js";
import { classifyEvaluation, type EvaluationCheck } from "./evaluate.js";
import {
  buildPhase1Transaction,
  buildRecordLaunchPriceTransaction,
  sendBundle,
  type TxSender,
} from "./submission.js";
import {
  ConsoleReportSink,
  JsonlFileReportSink,
  composeSinks,
  makeEvent,
  type ReportSink,
} from "./reporter.js";
import { loadOracleIdentity, loadSalvorKeypair } from "./keys.js";

/** ScoutSalvor construction options. */
export interface ScoutOptions {
  connection: Connection;
  cluster: ScoutConfig["cluster"];
  scannerProgramId: PublicKey;
  vaultProgramId: PublicKey;
  /** Cheap pre-filter thresholds. */
  thresholds: PreFilterThresholds;
  maxCandidatesPerCycle: number;
  maxPoolsPerScan: number;
  signatureScanLimit: number;
  launchPriceMaxPages: number;
  /** True ⇒ never submit (discovery + evaluation + monitoring only). */
  dryRun: boolean;
  /** Activity oracle (C1) — null ⇒ no phase1 submissions. */
  activityOracle: OracleIdentity | null;
  /** Launch-price oracle (C2) — null ⇒ pools without a LaunchPrice PDA are reported, not recorded. */
  launchPriceOracle: OracleIdentity | null;
  /** Operator (writer/payer) keypair — null ⇒ no submissions. */
  operatorKeypair: Keypair | null;
  fee: FeeSettings;
  maxSubmitAttempts: number;
  pollIntervalMs: number;
  sinks: ReportSink[];
  /** Activity cache TTL (ms); default 1 h. */
  activityCacheTtlMs?: number;
  /** Injectable tx sender (tests); default sendAndConfirmTransaction. */
  txSender?: TxSender;
}

/**
 * States that may re-enter the submission pipeline. Everything else
 * (monitoring states, terminal states) is either driven by the monitoring
 * pass or done — re-classifying a pool that already has on-chain state
 * with the pre-phase1 policy would wrongly eject it from monitoring.
 */
const SUBMISSION_STATES: ReadonlySet<string> = new Set([
  "discovered",
  "queued",
  "evaluated-eligible",
  "submission-failed",
  "launch-price-blocked",
]);

/**
 * ScoutSalvor — the first salvor bot. Discovery, evaluation requests,
 * lifecycle monitoring, and opportunity reporting. Boring by design.
 */
export class ScoutSalvor {
  readonly client: GraveYieldClient;
  private readonly tracker = new CandidateTracker();
  private readonly queue = new CandidateQueue();
  private readonly activityIndexer: ActivityIndexer;
  private readonly source: RaydiumV4Source;
  private readonly sink: ReportSink;
  /** Anchor staleness from the live Scanner ProtocolConfig (refreshed per cycle). */
  private anchorStalenessSeconds: bigint = SCANNER_PROTOCOL_CONFIG_DEFAULTS.anchorStalenessSeconds;
  private running = false;

  constructor(readonly opts: ScoutOptions) {
    this.client = new GraveYieldClient({
      connection: opts.connection,
      cluster: opts.cluster,
      graveScannerProgramId: opts.scannerProgramId,
      graveVaultProgramId: opts.vaultProgramId,
    });
    this.activityIndexer = new ActivityIndexer(
      opts.activityCacheTtlMs !== undefined ? { ttlMs: opts.activityCacheTtlMs } : undefined,
    );
    this.source = new RaydiumV4Source({ maxPools: opts.maxPoolsPerScan });
    this.sink = composeSinks(...opts.sinks);
  }

  // --------------------------------------------------------------- reporting

  private emit(
    type: Parameters<typeof makeEvent>[0],
    pool?: string,
    data?: Record<string, unknown>,
  ): void {
    this.sink.emit(makeEvent(type, pool, data));
  }

  // ------------------------------------------------- evaluate double-check

  /**
   * The read-only double-check: SDK `evaluatePool` plus the three
   * on-chain existence flags the admission policy needs.
   */
  private async evaluateCandidate(poolAddress: PublicKey): Promise<EvaluationCheck> {
    const outcome: EvaluatePoolOutcome = await this.client.evaluatePool(poolAddress);
    const [launchPrice, anchor, cert] = await Promise.all([
      fetchLaunchPrice(this.opts.connection, outcome.launchPricePda),
      fetchEligibilityAnchor(this.opts.connection, outcome.anchorPda),
      fetchEligibilityCert(this.opts.connection, outcome.certPda),
    ]);
    return {
      outcome,
      launchPriceRecorded: launchPrice !== null,
      anchorExists: anchor !== null,
      certExists: cert !== null,
    };
  }

  // ------------------------------------------------------------------ runOnce

  /**
   * Run one full Scout cycle. Returns the cycle summary; every
   * interesting detail flows through the report sinks.
   */
  async runOnce(): Promise<ScoutCycleResult> {
    const startedAtMs = Date.now();
    let discoveredCount = 0;
    let candidateCount = 0;
    let evaluatedCount = 0;
    let launchPricesRecorded = 0;
    let phase1Submitted = 0;
    let phase1Failed = 0;

    // Effective mode: dry-run wins, and submission mode additionally
    // requires both keys (belt and braces — config already validates).
    const canSubmit =
      !this.opts.dryRun &&
      this.opts.activityOracle !== null &&
      this.opts.operatorKeypair !== null;

    this.emit("cycle-start", undefined, { dryRun: !canSubmit });

    // Refresh ProtocolConfigs (also refreshes the Charter fee ceiling cache).
    try {
      const cfgs = await this.client.ensureConfigs();
      this.anchorStalenessSeconds = cfgs.scanner.anchorStalenessSeconds;
    } catch (err) {
      this.emit("error", undefined, {
        stage: "ensure-configs",
        message: String((err as { message?: string }).message ?? err),
      });
      const aborted: ScoutCycleResult = {
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        discoveredCount: 0,
        candidateCount: 0,
        evaluatedCount: 0,
        launchPricesRecorded: 0,
        phase1Submitted: 0,
        phase1Failed: 0,
        opportunities: this.tracker.opportunities().length,
        dryRun: !canSubmit,
      };
      this.emit("cycle-end", undefined, { ...aborted });
      return aborted;
    }

    // ---- stages 1–4: discovery → enrichment → pre-filter → score → queue

    for await (const pool of this.source.enumeratePools(this.opts.connection)) {
      discoveredCount++;
      const record = this.tracker.ensure(pool.poolAddress, pool.ammProgramId);
      // Pin the canonical PDAs (the tracker's ensure() only sets placeholders).
      record.anchorPda = eligibilityAnchorPda(this.opts.scannerProgramId, pool.ammProgramId, pool.poolAddress);
      record.certPda = eligibilityCertPda(this.opts.scannerProgramId, pool.ammProgramId, pool.poolAddress);
      record.launchPricePda = launchPricePda(this.opts.scannerProgramId, pool.ammProgramId, pool.poolAddress);
      if (record.state === "discovered") {
        this.emit("discovered", pool.poolAddress.toBase58());
      }

      const activity = await this.activityIndexer.indexActivity(
        this.opts.connection,
        pool.poolAddress,
        { scanLimit: this.opts.signatureScanLimit },
      );
      const reserves = await readReserves(this.opts.connection, pool.poolAddress, pool.pool);
      if (!reserves) continue; // account missing or unreadable this cycle
      const metadata = await readTokenMetadata(this.opts.connection, pool.poolAddress, pool.pool);
      if (!metadata) continue; // mints missing or uninitialized

      const preFilter = preFilterPool(activity, reserves, metadata, this.opts.thresholds);
      record.activity = activity;
      record.reserves = reserves;
      record.metadata = metadata;
      record.preFilter = preFilter;

      if (!preFilter.passed) {
        if (record.state === "discovered") {
          this.tracker.transition(
            pool.poolAddress,
            "filtered-out",
            preFilter.failedCriteria.join(", "),
          );
          this.emit("filtered-out", pool.poolAddress.toBase58(), {
            failedCriteria: preFilter.failedCriteria,
          });
        }
        continue;
      }

      const candidate: ScoutCandidate = {
        poolAddress: pool.poolAddress,
        ammProgramId: pool.ammProgramId,
        activity,
        reserves,
        metadata,
        preFilter,
      };
      const scored = scoreCandidate(candidate, this.opts.thresholds);
      record.score = scored.score;
      if (SUBMISSION_STATES.has(record.state)) {
        // Exhausted pools do not re-enter the queue (their submission
        // attempts were already spent); blocked pools only re-enter when
        // the missing piece (a launch-price oracle) is now configured.
        const attemptsExhausted = record.submitAttempts >= this.opts.maxSubmitAttempts;
        const blockedForever =
          record.state === "launch-price-blocked" && this.opts.launchPriceOracle === null;
        if (!attemptsExhausted && !blockedForever) {
          this.queue.enqueue(scored);
          if (record.state !== "queued") {
            this.tracker.transition(pool.poolAddress, "queued", `score=${scored.score.toFixed(3)}`);
          }
        }
      }
      candidateCount++;
      this.emit("candidate", pool.poolAddress.toBase58(), {
        score: scored.score,
        breakdown: scored.scoreBreakdown,
      });
    }

    // ---- stages 5–6: double-check the top N, then (maybe) submit

    const top: ScoutScoredCandidate[] = this.queue.drain(this.opts.maxCandidatesPerCycle);
    for (const scored of top) {
      const poolAddress = scored.candidate.poolAddress;
      const record = this.tracker.get(poolAddress);
      if (!record) continue;
      if (!SUBMISSION_STATES.has(record.state)) {
        // Belt and braces: on-chain lifecycle states are owned by the
        // monitoring pass — never re-classify them here.
        continue;
      }

      // Evaluation failures re-queue the candidate for the next cycle.
      let evaluation: EvaluationCheck;
      try {
        evaluation = await this.evaluateCandidate(poolAddress);
      } catch (err) {
        const message = String((err as { message?: string }).message ?? err);
        this.emit("error", poolAddress.toBase58(), { stage: "evaluate-pool", message });
        this.queue.enqueue(scored);
        continue;
      }
      evaluatedCount++;

      const attestable = scored.candidate.activity.lastSwapUnixTs > 0;
      const verdict = classifyEvaluation(evaluation, attestable);
      this.emit("evaluated", poolAddress.toBase58(), {
        eligible: evaluation.outcome.eligible,
        failedCriteria: evaluation.outcome.failedCriteria,
        hardFailures: verdict.hardFailures,
        softFailures: verdict.softFailures,
        launchPriceRecorded: evaluation.launchPriceRecorded,
        anchorExists: evaluation.anchorExists,
        certExists: evaluation.certExists,
        verdict: verdict.admissible
          ? "admissible"
          : verdict.monitorOnly
            ? "monitor-only"
            : "inadmissible",
        reason: verdict.reason,
      });

      if (!verdict.admissible) {
        if (verdict.monitorOnly) {
          // The monitoring pass below takes over from here.
          if (record.state !== "anchor-confirmed") {
            this.tracker.transition(
              poolAddress,
              "anchor-confirmed",
              verdict.reason ?? "on-chain state exists",
            );
          }
        } else if (record.state !== "evaluated-ineligible") {
          this.tracker.transition(
            poolAddress,
            "evaluated-ineligible",
            verdict.reason ?? undefined,
          );
        }
        continue;
      }

      if (!canSubmit) {
        this.tracker.transition(poolAddress, "evaluated-eligible", "dry-run / no submission keys");
        continue;
      }

      if (record.submitAttempts >= this.opts.maxSubmitAttempts) {
        this.tracker.transition(poolAddress, "submission-failed", "max submit attempts exhausted");
        continue;
      }

      // ---- C2: record the launch price when missing (phase 1 requires it)
      if (!evaluation.launchPriceRecorded) {
        if (!this.opts.launchPriceOracle || !this.opts.operatorKeypair) {
          this.tracker.transition(
            poolAddress,
            "launch-price-blocked",
            "LaunchPrice PDA missing and no launch-price oracle configured",
          );
          this.emit("launch-price-blocked", poolAddress.toBase58());
          continue;
        }
        try {
          const derivation = await deriveLaunchPriceV4(
            this.opts.connection,
            scored.candidate.ammProgramId,
            poolAddress,
            { maxPages: this.opts.launchPriceMaxPages },
          );
          if (!derivation) {
            this.tracker.transition(
              poolAddress,
              "launch-price-blocked",
              "pool has never swapped — outside the v1 C1/C2 domain",
            );
            this.emit("launch-price-blocked", poolAddress.toBase58(), { reason: "never-swapped" });
            continue;
          }
          const bundle = await buildRecordLaunchPriceTransaction({
            connection: this.opts.connection,
            client: this.client,
            scannerProgramId: this.opts.scannerProgramId,
            poolAddress,
            derivation,
            oracle: this.opts.launchPriceOracle,
            payer: this.opts.operatorKeypair.publicKey,
            fee: this.opts.fee,
          });
          const sig = await sendBundle({
            connection: this.opts.connection,
            tx: bundle.tx,
            signers: [this.opts.operatorKeypair],
            ...(this.opts.txSender !== undefined ? { sender: this.opts.txSender } : {}),
          });
          record.signatures.launchPrice = sig;
          this.tracker.transition(
            poolAddress,
            "launch-price-recorded",
            `record_launch_price sig=${sig}`,
          );
          launchPricesRecorded++;
          this.emit("launch-price-recorded", poolAddress.toBase58(), {
            signature: sig,
            launchPriceQ64x64: derivation.launchPriceQ64x64.toString(),
          });
        } catch (err) {
          const message = String((err as { message?: string }).message ?? err);
          record.submitAttempts += 1;
          record.lastError = message;
          this.tracker.transition(poolAddress, "submission-failed", `record_launch_price: ${message}`);
          this.emit("phase1-failed", poolAddress.toBase58(), {
            stage: "record-launch-price",
            message,
          });
          phase1Failed++;
          continue;
        }
      }

      // ---- C1: request on-chain evaluation (phase 1)
      try {
        const oracle = this.opts.activityOracle as OracleIdentity;
        const operator = this.opts.operatorKeypair as Keypair;
        const bundle = await buildPhase1Transaction({
          connection: this.opts.connection,
          client: this.client,
          scannerProgramId: this.opts.scannerProgramId,
          poolAddress,
          lastSwapUnixTs: scored.candidate.activity.lastSwapUnixTs,
          oracle,
          writer: operator.publicKey,
          fee: this.opts.fee,
        });
        const sig = await sendBundle({
          connection: this.opts.connection,
          tx: bundle.tx,
          signers: [operator],
          ...(this.opts.txSender !== undefined ? { sender: this.opts.txSender } : {}),
        });
        record.signatures.phase1 = sig;
        this.tracker.transition(
          poolAddress,
          "phase1-submitted",
          `evaluate_pool_phase_1 sig=${sig}`,
        );
        phase1Submitted++;
        this.emit("phase1-submitted", poolAddress.toBase58(), {
          signature: sig,
          anchorPda: record.anchorPda.toBase58(),
          issuedSlot: bundle.issuedSlot,
        });
      } catch (err) {
        const message = String((err as { message?: string }).message ?? err);
        record.submitAttempts += 1;
        record.lastError = message;
        this.tracker.transition(poolAddress, "submission-failed", `phase1: ${message}`);
        this.emit("phase1-failed", poolAddress.toBase58(), { stage: "phase1", message });
        phase1Failed++;
      }
    }

    // ---- stage 7: monitor every tracked pool in a monitorable state

    for (const record of this.tracker.all()) {
      if (!MONITORABLE_STATES.has(record.state)) continue;
      try {
        const outcome = await monitorCandidate({
          connection: this.opts.connection,
          anchorPda: record.anchorPda,
          certPda: record.certPda,
          currentState: record.state,
          anchorStalenessSeconds: this.anchorStalenessSeconds,
        });
        record.firstEligibleEpoch = outcome.firstEligibleEpoch;
        record.anchorWrittenAt = outcome.anchorWrittenAt;
        record.anchorInvalidated = outcome.anchorInvalidated;
        record.certExpiresAt = outcome.certExpiresAt;

        if (outcome.state !== record.state) {
          this.tracker.transition(record.poolAddress, outcome.state, outcome.note ?? undefined);
          switch (outcome.state) {
            case "anchor-confirmed":
              this.emit("anchor-confirmed", record.poolAddress.toBase58(), {
                firstEligibleEpoch: outcome.firstEligibleEpoch?.toString(),
                note: outcome.note,
              });
              break;
            case "waiting-epochs":
              this.emit("waiting-epochs", record.poolAddress.toBase58(), { note: outcome.note });
              break;
            case "certification-ready":
              this.emit("opportunity:certification-ready", record.poolAddress.toBase58(), {
                firstEligibleEpoch: outcome.firstEligibleEpoch?.toString(),
              });
              break;
            case "certified":
              this.emit("opportunity:salvageable", record.poolAddress.toBase58(), {
                certExpiresAt: outcome.certExpiresAt?.toString(),
              });
              break;
            case "cert-expired":
              this.emit("cert-expired", record.poolAddress.toBase58(), {
                certExpiresAt: outcome.certExpiresAt?.toString(),
              });
              break;
            case "anchor-stale":
              this.emit("anchor-stale", record.poolAddress.toBase58(), { note: outcome.note });
              break;
            default:
              this.emit("info", record.poolAddress.toBase58(), {
                state: outcome.state,
                note: outcome.note,
              });
          }
        } else if (record.state === "phase1-submitted") {
          // Keep the operator informed about pending anchor visibility.
          this.emit("info", record.poolAddress.toBase58(), {
            state: record.state,
            note: outcome.note,
          });
        }
      } catch (err) {
        this.emit("error", record.poolAddress.toBase58(), {
          stage: "monitor",
          message: String((err as { message?: string }).message ?? err),
        });
      }
    }

    const opportunities = this.tracker.opportunities();
    const result: ScoutCycleResult = {
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
      discoveredCount,
      candidateCount,
      evaluatedCount,
      launchPricesRecorded,
      phase1Submitted,
      phase1Failed,
      opportunities: opportunities.length,
      dryRun: !canSubmit,
    };
    this.emit("cycle-end", undefined, { ...result });
    return result;
  }

  // ------------------------------------------------------------- long-running

  /** Run cycles forever on the configured interval (until `stop()`). */
  async start(): Promise<void> {
    this.running = true;
    this.emit("info", undefined, {
      message: `scout loop starting (interval ${this.opts.pollIntervalMs}ms)`,
    });
    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        this.emit("error", undefined, {
          stage: "cycle",
          message: String((err as { message?: string }).message ?? err),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, this.opts.pollIntervalMs));
    }
  }

  /** Stop the loop after the current cycle completes. */
  stop(): void {
    this.running = false;
  }

  // ------------------------------------------------------------- accessors

  /** The Scout's formal output: every pool in an opportunity state. */
  opportunities(): ScoutOpportunity[] {
    return this.tracker.opportunities();
  }

  /** Full tracker snapshot (for operators and tests). */
  snapshot(): TrackedCandidate[] {
    return this.tracker.all();
  }

  /** Current queue depth. */
  queueSize(): number {
    return this.queue.size();
  }
}

/**
 * Build a `ScoutSalvor` from the environment-driven `ScoutConfig`.
 * Loads key material, wires the connection + sinks, and applies the
 * config's mode.
 */
export function buildScout(
  config: ScoutConfig,
  overrides?: {
    sinks?: ReportSink[];
    connection?: Connection;
    txSender?: TxSender;
    operatorKeypair?: Keypair;
  },
): ScoutSalvor {
  const connection = overrides?.connection ?? new Connection(config.rpcUrl, "confirmed");
  const sinks =
    overrides?.sinks ??
    ([
      new ConsoleReportSink(),
      ...(config.reportFile !== null ? [new JsonlFileReportSink(config.reportFile)] : []),
    ] as ReportSink[]);

  const operatorKeypair =
    overrides?.operatorKeypair ??
    (config.salvorKeypair !== null ? loadSalvorKeypair(config.salvorKeypair) : null);

  const fee: FeeSettings = {
    feeLamportsPerCu: config.feeLamportsPerCu,
    ...(config.computeUnitLimit !== null ? { computeUnitLimit: config.computeUnitLimit } : {}),
  };

  return new ScoutSalvor({
    connection,
    cluster: config.cluster,
    scannerProgramId: config.scannerProgramId,
    vaultProgramId: config.vaultProgramId,
    thresholds: {
      inactivitySeconds: config.inactivitySeconds,
      priceCollapseBps: config.priceCollapseBps,
      minTvlLamports: config.minTvlLamports,
      lpBurnDustThreshold: config.lpBurnDustThreshold,
    },
    maxCandidatesPerCycle: config.maxCandidatesPerCycle,
    maxPoolsPerScan: config.maxPoolsPerScan,
    signatureScanLimit: config.signatureScanLimit,
    launchPriceMaxPages: config.launchPriceMaxPages,
    dryRun: config.dryRun,
    activityOracle: config.activityOracleKey
      ? loadOracleIdentity(config.activityOracleKey, "ACTIVITY_ORACLE_KEY")
      : null,
    launchPriceOracle: config.launchPriceOracleKey
      ? loadOracleIdentity(config.launchPriceOracleKey, "LAUNCH_PRICE_ORACLE_KEY")
      : null,
    operatorKeypair,
    fee,
    maxSubmitAttempts: config.maxSubmitAttempts,
    pollIntervalMs: config.pollIntervalMs,
    sinks,
    ...(overrides?.txSender !== undefined ? { txSender: overrides.txSender } : {}),
  });
}
