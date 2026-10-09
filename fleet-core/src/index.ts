// SPDX-License-Identifier: Apache-2.0
//
// @graveyield/fleet-core — the shared execution foundation for the
// GraveYield salvor fleet (Conservative / Sniper / Experimental) and
// the integration surface Monitor/Risk consumes.
//
// Public surface (FLEET-M1):
//   envelope          — versioned opportunity envelope + identity keys
//   lifecycle         — executor state machine + transition contract
//   store             — idempotency + execution records + leases
//   events            — FleetEvent taxonomy, sinks, failure classes
//   estimator         — the ONE integer economic estimator
//   policy            — execution policy + D3 fee planning + live gating
//   route             — RouteAdapter seam + Jupiter v6 adapter + fakes
//   revalidate        — on-chain state revalidation (fail-closed)
//   raydiumAccounts   — fork-proven 13-account CPI derivation
//   pipeline          — prepare → simulate → submit → confirm

export * from "./envelope.js";
export * from "./lifecycle.js";
export * from "./store.js";
export * from "./events.js";
export * from "./estimator.js";
export * from "./policy.js";
export * from "./route.js";
export * from "./revalidate.js";
export * from "./raydiumAccounts.js";
export * from "./pipeline.js";
export * from "./strategy.js";
