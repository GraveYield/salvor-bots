// SPDX-License-Identifier: Apache-2.0
//
// Structured fleet events + failure classification (FLEET-M1).
//
// Every bot (Scout, executors, Monitor) publishes FleetEvents through a
// FleetEventSink. The JSON shape is the fleet's machine-readable
// contract — Monitor/Risk consumes it, and every event carries the
// emitting bot id + the opportunity identity key so events can be
// attributed and replayed.

import { opportunityKey, type FleetOpportunityIdentity, type OpportunityEnvelope } from "./envelope.js";
import type { ExecutionState } from "./lifecycle.js";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Failure taxonomy — stable names the Monitor keys its diagnostics on.
 * `transient-*` classes are retryable; everything else is terminal for
 * the current state of the opportunity.
 */
export type FailureClass =
  | "transient-rpc"
  | "transient-route"
  | "transient-blockhash"
  | "stale-opportunity"
  | "stale-anchor"
  | "cert-expired"
  | "cert-missing"
  | "anchor-missing"
  | "criteria-failed"
  | "state-changed"
  | "missing-accounts"
  | "economic-insufficient"
  | "economic-unresolvable"
  | "risk-cap-exceeded"
  | "lease-conflict"
  | "charter-refusal"
  | "simulation-failed"
  | "route-failure"
  | "snapshot-incomplete"
  | "submission-failed"
  | "unsupported"
  | "config-invalid"
  | "unknown";

/** Retryable failure classes (executors may re-enter preparation). */
export const RETRYABLE_FAILURE_CLASSES: readonly FailureClass[] = [
  "transient-rpc",
  "transient-route",
  "transient-blockhash",
  "submission-failed",
];

export function isRetryable(failure: FailureClass): boolean {
  return RETRYABLE_FAILURE_CLASSES.includes(failure);
}

/** Fleet event types — the vocabulary of the whole fleet's wire log. */
export type FleetEventType =
  // consumption
  | "opportunity-received"
  | "opportunity-duplicate"
  | "opportunity-rejected"
  // revalidation
  | "revalidated"
  | "revalidation-rejected"
  // coordination
  | "lease-acquired"
  | "lease-renewed"
  | "lease-denied"
  | "lease-released"
  // economics
  | "economic-pass"
  | "economic-reject"
  // execution
  | "prepared"
  | "simulated"
  | "simulation-failed"
  | "submitted"
  | "confirmed"
  | "execution-failed"
  | "reported"
  // monitor
  | "monitor-observation"
  | "monitor-anomaly"
  | "monitor-reconciled"
  | "monitor-mismatch"
  // lifecycle / ops
  | "cycle-start"
  | "cycle-end"
  | "info"
  | "error";

/** The structured event — one JSON object per line for JSONL sinks. */
export interface FleetEvent {
  /** Epoch ms. */
  tsMs: number;
  /** Emitting bot id ("scout", "conservative", "monitor", …). */
  botId: string;
  type: FleetEventType;
  /** Canonical opportunity identity key when pool-scoped. */
  identityKey?: string;
  /** Base58 pool address (duplicate of the identity tail for grep-ability). */
  pool?: string;
  /** The executor lifecycle state at emit time, when applicable. */
  state?: ExecutionState;
  /** Stable failure class for failure-carrying events. */
  failureClass?: FailureClass;
  /** Free-form structured payload (signatures, amounts as decimal strings, reasons…). */
  data?: Record<string, unknown>;
}

/** Where FleetEvents go. All sinks must never throw into the caller's loop. */
export interface FleetEventSink {
  emit(event: FleetEvent): void;
}

/** Build the canonical identity key for an identity (re-exported convenience). */
export function identityKeyOf(identity: FleetOpportunityIdentity): string {
  return opportunityKey(identity);
}

/** Identity key from an envelope. */
export function keyOfEnvelope(envelope: OpportunityEnvelope): string {
  return opportunityKey(envelope.identity);
}

/** Assemble a FleetEvent with defaults filled. */
export function makeEvent(input: {
  botId: string;
  type: FleetEventType;
  identity?: string | FleetOpportunityIdentity | null | undefined;
  state?: ExecutionState;
  failureClass?: FailureClass;
  data?: Record<string, unknown>;
  now?: () => number;
}): FleetEvent {
  const identityKey =
    typeof input.identity === "string"
      ? input.identity
      : input.identity
        ? opportunityKey(input.identity)
        : undefined;
  const event: FleetEvent = {
    tsMs: (input.now ?? Date.now)(),
    botId: input.botId,
    type: input.type,
  };
  if (identityKey !== undefined) {
    event.identityKey = identityKey;
    const pool = identityKey.split("|")[2];
    if (pool !== undefined) event.pool = pool;
  }
  if (input.state !== undefined) event.state = input.state;
  if (input.failureClass !== undefined) event.failureClass = input.failureClass;
  if (input.data !== undefined) event.data = input.data;
  return event;
}

/** In-memory ring sink — tests + the Monitor's replay path. */
export class MemoryEventSink implements FleetEventSink {
  readonly events: FleetEvent[] = [];
  constructor(private readonly limit = 10_000) {}
  emit(event: FleetEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.shift();
  }
  /** All events matching a predicate (replay helper). */
  where(predicate: (e: FleetEvent) => boolean): FleetEvent[] {
    return this.events.filter(predicate);
  }
  eventsFor(identityKey: string): FleetEvent[] {
    return this.where((e) => e.identityKey === identityKey);
  }
}

/** JSONL file sink — one JSON object per line, append-only. */
export class JsonlEventSink implements FleetEventSink {
  private readonly stream: import("node:fs").WriteStream;
  constructor(filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      /* the write below surfaces a usable error */
    }
    this.stream = createWriteStream(filePath, { flags: "a" });
  }
  emit(event: FleetEvent): void {
    this.stream.write(`${JSON.stringify(event)}\n`);
  }
  close(): void {
    this.stream.end();
  }
}

/** Fan-out sink — attach as many downstream consumers as needed. */
export class FanoutEventSink implements FleetEventSink {
  constructor(private readonly sinks: FleetEventSink[]) {}
  emit(event: FleetEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        /* a broken sink must not break the emitting bot */
      }
    }
  }
}

/** Console sink for operators (pretty by default, `--json` for machines). */
export class ConsoleEventSink implements FleetEventSink {
  constructor(private readonly json = false, private readonly out: (line: string) => void = console.log) {}
  emit(event: FleetEvent): void {
    if (this.json) {
      this.out(JSON.stringify(event));
      return;
    }
    const scope = event.identityKey ? ` ${event.identityKey}` : "";
    const extra = event.data ? ` ${JSON.stringify(event.data)}` : "";
    this.out(`[${event.botId}] ${event.type}${scope}${extra}`);
  }
}
