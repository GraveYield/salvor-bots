// SPDX-License-Identifier: Apache-2.0
//
// Fleet opportunity identity + versioned envelope (FLEET-M1).
//
// The minimum opportunity identity across the whole fleet is the triple
// (cluster, AMM program ID, pool address). Everything downstream —
// idempotency, leases, execution records, monitor reconciliation — keys
// off its canonical string form, so restarts and duplicate deliveries
// collapse onto the same record instead of racing.
//
// The envelope is the VERSIONED wire format executor bots consume. It is
// deliberately a plain serializable object (no PublicKey / bigint on the
// wire — base58 strings and decimal strings) so JSONL sinks, HTTP hops,
// or a future queue can carry it byte-faithfully.

import { createHash } from "node:crypto";

/** The clusters an opportunity can reference. */
export type FleetCluster = "localnet" | "devnet" | "mainnet-beta";

/** The two Scout opportunity kinds the fleet acts on. */
export type OpportunityKind = "certification-ready" | "salvageable";

/**
 * The minimum opportunity identity: (cluster, AMM program, pool).
 * Two bots seeing the same pool on the same cluster share one identity.
 */
export interface FleetOpportunityIdentity {
  cluster: FleetCluster;
  /** Base58 AMM program ID (v1 fleet: Raydium V4 only). */
  ammProgramId: string;
  /** Base58 pool address. */
  poolAddress: string;
}

/**
 * Canonical identity key — `cluster|amm|pool`. The ONLY key style used
 * for idempotency, leases, and execution records. Stable across
 * processes and restarts.
 */
export function opportunityKey(identity: FleetOpportunityIdentity): string {
  return `${identity.cluster}|${identity.ammProgramId}|${identity.poolAddress}`;
}

/** Parse a canonical identity key back into its parts. */
export function parseOpportunityKey(key: string): FleetOpportunityIdentity {
  const parts = key.split("|");
  if (parts.length !== 3) {
    throw new Error(`malformed opportunity key "${key}" — expected cluster|amm|pool`);
  }
  const [cluster, ammProgramId, poolAddress] = parts as [string, string, string];
  if (cluster !== "localnet" && cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new Error(`malformed opportunity key "${key}" — unknown cluster "${cluster}"`);
  }
  if (!ammProgramId || !poolAddress) {
    throw new Error(`malformed opportunity key "${key}" — empty program or pool`);
  }
  return { cluster, ammProgramId, poolAddress };
}

/**
 * Deterministic delivery id for idempotent consumption: a hash over the
 * identity + kind + source-detected-at + source bot. Re-delivery of the
 * SAME opportunity event (at-least-once sinks) collapses onto one
 * delivery; a genuinely NEW sighting (newer detection time, different
 * kind) is a new delivery that revalidation may admit or reject.
 */
export function deliveryIdOf(input: {
  identity: FleetOpportunityIdentity;
  kind: OpportunityKind;
  sourceBot: string;
  detectedAtMs: number;
}): string {
  const h = createHash("sha256");
  h.update(`${input.identity.cluster}|${input.identity.ammProgramId}|${input.identity.poolAddress}`);
  h.update(`|${input.kind}`);
  h.update(`|${input.sourceBot}`);
  h.update(`|${input.detectedAtMs}`);
  return h.digest("hex");
}

/** Where an envelope came from — attribution follows the opportunity everywhere. */
export interface OpportunityProvenance {
  /** Emitting bot id (e.g. "scout"). */
  bot: string;
  /** When the SOURCE detected the opportunity (epoch ms). */
  detectedAtMs: number;
  /** The source's advisory priority score, if it published one. NOT an economics input. */
  score: number | null;
}

/** Envelope schema version — bump on any breaking wire change. */
export const OPPORTUNITY_ENVELOPE_VERSION = 1 as const;

/**
 * The versioned opportunity envelope every executor consumes. All
 * numeric protocol quantities are decimal strings on the wire; the
 * typed accessors in `envelopeNumbers` convert on demand.
 */
export interface OpportunityEnvelope {
  schemaVersion: typeof OPPORTUNITY_ENVELOPE_VERSION;
  /** Deterministic delivery id (see `deliveryIdOf`) — idempotency key. */
  deliveryId: string;
  identity: FleetOpportunityIdentity;
  kind: OpportunityKind;
  provenance: OpportunityProvenance;
  /** Anchor epoch the ≥2-epoch confirmation counts from (decimal string), when known. */
  firstEligibleEpoch: string | null;
  /** Cert expiry (unix SECONDS, decimal string) for `salvageable` envelopes. */
  certExpiresAt: string | null;
  /** Millisecond timestamp when the consumer received the envelope. */
  receivedAtMs: number;
}

/** A concise envelope for logs and events — identity key + kind + provenance. */
export function describeEnvelope(env: OpportunityEnvelope): string {
  return `${opportunityKey(env.identity)} [${env.kind}] from ${env.provenance.bot} @ ${env.provenance.detectedAtMs}`;
}

/** Build an envelope from typed parts (converts bigint → decimal strings). */
export function buildEnvelope(input: {
  identity: FleetOpportunityIdentity;
  kind: OpportunityKind;
  sourceBot: string;
  detectedAtMs: number;
  score: number | null;
  firstEligibleEpoch?: bigint | null;
  certExpiresAt?: bigint | null;
  receivedAtMs?: number;
}): OpportunityEnvelope {
  const env: OpportunityEnvelope = {
    schemaVersion: OPPORTUNITY_ENVELOPE_VERSION,
    deliveryId: deliveryIdOf({
      identity: input.identity,
      kind: input.kind,
      sourceBot: input.sourceBot,
      detectedAtMs: input.detectedAtMs,
    }),
    identity: input.identity,
    kind: input.kind,
    provenance: { bot: input.sourceBot, detectedAtMs: input.detectedAtMs, score: input.score },
    firstEligibleEpoch:
      input.firstEligibleEpoch !== undefined && input.firstEligibleEpoch !== null
        ? input.firstEligibleEpoch.toString(10)
        : null,
    certExpiresAt:
      input.certExpiresAt !== undefined && input.certExpiresAt !== null
        ? input.certExpiresAt.toString(10)
        : null,
    receivedAtMs: input.receivedAtMs ?? Date.now(),
  };
  return env;
}

/** Structural validation — rejects wrong-version or incomplete envelopes. */
export function validateEnvelope(value: unknown): OpportunityEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new Error("envelope: not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== OPPORTUNITY_ENVELOPE_VERSION) {
    throw new Error(`envelope: unsupported schemaVersion ${String(v.schemaVersion)}`);
  }
  const identity = v.identity as FleetOpportunityIdentity | undefined;
  if (!identity || typeof identity.cluster !== "string" || typeof identity.ammProgramId !== "string" || typeof identity.poolAddress !== "string") {
    throw new Error("envelope: missing identity");
  }
  if (v.kind !== "certification-ready" && v.kind !== "salvageable") {
    throw new Error(`envelope: invalid kind ${String(v.kind)}`);
  }
  if (typeof v.deliveryId !== "string" || v.deliveryId.length !== 64) {
    throw new Error("envelope: deliveryId must be a sha256 hex string");
  }
  const provenance = v.provenance as OpportunityProvenance | undefined;
  if (!provenance || typeof provenance.bot !== "string" || typeof provenance.detectedAtMs !== "number") {
    throw new Error("envelope: missing provenance");
  }
  // Re-derive the delivery id — a mismatched id means a hand-edited or
  // corrupted envelope; reject rather than dedup on attacker-chosen keys.
  const expected = deliveryIdOf({
    identity,
    kind: v.kind,
    sourceBot: provenance.bot,
    detectedAtMs: provenance.detectedAtMs,
  });
  if (v.deliveryId !== expected) {
    throw new Error("envelope: deliveryId does not match its content");
  }
  return v as unknown as OpportunityEnvelope;
}
