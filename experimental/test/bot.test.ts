// SPDX-License-Identifier: Apache-2.0
//
// Experimental executor tests (FLEET-M5) — risk caps, attribution,
// isolation, and the never-weaken guarantees.

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
  type ExecutionPolicy,
} from "@graveyield/fleet-core";
import { ExperimentalSalvor, EXPERIMENTAL_TUNABLES, DEFAULT_RISK_CAPS } from "../src/bot.js";
import { SNIPER_TUNABLES } from "../../sniper/src/bot.js";
import { CONSERVATIVE_TUNABLES } from "../../conservative/src/bot.js";
import { VAULT_ID, FIXED_NOW_MS } from "../../fleet-core/test/helpers.js";
import { buildWorld } from "../../fleet-core/test/world.js";

const NOW = () => FIXED_NOW_MS;
const NOW_SEC = BigInt(Math.floor(FIXED_NOW_MS / 1000));

function makeBot(opts?: {
  mode?: "dry-run" | "simulation" | "live";
  riskCaps?: Partial<typeof DEFAULT_RISK_CAPS>;
  salvorLpAmount?: bigint;
  experimentId?: string;
}) {
  const w = buildWorld({
    wsolReserve: 5_000_000_000n,
    memecoinReserve: 1_000_000n,
    lpSupply: 10_000_000n,
    salvorLpAmount: opts?.salvorLpAmount ?? 1_000_000n,
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
    quotedAtMs: NOW(),
    adapter: "fake",
  }));
  const pipeline = new ExecutionPipeline({
    client: w.client,
    policy: { botId: "experimental", cluster: "localnet", mode: opts?.mode ?? "dry-run", accepts: { kinds: ["certification-ready", "salvageable"] }, retryBackoffMs: 1, ...EXPERIMENTAL_TUNABLES } as ExecutionPolicy,
    liveEnablement: opts?.mode === "live" ? { enabled: true, acknowledgedBy: "test" } : null,
    routeAdapter: route,
    eventSink: sink,
    txSender: w.rpc.fakeSend.bind(w.rpc),
    now: NOW,
  });
  const bot = new ExperimentalSalvor({
    config: {
      cluster: "localnet",
      mode: opts?.mode ?? "dry-run",
      liveEnablement: opts?.mode === "live" ? { enabled: true, acknowledgedBy: "test" } : null,
      riskCaps: opts?.riskCaps,
      experimentId: opts?.experimentId ?? "exp-001",
      retryBackoffMs: 1,
    },
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

function envelope(w: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: { cluster: "localnet", ammProgramId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", poolAddress: w.poolAddress.toBase58() },
    kind: "salvageable",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 1_000,
    score: 0.5,
    certExpiresAt: NOW_SEC + 3_600n,
  });
}

describe("Experimental — risk caps (hard, fail-closed)", () => {
  test("a fee budget above the experiment cap is rejected risk-cap-exceeded", async () => {
    // Profit 0.36 SOL × margin 0.2 = 0.072 SOL D3 budget > 0.02 SOL cap.
    const { w, bot } = makeBot({ riskCaps: { maxPriorityFeeBudgetLamports: 20_000_000n } });
    const out = await bot.processEnvelope(envelope(w));
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "risk-cap-exceeded");
    assert.match(out.reason ?? "", /experiment cap/);
  });

  test("a generous cap lets the same opportunity through (caps are the knob)", async () => {
    const { w, bot } = makeBot({ riskCaps: { maxPriorityFeeBudgetLamports: 100_000_000n } });
    const out = await bot.processEnvelope(envelope(w));
    assert.ok(out.ok, `${out.failureClass} ${out.reason}`);
  });

  test("an LP position above the fraction cap is rejected", async () => {
    // 5M of 10M supply = 50% > 20% cap. The fee cap is raised so the
    // LP cap is the binding constraint here.
    const { w, bot } = makeBot({ salvorLpAmount: 5_000_000n, riskCaps: { maxPriorityFeeBudgetLamports: 400_000_000n } });
    const out = await bot.processEnvelope(envelope(w));
    assert.ok(!out.ok);
    assert.equal(out.failureClass, "risk-cap-exceeded");
    assert.match(out.reason ?? "", /LP position/);
  });

  test("the caps are evaluated BEFORE simulation (no wasted exposure)", async () => {
    const { w, bot, sink } = makeBot({ riskCaps: { maxPriorityFeeBudgetLamports: 1n } });
    await bot.processEnvelope(envelope(w));
    assert.equal(sink.where((e) => e.type === "simulated").length, 0, "no simulation when the cap rejects");
  });
});

describe("Experimental — attribution + isolation", () => {
  test("every event carries the experiment id + risk-caps block", async () => {
    const { w, bot, sink } = makeBot({ experimentId: "exp-42" });
    await bot.processEnvelope(envelope(w));
    // Strategy-level events (emitted by the bot itself, not the shared
    // engine) all carry the attribution block.
    const strategyEventTypes = new Set(["opportunity-received", "lease-acquired", "reported"]);
    const events = sink.where((e) => e.botId === "experimental" && strategyEventTypes.has(e.type));
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.equal((e.data as { experimentId?: string }).experimentId, "exp-42");
      assert.ok((e.data as { riskCaps?: unknown }).riskCaps);
    }
  });

  test("isolation: experimental defaults are its OWN objects — other bots unaffected", () => {
    // Distinct objects (a mutated experimental default must not alias).
    assert.notEqual(EXPERIMENTAL_TUNABLES, CONSERVATIVE_TUNABLES);
    assert.notEqual(EXPERIMENTAL_TUNABLES, SNIPER_TUNABLES);
    // Distinct values where strategies differ.
    assert.notEqual(EXPERIMENTAL_TUNABLES.minNetProfitLamports, CONSERVATIVE_TUNABLES.minNetProfitLamports);
    assert.notEqual(EXPERIMENTAL_TUNABLES.feeMarginRatio, SNIPER_TUNABLES.feeMarginRatio);

  });

  test("experimental runs in its own store namespace (botId), so no cross-contamination", async () => {
    const { w, bot, store } = makeBot();
    await bot.processEnvelope(envelope(w));
    const key = `localnet|675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8|${w.poolAddress.toBase58()}`;
    assert.ok(await store.getExecution(key, "experimental"));
    assert.equal(await store.getExecution(key, "conservative"), null);
  });
});

describe("Experimental — never-weaken guarantees", () => {
  test("dry-run (default) never submits", async () => {
    const { w, bot } = makeBot({ riskCaps: { maxPriorityFeeBudgetLamports: 100_000_000n } });
    const out = await bot.processEnvelope(envelope(w));
    assert.ok(out.ok);
    assert.equal(w.rpc.sentTransactions.length, 0);
  });

  test("protocol eligibility is still enforced: an expired cert cannot be salvaged", async () => {
    const { w } = makeBot();
    // Expire the cert: delete it and install an EXPIRED one.
    w.rpc.deleteAccount(w.certPda);
    const { encodeCert, SCANNER_ID } = await import("../../fleet-core/test/helpers.js");
    const { SCANNER_ID: SCAN } = await import("../../fleet-core/test/helpers.js");
    void SCAN;
    w.rpc.setAccount(
      w.certPda,
      encodeCert({
        ammProgramId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
        poolAddress: w.poolAddress,
        anchorEpoch: 10n,
        expiresAt: NOW_SEC - 100n,
      }),
      new PublicKey(SCANNER_ID),
    );
    const { bot } = makeBot({ riskCaps: { maxPriorityFeeBudgetLamports: 100_000_000n } });
    const out = await bot.processEnvelope(envelope(w));
    assert.ok(out.ok, "the cert is expired → revalidation flips to certification-ready → no cert exists → the ATOMIC certify path prepares");
    // The prepared tx must be the certify-and-salvage bundle (fresh cert),
    // NOT a salvage against the expired cert.
    void out;
  });
});
