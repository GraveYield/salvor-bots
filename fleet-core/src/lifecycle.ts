// SPDX-License-Identifier: Apache-2.0
//
// Executor lifecycle states + allowed transitions (FLEET-M1).
//
// Every opportunity an executor consumes walks an explicit state
// machine. The map below is the CONTRACT: anything else is a bug, and
// `assertTransition` throws on illegal moves instead of letting a bot
// drift into an undefined state (e.g. submitting after a terminal
// failure).

/** Executor-side lifecycle states for one opportunity identity. */
export type ExecutionState =
  | "received"
  | "duplicate-suppressed"
  | "revalidating"
  | "rejected-stale"
  | "rejected-economics"
  | "lease-waiting"
  | "preparing"
  | "simulating"
  | "simulation-failed"
  | "ready"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed-terminal"
  | "reported";

const ALLOWED: Record<ExecutionState, readonly ExecutionState[]> = {
  received: ["duplicate-suppressed", "revalidating"],
  "duplicate-suppressed": [],
  revalidating: ["rejected-stale", "rejected-economics", "lease-waiting", "preparing"],
  "rejected-stale": ["reported"],
  "rejected-economics": ["reported"],
  "lease-waiting": ["preparing", "failed-terminal"],
  // Economic rejection is DURING preparation (the estimator runs inside
  // the shared pipeline's prepare step), so preparing may reject too.
  preparing: ["simulating", "rejected-economics", "failed-terminal"],
  simulating: ["simulation-failed", "ready", "failed-terminal"],
  "simulation-failed": ["preparing", "failed-terminal"],
  ready: ["submitting", "failed-terminal"],
  submitting: ["submitted", "failed-terminal"],
  submitted: ["confirmed", "failed-terminal"],
  confirmed: ["reported"],
  "failed-terminal": ["reported"],
  reported: [],
};

/** States that carry a signature or other durable outcome for the Monitor. */
export const OUTCOME_STATES: readonly ExecutionState[] = [
  "rejected-stale",
  "rejected-economics",
  "simulation-failed",
  "confirmed",
  "failed-terminal",
];

/** True when `to` is a legal successor of `from`. */
export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return ALLOWED[from].includes(to);
}

/** Legal successors of `state` (for diagnostics + tests). */
export function transitionsFrom(state: ExecutionState): readonly ExecutionState[] {
  return ALLOWED[state];
}

/** True when no further transitions exist. */
export function isTerminal(state: ExecutionState): boolean {
  return ALLOWED[state].length === 0;
}

/** Throw on an illegal transition — the state machine is the contract. */
export function assertTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `illegal lifecycle transition ${from} → ${to} (allowed: ${ALLOWED[from].join(", ") || "none"})`,
    );
  }
}

/** One entry in an opportunity's transition history. */
export interface TransitionRecord {
  from: ExecutionState | null;
  to: ExecutionState;
  tsMs: number;
  note: string | null;
}

/** A tiny mutable walker over the state machine (used by executors + tests). */
export class LifecycleWalker {
  private current: ExecutionState;
  private readonly history: TransitionRecord[] = [];

  constructor(initial: ExecutionState = "received", private readonly now: () => number = Date.now) {
    this.current = initial;
    this.history.push({ from: null, to: initial, tsMs: this.now(), note: null });
  }

  get state(): ExecutionState {
    return this.current;
  }

  get transitions(): readonly TransitionRecord[] {
    return this.history;
  }

  to(next: ExecutionState, note?: string): void {
    assertTransition(this.current, next);
    this.history.push({ from: this.current, to: next, tsMs: this.now(), note: note ?? null });
    this.current = next;
  }

  /** Only advance when the predicate holds — otherwise stay put (used for retry loops). */
  toIf(next: ExecutionState, predicate: boolean, note?: string): boolean {
    if (!predicate) return false;
    this.to(next, note);
    return true;
  }
}
