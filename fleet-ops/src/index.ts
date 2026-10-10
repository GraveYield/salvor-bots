// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/fleet-ops — the fleet service runner (Phase 11).
//
//   runner    FleetRunner — Scout cycles + Monitor sweeps + observability
//   health    HealthRegistry — component status, counters, snapshots
//   alerts    AlertManager + console/JSONL/webhook sinks
//   cli       graveyield-fleet entrypoints

export * from "./runner.js";
export * from "./health.js";
export * from "./alerts.js";
export { main as fleetMain, parseArgs as fleetParseArgs, loadFleetOpsConfig, wireFleet, type FleetOpsConfig } from "./cli.js";
