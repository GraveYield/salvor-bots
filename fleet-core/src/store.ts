// SPDX-License-Identifier: Apache-2.0
//
// Fleet coordination store — idempotency, execution records, leases
// (FLEET-M1).
//
// ⚠️ DEPLOYMENT TOPOLOGY (explicit, per the fleet mandate): the shipped
// `InMemoryFleetStore` coordinates bots INSIDE ONE PROCESS ONLY. An
// in-memory map absolutely does NOT prevent two separate processes from
// racing the same opportunity. Multi-process / multi-host deployments
// MUST provide a `FleetStore` implementation over shared state (the
// interface below is the seam); the fleet ships no such backend in v1
// because the supported topology is one process per bot on one host,
// with AT MOST one executor enabled per identity via configuration.
// Monitor/Risk observes every executor's events regardless of topology.

import { opportunityKey, type FleetOpportunityIdentity, type OpportunityEnvelope } from "./envelope.js";
import type { ExecutionState, TransitionRecord } from "./lifecycle.js";

/** A lease on one opportunity identity held by one bot. */
export interface OpportunityLease {
  identityKey: string;
  /** Bot id holding the lease. */
  holder: string;
  /** Epoch ms when the lease expires (holders renew before expiry). */
  expiresAtMs: number;
}

/** A durable (per-process) record of what an executor did with an identity. */
export interface ExecutionRecord {
  identityKey: string;
  botId: string;
  state: ExecutionState;
  /** Transition history (append-only). */
  transitions: TransitionRecord[];
  /** Last confirmed signature, once submitted. */
  signature: string | null;
  /** Delivery ids already consumed for this identity (idempotency set). */
  seenDeliveries: string[];
  updatedAtMs: number;
}

/**
 * The coordination surface every executor + monitor shares. All methods
 * are async so remote backends slot in without call-site changes.
 */
export interface FleetStore {
  // ---- idempotent consumption ----
  /** True iff `deliveryId` was already consumed by this bot. */
  hasDelivery(botId: string, deliveryId: string): Promise<boolean>;
  /** Mark a delivery consumed (idempotent itself). */
  markDelivery(botId: string, deliveryId: string, envelope: OpportunityEnvelope): Promise<void>;

  // ---- execution records ----
  getExecution(identityKey: string, botId: string): Promise<ExecutionRecord | null>;
  putExecution(record: ExecutionRecord): Promise<void>;
  /** All records for an identity across bots (Monitor reconciliation input). */
  listExecutions(identityKey: string): Promise<ExecutionRecord[]>;

  // ---- leases ----
  /**
   * Try to acquire the lease for `identityKey`. Returns the lease when
   * free or expired, `null` when another holder still owns it.
   */
  acquireLease(identityKey: string, holder: string, ttlMs: number): Promise<OpportunityLease | null>;
  /** Renew (extend) a lease the holder currently owns. */
  renewLease(identityKey: string, holder: string, ttlMs: number): Promise<OpportunityLease | null>;
  /** Release a lease (completion, failure, or shutdown). */
  releaseLease(identityKey: string, holder: string): Promise<void>;
  /** Current lease holder info, if any. */
  getLease(identityKey: string): Promise<OpportunityLease | null>;
}

/** Identity helper — the canonical key for an envelope. */
export function keyOf(identity: FleetOpportunityIdentity): string {
  return opportunityKey(identity);
}

/**
 * In-memory FleetStore. SINGLE-PROCESS COORDINATION ONLY — see the
 * module docblock. Deterministic, zero-dependency, and adequate for the
 * supported v1 topology plus every offline test.
 */
export class InMemoryFleetStore implements FleetStore {
  private readonly deliveries = new Map<string, OpportunityEnvelope>();
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly leases = new Map<string, OpportunityLease>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async hasDelivery(botId: string, deliveryId: string): Promise<boolean> {
    return this.deliveries.has(`${botId}#${deliveryId}`);
  }

  async markDelivery(botId: string, deliveryId: string, envelope: OpportunityEnvelope): Promise<void> {
    this.deliveries.set(`${botId}#${deliveryId}`, envelope);
  }

  async getExecution(identityKey: string, botId: string): Promise<ExecutionRecord | null> {
    return this.executions.get(`${identityKey}#${botId}`) ?? null;
  }

  async putExecution(record: ExecutionRecord): Promise<void> {
    this.executions.set(`${record.identityKey}#${record.botId}`, { ...record, updatedAtMs: this.now() });
  }

  async listExecutions(identityKey: string): Promise<ExecutionRecord[]> {
    const out: ExecutionRecord[] = [];
    for (const [key, record] of this.executions) {
      if (key.startsWith(`${identityKey}#`)) out.push({ ...record });
    }
    return out;
  }

  async acquireLease(identityKey: string, holder: string, ttlMs: number): Promise<OpportunityLease | null> {
    const existing = this.leases.get(identityKey);
    const now = this.now();
    if (existing && existing.holder !== holder && existing.expiresAtMs > now) {
      return null; // another live holder owns it
    }
    const lease: OpportunityLease = { identityKey, holder, expiresAtMs: now + ttlMs };
    this.leases.set(identityKey, lease);
    return lease;
  }

  async renewLease(identityKey: string, holder: string, ttlMs: number): Promise<OpportunityLease | null> {
    const existing = this.leases.get(identityKey);
    const now = this.now();
    if (!existing || existing.holder !== holder || existing.expiresAtMs <= now) return null;
    const renewed: OpportunityLease = { ...existing, expiresAtMs: now + ttlMs };
    this.leases.set(identityKey, renewed);
    return renewed;
  }

  async releaseLease(identityKey: string, holder: string): Promise<void> {
    const existing = this.leases.get(identityKey);
    if (existing && existing.holder === holder) this.leases.delete(identityKey);
  }

  async getLease(identityKey: string): Promise<OpportunityLease | null> {
    const existing = this.leases.get(identityKey);
    if (!existing) return null;
    if (existing.expiresAtMs <= this.now()) return null; // expired leases read as absent
    return { ...existing };
  }

  // ---- test/diagnostic surface ----
  /** Number of live (unexpired) leases — used by tests + the monitor. */
  liveLeaseCount(): number {
    const now = this.now();
    let n = 0;
    for (const lease of this.leases.values()) if (lease.expiresAtMs > now) n++;
    return n;
  }
}

/**
 * Idempotent envelope admission: returns `null` when the delivery was
 * already consumed (duplicate), otherwise marks + returns the envelope.
 * Convenience wrapper over hasDelivery/markDelivery that every
 * consumer loop should route through.
 */
export async function admitDelivery(
  store: FleetStore,
  botId: string,
  envelope: OpportunityEnvelope,
): Promise<OpportunityEnvelope | null> {
  if (await store.hasDelivery(botId, envelope.deliveryId)) return null;
  await store.markDelivery(botId, envelope.deliveryId, envelope);
  return envelope;
}
