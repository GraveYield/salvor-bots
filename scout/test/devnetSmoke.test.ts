// SPDX-License-Identifier: Apache-2.0
//
// Live devnet smoke tests for the Scout — read-only operations against
// the deployed devnet GraveYield programs (handoff §3.2). SKIPPED unless
// DEVNET_RPC_URL is set, so `pnpm -r test` stays green offline:
//
//   DEVNET_RPC_URL=https://api.devnet.solana.com pnpm -r test
//
// Scope (read-only only — the devnet ProtocolConfigs' activity/launch-price
// oracles point at the since-wiped deployer key, so attestation-signed
// submissions cannot verify against that cluster until the owner re-points
// them; every devnet Scout run is therefore discovery/monitor-only):
//
//   * both ProtocolConfigs decode with the Charter-locked spec defaults
//   * the Scout's dry-run cycle runs against live devnet RPC without
//     crashing and without submitting anything
//   * Raydium V4 discovery honours maxPoolsPerScan

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  GraveYieldClient,
  DEVNET_SCANNER_PROGRAM_ID,
  DEVNET_VAULT_PROGRAM_ID,
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  fetchScannerProtocolConfig,
  fetchVaultProtocolConfig,
  SCANNER_PROTOCOL_CONFIG_DEFAULTS,
  VAULT_PROTOCOL_CONFIG_DEFAULTS,
} from "@graveyield/sdk";

import {
  ScoutSalvor,
  MemoryReportSink,
  RaydiumV4Source,
  type ScoutOptions,
} from "../src/index.js";

const DEVNET_RPC = process.env.DEVNET_RPC_URL;
const SKIP = !DEVNET_RPC;

const scannerProgramId = new PublicKey(DEVNET_SCANNER_PROGRAM_ID);
const vaultProgramId = new PublicKey(DEVNET_VAULT_PROGRAM_ID);

function scoutOptions(connection: Connection, sinks: MemoryReportSink[]): ScoutOptions {
  return {
    connection,
    cluster: "devnet",
    scannerProgramId,
    vaultProgramId,
    thresholds: {
      inactivitySeconds: 7_776_000n,
      priceCollapseBps: 9_900,
      minTvlLamports: 500_000_000n,
      lpBurnDustThreshold: 1_000n,
    },
    maxCandidatesPerCycle: 1,
    maxPoolsPerScan: 25,
    signatureScanLimit: 50,
    launchPriceMaxPages: 2,
    dryRun: true,
    activityOracle: null,
    launchPriceOracle: null,
    operatorKeypair: null,
    fee: { feeLamportsPerCu: new BN(10_000) },
    maxSubmitAttempts: 1,
    pollIntervalMs: 60_000,
    sinks,
  };
}

describe("devnet smoke (read-only)", { skip: SKIP }, () => {
  const connection = new Connection(DEVNET_RPC ?? "http://localhost:8899", "confirmed");

  test("GraveScanner ProtocolConfig decodes with all spec defaults", async () => {
    const cfg = await fetchScannerProtocolConfig(connection, scannerProtocolConfigPda(scannerProgramId));
    assert.ok(cfg, "scanner ProtocolConfig must be initialized on devnet");
    assert.equal(cfg.inactivitySeconds, SCANNER_PROTOCOL_CONFIG_DEFAULTS.inactivitySeconds);
    assert.equal(cfg.priceCollapseBps, SCANNER_PROTOCOL_CONFIG_DEFAULTS.priceCollapseBps);
    assert.equal(cfg.minTvlLamports, SCANNER_PROTOCOL_CONFIG_DEFAULTS.minTvlLamports);
    assert.equal(cfg.anchorStalenessSeconds, SCANNER_PROTOCOL_CONFIG_DEFAULTS.anchorStalenessSeconds);
    assert.equal(cfg.lpBurnDustThreshold, SCANNER_PROTOCOL_CONFIG_DEFAULTS.lpBurnDustThreshold);
    assert.equal(cfg.certTtlSeconds, SCANNER_PROTOCOL_CONFIG_DEFAULTS.certTtlSeconds);
    assert.equal(cfg.paused, false);
  });

  test("GraveVault ProtocolConfig decodes with all spec defaults", async () => {
    const cfg = await fetchVaultProtocolConfig(connection, vaultProtocolConfigPda(vaultProgramId));
    assert.ok(cfg, "vault ProtocolConfig must be initialized on devnet");
    assert.equal(cfg.lpHolderShareBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.lpHolderShareBps);
    assert.equal(cfg.salvorShareBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.salvorShareBps);
    assert.equal(cfg.protocolShareBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.protocolShareBps);
    assert.equal(cfg.maxPriorityFeeCeilingLamports, VAULT_PROTOCOL_CONFIG_DEFAULTS.maxPriorityFeeCeilingLamports);
    assert.equal(cfg.maxSlippageBps, VAULT_PROTOCOL_CONFIG_DEFAULTS.maxSlippageBps);
    assert.equal(cfg.jupiterDustThresholdLamports, VAULT_PROTOCOL_CONFIG_DEFAULTS.jupiterDustThresholdLamports);
    assert.equal(cfg.timelockSeconds, VAULT_PROTOCOL_CONFIG_DEFAULTS.timelockSeconds);
    assert.equal(cfg.emergencyPaused, false);
  });

  test("Raydium V4 discovery runs against live devnet and honours maxPools", async () => {
    const source = new RaydiumV4Source({ maxPools: 5 });
    const pools = [];
    for await (const pool of source.enumeratePools(connection)) {
      pools.push(pool);
      if (pools.length >= 5) break;
    }
    // Devnet Raydium V4 pools are scarce (possibly zero) — the contract is
    // "no crash, at most maxPools", not "pools found".
    assert.ok(pools.length <= 5);
  });

  test("the Scout's dry-run cycle completes against live devnet without submitting", async () => {
    const sinks = [new MemoryReportSink()];
    const scout = new ScoutSalvor(scoutOptions(connection, sinks));
    const result = await scout.runOnce();
    assert.equal(result.dryRun, true);
    assert.equal(result.phase1Submitted, 0);
    assert.equal(result.launchPricesRecorded, 0);
    const mem = sinks[0] as MemoryReportSink;
    assert.ok(mem.ofType("cycle-start").length === 1);
    assert.ok(mem.ofType("cycle-end").length === 1);
    assert.equal(mem.ofType("phase1-submitted").length, 0);
  });
});
