#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Scout CLI — environment-driven entry point.
//
//   RPC_URL=… ACTIVITY_ORACLE_KEY=… SALVOR_KEYPAIR=… graveyield-scout
//
// Modes (see config.ts): dry-run is the default; submission mode needs
// ACTIVITY_ORACLE_KEY + SALVOR_KEYPAIR and SCOUT_DRY_RUN=0 (or unset with
// the activity oracle present). SCOUT_RUN_ONCE=1 executes exactly one
// cycle and exits — useful for cron-style operation and smoke tests.

import { loadScoutConfig, buildScout } from "./index.js";

async function main(): Promise<void> {
  const config = loadScoutConfig();
  const scout = buildScout(config);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      tsMs: Date.now(),
      type: "info",
      data: {
        message: "graveyield-scout starting",
        cluster: config.cluster,
        rpc: config.rpcUrl,
        scanner: config.scannerProgramId.toBase58(),
        vault: config.vaultProgramId.toBase58(),
        dryRun: config.dryRun,
        activityOracle: config.activityOracleKey !== null,
        launchPriceOracle: config.launchPriceOracleKey !== null,
        runOnce: config.runOnce,
      },
    }),
  );

  if (config.runOnce) {
    await scout.runOnce();
    return;
  }
  await scout.start();
}

const isDirectRun =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  process.on("SIGINT", () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ tsMs: Date.now(), type: "info", data: { message: "SIGINT — stopping after current cycle" } }));
    process.exit(0);
  });
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
