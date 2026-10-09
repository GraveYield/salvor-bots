// SPDX-License-Identifier: Apache-2.0
//
// Execution pipeline tests (FLEET-M1) — transaction-shape regression,
// index pinning, dry-run gating, simulation, and fail-closed paths.
// Everything runs on the in-memory world; the "sender" records instead
// of broadcasting; no private key beyond throwaway test keypairs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";

import {
  GraveYieldClient,
  RAYDIUM_V4_PROGRAM_ID,
  WSOL_MINT,
  ED25519_PROGRAM_ID,
  vaultAuthorityPda,
  salvageReceiptPda,
  decodeGraveYieldErrorCode,
} from "@graveyield/sdk";
import {
  ExecutionPipeline,
  LocalAttestationSource,
  MemoryEventSink,
  FakeRouteAdapter,
  buildEnvelope,
  opportunityKey,
  validatePolicy,
  DEFAULT_TUNABLES,
  type ExecutionPolicy,
  type PipelineOutcome,
} from "../src/index.js";
import { FIXED_NOW_MS, SCANNER_ID, VAULT_ID, encodeSalvageReceipt } from "./helpers.js";
import { buildWorld } from "./world.js";

const NOW = () => FIXED_NOW_MS;
const NOW_SEC = BigInt(Math.floor(FIXED_NOW_MS / 1000));

function policy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    botId: "pipeline-test",
    cluster: "localnet",
    mode: "dry-run",
    accepts: { kinds: ["certification-ready", "salvageable"] },
    retryBackoffMs: 10,
    minNetProfitLamports: 0n,
    ...DEFAULT_TUNABLES,
    ...overrides,
  };
}

/** A route whose in/out mirror the world's reserves at 4 WSOL per full memecoin reserve. */
function healthyRouteAdapter() {
  return new FakeRouteAdapter(async (req) => ({
    inputMint: req.inputMint.toBase58(),
    outputMint: req.outputMint.toBase58(),
    inAmount: req.amount,
    outAmount: 4_000_000_000n,
    slippageBps: req.slippageBps,
    routeData: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    routeAccounts: [
      { pubkey: PublicKey.unique(), isSigner: false, isWritable: false },
      {
        pubkey: getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthorityPda(VAULT_ID), true),
        isSigner: false,
        isWritable: true,
      },
    ],
    quotedAtMs: NOW(),
    adapter: "fake",
  }));
}

function makePipeline(opts: {
  world: ReturnType<typeof buildWorld>;
  pol?: ExecutionPolicy;
  route?: FakeRouteAdapter;
  sink?: MemoryEventSink;
}): { pipeline: ExecutionPipeline; route: FakeRouteAdapter; sink: MemoryEventSink } {
  const route = opts.route ?? healthyRouteAdapter();
  const sink = opts.sink ?? new MemoryEventSink();
  const pipeline = new ExecutionPipeline({
    client: opts.world.client,
    policy: opts.pol ?? policy(),
    routeAdapter: route,
    eventSink: sink,
    txSender: opts.world.rpc.fakeSend.bind(opts.world.rpc),
    now: NOW,
  });
  return { pipeline, route, sink };
}

function certificationReadyEnvelope(world: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: { cluster: "localnet", ammProgramId: RAYDIUM_V4_PROGRAM_ID.toBase58(), poolAddress: world.poolAddress.toBase58() },
    kind: "certification-ready",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 60_000,
    score: 0.5,
    firstEligibleEpoch: 10n,
  });
}

function salvageableEnvelope(world: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: { cluster: "localnet", ammProgramId: RAYDIUM_V4_PROGRAM_ID.toBase58(), poolAddress: world.poolAddress.toBase58() },
    kind: "salvageable",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 60_000,
    score: 0.5,
    certExpiresAt: NOW_SEC + 3_600n,
  });
}

describe("ExecutionPipeline — certification-ready path (dry-run)", () => {
  test("prepares the atomic [cuLimit, cuPrice, precompile(2), phase2(3), salvage(4)] bundle with the index pinned", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n });
    const { pipeline } = makePipeline({ world: w });
    const oracle = KeypairShim();
    const out = await pipeline.prepare({
      envelope: certificationReadyEnvelope(w),
      salvor: w.salvor.publicKey,
      attestationSource: new LocalAttestationSource(oracle),
    });
    assert.ok(out.ok, `prepare failed: ${out.failureClass} ${out.reason}`);
    const p = out.prepared!;
    assert.equal(p.kind, "certify-and-salvage");
    assert.equal(p.tx.instructions.length, 5);
    // Compute-budget ixs first: limit then price.
    assert.equal(p.tx.instructions[0]!.programId.toBase58(), "ComputeBudget111111111111111111111111111111");
    assert.equal(p.tx.instructions[1]!.programId.toBase58(), "ComputeBudget111111111111111111111111111111");
    // Precompile at index 2, phase2 at index 3, salvage at index 4.
    assert.equal(p.scannerIxIndex, 3);
    assert.equal(p.tx.instructions[2]!.programId.toBase58(), ED25519_PROGRAM_ID.toBase58());
    assert.equal(p.tx.instructions[3]!.programId.toBase58(), SCANNER_ID.toBase58());
    assert.equal(p.salvageIxIndex, 4);
    assert.equal(p.tx.instructions[4]!.programId.toBase58(), VAULT_ID.toBase58());
    // The precompile's embedded message instruction index MUST equal 3
    // (u16 LE at byte offset 14 in the Ed25519SigVerify wire format).
    const precompileData = p.tx.instructions[2]!.data;
    assert.equal(precompileData[14], 3);
    assert.equal(precompileData[15], 0);
    // The fee is Charter-bounded: price × cuLimit ≤ 25% of the 0.36 SOL
    // gross share, in micro-lamports (9e13).
    assert.ok(p.feeMicroLamportsPerCu.gt(new BN(0)));
    assert.ok(
      p.feeMicroLamportsPerCu
        .mul(new BN(p.computeUnitLimit))
        .lte(new BN((360_000_000n * 25n / 100n * 1_000_000n).toString())),
    );
    // Snapshot material is real: 2 holders, supply 10M, salvor LP 1M.
    assert.equal(p.snapshotSummary.holderCount, 2);
    assert.equal(p.snapshotSummary.totalSupply, 10_000_000n);
    assert.equal(p.snapshotSummary.salvorLpAmount, 1_000_000n);
    // The salvage ix carries 21 named + 13 raydium + 2 route accounts.
    assert.equal(p.tx.instructions[4]!.keys.length, 21 + 13 + 2);
    // min output floor from the estimator: 400M × (10000−300)/10000 = 388M.
    assert.equal(p.minQuoteOutputLamports, 388_000_000n);
  });

  test("dry-run NEVER submits: mode gate throws before any send", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.ok(out.ok, `prepare failed: ${out.failureClass} ${out.reason}`);
    const signer = w.salvor;
    await assert.rejects(
      () => pipeline.submit({ prepared: out.prepared!, signer }),
      /never submits/,
    );
    assert.equal(w.rpc.sentTransactions.length, 0, "no transaction may reach the sender in dry-run");
  });

  test("economic minimum rejects unprofitable opportunities before assembly", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n });
    // Net profit here is 0.36 SOL minus costs — set the minimum above it.
    const { pipeline } = makePipeline({ world: w, pol: policy({ minNetProfitLamports: 1_000_000_000n }) });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "economic-insufficient");
  });
});

describe("ExecutionPipeline — salvageable path (dry-run)", () => {
  test("prepares [cuLimit, cuPrice, salvage] with no precompile and no phase-2 re-issue", async () => {
    const w = buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.ok(out.ok, out.reason);
    const p = out.prepared!;
    assert.equal(p.kind, "salvage-only");
    assert.equal(p.tx.instructions.length, 3);
    assert.equal(p.scannerIxIndex, null);
    assert.equal(p.attestationSignature, null);
    assert.equal(p.salvageIxIndex, 2);
    assert.equal(p.tx.instructions[2]!.programId.toBase58(), VAULT_ID.toBase58());
    // No GraveScanner instruction anywhere — a live cert is consumed, not re-minted.
    assert.ok(!p.tx.instructions.some((ix) => ix.programId.equals(SCANNER_ID)));
  });
});

describe("ExecutionPipeline — safety gates", () => {
  test("stale quote is rejected route-failure", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    const staleRoute = new FakeRouteAdapter(async (req) => ({
      inputMint: req.inputMint.toBase58(),
      outputMint: req.outputMint.toBase58(),
      inAmount: req.amount,
      outAmount: 4_000_000_000n,
      slippageBps: req.slippageBps,
      routeData: new Uint8Array(4),
      routeAccounts: [
        { pubkey: getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthorityPda(VAULT_ID), true), isSigner: false, isWritable: true },
      ],
      quotedAtMs: NOW() - 60_000, // 60s old > 15s policy window
      adapter: "fake",
    }));
    const { pipeline } = makePipeline({ world: w, route: staleRoute });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "route-failure");
    assert.match(out.reason ?? "", /stale|older/i);
  });

  test("missing route accounts (no vault WSOL destination) fail closed", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    const emptyRoute = new FakeRouteAdapter(async (req) => ({
      inputMint: req.inputMint.toBase58(),
      outputMint: req.outputMint.toBase58(),
      inAmount: req.amount,
      outAmount: 4_000_000_000n,
      slippageBps: req.slippageBps,
      routeData: new Uint8Array(4),
      routeAccounts: [],
      quotedAtMs: NOW(),
      adapter: "fake",
    }));
    const { pipeline } = makePipeline({ world: w, route: emptyRoute });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "route-failure");
    assert.match(out.reason ?? "", /WSOL destination/);
  });

  test("LP supply moving after the snapshot fails closed (state-changed, 7018 caught early)", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    // Deterministic race injection: the FIRST getProgramAccounts call is
    // the snapshot enumeration — mutate the LP mint supply right after
    // it so the pipeline's re-pin read (which follows the snapshot)
    // observes drift.
    const originalGpa = w.rpc.getProgramAccounts.bind(w.rpc);
    let mutated = false;
    w.rpc.getProgramAccounts = async (programId: PublicKey, opts?: never) => {
      const out = await originalGpa(programId, opts);
      if (!mutated) {
        mutated = true;
        const buf = new Uint8Array(82);
        const view = new DataView(buf.buffer);
        view.setBigUint64(36, 9_500_000n, true);
        view.setUint8(44, 9);
        view.setUint8(45, 1);
        w.rpc.setAccount(w.lpMint, buf, TOKEN_PROGRAM);
      }
      return out;
    };
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "state-changed");
    assert.match(out.reason ?? "", /supply/);
  });

  test("salvor without LP fails closed (missing-accounts)", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 0n, certExpiresAt: NOW_SEC + 3_600n });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "missing-accounts");
    assert.match(out.reason ?? "", /no LP/);
  });

  test("certification-ready without an AttestationSource is config-invalid (no silent skip)", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({ envelope: certificationReadyEnvelope(w), salvor: w.salvor.publicKey });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "config-invalid");
    assert.match(out.reason ?? "", /AttestationSource/);
  });
});

describe("ExecutionPipeline — simulation + submission", () => {
  test("simulate passes on a healthy world and carries unitsConsumed", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    const { pipeline } = makePipeline({ world: w });
    const prep = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.ok(prep.ok);
    const sim = await pipeline.simulate(prep.prepared!);
    assert.ok(sim.ok);
    assert.equal(sim.simulation?.unitsConsumed, 424_242);
  });

  test("a failing simulation decodes the GraveYield error and refuses", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    w.rpc.simulationResult = {
      err: { InstructionError: [2, { Custom: 7002 }] }, // EligibilityCertExpired
      logs: ["Program log: expired"],
      unitsConsumed: 100,
    };
    const { pipeline } = makePipeline({ world: w });
    const prep = await pipeline.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.ok(prep.ok, `prepare failed: ${prep.failureClass} ${prep.reason}`);
    const sim = await pipeline.simulate(prep.prepared!);
    assert.equal(sim.ok, false);
    assert.equal(sim.failureClass, "simulation-failed");
    assert.match(sim.reason ?? "", /EligibilityCertExpired/);
  });

  test("live mode submits through the injected sender and reads the salvage receipt", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    // Constructing with mode=live without enablement must throw — the
    // guard itself is under test.
    assert.throws(
      () =>
        makePipeline({
          world: w,
          pol: policy({ mode: "live" }),
        }),
      /explicit operator enablement/,
    );
    // Now with enablement — the constructor re-validates it.
    const live = new ExecutionPipeline({
      client: w.client,
      policy: policy({ mode: "live" }),
      liveEnablement: { enabled: true, acknowledgedBy: "test-operator" },
      routeAdapter: healthyRouteAdapter(),
      eventSink: new MemoryEventSink(),
      txSender: w.rpc.fakeSend.bind(w.rpc),
      now: NOW,
    });
    const prep = await live.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.ok(prep.ok);
    const sim = await live.simulate(prep.prepared!);
    assert.ok(sim.ok);
    // Install the receipt at the canonical PDA the salvage ix references.
    w.rpc.setAccount(
      salvageReceiptPda(VAULT_ID, w.poolAddress),
      encodeSalvageReceipt({
        poolAddress: w.poolAddress,
        salvor: w.salvor.publicKey,
        lpHolderAmountLamports: 360_000_000n,
        salvorAmountLamports: 360_000_000n,
        protocolAmountLamports: 180_000_000n,
        totalProceedsLamports: 900_000_000n,
        memecoinMint: w.memecoinMint,
      }),
      VAULT_ID,
    );
    const sub = await live.submit({ prepared: prep.prepared!, signer: w.salvor });
    assert.ok(sub.ok, sub.reason);
    assert.equal(sub.stage, "confirmed");
    assert.ok(sub.signature);
    assert.equal(w.rpc.sentTransactions.length, 1, "exactly one transaction in live mode");
    assert.equal(sub.receipt?.totalProceedsLamports, 900_000_000n);
    assert.equal(sub.receipt?.salvorAmountLamports, 360_000_000n);
    // Settlement sums: 40/40/20 of 0.9 SOL.
    const r = sub.receipt!;
    assert.equal(r.lpHolderAmountLamports + r.salvorAmountLamports + r.protocolAmountLamports, r.totalProceedsLamports);
  });

  test("submitted fee respects the D3 budget (price ix ≤ plan.max × cuLimit)", async () => {
    const w = buildWorld({ wsolReserve: 5_000_000_000n, memecoinReserve: 1_000_000n, lpSupply: 10_000_000n, salvorLpAmount: 1_000_000n, certExpiresAt: NOW_SEC + 3_600n });
    const live = new ExecutionPipeline({
      client: w.client,
      policy: policy({ mode: "live" }),
      liveEnablement: { enabled: true, acknowledgedBy: "test-operator" },
      routeAdapter: healthyRouteAdapter(),
      eventSink: new MemoryEventSink(),
      txSender: w.rpc.fakeSend.bind(w.rpc),
      now: NOW,
    });
    const prep = await live.prepare({ envelope: salvageableEnvelope(w), salvor: w.salvor.publicKey });
    assert.ok(prep.ok);
    const p = prep.prepared!;
    // price × cuLimit ≤ 25% of the 0.36 SOL gross share (in µL).
    const budgetMicro = new BN("90000000000000"); // 0.09 SOL = 9e13 µL
    assert.ok(p.feeMicroLamportsPerCu.mul(new BN(p.computeUnitLimit)).lte(budgetMicro));
    // And the attached ix matches the plan exactly: SetComputeUnitPrice
    // data = [tag=3][u64 LE micro-lamports] (SetComputeUnitLimit = tag 2).
    const priceIx = p.tx.instructions[1]!;
    assert.equal(priceIx.data[0], 3);
    assert.equal(priceIx.data.readBigUInt64LE(1), BigInt(p.feeMicroLamportsPerCu.toString()));
  });
});

// throwaway keypair shim (no secrets material in tests)
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM } from "./helpers.js";
function KeypairShim(): Keypair {
  return Keypair.generate();
}

// silence unused import (decodeGraveYieldErrorCode exercised indirectly via the sim path)
void decodeGraveYieldErrorCode;
