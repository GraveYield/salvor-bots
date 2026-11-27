// web3.js 3.x removed the 1.x `PublicKey.unique()` helper; a counter-seeded
// sha256 keygen keeps the route fixtures deterministic and synchronous.
let uniqueKeyCounter = 0;
function uniquePublicKey(): PublicKey {
  return new PublicKey(
    createHash("sha256").update(`pipeline-fixture-${uniqueKeyCounter++}`).digest(),
  );
}

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
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import BN from "bn.js";

import {
  RAYDIUM_V4_PROGRAM_ID,
  WSOL_MINT,
  ED25519_PROGRAM_ID,
  vaultAuthorityPda,
  salvageReceiptPda,
  decodeGraveYieldErrorCode,
  LastSwapEvidenceIncompleteError,
} from "@graveyield/sdk";
import {
  ExecutionPipeline,
  LocalAttestationSource,
  MemoryEventSink,
  FakeRouteAdapter,
  buildEnvelope,
  DEFAULT_TUNABLES,
  type AttestationSource,
  type ClaimsSnapshotter,
  type ExecutionPolicy,
  type SnapshotterRequest,
  type VerifiedClaimsSnapshot,
  ClaimsSnapshotterError,
  RustCliClaimsSnapshotter,
} from "../src/index.js";
import {
  FIXED_NOW_MS,
  FIXED_SLOT,
  SCANNER_ID,
  VAULT_ID,
  encodeSalvageReceipt,
  makeSwapTxLike,
} from "./helpers.js";
import { buildClaimsArtifact, buildSinkLedger } from "./fixtures/artifactFactory.js";
import { buildWorld, type World } from "./world.js";

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
      { pubkey: uniquePublicKey(), isSigner: false, isWritable: false },
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

/**
 * A pipeline-behavior stub implementing the ClaimsSnapshotter seam
 * directly (bypassing verification — verification coverage lives in
 * snapshotter.test.ts and the end-to-end CLI test below).
 */
function stubSnapshotter(
  world: World,
  opts?: { failWith?: ClaimsSnapshotterError; artifactSha256?: string },
): ClaimsSnapshotter {
  return {
    async produceSnapshot(req: SnapshotterRequest): Promise<VerifiedClaimsSnapshot> {
      if (opts?.failWith) throw opts.failWith;
      void req;
      return {
        root: new Uint8Array(32).fill(7),
        totalSupply: world.lpSupply,
        snapshotSlot: FIXED_SLOT,
        holderCount: world.holders.length,
        artifactSha256: opts?.artifactSha256 ?? "stub-digest",
        sinkLedgerSha256: "stub-ledger-digest",
        sinkLedgerId: "GY-SINK-STUB",
      };
    },
  };
}

function makePipeline(opts: {
  world: ReturnType<typeof buildWorld>;
  pol?: ExecutionPolicy;
  route?: FakeRouteAdapter;
  sink?: MemoryEventSink;
  snapshotter?: ClaimsSnapshotter;
}): { pipeline: ExecutionPipeline; route: FakeRouteAdapter; sink: MemoryEventSink } {
  const route = opts.route ?? healthyRouteAdapter();
  const sink = opts.sink ?? new MemoryEventSink();
  const pipeline = new ExecutionPipeline({
    client: opts.world.client,
    policy: opts.pol ?? policy(),
    routeAdapter: route,
    eventSink: sink,
    snapshotter: opts.snapshotter ?? stubSnapshotter(opts.world),
    txSender: opts.world.rpc.fakeSend.bind(opts.world.rpc),
    now: NOW,
  });
  return { pipeline, route, sink };
}

function certificationReadyEnvelope(world: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: {
      cluster: "localnet",
      ammProgramId: RAYDIUM_V4_PROGRAM_ID.toBase58(),
      poolAddress: world.poolAddress.toBase58(),
    },
    kind: "certification-ready",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 60_000,
    score: 0.5,
    firstEligibleEpoch: 10n,
  });
}

function salvageableEnvelope(world: ReturnType<typeof buildWorld>) {
  return buildEnvelope({
    identity: {
      cluster: "localnet",
      ammProgramId: RAYDIUM_V4_PROGRAM_ID.toBase58(),
      poolAddress: world.poolAddress.toBase58(),
    },
    kind: "salvageable",
    sourceBot: "scout",
    detectedAtMs: FIXED_NOW_MS - 60_000,
    score: 0.5,
    certExpiresAt: NOW_SEC + 3_600n,
  });
}

describe("ExecutionPipeline — certification-ready path (dry-run)", () => {
  test("prepares the atomic [cuLimit, cuPrice, precompile(2), phase2(3), salvage(4)] bundle with the index pinned", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
    });
    const { pipeline } = makePipeline({ world: w });
    const oracle = await KeypairShim();
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
    assert.equal(
      p.tx.instructions[0]!.programId.toBase58(),
      "ComputeBudget111111111111111111111111111111",
    );
    assert.equal(
      p.tx.instructions[1]!.programId.toBase58(),
      "ComputeBudget111111111111111111111111111111",
    );
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
        .lte(new BN((((360_000_000n * 25n) / 100n) * 1_000_000n).toString())),
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
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.ok(out.ok, `prepare failed: ${out.failureClass} ${out.reason}`);
    const signer = w.salvor;
    await assert.rejects(
      () => pipeline.submit({ prepared: out.prepared!, signer }),
      /never submits/,
    );
    assert.equal(
      w.rpc.sentTransactions.length,
      0,
      "no transaction may reach the sender in dry-run",
    );
  });

  test("economic minimum rejects unprofitable opportunities before assembly", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
    });
    // Net profit here is 0.36 SOL minus costs — set the minimum above it.
    const { pipeline } = makePipeline({
      world: w,
      pol: policy({ minNetProfitLamports: 1_000_000_000n }),
    });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "economic-insufficient");
  });
});

/**
 * Wraps an AttestationSource and records every signing request — lets the
 * regression assert that the oracle is NEVER asked to sign from incomplete
 * evidence (IMPL-001 Correction 004).
 */
class RecordingAttestationSource implements AttestationSource {
  readonly requests: Uint8Array[] = [];
  constructor(private readonly inner: AttestationSource) {}
  async signAttestation(message: Uint8Array) {
    this.requests.push(message);
    return this.inner.signAttestation(message);
  }
}

describe("ExecutionPipeline — incomplete last-swap evidence on the certification path (IMPL-001 Correction 004)", () => {
  const WORLD = {
    wsolReserve: 5_000_000_000n,
    memecoinReserve: 1_000_000n,
    lpSupply: 10_000_000n,
    salvorLpAmount: 1_000_000n,
  };

  test("control: a verified swap still prepares the certify-and-salvage bundle", async () => {
    const w = await buildWorld({ ...WORLD });
    const { pipeline } = makePipeline({ world: w });
    const oracle = new RecordingAttestationSource(new LocalAttestationSource(await KeypairShim()));
    const out = await pipeline.prepare({
      envelope: certificationReadyEnvelope(w),
      salvor: w.salvor.publicKey,
      attestationSource: oracle,
    });
    assert.ok(out.ok, `prepare failed: ${out.failureClass} ${out.reason}`);
    assert.equal(out.prepared!.kind, "certify-and-salvage");
    assert.equal(oracle.requests.length, 1, "exactly one attestation signing request");
    assert.equal(w.rpc.sentTransactions.length, 0, "dry-run never sends");
  });

  test("LastSwapEvidenceIncompleteError fails certification closed: no attestation, no prepared bundle, no send", async () => {
    const w = await buildWorld({ ...WORLD });
    // Incomplete evidence: the pool's history holds a finalized candidate,
    // but the RPC no longer serves its transaction data (pruned). The
    // candidate is unresolved, so deriveLastSwapV4 must THROW incomplete —
    // never fold into null (definitive) and never fabricate a swap.
    w.rpc.transactions.clear();
    const { pipeline, sink } = makePipeline({ world: w });
    const oracle = new RecordingAttestationSource(new LocalAttestationSource(await KeypairShim()));
    await assert.rejects(
      () =>
        pipeline.prepare({
          envelope: certificationReadyEnvelope(w),
          salvor: w.salvor.publicKey,
          attestationSource: oracle,
        }),
      (err: Error) => {
        assert.ok(
          err instanceof LastSwapEvidenceIncompleteError,
          `expected LastSwapEvidenceIncompleteError, got: ${String(err)}`,
        );
        const incomplete = err as LastSwapEvidenceIncompleteError;
        assert.equal(incomplete.evidence.status, "incomplete");
        assert.equal(incomplete.evidence.lastSwap, null);
        assert.equal(incomplete.evidence.candidates.length, 1);
        assert.equal(incomplete.evidence.candidates[0]!.outcome.kind, "unresolved");
        assert.equal(incomplete.evidence.candidates[0]!.outcome.reason, "transaction_data_missing");
        return true;
      },
    );
    assert.equal(
      oracle.requests.length,
      0,
      "no attestation may be signed from incomplete evidence",
    );
    assert.equal(w.rpc.sentTransactions.length, 0, "no transaction may be sent");
    // The pipeline reached assembly (economics passed) but reported nothing
    // as prepared or submitted — the typed error surfaced instead.
    assert.equal(sink.where((e) => e.type === "economic-pass").length, 1);
    assert.equal(sink.where((e) => e.type === "prepared").length, 0);
    assert.equal(sink.where((e) => e.type === "submitted").length, 0);
  });

  test("incomplete evidence stays distinguishable from a definitive no_swap_in_scan", async () => {
    const w = await buildWorld({ ...WORLD });
    // Definitive no-swap world: the pool's ONLY history entry is an
    // EXPLICITLY failed transaction (meta.err recorded) — provably not an
    // economic swap, and the scan reaches history end. deriveLastSwapV4
    // returns null, so certification fails with the dedicated no-swap
    // error — NOT the incomplete-evidence error.
    const sigs = w.rpc.signaturesByPool.get(w.poolAddress.toBase58())!;
    const sigInfo = sigs[0]!;
    w.rpc.transactions.set(
      sigInfo.signature,
      makeSwapTxLike({
        programId: RAYDIUM_V4_PROGRAM_ID,
        poolAddress: w.poolAddress,
        coinVault: w.coinVault,
        pcVault: w.pcVault,
        blockTime: sigInfo.blockTime,
        slot: sigInfo.slot,
        signature: sigInfo.signature,
        coinPre: "1000000",
        coinPost: "1100000",
        pcPre: "100000",
        pcPost: "90000",
        metaErr: { InstructionError: [0, { Custom: 0x1771 }] },
      }),
    );
    const { pipeline, sink } = makePipeline({ world: w });
    const oracle = new RecordingAttestationSource(new LocalAttestationSource(await KeypairShim()));
    await assert.rejects(
      () =>
        pipeline.prepare({
          envelope: certificationReadyEnvelope(w),
          salvor: w.salvor.publicKey,
          attestationSource: oracle,
        }),
      (err: Error) => {
        assert.ok(
          !(err instanceof LastSwapEvidenceIncompleteError),
          "definitive no_swap_in_scan must NOT surface as LastSwapEvidenceIncompleteError",
        );
        assert.match(err.message, /cannot certify .*no_swap_in_scan/);
        return true;
      },
    );
    assert.equal(oracle.requests.length, 0, "no attestation without a verified last swap");
    assert.equal(w.rpc.sentTransactions.length, 0, "no transaction may be sent");
    assert.equal(sink.where((e) => e.type === "prepared").length, 0);
    assert.equal(sink.where((e) => e.type === "submitted").length, 0);
  });
});

describe("ExecutionPipeline — salvageable path (dry-run)", () => {
  test("prepares [cuLimit, cuPrice, salvage] with no precompile and no phase-2 re-issue", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
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
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const staleRoute = new FakeRouteAdapter(async (req) => ({
      inputMint: req.inputMint.toBase58(),
      outputMint: req.outputMint.toBase58(),
      inAmount: req.amount,
      outAmount: 4_000_000_000n,
      slippageBps: req.slippageBps,
      routeData: new Uint8Array(4),
      routeAccounts: [
        {
          pubkey: getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthorityPda(VAULT_ID), true),
          isSigner: false,
          isWritable: true,
        },
      ],
      quotedAtMs: NOW() - 60_000, // 60s old > 15s policy window
      adapter: "fake",
    }));
    const { pipeline } = makePipeline({ world: w, route: staleRoute });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "route-failure");
    assert.match(out.reason ?? "", /stale|older/i);
  });

  test("missing route accounts (no vault WSOL destination) fail closed", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
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
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "route-failure");
    assert.match(out.reason ?? "", /WSOL destination/);
  });

  test("LP supply moving after the snapshot fails closed (state-changed, 7018 caught early)", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    // Deterministic drift injection (D3): the claims snapshotter already
    // produced an artifact pinning the ORIGINAL supply (the stub reports
    // world.lpSupply); the LP mint supply then moves BEFORE preparation
    // continues. The pipeline's re-pin read (which follows the snapshot)
    // must observe the drift and fail closed — the on-chain 7018 check,
    // caught early.
    const buf = new Uint8Array(82);
    const view = new DataView(buf.buffer);
    view.setBigUint64(36, 9_500_000n, true);
    view.setUint8(44, 9);
    view.setUint8(45, 1);
    w.rpc.setAccount(w.lpMint, buf, TOKEN_PROGRAM);
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "state-changed");
    assert.match(out.reason ?? "", /supply/);
  });

  test("salvor without LP fails closed (missing-accounts)", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 0n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "missing-accounts");
    assert.match(out.reason ?? "", /no LP/);
  });

  test("certification-ready without an AttestationSource is config-invalid (no silent skip)", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
    });
    const { pipeline } = makePipeline({ world: w });
    const out = await pipeline.prepare({
      envelope: certificationReadyEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "config-invalid");
    assert.match(out.reason ?? "", /AttestationSource/);
  });
});

describe("ExecutionPipeline — simulation + submission", () => {
  test("simulate passes on a healthy world and carries unitsConsumed", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const { pipeline } = makePipeline({ world: w });
    const prep = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.ok(prep.ok);
    const sim = await pipeline.simulate(prep.prepared!);
    assert.ok(sim.ok);
    assert.equal(sim.simulation?.unitsConsumed, 424_242);
  });

  test("a failing simulation decodes the GraveYield error and refuses", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    w.rpc.simulationResult = {
      err: { InstructionError: [2, { Custom: 7002 }] }, // EligibilityCertExpired
      logs: ["Program log: expired"],
      unitsConsumed: 100,
    };
    const { pipeline } = makePipeline({ world: w });
    const prep = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.ok(prep.ok, `prepare failed: ${prep.failureClass} ${prep.reason}`);
    const sim = await pipeline.simulate(prep.prepared!);
    assert.equal(sim.ok, false);
    assert.equal(sim.failureClass, "simulation-failed");
    assert.match(sim.reason ?? "", /EligibilityCertExpired/);
  });

  test("live mode submits through the injected sender and reads the salvage receipt", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
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
      snapshotter: stubSnapshotter(w),
      txSender: w.rpc.fakeSend.bind(w.rpc),
      now: NOW,
    });
    const prep = await live.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
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
    assert.equal(
      r.lpHolderAmountLamports + r.salvorAmountLamports + r.protocolAmountLamports,
      r.totalProceedsLamports,
    );
  });

  test("submitted fee respects the D3 budget (price ix ≤ plan.max × cuLimit)", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const live = new ExecutionPipeline({
      client: w.client,
      policy: policy({ mode: "live" }),
      liveEnablement: { enabled: true, acknowledgedBy: "test-operator" },
      routeAdapter: healthyRouteAdapter(),
      eventSink: new MemoryEventSink(),
      snapshotter: stubSnapshotter(w),
      txSender: w.rpc.fakeSend.bind(w.rpc),
      now: NOW,
    });
    const prep = await live.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.ok(prep.ok);
    const p = prep.prepared!;
    // price × cuLimit ≤ 25% of the 0.36 SOL gross share (in µL).
    const budgetMicro = new BN("90000000000000"); // 0.09 SOL = 9e13 µL
    assert.ok(p.feeMicroLamportsPerCu.mul(new BN(p.computeUnitLimit)).lte(budgetMicro));
    // And the attached ix matches the plan exactly: SetComputeUnitPrice
    // data = [tag=3][u64 LE micro-lamports] (SetComputeUnitLimit = tag 2).
    const priceIx = p.tx.instructions[1]!;
    assert.equal(priceIx.data[0], 3);
    // 3.x instruction data is Uint8Array; Buffer.from copies the same bytes.
    assert.equal(
      Buffer.from(priceIx.data).readBigUInt64LE(1),
      BigInt(p.feeMicroLamportsPerCu.toString()),
    );
  });
});

// throwaway keypair shim (no secrets material in tests)
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM } from "./helpers.js";
async function KeypairShim(): Promise<Keypair> {
  return Keypair.generate();
}

// silence unused import (decodeGraveYieldErrorCode exercised indirectly via the sim path)
void decodeGraveYieldErrorCode;

// ---------------------------------------------------------------- D3 (claims
// snapshot production via the Rust CLI boundary)

describe("ExecutionPipeline — D3 claims snapshot production (Rust CLI is the sole producer)", () => {
  const MOCK_CLI = fileURLToPath(
    new URL("./fixtures/bin/mock-snapshotter-cli.mjs", import.meta.url),
  );

  test("the salvage root comes exclusively from the verified Rust claims artifact (end-to-end through the CLI boundary)", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    // A governed sink ledger + a valid D2 claims-grade artifact for the
    // world's EXACT pool/AMM/mint and holder set (fixture-grade: the SDK
    // tree is the byte-locked port of the Rust tree). The sink balance is
    // part of the 10M world supply, so the leaf set shrinks accordingly —
    // the artifact's closing identity must reconcile to the live 10M.
    const sinkOwner = new PublicKey(new Uint8Array(32).fill(0x5a));
    const sinkAccount = new PublicKey(new Uint8Array(32).fill(0x5b));
    const sinkBalance = 50_000n; // part of the 10M world supply
    const leafHolders = [
      { owner: w.holders[0]!.owner, balance: w.holders[0]!.balance },
      { owner: w.holders[1]!.owner, balance: w.holders[1]!.balance - sinkBalance },
    ];
    const ledger = buildSinkLedger({
      pool: w.poolAddress,
      amm: RAYDIUM_V4_PROGRAM_ID,
      lpMint: w.lpMint,
      entries: [{ owner: sinkOwner, tokenAccount: sinkAccount, rawBalance: sinkBalance }],
    });
    const { text: artifactText } = buildClaimsArtifact({
      pool: w.poolAddress,
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      lpMint: w.lpMint,
      snapshotSlot: FIXED_SLOT,
      holders: leafHolders,
      sinkExclusions: [{ owner: sinkOwner, balance: sinkBalance }],
      sinkLedger: { bytes: ledger.bytes, ledgerId: ledger.ledgerId },
    });
    const dir = mkdtempSync(join(tmpdir(), "gy-pipeline-d3-"));
    const ledgerPath = join(dir, "sink-ledger.json");
    const artifactPath = join(dir, "artifact.json");
    writeFileSync(ledgerPath, ledger.bytes);
    writeFileSync(artifactPath, artifactText);

    const snapshotter = new RustCliClaimsSnapshotter({
      executablePath: MOCK_CLI,
      rpcUrl: "http://127.0.0.1:8899",
      commitment: "confirmed",
      sinkLedgerPath: ledgerPath,
      timeoutMs: 10_000,
      env: { PATH: process.env["PATH"] ?? "", GY_MOCK_ARTIFACT: artifactPath },
    });
    const { pipeline, sink } = makePipeline({ world: w, snapshotter });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.ok(out.ok, `prepare failed: ${out.failureClass} ${out.reason}`);
    const json = JSON.parse(artifactText) as { merkle_root: string };
    // The root baked into the transaction IS the verified artifact's root.
    assert.equal(
      Buffer.from(out.prepared!.snapshotSummary.merkleRoot).toString("hex"),
      json.merkle_root,
    );
    assert.equal(out.prepared!.snapshotSummary.totalSupply, 10_000_000n);
    assert.equal(out.prepared!.snapshotSummary.holderCount, leafHolders.length);
    assert.equal(
      out.prepared!.snapshotSummary.artifactSha256,
      createHash("sha256").update(artifactText, "utf8").digest("hex"),
    );
    // Structured operational reporting carries the artifact digest.
    const preparedEvent = sink.events.find((e) => e.type === "prepared");
    assert.ok(preparedEvent);
    assert.equal(
      preparedEvent.data["artifactSha256"],
      out.prepared!.snapshotSummary.artifactSha256,
    );
    assert.ok("snapshotSlot" in preparedEvent.data);
  });

  test("a snapshotter failure is terminal for the attempt (snapshot-producer) — no TS fallback", async () => {
    const w = await buildWorld({
      wsolReserve: 5_000_000_000n,
      memecoinReserve: 1_000_000n,
      lpSupply: 10_000_000n,
      salvorLpAmount: 1_000_000n,
      certExpiresAt: NOW_SEC + 3_600n,
    });
    const { pipeline, sink } = makePipeline({
      world: w,
      snapshotter: stubSnapshotter(w, {
        failWith: new ClaimsSnapshotterError(
          "nonzero-exit",
          "grave-snapshotter-cli exited with code 1",
          {
            exitCode: 1,
          },
        ),
      }),
    });
    const out = await pipeline.prepare({
      envelope: salvageableEnvelope(w),
      salvor: w.salvor.publicKey,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failureClass, "snapshot-producer");
    // Terminal: not in the retryable set.
    const { isRetryable } = await import("../src/events.js");
    assert.equal(isRetryable("snapshot-producer"), false);
    // Structured reporting identifies the producer + failure category.
    const event = sink.events.find((e) => e.type === "revalidation-rejected");
    assert.ok(event);
    assert.equal(event.data["producer"], "grave-snapshotter-cli");
    assert.equal(event.data["producerFailureCategory"], "nonzero-exit");
    assert.equal(event.data["pool"], w.poolAddress.toBase58());
  });

  test("the live preparation path cannot obtain a root from the TypeScript snapshot producer (static source gate)", async () => {
    // fleet-core/src/pipeline.ts must not reference the SDK's TS snapshot
    // producer AT ALL: no snapshotLpHolders, no SnapshotResult.
    const source = readFileSync(
      fileURLToPath(new URL("../src/pipeline.ts", import.meta.url)),
      "utf8",
    );
    assert.ok(!source.includes("snapshotLpHolders"), "pipeline must not import snapshotLpHolders");
    assert.ok(!source.includes("SnapshotResult"), "pipeline must not use SnapshotResult");
    // The root must be taken from the verified artifact material.
    assert.match(source, /snapshot\.root/);
    assert.match(source, /this\.snapshotter\.produceSnapshot/);
  });
});
