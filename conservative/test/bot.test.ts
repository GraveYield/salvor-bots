// SPDX-License-Identifier: Apache-2.0
//
// Conservative executor tests (FLEET-M3) — the reference executor over
// the shared engine: both opportunity paths, dry-run gating, duplicate
// suppression, restart resumption, lease coordination, retries.

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
import { ConservativeSalvor, CONSERVATIVE_TUNABLES } from "../src/bot.js";
import { VAULT_ID, FIXED_NOW_MS, SCANNER_ID } from "../../fleet-core/test/helpers.js";
import { buildWorld } from "../../fleet-core/test/world.js";

const NOW = () => FIXED_NOW_MS;
const NOW_SEC = BigInt(Math.floor(FIXED_NOW_MS / 1000));

/** Default-conservative world + pipeline + bot wiring. */
function makeBot(opts?: {
  mode?: "dry-run" | "simulation" | "live";
  tunables?: Record<string, unknown>;
  routeQuotedAtMs?: number;
  minNetProfitLamports?: bigint;
}) {
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
    routeData: Uint8Array.from([0xbe, 0xef]),
    routeAccounts: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
      {
        pubkey: getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthorityPda(new PublicKey(VAULT_ID)), true),
        isSigner: false,
        isWritable: true,
      },
    ],
    quotedAtMs: opts?.routeQuotedAtMs ?? NOW(),
    adapter: "fake",
  }));
  const pipeline = new ExecutionPipeline({
    client: w.client,
    policy: {
      botId: "conservative",
      cluster: "localnet",
      mode: opts?.mode ?? "dry-run",
      accepts: { kinds: ["certification-ready", "salvageable"] },
      retryBackoffMs: 1,
      ...CONSERVATIVE_TUNABLES,
      ...(opts?.tunables ?? {}),
      // Applied LAST so the explicit min always wins.
      minNetProfitLamports: opts?.minNetProfitLamports ?? CONSERVATIVE_TUNABLES.minNetProfitLamports,
    } as ExecutionPolicy,
    liveEnablement: opts?.mode === "live" ? { enabled: true, acknowledgedBy: "test" } : null,
    routeAdapter: route,
    eventSink: sink,
    txSender: w.rpc.fakeSend.bind(w.rpc),
    now: NOW,
  });
  const oracle = Keypair.generate();
  const bot = new ConservativeSalvor({
    config: {
      cluster: "localnet",
      mode: opts?.mode ?? "dry-run",
      liveEnablement: opts?.mode === "live" ? { enabled: true, acknowledgedBy: "test" } : null,
      tunables: { ...(opts?.tunables ?? {}), minNetProfitLamports: opts?.minNetProfitLamports ?? CONSERVATIVE_TUNABLES.minNetProfitLamports },
      retryBackoffMs: 1,
    },
    client: w.client,
    pipeline,
    store,
    sink,
    signer: w.salvor,
    attestationSource: new LocalAttestationSource(oracle),
    now: NOW,
  });
  return { w, bot, sink, store, route };
}

function salvageableEnvelope(w: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: { cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: w.poolAddress.toBase58() },
    kind: "salvageable",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 1_000,
    score: 0.42,
    certExpiresAt: NOW_SEC + 3_600n,
  });
}

function certificationReadyEnvelope(w: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: { cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: w.poolAddress.toBase58() },
    kind: "certification-ready",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 1_000,
    score: 0.42,
    firstEligibleEpoch: 10n,
  });
}

describe("Conservative — dry-run (default mode)", () => {
  test("salvageable path: full pass, nothing submitted, reported dry-run", async () => {
    const { w, bot, sink } = makeBot();
    const out = await bot.processEnvelope(salvageableEnvelope(w));
    assert.ok(out.admitted);
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
    assert.match(out.state, /reported|ready/);
    assert.match(out.reason ?? "", /dry-run complete/);
    assert.equal(w.rpc.sentTransactions.length, 0, "dry-run NEVER submits");
    assert.ok(sink.events.length > 0);
    // The reported event carries the dry-run marker.
    const reported = sink.where((e) => e.type === "reported");
    assert.ok(reported.some((e) => (e.data as { dryRun?: boolean }).dryRun === true));
  });

  test("certification-ready path: prepare + simulate the ATOMIC certify-and-salvage bundle", async () => {
    // Delete the world's cert → the pool is genuinely certification-ready.
    const { w, bot, sink } = makeBot();
    w.rpc.deleteAccount(w.certPda);
    const out = await bot.processEnvelope(certificationReadyEnvelope(w));
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
    const prepared = sink.where(
      (e) =>
        e.type === "prepared" &&
        e.botId === "conservative" &&
        (e.data as { kind?: string }).kind !== undefined &&
        (e.data as { scannerIxIndex?: number }).scannerIxIndex === undefined,
    );
    assert.equal(prepared.length, 1, "one Conservative-level prepared event (the pipeline's carries scannerIxIndex)");
    assert.equal((prepared[0]?.data as { kind?: string }).kind, "certify-and-salvage");
    assert.equal(w.rpc.sentTransactions.length, 0);
  });

  test("kind flip: a certification-ready envelope whose cert ALREADY exists is executed salvage-only (no phase-2 re-issue)", async () => {
    const { w, bot, sink } = makeBot();
    const out = await bot.processEnvelope(certificationReadyEnvelope(w));
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
    const prepared = sink.where(
      (e) =>
        e.type === "prepared" &&
        e.botId === "conservative" &&
        (e.data as { kind?: string }).kind !== undefined &&
        (e.data as { scannerIxIndex?: number }).scannerIxIndex === undefined,
    );
    assert.equal((prepared[0]?.data as { kind?: string }).kind, "salvage-only", "live state wins over the envelope's stale kind");
  });

  test("duplicate delivery is suppressed (idempotent consumption)", async () => {
    const { w, bot } = makeBot();
    const env = salvageableEnvelope(w);
    const first = await bot.processEnvelope(env);
    const second = await bot.processEnvelope(env);
    assert.ok(first.admitted);
    assert.ok(!second.admitted);
    assert.equal(second.state, "duplicate-suppressed");
  });

  test("stale sighting (older than maxOpportunityAgeMs) is rejected before revalidation", async () => {
    const { w, bot } = makeBot();
    const env = salvageableEnvelope(w);
    env.provenance.detectedAtMs = FIXED_NOW_MS - 10 * 3_600_000; // 10h old > 6h window
    const out = await bot.processEnvelope(env);
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "stale-opportunity");
  });
});

describe("Conservative — strategy shape", () => {
  test("the conservative minimum (0.05 SOL) rejects marginal economics", async () => {
    const { w, bot } = makeBot({ minNetProfitLamports: 50_000_000n });
    // World economics: net ≈ 0.36 SOL minus costs — well above 0.05 SOL.
    const good = await bot.processEnvelope(salvageableEnvelope(w));
    assert.ok(good.ok, good.reason);
    // A bot demanding 10 SOL net rejects the same 0.36 SOL opportunity.
    const { w: w2, bot: bot2 } = makeBot({ minNetProfitLamports: 10_000_000_000n });
    const out = await bot2.processEnvelope(salvageableEnvelope(w2));
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "economic-insufficient");
  });

  test("conservative policy is tighter than the D3 default on slippage and margin", () => {
    assert.ok((CONSERVATIVE_TUNABLES.slippageBpsOverride ?? 10_000) < 300);
    assert.ok(CONSERVATIVE_TUNABLES.feeMarginRatio < 0.25);
    assert.ok(CONSERVATIVE_TUNABLES.minNetProfitLamports > 0n);
  });
});

describe("Conservative — coordination + records", () => {
  test("a second bot instance is denied the lease while the first holds it", async () => {
    const { w, bot, store } = makeBot();
    const env = salvageableEnvelope(w);
    // A phantom holder keeps the lease.
    await store.acquireLease(opportunityKey(env.identity), "sniper", 120_000);
    const out = await bot.processEnvelope(env);
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "lease-conflict");
    assert.equal(out.state, "lease-waiting");
  });

  test("restart safety: execution records persist in the store across bot instances", async () => {
    const { w, bot, store } = makeBot();
    const env = salvageableEnvelope(w);
    await bot.processEnvelope(env);
    const record = await store.getExecution(opportunityKey(env.identity), "conservative");
    assert.ok(record);
    assert.ok(record.transitions.length > 0);
    // A NEW bot instance (restart) with the SAME store sees the delivery.
    const { bot: bot2 } = makeBot();
    const bot2withStore = new ConservativeSalvor({
      config: { cluster: "localnet", mode: "dry-run", retryBackoffMs: 1 },
      client: w.client,
      pipeline: bot2["pipeline"],
      store,
      sink: new MemoryEventSink(),
      signer: w.salvor,
      now: NOW,
    });
    const again = await bot2withStore.processEnvelope(env);
    assert.ok(!again.admitted, "restart re-processing the same delivery must be suppressed");
  });

  test("cycle summary aggregates duplicates and failures", async () => {
    const { w, bot } = makeBot({ minNetProfitLamports: 10_000_000_000n }); // everything rejects
    const env = salvageableEnvelope(w);
    const cycle = await bot.runOnce([env, env]);
    assert.equal(cycle.received, 2);
    assert.equal(cycle.duplicates, 1);
    assert.equal(cycle.failed, 1);
    assert.ok(cycle.dryRun);
  });
});

describe("Conservative — live mode", () => {
  test("live mode submits exactly once and reports the confirmed signature", async () => {
    const { w, bot, sink } = makeBot({ mode: "live" });
    const out = await bot.processEnvelope(salvageableEnvelope(w));
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
    assert.ok(out.signature);
    assert.equal(w.rpc.sentTransactions.length, 1);
    assert.ok(sink.where((e) => e.type === "confirmed").some((e) => (e.data as { signature?: string }).signature === out.signature));
  });

  test("live construction without a signer is refused", async () => {
    const { w } = makeBot({ mode: "live" });
    const { ExecutionPipeline: P } = await import("@graveyield/fleet-core");
    const pipeline = new P({
      client: w.client,
      policy: {
        botId: "conservative", cluster: "localnet", mode: "live",
        accepts: { kinds: ["salvageable"] }, retryBackoffMs: 1, minNetProfitLamports: 0n,
        ...CONSERVATIVE_TUNABLES,
      } as ExecutionPolicy,
      liveEnablement: { enabled: true, acknowledgedBy: "test" },
      routeAdapter: new FakeRouteAdapter(async () => {
        throw new Error("unused");
      }),
      eventSink: new MemoryEventSink(),
      txSender: w.rpc.fakeSend.bind(w.rpc),
      now: NOW,
    });
    assert.throws(
      () =>
        new ConservativeSalvor({
          config: { cluster: "localnet", mode: "live", liveEnablement: { enabled: true, acknowledgedBy: "test" }, retryBackoffMs: 1 },
          client: w.client,
          pipeline,
        }),
      /live mode requires a signer/,
    );
  });

  test("send failure retries up to maxSubmitAttempts then fails terminal", async () => {
    const { w, bot, sink } = makeBot({ mode: "live" });
    w.rpc.sendError = new Error("RPC boom");
    const out = await bot.processEnvelope(salvageableEnvelope(w));
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "submission-failed");
    const attemptFailures = sink.where((e) => e.type === "execution-failed" && (e.data as { attempt?: number }).attempt !== undefined);
    assert.equal(attemptFailures.length, 3, "three attempts (maxSubmitAttempts), then terminal");
    assert.equal(w.rpc.sentTransactions.length, 0, "every attempt failed before landing");
  });
});
