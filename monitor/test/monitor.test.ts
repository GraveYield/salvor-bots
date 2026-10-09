// SPDX-License-Identifier: Apache-2.0
//
// FleetMonitor tests (FLEET-M2) — replayable event streams, anomaly
// sweeps, and on-chain reconciliation against a fake receipt. The
// Monitor under test NEVER holds a keypair and never submits.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";

import { GraveYieldClient, salvageReceiptPda } from "@graveyield/sdk";
import {
  makeEvent,
  buildEnvelope,
  MemoryEventSink,
  opportunityKey,
  type FleetEvent,
  type MonitorConfig,
} from "@graveyield/fleet-core";
import { FleetMonitor } from "../src/monitor.js";
import { VAULT_ID, encodeSalvageReceipt } from "../../fleet-core/test/helpers.js";
import { buildWorld } from "../../fleet-core/test/world.js";

const IDENTITY = {
  cluster: "localnet",
  ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  poolAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
};
const KEY = opportunityKey(IDENTITY);

function config(overrides?: Partial<MonitorConfig>): MonitorConfig {
  return { botId: "monitor", staleAfterMs: 60_000, verificationGraceMs: 30_000, maxAttemptsPerIdentity: 2, ...overrides };
}

/** A deterministic event recorder feeding the monitor. */
function eventAt(botId: string, type: FleetEvent["type"], tsMs: number, data?: Record<string, unknown>, extra?: { identityKey?: string; failureClass?: FleetEvent["failureClass"] }): FleetEvent {
  return makeEvent({ botId, type, identity: extra?.identityKey ?? KEY, data, failureClass: extra?.failureClass, now: () => tsMs });
}

function makeMonitor(now: () => number, cfg?: MonitorConfig) {
  const sink = new MemoryEventSink();
  const client = new GraveYieldClient({
    connection: {} as never, // ingestion + diagnose never touch the chain
    cluster: "localnet",
    graveScannerProgramId: Keypair.generate().publicKey,
    graveVaultProgramId: new PublicKey(VAULT_ID),
  });
  const monitor = new FleetMonitor({ client, config: cfg ?? config({ now }), sink });
  return { monitor, sink };
}

describe("event ingestion + lifecycle tracking", () => {
  test("a full executor story folds into one observation", () => {
    const now = () => 10_000;
    const { monitor } = makeMonitor(now);
    const env = buildEnvelope({ identity: IDENTITY, kind: "salvageable", sourceBot: "scout", detectedAtMs: 9_000, score: 0.4 });

    monitor.observeFleetEvent(eventAt("conservative", "opportunity-received", 10_000, { kind: "salvageable" }), env);
    monitor.observeFleetEvent(eventAt("conservative", "revalidated", 10_100, { kind: "salvageable" }), env);
    monitor.observeFleetEvent(eventAt("conservative", "economic-pass", 10_200, { netProfitLamports: "1" }), env);
    monitor.observeFleetEvent(eventAt("conservative", "prepared", 10_300), env);
    monitor.observeFleetEvent(eventAt("conservative", "confirmed", 11_000, {
      signature: "SIG_ABC",
      totalProceedsLamports: "900000000",
      salvorAmountLamports: "360000000",
    }), env);

    const obs = monitor.observe(KEY);
    assert.ok(obs);
    assert.equal(obs.claims.length, 2);
    assert.equal(obs.attempts.length, 2, "economic-pass + prepared both count as execution attempts");
    assert.equal(obs.signatures.length, 1);
    assert.equal(obs.signatures[0]?.signature, "SIG_ABC");
    assert.equal(obs.reportedReceipt?.totalProceedsLamports, "900000000");
  });

  test("replaying the same recorded events is side-effect-free (replayable tests)", () => {
    const now = () => 10_000;
    const { monitor } = makeMonitor(now);
    const env = buildEnvelope({ identity: IDENTITY, kind: "salvageable", sourceBot: "scout", detectedAtMs: 9_000, score: 0.4 });
    const stream: Array<[FleetEvent, typeof env]> = [
      [eventAt("conservative", "opportunity-received", 10_000, { kind: "salvageable" }), env],
      [eventAt("conservative", "prepared", 10_300), env],
    ];
    for (const [e, v] of stream) monitor.observeFleetEvent(e, v);
    const first = JSON.stringify(monitor.snapshot());
    for (const [e, v] of stream) monitor.observeFleetEvent(e, v); // replay
    for (let i = 0; i < 3; i++) for (const [e, v] of stream) monitor.observeFleetEvent(e, v);
    assert.equal(JSON.stringify(monitor.snapshot()), first);
  });

  test("scout events are tracked on their own channel", () => {
    const { monitor } = makeMonitor(() => 1);
    monitor.observeScoutEvent({ tsMs: 1, type: "opportunity:certification-ready", pool: IDENTITY.poolAddress });
    const snap = monitor.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0]?.poolAddress, IDENTITY.poolAddress);
  });
});

describe("anomaly diagnostics", () => {
  test("stale opportunity (no activity, no signature) is flagged", () => {
    let now = 10_000;
    const { monitor } = makeMonitor(() => now);
    monitor.observeFleetEvent(eventAt("conservative", "opportunity-received", 10_000, { kind: "salvageable" }));
    now = 200_000; // way past staleAfterMs
    const diags = monitor.diagnose();
    assert.ok(diags.some((d) => d.code === "stale-opportunity"));
  });

  test("cert expiry: imminent and expired flags", () => {
    let now = 1_800_000_000_000;
    const { monitor } = makeMonitor(() => now);
    // Cert expiring 5 minutes out → imminent.
    monitor.observeFleetEvent(eventAt("conservative", "revalidated", now, { certExpiresAt: String(Math.floor(now / 1000) + 300) }));
    assert.ok(monitor.diagnose().some((d) => d.code === "cert-expiry-imminent"));
    // After expiry → expired.
    now += 400_000;
    assert.ok(monitor.diagnose().some((d) => d.code === "cert-expired"));
  });

  test("repeated attempts above the ceiling are flagged with bot attribution", () => {
    const { monitor } = makeMonitor(() => 1);
    for (let i = 0; i < 4; i++) {
      monitor.observeFleetEvent(eventAt("conservative", "prepared", 1 + i));
    }
    const diag = monitor.diagnose().find((d) => d.code === "repeated-attempts");
    assert.ok(diag);
    assert.deepEqual(diag.detail.bots, ["conservative"]);
  });

  test("conflicting kind claims from two bots are flagged", () => {
    const { monitor } = makeMonitor(() => 1);
    monitor.observeFleetEvent(eventAt("conservative", "opportunity-received", 1, { kind: "salvageable" }));
    monitor.observeFleetEvent(eventAt("sniper", "opportunity-received", 2, { kind: "certification-ready" }));
    assert.ok(monitor.diagnose().some((d) => d.code === "conflicting-claims"));
  });

  test("confirmed-but-unverified is flagged until a receipt is reported", () => {
    const { monitor } = makeMonitor(() => 1);
    monitor.observeFleetEvent(eventAt("conservative", "confirmed", 1, { signature: "SIG_X" }));
    assert.ok(monitor.diagnose().some((d) => d.code === "unverified-confirmation"));
    monitor.observeFleetEvent(eventAt("conservative", "confirmed", 2, {
      signature: "SIG_X",
      totalProceedsLamports: "10",
      salvorAmountLamports: "4",
      lpHolderAmountLamports: "4",
      protocolAmountLamports: "2",
    }));
    assert.ok(!monitor.diagnose().some((d) => d.code === "unverified-confirmation"));
  });

  test("repeated non-transient failures escalate to critical", () => {
    const { monitor } = makeMonitor(() => 1);
    monitor.observeFleetEvent(eventAt("conservative", "simulation-failed", 1, { reason: "r1" }, { failureClass: "simulation-failed" }));
    monitor.observeFleetEvent(eventAt("conservative", "simulation-failed", 2, { reason: "r2" }, { failureClass: "simulation-failed" }));
    const diag = monitor.diagnose().find((d) => d.code === "failed-simulation");
    assert.ok(diag);
    assert.equal(diag.severity, "critical");
  });
});

describe("on-chain reconciliation (read-only)", () => {
  test("receipt-verified: sums + shares + reported amounts match the chain", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n });
    const sink = new MemoryEventSink();
    const monitor = new FleetMonitor({
      client: w.client,
      config: config({ now: () => 1 }),
      sink,
    });
    const key = opportunityKey({ cluster: "localnet", ammProgramId: "RAYDIUM", poolAddress: w.poolAddress.toBase58() })
      .replace("RAYDIUM", "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
    const env = buildEnvelope({
      identity: { cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: w.poolAddress.toBase58() },
      kind: "salvageable",
      sourceBot: "scout",
      detectedAtMs: 1,
      score: null,
    });
    monitor.observeFleetEvent(eventAt("conservative", "confirmed", 2, {
      signature: "SIG_1",
      totalProceedsLamports: "900000000",
      salvorAmountLamports: "360000000",
      lpHolderAmountLamports: "360000000",
      protocolAmountLamports: "180000000",
    }), env);

    // Install the exact matching receipt on the fake chain.
    w.rpc.setAccount(
      salvageReceiptPda(new PublicKey(VAULT_ID), w.poolAddress),
      encodeSalvageReceipt({
        poolAddress: w.poolAddress,
        salvor: w.salvor.publicKey,
        lpHolderAmountLamports: 360_000_000n,
        salvorAmountLamports: 360_000_000n,
        protocolAmountLamports: 180_000_000n,
        totalProceedsLamports: 900_000_000n,
        memecoinMint: w.memecoinMint,
      }),
      new PublicKey(VAULT_ID),
    );

    const rec = await monitor.reconcile(key, "conservative", "SIG_1");
    assert.equal(rec.status, "receipt-verified");
    assert.equal(rec.receipt?.totalProceedsLamports, 900_000_000n);
    assert.equal(rec.receipt?.salvorAmountLamports, 360_000_000n);
    assert.equal(rec.detail.sumsOk, true);
    assert.equal(rec.detail.sharesOk, true);
    assert.ok(sink.events.some((e) => e.type === "monitor-reconciled"));
  });

  test("receipt-anomaly: a 50/30/20 split off-protocol is caught", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n });
    const monitor = new FleetMonitor({ client: w.client, config: config({ now: () => 1 }), sink: new MemoryEventSink() });
    const key = opportunityKey({ cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: w.poolAddress.toBase58() });
    w.rpc.setAccount(
      salvageReceiptPda(new PublicKey(VAULT_ID), w.poolAddress),
      encodeSalvageReceipt({
        poolAddress: w.poolAddress,
        salvor: w.salvor.publicKey,
        lpHolderAmountLamports: 450_000_000n, // 50/30/20 — NOT the protocol split
        salvorAmountLamports: 270_000_000n,
        protocolAmountLamports: 180_000_000n,
        totalProceedsLamports: 900_000_000n,
        memecoinMint: w.memecoinMint,
      }),
      new PublicKey(VAULT_ID),
    );
    const rec = await monitor.reconcile(key, "conservative", "SIG_2");
    assert.equal(rec.status, "receipt-anomaly");
    assert.equal(rec.detail.sharesOk, false);
  });

  test("receipt-missing: a claimed confirmation with no on-chain receipt", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n });
    const monitor = new FleetMonitor({ client: w.client, config: config({ now: () => 1 }), sink: new MemoryEventSink() });
    const key = opportunityKey({ cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: w.poolAddress.toBase58() });
    const rec = await monitor.reconcile(key, "conservative", "SIG_MISSING");
    assert.equal(rec.status, "receipt-missing");
  });

  test("the monitor instance holds no keypair and its API surface has no submit path", () => {
    const { monitor } = makeMonitor(() => 1);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(monitor));
    assert.ok(!proto.some((n) => n.toLowerCase().includes("submit")));
    assert.ok(!proto.some((n) => n.toLowerCase().includes("sign")));
    assert.ok(!("keypair" in monitor));
    assert.ok(!("signer" in monitor));
  });
});
