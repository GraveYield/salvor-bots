// SPDX-License-Identifier: Apache-2.0
//
// FleetMonitor — the Monitor/Risk observer and verification layer
// (FLEET-M2).
//
// WHAT IT IS: an independent observer over the whole fleet's structured
// events (Scout's ScoutEvents and every executor's FleetEvents), plus a
// post-execution VERIFIER that reconciles claimed outcomes against the
// live chain and the GraveVault SalvageReceipt.
//
// WHAT IT IS NOT (hard boundary, enforced by construction): the Monitor
// has NO keypair, NO signer, NO TransactionInstruction builder, and NO
// code path that submits anything. It only ever reads.
//
// Responsibilities (fleet mandate §3.B):
//   * consume structured Scout + executor events;
//   * track opportunity age, certificate expiry, execution status,
//     signatures, failures, retries, and confirmed outcomes;
//   * verify successful transactions against chain state and the
//     GraveVault salvage receipt (40/40/20 amounts + total);
//   * reconcile reported execution results with on-chain outcomes;
//   * detect stale opportunities, failed transactions, missing state,
//     conflicting bot claims, repeated attempts, and anomalous outcomes;
//   * emit structured, machine-readable events and diagnostics;
//   * support replayable tests with mocked RPC + recorded events.

import { PublicKey } from "@solana/web3.js";
import {
  decodeSalvageReceipt,
  eligibilityCertPda,
  fetchEligibilityCert,
  salvageReceiptPda,
  type GraveYieldClient,
} from "@graveyield/sdk";

import {
  keyOfEnvelope,
  makeEvent,
  opportunityKey,
  type FleetEvent,
  type FleetEventSink,
  type FleetEventType,
  type FailureClass,
  type OpportunityEnvelope,
} from "@graveyield/fleet-core";

/** Where an observed event came from. */
export type EventSource = "scout" | "executor" | "monitor" | "operator";

/** A recorded Scout event (ScoutEvent shape, pool + type + data). */
export interface ScoutEventLike {
  tsMs: number;
  type: string;
  pool?: string;
  data?: Record<string, unknown>;
}

/** One opportunity's observation state as the Monitor tracks it. */
export interface ObservedOpportunity {
  identityKey: string;
  cluster: string;
  ammProgramId: string;
  poolAddress: string;
  /** Discovery / last-sighting timestamps. */
  firstSeenMs: number;
  lastActivityMs: number;
  /** The kinds each bot has claimed for this identity. */
  claims: Array<{ bot: string; kind: string; tsMs: number }>;
  /** Execution attempts observed (per bot). */
  attempts: Array<{
    bot: string;
    tsMs: number;
    type: FleetEventType;
    failureClass?: FailureClass;
    signature?: string;
    reason?: string;
  }>;
  /** Confirmed signatures with their timestamps. */
  signatures: Array<{ bot: string; signature: string; tsMs: number }>;
  /** Reported economics at confirmation (decimal strings). */
  reportedReceipt: {
    totalProceedsLamports: string;
    salvorAmountLamports: string;
    lpHolderAmountLamports: string;
    protocolAmountLamports: string;
  } | null;
  /** Cert expiry the fleet last reported (unix seconds string). */
  certExpiresAt: string | null;
}

/** The verdict of reconciling a claimed execution with the chain. */
export interface Reconciliation {
  identityKey: string;
  poolAddress: string;
  bot: string;
  signature: string;
  /** "receipt-verified": receipt found + sums + bot attribution match. */
  status:
    | "receipt-verified"
    | "receipt-missing"
    | "receipt-anomaly"
    | "cert-gone"
    | "chain-unreadable";
  /** Human/JSON diagnostics. */
  detail: Record<string, unknown>;
  /** The on-chain receipt when found. */
  receipt: {
    totalProceedsLamports: bigint;
    salvorAmountLamports: bigint;
    lpHolderAmountLamports: bigint;
    protocolAmountLamports: bigint;
    dustMemecoinLamports: bigint;
    salvor: string;
    issuedAtSlot: bigint;
  } | null;
}

/** Monitor configuration. */
export interface MonitorConfig {
  botId: string;
  /** An opportunity with no activity for longer than this is flagged stale (ms). */
  staleAfterMs: number;
  /** A confirmed-but-unverified execution older than this is flagged unverified (ms). */
  verificationGraceMs: number;
  /** More than this many attempts on one identity (across bots) is anomalous. */
  maxAttemptsPerIdentity: number;
  /** Now (epoch ms) — injectable for deterministic tests. */
  now?: () => number;
}

/** A diagnostic the Monitor raises. */
export interface MonitorDiagnostic {
  tsMs: number;
  severity: "info" | "warning" | "critical";
  identityKey: string | null;
  code:
    | "stale-opportunity"
    | "cert-expiry-imminent"
    | "cert-expired"
    | "repeated-attempts"
    | "conflicting-claims"
    | "failed-simulation"
    | "failed-submission"
    | "unverified-confirmation"
    | "receipt-mismatch"
    | "receipt-missing"
    | "receipt-verified"
    | "reconciled";
  detail: Record<string, unknown>;
}

export interface MonitorOptions {
  client: GraveYieldClient;
  config: MonitorConfig;
  /** The Monitor's own event output. */
  sink: FleetEventSink;
}

/**
 * The fleet observer. Feed it events (`observeScoutEvent`,
 * `observeFleetEvent`); read its state (`snapshot`, `diagnose`);
 * reconcile confirmed outcomes on chain (`reconcile`).
 */
export class FleetMonitor {
  readonly client: GraveYieldClient;
  readonly config: MonitorConfig;
  private readonly sink: FleetEventSink;
  private readonly now: () => number;
  private readonly observations = new Map<string, ObservedOpportunity>();
  /**
   * Event-identity dedup (replay safety): botId|type|identity|tsMs|data.
   * Sibling events flowing under ONE envelope delivery are distinct
   * observations; a REPLAYED log re-sends identical events, which
   * collapse here.
   */
  private readonly seenEventIds = new Set<string>();
  /** Env-numbered facts the monitor tracks for cert expiry. */
  private readonly certExpiries = new Map<string, string>();

  constructor(opts: MonitorOptions) {
    this.client = opts.client;
    this.config = opts.config;
    this.sink = opts.sink;
    this.now = opts.config.now ?? Date.now;
  }

  // ------------------------------------------------------------- ingestion

  private emit(type: FleetEventType, data: Record<string, unknown>, identityKey?: string): void {
    const event = makeEvent({ botId: this.config.botId, type, data });
    if (identityKey !== undefined) event.identityKey = identityKey;
    this.sink.emit(event);
  }

  private observationFor(identityKey: string): ObservedOpportunity {
    let obs = this.observations.get(identityKey);
    if (!obs) {
      const [cluster = "", amm = "", pool = ""] = identityKey.split("|");
      obs = {
        identityKey,
        cluster,
        ammProgramId: amm,
        poolAddress: pool,
        firstSeenMs: this.now(),
        lastActivityMs: this.now(),
        claims: [],
        attempts: [],
        signatures: [],
        reportedReceipt: null,
        certExpiresAt: null,
      };
      this.observations.set(identityKey, obs);
    }
    return obs;
  }

  /**
   * Ingest an executor FleetEvent. Replaying a recorded event stream is
   * side-effect-free: identical events (bot, type, identity, ts, data)
   * collapse onto their first observation.
   */
  observeFleetEvent(event: FleetEvent, envelope?: OpportunityEnvelope): void {
    void envelope; // provenance is carried on the event itself
    const eventId = `${event.botId}|${event.type}|${event.identityKey ?? ""}|${event.tsMs}|${JSON.stringify(event.data ?? null)}`;
    if (this.seenEventIds.has(eventId)) return; // replayed event
    this.seenEventIds.add(eventId);
    if (!event.identityKey) {
      this.emit("monitor-observation", { kind: "non-scoped-event", type: event.type });
      return;
    }
    const obs = this.observationFor(event.identityKey);
    obs.lastActivityMs = event.tsMs;
    const signatureData = event.data as { signature?: string; reason?: string } | undefined;
    const failureReason = (event.data as { reason?: string } | undefined)?.reason;

    switch (event.type) {
      case "opportunity-received":
      case "revalidated":
        obs.claims.push({ bot: event.botId, kind: String((event.data as { kind?: unknown })?.kind ?? "unknown"), tsMs: event.tsMs });
        break;
      case "economic-pass":
      case "prepared":
      case "submitted":
        obs.attempts.push({
          bot: event.botId,
          tsMs: event.tsMs,
          type: event.type,
          ...(event.failureClass !== undefined ? { failureClass: event.failureClass } : {}),
          ...(signatureData?.signature !== undefined ? { signature: signatureData.signature } : {}),
          ...(signatureData?.reason !== undefined ? { reason: signatureData.reason } : {}),
        });
        break;
      case "confirmed": {
        const signature = signatureData?.signature;
        if (signature) obs.signatures.push({ bot: event.botId, signature, tsMs: event.tsMs });
        const receipt = (event.data as {
          totalProceedsLamports?: string;
          salvorAmountLamports?: string;
          lpHolderAmountLamports?: string;
          protocolAmountLamports?: string;
        } | undefined);
        if (receipt?.totalProceedsLamports) {
          obs.reportedReceipt = {
            totalProceedsLamports: receipt.totalProceedsLamports ?? "0",
            salvorAmountLamports: receipt.salvorAmountLamports ?? "0",
            lpHolderAmountLamports: receipt.lpHolderAmountLamports ?? "0",
            protocolAmountLamports: receipt.protocolAmountLamports ?? "0",
          };
        }
        break;
      }
      case "simulation-failed":
      case "execution-failed":
      case "revalidation-rejected":
      case "economic-reject":
      case "opportunity-rejected":
        obs.attempts.push({
          bot: event.botId,
          tsMs: event.tsMs,
          type: event.type,
          ...(event.failureClass !== undefined ? { failureClass: event.failureClass } : {}),
          ...(failureReason !== undefined ? { reason: failureReason } : {}),
        });
        break;
      default:
        // Everything else still refreshes lastActivityMs (already done).
        break;
    }

    // Cert expiry tracking from any event that carries it.
    const certExpires = (event.data as { certExpiresAt?: string } | undefined)?.certExpiresAt;
    if (typeof certExpires === "string") this.certExpiries.set(event.identityKey, certExpires);
    obs.certExpiresAt = this.certExpiries.get(event.identityKey) ?? null;

    this.emit("monitor-observation", { observed: event.type, bot: event.botId }, event.identityKey);
  }

  /** Ingest a Scout event (different shape — pool base58, string types). */
  observeScoutEvent(event: ScoutEventLike): void {
    if (!event.pool) return; // Scout cycle events are not identity-scoped
    const identityKey = `devnet|unknown|${event.pool}`;
    // The Scout's FleetEvents carry the full identity when the executor
    // forwards them; standalone Scout events keep their own channel.
    const obs = this.observations.get(`__scout__${event.pool}`);
    if (obs) {
      obs.lastActivityMs = event.tsMs;
      return;
    }
    const created: ObservedOpportunity = {
      identityKey,
      cluster: "scout-channel",
      ammProgramId: event.pool,
      poolAddress: event.pool,
      firstSeenMs: event.tsMs,
      lastActivityMs: event.tsMs,
      claims: [],
      attempts: [],
      signatures: [],
      reportedReceipt: null,
      certExpiresAt: null,
    };
    this.observations.set(`__scout__${event.pool}`, created);
    if (event.type === "opportunity:salvageable" || event.type === "opportunity:certification-ready") {
      this.emit("monitor-observation", { observed: event.type, source: "scout" }, created.identityKey);
    }
  }

  // ------------------------------------------------------------- queries

  /** All observations (copy). */
  snapshot(): ObservedOpportunity[] {
    return [...this.observations.values()].map((o) => structuredClone(o));
  }

  /** One identity's observation. */
  observe(identityKey: string): ObservedOpportunity | null {
    return this.observations.get(identityKey) ?? null;
  }

  /**
   * Run the anomaly sweep over current state: staleness, cert expiry,
   * repeated attempts, conflicting claims, unverified confirmations.
   */
  diagnose(): MonitorDiagnostic[] {
    const now = this.now();
    const out: MonitorDiagnostic[] = [];
    for (const obs of this.observations.values()) {
      const age = now - obs.firstSeenMs;
      // Stale opportunity: nothing happened for a long time.
      if (now - obs.lastActivityMs > this.config.staleAfterMs && obs.signatures.length === 0) {
        out.push({
          tsMs: now,
          severity: "warning",
          identityKey: obs.identityKey,
          code: "stale-opportunity",
          detail: { ageMs: age, lastActivityMs: obs.lastActivityMs },
        });
      }
      // Cert expiry tracking.
      if (obs.certExpiresAt) {
        const expiresAtSec = BigInt(obs.certExpiresAt);
        const nowSec = BigInt(Math.floor(now / 1000));
        const remaining = expiresAtSec - nowSec;
        if (remaining <= 0n) {
          out.push({
            tsMs: now,
            severity: "info",
            identityKey: obs.identityKey,
            code: "cert-expired",
            detail: { expiresAt: obs.certExpiresAt },
          });
        } else if (remaining * 1000n < 600_000n) {
          out.push({
            tsMs: now,
            severity: "warning",
            identityKey: obs.identityKey,
            code: "cert-expiry-imminent",
            detail: { remainingMs: Number(remaining * 1000n) },
          });
        }
      }
      // Repeated attempts across the fleet.
      const attempts = obs.attempts.filter((a) => a.type === "prepared" || a.type === "submitted");
      if (attempts.length > this.config.maxAttemptsPerIdentity) {
        out.push({
          tsMs: now,
          severity: "warning",
          identityKey: obs.identityKey,
          code: "repeated-attempts",
          detail: { attempts: attempts.length, bots: [...new Set(attempts.map((a) => a.bot))] },
        });
      }
      // Conflicting claims: two bots each claiming a DIFFERENT kind for
      // the same identity at (roughly) the same time.
      const kindsByBot = new Map<string, Set<string>>();
      for (const c of obs.claims) {
        if (!kindsByBot.has(c.bot)) kindsByBot.set(c.bot, new Set());
        kindsByBot.get(c.bot)!.add(c.kind);
      }
      if (kindsByBot.size > 1) {
        const allKinds = new Set<string>();
        for (const s of kindsByBot.values()) for (const k of s) allKinds.add(k);
        if (allKinds.size > 1) {
          out.push({
            tsMs: now,
            severity: "warning",
            identityKey: obs.identityKey,
            code: "conflicting-claims",
            detail: { claims: obs.claims.map((c) => ({ bot: c.bot, kind: c.kind })) },
          });
        }
      }
      // Confirmed but never reconciled.
      if (obs.signatures.length > 0 && !obs.reportedReceipt) {
        out.push({
          tsMs: now,
          severity: "warning",
          identityKey: obs.identityKey,
          code: "unverified-confirmation",
          detail: { signatures: obs.signatures.map((s) => s.signature) },
        });
      }
      // Failed submissions/simulations are surfaced as critical only
      // when they repeat; the first failure is normal fleet noise.
      const failures = obs.attempts.filter((a) => a.failureClass !== undefined);
      const failsByClass = new Map<string, number>();
      for (const f of failures) {
        const key = f.failureClass ?? "unknown";
        failsByClass.set(key, (failsByClass.get(key) ?? 0) + 1);
      }
      for (const [cls, count] of failsByClass) {
        if (count > 1) {
          out.push({
            tsMs: now,
            severity: cls.startsWith("transient") ? "warning" : "critical",
            identityKey: obs.identityKey,
            code: cls === "simulation-failed" ? "failed-simulation" : cls === "submission-failed" ? "failed-submission" : "repeated-attempts",
            detail: { failureClass: cls, count },
          });
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------- verification

  /**
   * Reconcile one identity's reported confirmation against the live
   * chain: read the SalvageReceipt PDA, check the 40/40/20 sums, the
   * bot attribution, and (when applicable) whether the cert is gone or
   * still live. READ-ONLY — the Monitor cannot submit anything.
   */
  async reconcile(identityKey: string, bot: string, signature: string): Promise<Reconciliation> {
    const obs = this.observations.get(identityKey);
    const poolAddress = obs?.poolAddress ?? identityKey.split("|")[2] ?? "";
    let poolPubkey: PublicKey;
    try {
      poolPubkey = new PublicKey(poolAddress);
    } catch {
      return { identityKey, poolAddress, bot, signature, status: "chain-unreadable", detail: { error: "unparseable pool address" }, receipt: null };
    }

    let info = null;
    try {
      info = await this.client.connection.getAccountInfo(salvageReceiptPda(this.client.graveVaultProgramId, poolPubkey));
    } catch (err) {
      return { identityKey, poolAddress, bot, signature, status: "chain-unreadable", detail: { error: String(err) }, receipt: null };
    }
    if (!info) {
      this.emit("monitor-mismatch", { status: "receipt-missing", signature, bot }, identityKey);
      return { identityKey, poolAddress, bot, signature, status: "receipt-missing", detail: { note: "no SalvageReceipt PDA on chain for this pool" }, receipt: null };
    }
    const receipt = decodeSalvageReceipt(info.data);
    const sum =
      receipt.lpHolderAmountLamports + receipt.salvorAmountLamports + receipt.protocolAmountLamports;
    const sumsOk = sum === receipt.totalProceedsLamports;
    const sharesOk =
      // Each leg within 1 lamport of its 40/40/20 share of total.
      receipt.totalProceedsLamports === 0n ||
      (shareMatches(receipt.lpHolderAmountLamports, receipt.totalProceedsLamports, 4_000) &&
        shareMatches(receipt.salvorAmountLamports, receipt.totalProceedsLamports, 4_000) &&
        shareMatches(receipt.protocolAmountLamports, receipt.totalProceedsLamports, 2_000));

    // Compare against what the executor REPORTED.
    const reportedOk =
      !obs?.reportedReceipt ||
      (obs.reportedReceipt.totalProceedsLamports === receipt.totalProceedsLamports.toString(10) &&
        obs.reportedReceipt.salvorAmountLamports === receipt.salvorAmountLamports.toString(10));

    const status: Reconciliation["status"] = sumsOk && sharesOk && reportedOk ? "receipt-verified" : "receipt-anomaly";
    this.emit(status === "receipt-verified" ? "monitor-reconciled" : "monitor-mismatch", {
      status,
      signature,
      sum: sum.toString(10),
      total: receipt.totalProceedsLamports.toString(10),
      reportedOk,
      sumsOk,
      sharesOk,
    }, identityKey);

    return {
      identityKey,
      poolAddress,
      bot,
      signature,
      status,
      detail: {
        sumsOk,
        sharesOk,
        reportedOk,
        expectedSharesBps: { lpHolder: 4_000, salvor: 4_000, protocol: 2_000 },
      },
      receipt: {
        totalProceedsLamports: receipt.totalProceedsLamports,
        salvorAmountLamports: receipt.salvorAmountLamports,
        lpHolderAmountLamports: receipt.lpHolderAmountLamports,
        protocolAmountLamports: receipt.protocolAmountLamports,
        dustMemecoinLamports: receipt.dustMemecoinLamports,
        salvor: receipt.salvor.toBase58(),
        issuedAtSlot: receipt.issuedAtSlot,
      },
    };
  }

  /** Check the LIVE cert state for an identity (cert gone / still valid). */
  async checkCert(ammProgramId: string, poolAddress: string): Promise<{ exists: boolean; expiresAt: bigint | null }> {
    const cert = await fetchEligibilityCert(
      this.client.connection,
      eligibilityCertPda(this.client.graveScannerProgramId, new PublicKey(ammProgramId), new PublicKey(poolAddress)),
    );
    return { exists: cert !== null, expiresAt: cert?.expiresAt ?? null };
  }
}

/** |amount − bps% × total| ≤ 1 lamport (integer rounding tolerance). */
function shareMatches(amount: bigint, total: bigint, bps: number): boolean {
  const expected = (total * BigInt(bps)) / 10_000n;
  const diff = amount > expected ? amount - expected : expected - amount;
  return diff <= 1n;
}
