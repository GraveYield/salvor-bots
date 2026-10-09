// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/scout — the GraveYield Scout Salvor (Phase 10).
//
// Discovery + evaluation requests + lifecycle monitoring + opportunity
// reporting. The Scout never salvages and never certifies: the on-chain
// GraveScanner is the only eligibility authority, and the certify/salvage
// steps belong to the downstream execution bots.

// ----- orchestrator + construction -----
export { ScoutSalvor, buildScout, type ScoutOptions } from "./scout.js";

// ----- configuration + keys -----
export { loadScoutConfig, resolveDryRun, SCOUT_SPEC_DEFAULTS, type ScoutConfig } from "./config.js";
export { loadOracleIdentity, loadSalvorKeypair } from "./keys.js";

// ----- pipeline stages -----
export { RaydiumV4Source, type DiscoveredPool } from "./source.js";
export {
  ActivityIndexer,
  readReserves,
  readTokenMetadata,
  type ActivityRecord,
  type ReserveRecord,
  type TokenMetadata,
} from "./enrich.js";
export {
  preFilterPool,
  CRITERION_INACTIVITY,
  CRITERION_PRICE_COLLAPSE,
  CRITERION_MIN_TVL,
  CRITERION_LP_NOT_BURNED,
  CRITERION_NO_LOCK,
  CRITERION_EPOCH_CONFIRMED,
  ALL_CRITERIA_MASK,
  type PreFilterThresholds,
  type PreFilterResult,
} from "./eligibility.js";
export { scoreCandidate, type ScoringThresholds } from "./scoring.js";
export { CandidateQueue } from "./queue.js";

// ----- admission policy + submission -----
export { classifyEvaluation, type EvaluationCheck, type EvaluationVerdict } from "./evaluate.js";
export {
  buildPhase1Transaction,
  buildRecordLaunchPriceTransaction,
  sendBundle,
  signAttestation,
  defaultTxSender,
  type TxSender,
  type Phase1TxBundle,
  type RecordLaunchPriceTxBundle,
} from "./submission.js";

// ----- lifecycle + monitoring -----
export {
  CandidateTracker,
  monitorCandidate,
  MIN_EPOCH_CONFIRMATION,
  MONITORABLE_STATES,
  type MonitorOutcome,
} from "./lifecycle.js";

// ----- reporting -----
export {
  makeEvent,
  composeSinks,
  MemoryReportSink,
  ConsoleReportSink,
  JsonlFileReportSink,
  type ReportSink,
} from "./reporter.js";

// ----- shared types -----
export type {
  CandidateLifecycleState,
  TrackedCandidate,
  ScoutEvent,
  ScoutEventType,
  ScoutCycleResult,
  ScoutOpportunity,
  ScoutCandidate,
  ScoutScoredCandidate,
  FeeSettings,
  OracleIdentity,
} from "./types.js";
