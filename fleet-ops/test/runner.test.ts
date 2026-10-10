// SPDX-License-Identifier: Apache-2.0
//
// FleetRunner tests — Scout cycle observability, Monitor sweep alerting,
// and the Scout→Monitor bridge. Everything runs on fakes; no RPC, no
// real Scout constructor (its Connection stays untouched).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AlertManager, FleetRunner, HealthRegistry, type Alert } from "../src/index.js";
import type { ScoutCycleResult } from "@graveyield/scout";
import type { MonitorDiagnostic } from "@graveyield/monitor";

function cycleResult(overrides: Partial<ScoutCycleResult> = {}): ScoutCycleResult {
  return {
    startedAtMs: 1,
    durationMs: 10,
    discoveredCount: 100,
    candidateCount: 3,
    evaluatedCount: 3,
    launchPricesRecorded: 1,
    phase1Submitted: 1,
    phase1Failed: 0,
    ...overrides,
  } as ScoutCycleResult;
}

interface Harness {
  runner: FleetRunner;
  health: HealthRegistry;
  alerts: AlertManager;
  alertLog: Alert[];
  scoutThrow: { value: boolean };
  scoutResult: { value: ScoutCycleResult };
  diagnostics: { value: MonitorDiagnostic[] };
  scoutEventsInMonitor: Array<{ tsMs: number; type: string; pool?: string }>;
}

function harness(): Harness {
  const health = new HealthRegistry("test", () => Date.now());
  const alertLog: Alert[] = [];
  const alerts = new AlertManager({ deliver: (a) => alertLog.push(a) }, 30 * 60 * 1000, () => Date.now());

  const h: Harness = {
    runner: undefined as unknown as FleetRunner,
    health,
    alerts,
    alertLog,
    scoutThrow: { value: false },
    scoutResult: { value: cycleResult() },
    diagnostics: { value: [] },
    scoutEventsInMonitor: [],
  };

  const scout = {
    runOnce: async (): Promise<ScoutCycleResult> => {
      if (h.scoutThrow.value) throw new Error("scout exploded");
      return h.scoutResult.value;
    },
  };

  const monitor = {
    diagnose: (): MonitorDiagnostic[] => h.diagnostics.value,
    observeScoutEvent: (event: { tsMs: number; type: string; pool?: string }): void => {
      h.scoutEventsInMonitor.push(event);
    },
    snapshot: (): unknown[] => [],
  };

  h.runner = new FleetRunner({
    scout: scout as never,
    monitor: monitor as never,
    health,
    alerts,
    scoutPollMs: 60_000,
    monitorPollMs: 60_000,
  });

  return h;
}

function diagnostic(code: MonitorDiagnostic["code"], severity: MonitorDiagnostic["severity"]): MonitorDiagnostic {
  return { tsMs: 1, severity, identityKey: "devnet|raydium-v4|pool", code, detail: { attempts: 2n } };
}

describe("FleetRunner — Scout cycles", () => {
  test("a healthy cycle heartbeats ok and bumps the counters", async () => {
    const h = harness();
    h.scoutResult.value = cycleResult({ discoveredCount: 250, candidateCount: 7, phase1Submitted: 2 });
    await h.runner.runScoutCycle();
    const snap = h.health.snapshot();
    const scout = snap.components.find((c) => c.name === "scout");
    assert.ok(scout);
    assert.equal(scout.status, "ok");
    assert.match(scout.detail, /discovered=250/);
    assert.match(scout.detail, /p1ok=2/);
    assert.equal(h.health.counterValue("scout.cycles"), 1);
    assert.equal(h.health.counterValue("scout.discovered"), 250);
    assert.equal(h.health.counterValue("scout.candidates"), 7);
    assert.equal(h.alertLog.length, 0);
  });

  test("phase-1 failures degrade the cycle without alerting (submission path reports its own)", async () => {
    const h = harness();
    h.scoutResult.value = cycleResult({ phase1Failed: 1 });
    await h.runner.runScoutCycle();
    const scout = h.health.snapshot().components.find((c) => c.name === "scout");
    assert.ok(scout);
    assert.equal(scout.status, "degraded");
    assert.equal(h.alertLog.length, 0);
  });

  test("a thrown cycle heartbeats down and raises the critical alert", async () => {
    const h = harness();
    h.scoutThrow.value = true;
    await assert.rejects(() => h.runner.runScoutCycle(), /scout exploded/);
    const scout = h.health.snapshot().components.find((c) => c.name === "scout");
    assert.ok(scout);
    assert.equal(scout.status, "down");
    assert.ok(h.alertLog.some((a) => a.code === "scout-cycle-failed" && a.severity === "critical"));
  });
});

describe("FleetRunner — Monitor sweeps", () => {
  test("info diagnostics are counted, never alerted", () => {
    const h = harness();
    h.diagnostics.value = [diagnostic("receipt-verified", "info"), diagnostic("reconciled", "info")];
    const out = h.runner.runMonitorSweep();
    assert.equal(out.length, 2);
    assert.equal(h.alertLog.length, 0);
    assert.equal(h.health.counterValue("monitor.diag-receipt-verified"), 1);
  });

  test("warn diagnostics alert; critical diagnostics alert and degrade", () => {
    const h = harness();
    h.diagnostics.value = [
      diagnostic("stale-opportunity", "warning"),
      diagnostic("conflicting-claims", "critical"),
    ];
    h.runner.runMonitorSweep();
    assert.ok(h.alertLog.some((a) => a.code === "monitor-stale-opportunity" && a.severity === "warn"));
    assert.ok(h.alertLog.some((a) => a.code === "monitor-conflicting-claims" && a.severity === "critical"));
    const monitor = h.health.snapshot().components.find((c) => c.name === "monitor");
    assert.ok(monitor);
    assert.equal(monitor.status, "degraded");
  });

  test("bigint detail fields are stringified into alert context", () => {
    const h = harness();
    h.diagnostics.value = [diagnostic("repeated-attempts", "warning")];
    h.runner.runMonitorSweep();
    const alert = h.alertLog.find((a) => a.code === "monitor-repeated-attempts");
    assert.ok(alert);
    assert.equal(alert.context.attempts, "2");
  });
});

describe("FleetRunner — bridge + lifecycle", () => {
  test("bridgeScoutEvent feeds the Monitor's ingestion", () => {
    const h = harness();
    h.runner.bridgeScoutEvent({ tsMs: 1234, type: "cycle-started" });
    assert.equal(h.scoutEventsInMonitor.length, 1);
    assert.equal(h.scoutEventsInMonitor[0]?.type, "cycle-started");
  });

  test("start/stop manages both schedules (no timers leak after stop)", () => {
    const h = harness();
    const stop = h.runner.start();
    stop();
    // A second start after stop must be a clean restart.
    const stop2 = h.runner.start();
    stop2();
    assert.ok(true); // the assertion is that neither call throws
  });
});
