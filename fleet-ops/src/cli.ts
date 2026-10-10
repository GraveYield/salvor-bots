// SPDX-License-Identifier: Apache-2.0
//
// graveyield-fleet CLI — run the Scout + Monitor as one supervised
// service (the "first Salvor running" Phase 11 row).
//
//   graveyield-fleet run      long-running supervisor (default)
//   graveyield-fleet cycle    one Scout cycle, then exit
//   graveyield-fleet sweep    one Monitor sweep, then exit
//   graveyield-fleet health   print the health snapshot
//
// Environment: the Scout consumes its own documented contract
// (loadScoutConfig — RPC_URL, SCOUT_DRY_RUN, ACTIVITY_ORACLE_KEY, …);
// fleet-ops adds FLEET_STATE_DIR, FLEET_SCOUT_POLL_MS,
// FLEET_MONITOR_POLL_MS, FLEET_ALERT_DEDUP_MS on top.
//
// The bridge: Scout events flow into the Monitor via a ReportSink, so
// the process's Monitor sees every Scout emission. The runner never
// touches the Scout's dry-run gate — submission mode still requires the
// operator's explicit environment.

import { JsonlEventSink } from "@graveyield/fleet-core";
import { FleetMonitor } from "@graveyield/monitor";
import {
  buildScout,
  ConsoleReportSink,
  JsonlFileReportSink,
  loadScoutConfig,
  type ScoutEvent,
} from "@graveyield/scout";

import { AlertManager, composeAlertSinks, ConsoleAlertSink, JsonlAlertSink, type AlertSink } from "./alerts.js";
import { HealthRegistry } from "./health.js";
import { FleetRunner } from "./runner.js";

/** Fleet-level configuration on top of the Scout's own env contract. */
export interface FleetOpsConfig {
  stateDir: string;
  scoutPollMs: number;
  monitorPollMs: number;
  alertDedupMs: number;
}

/** Read the fleet-ops env vars. */
export function loadFleetOpsConfig(env: NodeJS.ProcessEnv = process.env): FleetOpsConfig {
  return {
    stateDir: env.FLEET_STATE_DIR ?? "fleet-state",
    scoutPollMs: positiveInt(env.FLEET_SCOUT_POLL_MS, 5 * 60 * 1000),
    monitorPollMs: positiveInt(env.FLEET_MONITOR_POLL_MS, 60 * 1000),
    alertDedupMs: positiveInt(env.FLEET_ALERT_DEDUP_MS, 30 * 60 * 1000),
  };
}

/** Parse argv accepting both --key=value and --key value. */
export function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          args[token.slice(2)] = next;
          i++;
        } else {
          args[token.slice(2)] = true;
        }
      }
    }
  }
  return args;
}

/** Wire the full fleet service. Exported for tests. */
export function wireFleet(config: FleetOpsConfig): { runner: FleetRunner; health: HealthRegistry; alerts: AlertManager } {
  const health = new HealthRegistry("graveyield-fleet");
  const sinks: AlertSink[] = [new ConsoleAlertSink(), JsonlAlertSink.toFile(`${config.stateDir}/alerts.jsonl`)];
  const alerts = new AlertManager(composeAlertSinks(...sinks), config.alertDedupMs);

  const monitorEventSink = new JsonlEventSink(`${config.stateDir}/monitor-events.jsonl`);

  // Scout first (the Monitor shares its GraveYieldClient — one Connection,
  // one RPC budget for the whole process). The bridge sink late-binds to
  // the Monitor: events only flow once cycles run, by which time the
  // reference is set.
  const scoutConfig = loadScoutConfig();
  let monitorRef: FleetMonitor | null = null;
  const bridgeSink = {
    emit(event: ScoutEvent): void {
      monitorRef?.observeScoutEvent(event);
    },
  };
  const scoutSinks = [
    new ConsoleReportSink(),
    ...(scoutConfig.reportFile !== null ? [new JsonlFileReportSink(scoutConfig.reportFile)] : []),
    bridgeSink,
  ];
  const scout = buildScout(scoutConfig, { sinks: scoutSinks });

  const monitor = new FleetMonitor({
    client: scout.client,
    config: {
      botId: "fleet-ops",
      staleAfterMs: 24 * 60 * 60 * 1000,
      verificationGraceMs: 10 * 60 * 1000,
      maxAttemptsPerIdentity: 5,
    },
    sink: monitorEventSink,
  });
  monitorRef = monitor;

  const runner = new FleetRunner({
    scout,
    monitor,
    health,
    alerts,
    scoutPollMs: config.scoutPollMs,
    monitorPollMs: config.monitorPollMs,
  });

  return { runner, health, alerts };
}

/** CLI main. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const positional = (argv ?? []).filter((a) => !a.startsWith("--"));
  const cmd = positional[0] ?? "run";
  const config = loadFleetOpsConfig();

  switch (cmd) {
    case "run": {
      const { runner, health } = wireFleet(config);
      const stop = runner.start();
      const shutdown = (): void => {
        stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.stdout.write(`${health.summary()}\n`);
      setInterval(() => process.stdout.write(`${health.summary()}\n`), 60_000).unref();
      return new Promise(() => {}) as unknown as number;
    }
    case "cycle": {
      const { runner, health } = wireFleet(config);
      const result = await runner.runScoutCycle();
      console.log(JSON.stringify(result, null, 2));
      void health;
      return 0;
    }
    case "sweep": {
      const { runner } = wireFleet(config);
      const diagnostics = runner.runMonitorSweep();
      console.log(JSON.stringify(diagnostics, null, 2));
      return 0;
    }
    case "health": {
      const { health } = wireFleet(config);
      console.log(health.render());
      return 0;
    }
    default:
      process.stderr.write(
        [
          "graveyield-fleet — the five-bot fleet service runner",
          "",
          "usage: graveyield-fleet [run|cycle|sweep|health]",
          "",
          "  run      run the Scout + Monitor forever (default)",
          "  cycle    one Scout cycle, then exit",
          "  sweep    one Monitor sweep, then exit",
          "  health   print the health snapshot",
          "",
        ].join("\n"),
      );
      return 2;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}
