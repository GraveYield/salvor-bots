// SPDX-License-Identifier: Apache-2.0
//
// Report sinks — how the Scout talks to operators and to the next
// execution component.
//
// Every interesting Scout moment becomes a `ScoutEvent` pushed to every
// configured sink. The default CLI wiring is console JSON lines plus an
// optional JSONL file (`SCOUT_REPORT_FILE`). Opportunity events
// (`opportunity:certification-ready`, `opportunity:salvageable`) are the
// Scout's formal output — the Sniper / Conservative / Experimental bots
// consume them (in-process via `ScoutSalvor.opportunities()`, or from the
// JSONL stream) under their own execution policy.

import { appendFileSync } from "node:fs";
import type { ScoutEvent, ScoutEventType } from "./types.js";

/** A destination for Scout events. */
export interface ReportSink {
  emit(event: ScoutEvent): void;
}

/** Construct an event with a timestamp. */
export function makeEvent(
  type: ScoutEventType,
  pool?: string,
  data?: Record<string, unknown>,
): ScoutEvent {
  const event: ScoutEvent = { tsMs: Date.now(), type };
  if (pool !== undefined) event.pool = pool;
  if (data !== undefined) event.data = data;
  return event;
}

/** In-memory sink — the primary assertion point for tests. */
export class MemoryReportSink implements ReportSink {
  readonly events: ScoutEvent[] = [];

  emit(event: ScoutEvent): void {
    this.events.push(event);
  }

  /** All events of one type. */
  ofType(type: ScoutEventType): ScoutEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /** First event matching a pool + type (for ordered assertions). */
  first(pool: string, type: ScoutEventType): ScoutEvent | undefined {
    return this.events.find((e) => e.pool === pool && e.type === type);
  }
}

/** Console sink — one JSON line per event on stdout. */
export class ConsoleReportSink implements ReportSink {
  emit(event: ScoutEvent): void {
    // Structured single-line JSON keeps `| jq` / log shippers simple.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(event));
  }
}

/** JSONL file sink — appends one JSON line per event. */
export class JsonlFileReportSink implements ReportSink {
  constructor(private readonly filePath: string) {}

  emit(event: ScoutEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}

/** Fan out an event to every sink; one failing sink never blocks the rest. */
export function composeSinks(...sinks: ReportSink[]): ReportSink {
  return {
    emit(event: ScoutEvent): void {
      for (const sink of sinks) {
        try {
          sink.emit(event);
        } catch {
          // A broken sink (disk full, pipe closed) must not kill the bot.
        }
      }
    },
  };
}
