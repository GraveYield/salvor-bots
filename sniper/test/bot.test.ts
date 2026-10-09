// SPDX-License-Identifier: Apache-2.0
//
// Sniper executor tests (FLEET-M4) — urgency ordering, tighter windows,
// fee-share delta, and SAFETY PARITY with the reference executor.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { GraveYieldClient, WSOL_MINT, vaultAuthorityPda } from "@graveyield/sdk";
import {
  ExecutionPipeline,
  LocalAttestationSource,
  MemoryEventSink,
  InMemoryFleetStore,
  FakeRouteAdapter,
  buildEnvelope,
  opportunityKey,
  type ExecutionPolicy,
} from "@graveyield/fleet-core";
import { SniperSalvor, SNIPER_TUNABLES, byCertUrgency } from "../src/bot.js";
import { VAULT_ID, FIXED_NOW_MS } from "../../fleet-core/test/helpers.js";
import { buildWorld } from "../../fleet-core/test/world.js";

const NOW = () => FIXED_NOW_MS;
const NOW_SEC = BigInt(Math.floor(FIXED_NOW_MS / 1000));

function makeBot(opts?: { mode?: "dry-run" | "simulation" | "live"; quoteAt?: number }) {
  const w = buildWorld({
    wsolReserve: 5_000_000_000n,
    memecoinReserve: 1_000_000n,
    lpSupply: 10_000_000n,
    salvorLpAmount: 1_000_000n,
    certExpiresAt: NOW_SEC + 3_600n,
  });
  const sink = new MemoryEventSink();
  const store = new InMemoryFleetStore(() => NOW());
  const route = new FakeRouteAdapter(async (req) => ({
    inputMint: req.inputMint.toBase58(),
    outputMint: req.outputMint.toBase58(),
    inAmount: req.amount,
    outAmount: 4_000_000_000n,
    slippageBps: req.slippageBps,
    routeData: Uint8Array.from([1]),
    routeAccounts: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
      { pubkey: getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthorityPda(new PublicKey(VAULT_ID)), true), isSigner: false, isWritable: true },
    ],
    quotedAtMs: opts?.quoteAt ?? NOW(),
    adapter: "fake",
  }));
  const pipeline = new ExecutionPipeline({
    client: w.client,
    policy: { botId: "sniper", cluster: "localnet", mode: opts?.mode ?? "dry-run", accepts: { kinds: ["certification-ready", "salvageable"] }, retryBackoffMs: 1, ...SNIPER_TUNABLES } as ExecutionPolicy,
    liveEnablement: opts?.mode === "live" ? { enabled: true, acknowledgedBy: "test" } : null,
    routeAdapter: route,
    eventSink: sink,
    txSender: w.rpc.fakeSend.bind(w.rpc),
    now: NOW,
  });
  const bot = new SniperSalvor({
    config: { cluster: "localnet", mode: opts?.mode ?? "dry-run", liveEnablement: opts?.mode === "live" ? { enabled: true, acknowledgedBy: "test" } : null, retryBackoffMs: 1 },
    client: w.client,
    pipeline,
    store,
    sink,
    signer: w.salvor,
    attestationSource: new LocalAttestationSource(Keypair.generate()),
    now: NOW,
  });
  return { w, bot, sink, store };
}

function envelope(w: ReturnType<typeof buildWorld>, opts?: { certExpiresAt?: bigint | null; score?: number; detectedAtMs?: number; pool?: PublicKey }) {
  return buildEnvelope({
    identity: { cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: (opts?.pool ?? w.poolAddress).toBase58() },
    kind: opts?.certExpiresAt ? "salvageable" : "certification-ready",
    sourceBot: "scout",
    detectedAtMs: opts?.detectedAtMs ?? FIXED_NOW_MS - 1_000,
    score: opts?.score ?? 0.5,
    certExpiresAt: opts?.certExpiresAt ?? null,
  });
}

describe("Sniper — urgency ordering", () => {
  test("soonest cert expiry is processed FIRST (the clock decides priority)", async () => {
    const { w, bot, sink } = makeBot();
    // Three DISTINCT pools in one world family (per-pool derivation keys).
    const poolSoon = buildWorld({ poolSeed: 0x51, wsolReserve: 1_000_000_000n, memecoinReserve: 100n, lpSupply: 10_000_000n, salvorLpAmount: 0n, certExpiresAt: NOW_SEC + 300n });
    const poolLate = buildWorld({ poolSeed: 0x52, wsolReserve: 1_000_000_000n, memecoinReserve: 100n, lpSupply: 10_000_000n, salvorLpAmount: 0n, certExpiresAt: NOW_SEC + 3_500n });
    const poolNoCert = buildWorld({ poolSeed: 0x53, wsolReserve: 1_000_000_000n, memecoinReserve: 100n, lpSupply: 10_000_000n, salvorLpAmount: 0n });
    void w;
    const order = [poolNoCert, poolLate, poolSoon].map((p) => envelope(p, { certExpiresAt: p.certPda ? NOW_SEC + 3_600n : null, pool: p.poolAddress }));
    // Overwrite certExpiresAt to the REAL per-pool values.
    order[0]!.certExpiresAt = null; // no cert → sorts last
    order[1]!.certExpiresAt = (NOW_SEC + 3_500n).toString(); // late
    order[2]!.certExpiresAt = (NOW_SEC + 300n).toString(); // soon

    await bot.runOnce(order);
    const receivedOrder = sink
      .where((e) => e.type === "opportunity-received" && e.botId === "sniper")
      .map((e) => e.identityKey);
    assert.equal(receivedOrder.length, 3);
    assert.equal(receivedOrder[0], opportunityKey(order[2]!.identity), "soon-expiring cert first");
    assert.equal(receivedOrder[1], opportunityKey(order[1]!.identity), "late-expiring cert second");
    assert.equal(receivedOrder[2], opportunityKey(order[0]!.identity), "no-cert (certification-ready) last");
  });

  test("ties break by score, then freshness", () => {
    const { w } = makeBot();
    const a = envelope(w, { certExpiresAt: NOW_SEC + 600n, score: 0.2 });
    const b = envelope(w, { certExpiresAt: NOW_SEC + 600n, score: 0.9 });
    assert.equal(byCertUrgency(b, a) < 0, true, "higher score first on expiry ties");
  });
});

describe("Sniper — windows + strategy shape", () => {
  test("the 5s quote window rejects quotes Conservative would accept", async () => {
    const { w, bot } = makeBot({ quoteAt: NOW() - 6_000 }); // 6s old
    const out = await bot.processEnvelope(envelope(w, { certExpiresAt: NOW_SEC + 3_600n }));
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "route-failure");
  });

  test("sniper fees share more of profit than conservative but stay under the D3 plan", () => {
    assert.ok(SNIPER_TUNABLES.feeMarginRatio > 0.25, "the sniper edge");
    assert.ok(SNIPER_TUNABLES.feeMarginRatio <= 1, "and never beyond the legal margin");
    assert.ok((SNIPER_TUNABLES.slippageBpsOverride ?? 10_000) <= 300, "slippage never widens past the protocol default");
  });
});

describe("Sniper — safety parity", () => {
  test("dry-run (default) never submits, even with an expiring cert", async () => {
    const { w, bot } = makeBot();
    const out = await bot.processEnvelope(envelope(w, { certExpiresAt: NOW_SEC + 120n }));
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
    assert.equal(w.rpc.sentTransactions.length, 0);
  });

  test("live mode submits through the SAME pipeline and simulates first", async () => {
    const { w, bot, sink } = makeBot({ mode: "live" });
    const out = await bot.processEnvelope(envelope(w, { certExpiresAt: NOW_SEC + 3_600n }));
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
    assert.equal(w.rpc.sentTransactions.length, 1);
    assert.ok(sink.where((e) => e.type === "simulated" && e.botId === "sniper").length >= 1, "simulation gate ran");
  });

  test("cross-bot lease: the sniper is denied while conservative holds the lease", async () => {
    const { w, bot, store } = makeBot();
    const env = envelope(w, { certExpiresAt: NOW_SEC + 3_600n });
    await store.acquireLease(opportunityKey(env.identity), "conservative", 120_000);
    const out = await bot.processEnvelope(env);
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "lease-conflict");
  });
});
