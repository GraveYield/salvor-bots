// SPDX-License-Identifier: Apache-2.0
//
// Candidate queue — the Scout's pipeline stage 7. Ported from the Phase 9
// indexer (`indexer/src/queue.ts`). Priority by score descending, dedup
// by pool address (highest score wins).
//
// In-memory by design: Phase 10 has exactly one Scout and no persistent
// queue store (Redis/SQLite land with Phase 11 observability).

import type { ScoutScoredCandidate } from "./types.js";

/**
 * CandidateQueue — a priority queue of scored candidates. Deduplicates
 * by pool address (highest score wins); `drain(n)` yields the top N by
 * score descending and removes them.
 */
export class CandidateQueue {
  private readonly entries = new Map<string, ScoutScoredCandidate>();

  /** Add or update a scored candidate; the higher score wins. */
  enqueue(scored: ScoutScoredCandidate): void {
    const key = scored.candidate.poolAddress.toBase58();
    const existing = this.entries.get(key);
    if (!existing || scored.score > existing.score) {
      this.entries.set(key, scored);
    }
  }

  /** Drain the top N candidates by score descending (removes them). */
  drain(n: number): ScoutScoredCandidate[] {
    const all = [...this.entries.values()];
    all.sort((a, b) => b.score - a.score);
    const out = all.slice(0, n);
    for (const s of out) {
      this.entries.delete(s.candidate.poolAddress.toBase58());
    }
    return out;
  }

  /** Peek at the top N candidates without removing them. */
  peek(n: number): ScoutScoredCandidate[] {
    const all = [...this.entries.values()];
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, n);
  }

  /** Remove a specific pool from the queue. */
  remove(poolAddress: string): boolean {
    return this.entries.delete(poolAddress);
  }

  /** Current queue size. */
  size(): number {
    return this.entries.size;
  }

  /** Clear the queue. */
  clear(): void {
    this.entries.clear();
  }

  /** Check if a pool is already queued. */
  has(poolAddress: string): boolean {
    return this.entries.has(poolAddress);
  }
}
