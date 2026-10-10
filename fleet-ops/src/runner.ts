// SPDX-License-Identifier: Apache-2.0
//
// FleetRunner — "first Salvor running" as a supervised service.
//
// One process, two schedules:
//   * the Scout runs its discovery → evaluation → submission cycle;
//   * the Monitor sweeps its tracked opportunities and diagnostics.
//
// The bridge is the important part: the Scout's event sink FANOUTS into
// the Monitor's `observeScoutEvent`, so every Scout emission (discovery,
// phase-1 submissions, lifecycle transitions, opportunity events) is
// ingested by the Monitor in the same process — the fleet's read-only
// observer sees exactly what the Scout does, with no second feed to
// drift. Executor bots join through the same pattern when an operator
// enables them (they stay dry-run by default; enabling live execution is
// an explicit operator act, never a runner default).
//
// The runner owns observability: health heartbeats + counters, alerts on
// cycle failures and critical diagnostics, JSONL trails via the
// fleet-core sinks. It never touches keys and never changes the Scout's
// dry-run gate.

import type { FleetEvent, FleetEventSink } from "@graveyield/fleet-core";
import type { ScoutCycleResult, ScoutSalvor } from "@graveyield/scout";
import type { FleetMonitor, MonitorDiagnostic } from "@graveyield/monitor";

import type { AlertManager, AlertSeverity } from "./alerts.js";
import type { HealthRegistry } from "./health.js";

/** Severity mapping for monitor diagnostic codes (default: info). */
const DIAGNOSTIC_SEVERITY: Record<MonitorDiagnostic["code"], AlertSeverity> = {
  "stale-opportunity": "warn",
  "cert-expiry-imminent": "info",
  "cert-expired": "warn",
  "repeated-attempts": "warn",
  "conflicting-claims": "critical",
  "failed-simulation": "critical",
  "failed-submission": "warn",
  "unverified-confirmation": "warn",
  "receipt-mismatch": "critical",
  "receipt-missing": "warn",
  "receipt-verified": "info",
  reconciled: "info",
};

/** Runner options. The Scout and Monitor are constructed by the caller. */
export interface FleetRunnerOptions {
  scout: Pick<ScoutSalvor, "runOnce">;
  monitor: Pick<FleetMonitor, "diagnose" | "observeScoutEvent" | "observeFleetEvent" | "snapshot">;
  health: HealthRegistry;
  alerts: AlertManager;
  /** Extra event sink for the monitor's own output (JSONL trail). */
  monitorSink?: FleetEventSink;
  /** Scout cycle interval in ms (drives the freshness window). */
  scoutPollMs?: number;
  /** Monitor sweep interval in ms (drives the freshness window). */
  monitorPollMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** The fleet service runner. */
export class FleetRunner {
  private scoutTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: FleetRunnerOptions) {
    this.opts.health.register("scout", 3 * (opts.scoutPollMs ?? 5 * 60 * 1000));
    this.opts.health.register("monitor", 3 * (opts.monitorPollMs ?? 60 * 1000));
  }

  /**
   * Run one Scout cycle with full observability. The Monitor sees the
   * cycle's events through the sink bridge wired at construction (the
   * runner-level bridge here covers callers who hand us the monitor's
   * ingestion method directly).
   */
  async runScoutCycle(): Promise<ScoutCycleResult> {
    const { health, alerts } = this.opts;
    health.counter("scout.cycles");
    try {
      const result = await this.opts.scout.runOnce();
      health.counter("scout.discovered", result.discoveredCount);
      health.counter("scout.candidates", result.candidateCount);
      health.counter("scout.evaluated", result.evaluatedCount);
      health.counter("scout.launch-prices-recorded", result.launchPricesRecorded);
      health.counter("scout.phase1-submitted", result.phase1Submitted);
      health.counter("scout.phase1-failed", result.phase1Failed);
      health.heartbeat(
        "scout",
        result.phase1Failed > 0 ? "degraded" : "ok",
        `discovered=${result.discoveredCount} candidates=${result.candidateCount} ` +
          `evaluated=${result.evaluatedCount} lp=${result.launchPricesRecorded} ` +
          `p1ok=${result.phase1Submitted} p1fail=${result.phase1Failed} (${result.durationMs}ms)`,
      );
      return result;
    } catch (error) {
      health.counter("scout.cycle-errors");
      const message = error instanceof Error ? error.message : String(error);
      health.heartbeat("scout", "down", `cycle failed: ${message}`);
      alerts.raise("scout-cycle-failed", "critical",
        "Scout cycle threw — discovery is stalled",
        { error: message });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Run one Monitor sweep: ingest-free diagnostics pass + alerting. */
  runMonitorSweep(): MonitorDiagnostic[] {
    const { health, alerts } = this.opts;
    health.counter("monitor.sweeps");
    let degraded = false;
    const diagnostics = this.opts.monitor.diagnose();
    for (const diagnostic of diagnostics) {
      health.counter(`monitor.diag-${diagnostic.code}`);
      const severity = DIAGNOSTIC_SEVERITY[diagnostic.code] ?? "info";
      if (severity === "warn" || severity === "critical") {
        if (severity === "critical") degraded = true;
        alerts.raise(`monitor-${diagnostic.code}`, severity,
          `Monitor diagnostic: ${diagnostic.code}`,
          {
            identityKey: diagnostic.identityKey,
            ...stringifyDetail(diagnostic.detail),
          });
      }
    }
    const observed = this.opts.monitor.snapshot().length;
    health.heartbeat(
      "monitor",
      degraded ? "degraded" : "ok",
      `observed=${observed} diagnostics=${diagnostics.length}`,
    );
    return diagnostics;
  }

  /** Ingest a Scout event into the Monitor (the bridge, for manual wiring). */
  bridgeScoutEvent(event: Parameters<FleetMonitor["observeScoutEvent"]>[0]): void {
    this.opts.monitor.observeScoutEvent(event);
  }

  /** Ingest a fleet event into the Monitor (executor path). */
  bridgeFleetEvent(event: FleetEvent): void {
    this.opts.monitor.observeFleetEvent(event);
  }

  /** Start both schedules. Returns the stop function. */
  start(): () => void {
    if (this.scoutTimer || this.monitorTimer) return () => this.stop();
    this.scoutTimer = setInterval(() => {
      this.runScoutCycle().catch(() => {
        // runScoutCycle already heartbeated + alerted; the loop must survive.
      });
    }, this.opts.scoutPollMs ?? 5 * 60 * 1000);
    this.monitorTimer = setInterval(() => {
      try {
        this.runMonitorSweep();
      } catch {
        // diagnose() is in-memory; a throw here is a wiring bug. Survive anyway.
      }
    }, this.opts.monitorPollMs ?? 60 * 1000);
    return () => this.stop();
  }

  stop(): void {
    if (this.scoutTimer) {
      clearInterval(this.scoutTimer);
      this.scoutTimer = null;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }
}

/** Monitor diagnostic details carry bigints — stringify for alert context. */
function stringifyDetail(detail: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "bigint") {
      out[key] = value.toString(10);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}
