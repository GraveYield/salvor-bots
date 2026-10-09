// SPDX-License-Identifier: Apache-2.0
//
// The shared execution pipeline (FLEET-M1).
//
// Conservative / Sniper / Experimental ALL submit through this class —
// there is no second transaction-construction path. What it guarantees
// for every executor, in every mode:
//
//   1. Fresh on-chain revalidation BEFORE anything is built
//      (`revalidateOpportunity` — the envelope's state is never trusted).
//   2. A live-derived 13-account Raydium V4 set (`deriveV4CpiAccounts`).
//   3. A complete LP-holder snapshot via the SDK (completeness-gated),
//      with the LIVE LP supply re-pinned against the snapshot before a
//      transaction may be built (the on-chain 7018 check, caught early).
//   4. A real route quote through the shared RouteAdapter, freshness-
//      checked, with the min-output floor re-derived by the estimator
//      (never the adapter's own floor), slippage only ever tightened
//      below the live config max.
//   5. The D3 fee plan (`policy.planFees` → SDK `derivePriorityFeePlan`)
//      with the Charter guard applied again at assembly AND at submit.
//   6. Dynamically pinned attestation instruction indices: the precompile
//      is built with the phase-2 instruction's FINAL index (the on-chain
//      load_instruction_pair validator requires msg_ix_index ==
//      current_index — compute-budget ixs shift it; FLEET-M0 F3).
//   7. Full-transaction simulation against current state with GraveYield
//      error decoding BEFORE any submission.
//   8. Dry-run / simulation modes NEVER submit; `live` requires explicit
//      enablement (validated in `validatePolicy`) and a signer.
//
// What it deliberately does NOT do: it does not pick strategies (that
// is the policy), does not track history (the store), and does not
// observe (the Monitor).

import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  GraveYieldClient,
  buildAttestationMessage,
  buildEd25519VerifyInstruction,
  buildEvaluatePoolPhase2Ix,
  buildSalvagePoolIx,
  fetchSlotHash,
  fetchV4Pool,
  IX_DATA_MSG_OFFSET,
  RAYDIUM_V4_PROGRAM_ID,
  decodeSalvageReceipt,
  decodeGraveYieldError,
  decodeGraveYieldErrorCode,
  simulateTransaction,
  snapshotLpHolders,
  salvageReceiptPda,
  eligibilityCertPda,
  readLpMintSupply,
  WSOL_MINT,
  type SnapshotResult,
  type SdkSimulationResult,
} from "@graveyield/sdk";

import { estimateSalvageEconomics, type EconomicEstimate } from "./estimator.js";
import type { ExecutionPolicy, LiveEnablement } from "./policy.js";
import { validatePolicy, planFees } from "./policy.js";
import { makeEvent, type FleetEventSink, type FailureClass } from "./events.js";
import { revalidateOpportunity, type RevalidatedOpportunity } from "./revalidate.js";
import { deriveV4CpiAccounts, toRemainingAccounts, MissingAccountsError } from "./raydiumAccounts.js";
import type { RouteAdapter, RouteQuote } from "./route.js";
import { RouteError } from "./route.js";
import type { OpportunityEnvelope } from "./envelope.js";

/** Injectable transaction sender (tests replace the network call). */
export type TxSender = (
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
) => Promise<string>;

/** Default sender — confirm-once via web3.js. */
export const defaultTxSender: TxSender = (connection, tx, signers) =>
  import("@solana/web3.js").then(({ sendAndConfirmTransaction }) =>
    sendAndConfirmTransaction(connection, tx, signers),
  );

/** A C1 attestation source — the executor NEVER holds the oracle key itself. */
export interface AttestationSource {
  /**
   * Sign the 112-byte last-swap attestation message with the CURRENT
   * activity oracle. Tests use a local keypair; production points at
   * the indexer's oracle service. Returns the 64-byte signature and the
   * oracle's public key (the pipeline does not assume which key it is —
   * the on-chain validator binds it to ProtocolConfig.activity_oracle).
   */
  signAttestation(message: Uint8Array): Promise<{ signature: Uint8Array; oraclePublicKey: PublicKey }>;
}

/** A local oracle keypair source (tests + devnet drill). */
export class LocalAttestationSource implements AttestationSource {
  constructor(private readonly oracle: Keypair) {}
  async signAttestation(message: Uint8Array) {
    const nacl = (await import("tweetnacl")).default;
    const signature = nacl.sign.detached(Buffer.from(message), Buffer.from(this.oracle.secretKey));
    return { signature, oraclePublicKey: this.oracle.publicKey };
  }
}

/** The salvage inputs the pipeline assembles from live state. */
export interface SalvageContext {
  revalidated: RevalidatedOpportunity;
  envelope: OpportunityEnvelope;
  /** Salvor signer's public key (fee payer + LP burn source owner). */
  salvor: PublicKey;
  route: RouteQuote;
  snapshot: SnapshotResult;
  estimate: EconomicEstimate;
}

/** A fully prepared transaction, ready for the simulate/submit gates. */
export interface PreparedTransaction {
  kind: "certify-and-salvage" | "salvage-only";
  tx: Transaction;
  /** Scanner instruction index (precompile pin) — certify path only. */
  scannerIxIndex: number | null;
  salvageIxIndex: number;
  /** Attestation material (certify path only). */
  attestationMessage: Uint8Array | null;
  attestationSignature: Uint8Array | null;
  issuedSlot: number | null;
  feeMicroLamportsPerCu: BN;
  computeUnitLimit: number;
  /** The snapshot material baked into the tx (for the Monitor + restarts). */
  snapshotSummary: {
    merkleRoot: Uint8Array;
    totalSupply: bigint;
    salvorLpAmount: bigint;
    holderCount: number;
    snapshotSlot: number;
  };
  minQuoteOutputLamports: bigint;
  /** The route actually embedded (post-validation). */
  route: RouteQuote;
}

/** Pipeline result for one attempted execution. */
export interface PipelineOutcome {
  ok: boolean;
  stage: "revalidated" | "economic-reject" | "prepared" | "simulated" | "submitted" | "confirmed" | "failed";
  failureClass?: FailureClass;
  reason?: string;
  prepared?: PreparedTransaction;
  simulation?: SdkSimulationResult;
  signature?: string;
  /** The economics verdict computed during preparation (prepared stage). */
  estimate?: EconomicEstimate;
  /** Verified on-chain salvage receipt (live mode, post-confirmation). */
  receipt?: {
    totalProceedsLamports: bigint;
    salvorAmountLamports: bigint;
    lpHolderAmountLamports: bigint;
    protocolAmountLamports: bigint;
    slot: bigint;
  } | null;
}

/** Pipeline construction options. */
export interface PipelineOptions {
  client: GraveYieldClient;
  policy: ExecutionPolicy;
  /** Explicit enablement for live mode (required when mode = "live"). */
  liveEnablement?: LiveEnablement | null;
  routeAdapter: RouteAdapter;
  eventSink: FleetEventSink;
  /** Transaction sender — injectable for tests. */
  txSender?: TxSender;
  /** Now (epoch ms) — injectable for deterministic tests. */
  now?: () => number;
}

/**
 * The shared pipeline. One instance per bot; the store/lease layer is
 * the CALLER's responsibility (the pipeline is stateless between runs).
 */
export class ExecutionPipeline {
  readonly client: GraveYieldClient;
  readonly policy: ExecutionPolicy;
  private readonly sender: TxSender;
  private readonly routes: RouteAdapter;
  private readonly sink: FleetEventSink;
  private readonly now: () => number;

  constructor(opts: PipelineOptions) {
    // validatePolicy throws on any global-invariant breach (live mode
    // without explicit enablement, bad margins, negative minimums…).
    this.policy = validatePolicy(opts.policy, opts.liveEnablement ?? null);
    this.client = opts.client;
    this.routes = opts.routeAdapter;
    this.sink = opts.eventSink;
    this.sender = opts.txSender ?? defaultTxSender;
    this.now = opts.now ?? Date.now;
  }

  private emit(type: Parameters<typeof makeEvent>[0]["type"], data: Record<string, unknown>, extra?: Partial<Parameters<typeof makeEvent>[0]>): void {
    this.sink.emit(
      makeEvent({
        botId: this.policy.botId,
        type,
        data,
        ...(extra ?? {}),
      }),
    );
  }

  // ------------------------------------------------------------ economics

  /**
   * Freshly read the pool + run the shared estimator + fetch a route
   * quote. Shared by both executor paths — economics are computed ONCE,
   * from current data, with exact integer math.
   */
  async estimateCurrent(opts: {
    revalidated: RevalidatedOpportunity;
    salvor: PublicKey;
    salvorLpAmount: bigint;
    envelope: OpportunityEnvelope;
  }): Promise<{ estimate: EconomicEstimate; route: RouteQuote; quoteIsFresh: boolean }> {
    const rv = opts.revalidated;
    const memecoinMint = rv.memecoinMint;

    // Orientation-correct route quote: memecoin → WSOL.
    const effectiveSlippage =
      this.policy.slippageBpsOverride !== undefined && this.policy.slippageBpsOverride !== null
        ? Math.min(this.policy.slippageBpsOverride, rv.vaultConfig.maxSlippageBps)
        : rv.vaultConfig.maxSlippageBps;
    const vaultAuthority = await this.vaultAuthorityPda();
    const vaultWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthority, true);

    const route = await this.routes.quote({
      inputMint: memecoinMint,
      outputMint: WSOL_MINT,
      // Quote for the FULL memecoin reserve share the pool would pay on
      // a full-snapshot burn — the estimator scales linearly to the
      // salvor's actual burn share. Quoting the full reserve keeps one
      // quote reusable across salvor sizes and matches the pool-implied
      // reference the on-chain ceiling uses.
      amount: rv.coinIsWsol ? rv.pcReserve : rv.coinReserve,
      slippageBps: effectiveSlippage,
      destinationTokenAccount: vaultWsolAta,
      authority: vaultAuthority,
    });

    const quoteAgeMs = this.now() - route.quotedAtMs;
    const quoteIsFresh = quoteAgeMs <= this.policy.quoteMaxAgeMs;

    // Estimator inputs — pass 1 solves the D3 fee plan from the gross
    // share (cost-independent), pass 2 prices the costs in exactly.
    const estimatorPoolInputs = {
      coinReserve: rv.coinReserve,
      pcReserve: rv.pcReserve,
      lpSupply: rv.lpSupply,
      coinMint: rv.pool.baseMint.toBase58(),
      pcMint: rv.pool.quoteMint.toBase58(),
      wsolMint: WSOL_MINT.toBase58(),
    };
    const estimatorConfigInputs = {
      salvorShareBps: rv.vaultConfig.salvorShareBps,
      maxSlippageBps: rv.vaultConfig.maxSlippageBps,
      jupiterDustThresholdLamports: rv.vaultConfig.jupiterDustThresholdLamports,
    };
    const estimatorCostInputsBase = {
      // The certify+salvage bundle is ONE atomic transaction — one
      // signature per attempt (phase-1 costs were sunk by the Scout).
      signatureCount: 1,
      frontedRentLamports: this.policy.frontedRentLamports ?? 0n,
      expectedFailureCostLamports: this.policy.expectedFailureCostLamports ?? 0n,
    };

    // Pass 1: gross share (fee budget zeroed — the share is cost-free).
    const grossPass = estimateSalvageEconomics({
      pool: estimatorPoolInputs,
      route: { quoteInAmount: route.inAmount, quoteOutLamports: route.outAmount },
      position: { salvorLpAmount: opts.salvorLpAmount },
      config: estimatorConfigInputs,
      costs: { ...estimatorCostInputsBase, priorityFeeBudgetLamports: 0n },
      slippageBpsOverride: this.policy.slippageBpsOverride ?? null,
      minNetProfitLamports: 0n,
    });
    if (grossPass.status === "reject") {
      return { estimate: grossPass, route, quoteIsFresh };
    }

    // D3 fee plan from the expected profit (margin × gross share),
    // bounded by the LIVE ProtocolConfig ceiling.
    const plan = planFees({
      policy: this.policy,
      expectedProfitLamports: new BN((grossPass.salvorGrossShareLamports ?? 0n).toString(10)),
      protocolCeilingMicroLamportsPerCu: new BN(rv.vaultConfig.maxPriorityFeeCeilingLamports.toString(10)),
    });
    const priorityFeeBudgetLamports = BigInt(
      plan.maxMicroLamportsPerCu.mul(new BN(this.policy.computeUnitLimit)).div(new BN(1_000_000)).toString(10),
    );

    // Pass 2: the full economics with the real fee budget.
    const estimate = estimateSalvageEconomics({
      pool: estimatorPoolInputs,
      route: { quoteInAmount: route.inAmount, quoteOutLamports: route.outAmount },
      position: { salvorLpAmount: opts.salvorLpAmount },
      config: estimatorConfigInputs,
      costs: { ...estimatorCostInputsBase, priorityFeeBudgetLamports },
      slippageBpsOverride: this.policy.slippageBpsOverride ?? null,
      minNetProfitLamports: this.policy.minNetProfitLamports,
    });

    return { estimate, route, quoteIsFresh };
  }

  private async vaultAuthorityPda(): Promise<PublicKey> {
    // seeds ["vault_authority"] under the vault program (SDK's pdas.ts).
    const { vaultAuthorityPda } = await import("@graveyield/sdk");
    return vaultAuthorityPda(this.client.graveVaultProgramId);
  }

  // ------------------------------------------------------------ prepare

  /**
   * Read the salvor's LP token account balance (the burn source).
   * Rejects when the ATA is missing or empty — fail closed.
   */
  async readSalvorLpBalance(salvor: PublicKey, lpMint: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(lpMint, salvor);
    const info = await this.client.connection.getAccountInfo(ata);
    if (!info) return 0n;
    // SPL token account: amount @ 64 (u64 LE).
    const data = info.data;
    if (data.length < 72) throw new Error(`salvor LP ATA ${ata.toBase58()} too short`);
    return data.readBigUInt64LE(64);
  }

  /**
   * Revalidate → derive accounts → snapshot → quote → estimate →
   * assemble. Everything up to (but not including) simulation.
   */
  async prepare(opts: {
    envelope: OpportunityEnvelope;
    salvor: PublicKey;
    attestationSource?: AttestationSource;
  }): Promise<PipelineOutcome> {
    const { envelope, salvor } = opts;
    const identity = envelope.identity;
    const amm = new PublicKey(identity.ammProgramId);
    const pool = new PublicKey(identity.poolAddress);

    // 1. Revalidate EVERYTHING against the live chain.
    let rv: RevalidatedOpportunity;
    try {
      const outcome = await revalidateOpportunity({
        client: this.client,
        ammProgramId: amm,
        poolAddress: pool,
        minCertRemainingMs: this.policy.minCertRemainingMs,
        options: { now: this.now },
      });
      if (!outcome.ok) {
        this.emit("revalidation-rejected", { reason: outcome.reason }, {
          identity,
          failureClass: outcome.failureClass,
        });
        return { ok: false, stage: "revalidated", failureClass: outcome.failureClass, reason: outcome.reason };
      }
      rv = outcome.opportunity;
    } catch (err) {
      return { ok: false, stage: "revalidated", failureClass: "transient-rpc", reason: `revalidation threw: ${String(err)}` };
    }

    // Strategy filter: kind acceptance.
    if (!this.policy.accepts.kinds.includes(rv.kind)) {
      const reason = `strategy does not accept kind "${rv.kind}" (envelope said "${envelope.kind}")`;
      this.emit("revalidation-rejected", { reason }, { identity, failureClass: "stale-opportunity" });
      return { ok: false, stage: "revalidated", failureClass: "stale-opportunity", reason };
    }

    // 2. Live-derived CPI account set.
    let derived;
    try {
      derived = await deriveV4CpiAccounts(this.client.connection, rv.pool);
    } catch (err) {
      const failureClass: FailureClass =
        err instanceof MissingAccountsError ? "missing-accounts" : "transient-rpc";
      this.emit("revalidation-rejected", { reason: String(err) }, { identity, failureClass });
      return { ok: false, stage: "revalidated", failureClass, reason: String(err) };
    }

    // 3. Salvor LP balance (burn source) — fail closed on empty.
    const salvorLpAmount = await this.readSalvorLpBalance(salvor, rv.pool.lpMint);
    if (salvorLpAmount === 0n) {
      const reason = `salvor holds no LP for pool ${pool.toBase58()} — nothing to burn`;
      this.emit("revalidation-rejected", { reason }, { identity, failureClass: "missing-accounts" });
      return { ok: false, stage: "revalidated", failureClass: "missing-accounts", reason };
    }

    // 4. Complete LP-holder snapshot (SDK; completeness-gated) + live
    //    supply re-pin (the on-chain 7018 check, caught early).
    let snapshot: SnapshotResult;
    try {
      snapshot = await snapshotLpHolders(this.client.connection, pool);
    } catch (err) {
      this.emit("revalidation-rejected", { reason: String(err) }, { identity, failureClass: "snapshot-incomplete" });
      return { ok: false, stage: "revalidated", failureClass: "snapshot-incomplete", reason: String(err) };
    }
    const liveSupply = await readLpMintSupply(this.client.connection, rv.pool.lpMint);
    if (liveSupply !== BigInt(snapshot.snapshot.totalSupply.toString(10))) {
      const reason = `LP supply moved between snapshot and preparation (${snapshot.snapshot.totalSupply.toString()} → ${liveSupply.toString()}) — re-snapshotting is required`;
      this.emit("revalidation-rejected", { reason }, { identity, failureClass: "state-changed" });
      return { ok: false, stage: "revalidated", failureClass: "state-changed", reason };
    }

    // 5. Route + economics (fresh).
    let quote: RouteQuote;
    let estimate: EconomicEstimate;
    let quoteIsFresh: boolean;
    try {
      const econ = await this.estimateCurrent({ revalidated: rv, salvor, salvorLpAmount, envelope });
      quote = econ.route;
      estimate = econ.estimate;
      quoteIsFresh = econ.quoteIsFresh;
    } catch (err) {
      const failureClass: FailureClass = err instanceof RouteError ? "route-failure" : "transient-route";
      this.emit("revalidation-rejected", { reason: String(err) }, { identity, failureClass });
      return { ok: false, stage: "revalidated", failureClass, reason: String(err) };
    }
    if (!quoteIsFresh) {
      const reason = `route quote older than ${this.policy.quoteMaxAgeMs}ms — refusing to use it`;
      this.emit("revalidation-rejected", { reason }, { identity, failureClass: "route-failure" });
      return { ok: false, stage: "revalidated", failureClass: "route-failure", reason };
    }
    if (estimate.status === "reject") {
      const failureClass: FailureClass = estimate.failureClass ?? "economic-unresolvable";
      const reason = estimate.reason ?? "economics unresolvable";
      this.emit("economic-reject", { reason }, { identity, failureClass });
      return { ok: false, stage: "economic-reject", failureClass, reason };
    }
    if ((estimate.netProfitLamports ?? 0n) < this.policy.minNetProfitLamports) {
      const reason = `net profit ${estimate.netProfitLamports?.toString()} below minimum ${this.policy.minNetProfitLamports.toString()}`;
      this.emit("economic-reject", { reason }, { identity, failureClass: "economic-insufficient" });
      return { ok: false, stage: "economic-reject", failureClass: "economic-insufficient", reason };
    }
    this.emit("economic-pass", {
      netProfitLamports: estimate.netProfitLamports?.toString(),
      grossProceedsWsolLamports: estimate.grossProceedsWsolLamports?.toString(),
      minQuoteOutputLamports: estimate.minQuoteOutputLamports?.toString(),
      effectiveSlippageBps: estimate.effectiveSlippageBps,
      swapLegBelowDust: estimate.swapLegBelowDust,
    }, { identity });

    // 6. Route validation — untrusted until proven otherwise.
    const routeProblem = validateRouteForSalvage(quote, {
      inputMint: rv.memecoinMint,
      outputMint: WSOL_MINT,
      expectedOutLamports: estimate.minQuoteOutputLamports ?? 0n,
      vaultAuthority: await this.vaultAuthorityPda(),
      vaultWsolAta: getAssociatedTokenAddressSync(WSOL_MINT, await this.vaultAuthorityPda(), true),
    });
    if (routeProblem) {
      this.emit("revalidation-rejected", { reason: routeProblem }, { identity, failureClass: "route-failure" });
      return { ok: false, stage: "revalidated", failureClass: "route-failure", reason: routeProblem };
    }

    // 7. Assemble the transaction for the CURRENT kind.
    const feePlan = planFees({
      policy: this.policy,
      expectedProfitLamports: new BN((estimate.salvorGrossShareLamports ?? 0n).toString(10)),
      protocolCeilingMicroLamportsPerCu: new BN(rv.vaultConfig.maxPriorityFeeCeilingLamports.toString(10)),
    });

    const salvageIxInput = {
      vaultProgramId: this.client.graveVaultProgramId,
      scannerProgramId: this.client.graveScannerProgramId,
      ammProgramId: amm,
      poolAddress: pool,
      salvor,
      salvorLpTokenAccount: getAssociatedTokenAddressSync(rv.pool.lpMint, salvor),
      lpMint: rv.pool.lpMint,
      memecoinMint: rv.memecoinMint,
      lpSnapshotMerkleRoot: snapshot.tree.root(),
      lpTotalSupplyAtSnapshot: BigInt(snapshot.snapshot.totalSupply.toString(10)),
      salvorLpAmount,
      minQuoteOutputLamports: estimate.minQuoteOutputLamports ?? 0n,
      maxSlippageBpsOverride: this.policy.slippageBpsOverride ?? null,
      jupiterRouteData: quote.routeData,
      jupiterRouteAccountsLen: quote.routeAccounts.length,
      raydiumV4RemainingAccounts: toRemainingAccounts(derived),
      jupiterRouteAccounts: quote.routeAccounts,
    };

    let prepared: PreparedTransaction;
    if (rv.kind === "salvageable") {
      prepared = await this.assembleSalvageOnlyTx({ rv, salvageIxInput, feePrice: feePlan.maxMicroLamportsPerCu, snapshot, estimate, route: quote });
    } else {
      // certification-ready → certify + salvage in ONE atomic tx.
      if (!opts.attestationSource) {
        const reason = "certification-ready requires an AttestationSource (oracle-signed C1) — none configured";
        this.emit("revalidation-rejected", { reason }, { identity, failureClass: "config-invalid" });
        return { ok: false, stage: "revalidated", failureClass: "config-invalid", reason };
      }
      prepared = await this.assembleCertifyAndSalvageTx({
        rv,
        salvageIxInput,
        feePrice: feePlan.maxMicroLamportsPerCu,
        snapshot,
        estimate,
        route: quote,
        attestationSource: opts.attestationSource,
      });
    }

    this.emit("prepared", {
      kind: prepared.kind,
      scannerIxIndex: prepared.scannerIxIndex,
      salvageIxIndex: prepared.salvageIxIndex,
      feeMicroLamportsPerCu: prepared.feeMicroLamportsPerCu.toString(),
      computeUnitLimit: prepared.computeUnitLimit,
      holderCount: prepared.snapshotSummary.holderCount,
      snapshotSupply: prepared.snapshotSummary.totalSupply.toString(),
      salvorLpAmount: prepared.snapshotSummary.salvorLpAmount.toString(),
      minQuoteOutputLamports: prepared.minQuoteOutputLamports.toString(),
      routeAccounts: prepared.route.routeAccounts.length,
    }, { identity });

    return { ok: true, stage: "prepared", prepared, estimate };
  }

  /** [cuLimit, (cuPrice), salvage] — the already-certified path. */
  private async assembleSalvageOnlyTx(opts: {
    rv: RevalidatedOpportunity;
    salvageIxInput: Parameters<typeof buildSalvagePoolIx>[0];
    feePrice: BN;
    snapshot: SnapshotResult;
    estimate: EconomicEstimate;
    route: RouteQuote;
  }): Promise<PreparedTransaction> {
    const salvageIx = buildSalvagePoolIx(opts.salvageIxInput);
    const tx = new Transaction();
    const computeIxs = await this.computeIxsFor(opts.feePrice);
    for (const ix of computeIxs) tx.add(ix);
    tx.add(salvageIx);
    return {
      kind: "salvage-only",
      tx,
      scannerIxIndex: null,
      salvageIxIndex: computeIxs.length,
      attestationMessage: null,
      attestationSignature: null,
      issuedSlot: null,
      feeMicroLamportsPerCu: opts.feePrice,
      computeUnitLimit: this.policy.computeUnitLimit,
      snapshotSummary: {
        merkleRoot: opts.snapshot.tree.root(),
        totalSupply: BigInt(opts.snapshot.snapshot.totalSupply.toString(10)),
        salvorLpAmount: BigInt(opts.salvageIxInput.salvorLpAmount.toString()),
        holderCount: opts.snapshot.snapshot.holders.length,
        snapshotSlot: opts.snapshot.snapshotSlot,
      },
      minQuoteOutputLamports: opts.estimate.minQuoteOutputLamports ?? 0n,
      route: opts.route,
    };
  }

  /**
   * [cuLimit, (cuPrice), precompile(pinned), phase2, salvage] — the
   * certification-ready path. The cert is minted and consumed in the
   * SAME transaction, so the 1h TTL cannot race between separate txs.
   */
  private async assembleCertifyAndSalvageTx(opts: {
    rv: RevalidatedOpportunity;
    salvageIxInput: Parameters<typeof buildSalvagePoolIx>[0];
    feePrice: BN;
    snapshot: SnapshotResult;
    estimate: EconomicEstimate;
    route: RouteQuote;
    attestationSource: AttestationSource;
  }): Promise<PreparedTransaction> {
    const { rv } = opts;
    const connection = this.client.connection;
    const issuedSlot = await connection.getSlot();
    const slotHash = await fetchSlotHash(connection, issuedSlot);
    if (!slotHash) {
      throw new Error(`slot hash unavailable for slot ${issuedSlot} — attestation cannot be anchored`);
    }

    // The last-swap timestamp must be REAL: re-derive from Raydium V4
    // history (SDK, fail-closed) — never from the envelope.
    const { deriveLastSwapV4 } = await import("@graveyield/sdk");
    const lastSwap = await deriveLastSwapV4(connection, rv.ammProgramId, rv.poolAddress);
    if (!lastSwap) {
      throw new Error(
        `cannot certify ${rv.poolAddress.toBase58()}: last-swap derivation unavailable (never swapped or incomplete history)`,
      );
    }

    const attestationMessage = buildAttestationMessage({
      ammProgramId: RAYDIUM_V4_PROGRAM_ID,
      poolAddress: rv.poolAddress,
      lastSwapUnixTs: lastSwap.lastSwapUnixTs,
      issuedSlot,
      slotHash,
    });
    const { signature: attestationSignature, oraclePublicKey } =
      await opts.attestationSource.signAttestation(attestationMessage);

    const phase2 = buildEvaluatePoolPhase2Ix({
      scannerProgramId: this.client.graveScannerProgramId,
      ammProgramId: rv.ammProgramId,
      poolAddress: rv.poolAddress,
      msg: attestationMessage,
      writer: opts.salvageIxInput.salvor,
    });

    const computeIxs = await this.computeIxsFor(opts.feePrice);
    // DYNAMIC INDEX PIN: precompile references the phase-2 ix at its
    // FINAL transaction index (compute ixs shift it — F3).
    const scannerIxIndex = computeIxs.length + 1;
    const precompileIx = buildEd25519VerifyInstruction({
      signature: attestationSignature,
      oraclePublicKey,
      message: attestationMessage,
      scannerInstructionIndex: scannerIxIndex,
      messageAddressOffset: IX_DATA_MSG_OFFSET,
    });
    const salvageIx = buildSalvagePoolIx(opts.salvageIxInput);

    const tx = new Transaction();
    for (const ix of computeIxs) tx.add(ix);
    tx.add(precompileIx);
    tx.add(phase2);
    tx.add(salvageIx);
    // Assert the pin matches the assembled layout before returning.
    if (scannerIxIndex !== computeIxs.length + 1 || tx.instructions[scannerIxIndex] !== phase2) {
      throw new Error("attestation index pin drifted from the assembled transaction layout");
    }

    return {
      kind: "certify-and-salvage",
      tx,
      scannerIxIndex,
      salvageIxIndex: scannerIxIndex + 1,
      attestationMessage,
      attestationSignature,
      issuedSlot,
      feeMicroLamportsPerCu: opts.feePrice,
      computeUnitLimit: this.policy.computeUnitLimit,
      snapshotSummary: {
        merkleRoot: opts.snapshot.tree.root(),
        totalSupply: BigInt(opts.snapshot.snapshot.totalSupply.toString(10)),
        salvorLpAmount: BigInt(opts.salvageIxInput.salvorLpAmount.toString()),
        holderCount: opts.snapshot.snapshot.holders.length,
        snapshotSlot: opts.snapshot.snapshotSlot,
      },
      minQuoteOutputLamports: opts.estimate.minQuoteOutputLamports ?? 0n,
      route: opts.route,
    };
  }

  /**
   * Compute-budget instructions. The limit is ALWAYS set exactly once
   * (salvage bundles are large); the price only when > 0 — a zero fee
   * skips the price ix entirely (a zero priority fee trivially
   * satisfies the Charter). Any non-zero fee goes through the SDK's
   * charterGuard, which throws before anything reaches the network if
   * it exceeds the on-chain ceiling. The SDK call supplies ONLY the
   * price (no duplicate limit ix).
   */
  private async computeIxsFor(feePrice: BN): Promise<TransactionInstruction[]> {
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.policy.computeUnitLimit }),
    ];
    if (feePrice.gt(new BN(0))) {
      ixs.push(...(await this.client.computeBudgetIxs({ lamportsPerCu: feePrice })));
    }
    return ixs;
  }

  // -------------------------------------------------- simulate + submit

  /** Simulate a prepared transaction against current state. */
  async simulate(prepared: PreparedTransaction, identity?: import("./envelope.js").FleetOpportunityIdentity): Promise<PipelineOutcome> {
    // A valid recent blockhash is required for simulation; fetch one now.
    const { blockhash } = await this.client.connection.getLatestBlockhash();
    prepared.tx.recentBlockhash = blockhash;
    if (prepared.feeMicroLamportsPerCu.gt(new BN(0))) {
      // Belt-and-braces Charter guard at the gate (the SDK's
      // computeBudgetIxs already checked the attached price).
      const rejection = await this.client.charterGuard({ feeLamportsPerCu: prepared.feeMicroLamportsPerCu });
      if (rejection) {
        this.emit("simulation-failed", { reason: rejection }, { identity, failureClass: "charter-refusal" });
        return { ok: false, stage: "failed", failureClass: "charter-refusal", reason: rejection };
      }
    }
    const sim = await simulateTransaction(this.client.connection, prepared.tx);
    if (!sim.ok) {
      // web3.js surfaces structured errors ({ InstructionError: [i,
      // { Custom: code }] }) — extract the custom code ourselves and
      // merge with the message-regex decoder so e.g. 7002 renders as
      // GraveVault::EligibilityCertExpired even without logs.
      const structured = extractCustomErrorCode(sim.raw.err);
      const decoded = sim.graveYieldError ?? (structured !== null ? decodeGraveYieldErrorCode(structured) : undefined);
      this.emit("simulation-failed", {
        reason: decoded ? `${decoded.program}::${decoded.name} (${decoded.hex}): ${decoded.description}` : JSON.stringify(sim.raw.err),
        logs: sim.logs ?? undefined,
      }, { identity, failureClass: "simulation-failed" });
      return { ok: false, stage: "failed", failureClass: "simulation-failed", reason: decoded?.name ?? "simulation error", simulation: sim };
    }
    this.emit("simulated", { unitsConsumed: sim.unitsConsumed }, { identity });
    return { ok: true, stage: "simulated", prepared, simulation: sim };
  }

  /**
   * Submit + confirm. Requires live mode — a hard THROW: dry-run and
   * simulation modes can never reach the network through this class,
   * not even by calling it directly.
   */
  async submit(opts: {
    prepared: PreparedTransaction;
    signer: Keypair;
    identity?: import("./envelope.js").FleetOpportunityIdentity;
  }): Promise<PipelineOutcome> {
    if (this.policy.mode !== "live") {
      this.emit("error", {
        reason: `mode "${this.policy.mode}" never submits — flip to live with explicit operator enablement`,
      }, { identity: opts.identity, failureClass: "config-invalid" });
      throw new Error(
        `submit refused: mode "${this.policy.mode}" never submits — flip to live with explicit operator enablement`,
      );
    }
    const signature = await this.sender(this.client.connection, opts.prepared.tx, [opts.signer]);
    this.emit("submitted", { signature }, { identity: opts.identity });
    const receipt = await this.verifySalvageReceipt(opts.prepared, signature);
    if (receipt.ok) {
      this.emit("confirmed", {
        signature,
        totalProceedsLamports: receipt.receipt?.totalProceedsLamports.toString(),
        salvorAmountLamports: receipt.receipt?.salvorAmountLamports.toString(),
      }, { identity: opts.identity });
      return { ok: true, stage: "confirmed", signature, receipt: receipt.receipt, prepared: opts.prepared };
    }
    // The tx landed but the receipt read didn't resolve yet — report
    // submission; the Monitor owns the reconciliation retry.
    this.emit("confirmed", { signature, receiptVerification: receipt.reason }, { identity: opts.identity });
    return { ok: true, stage: "confirmed", signature, prepared: opts.prepared };
  }

  /** Read back the SalvageReceipt PDA after confirmation (best-effort; the Monitor re-checks). */
  private async verifySalvageReceipt(
    prepared: PreparedTransaction,
    _signature: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; receipt: NonNullable<PipelineOutcome["receipt"]> }> {
    try {
      // Deterministic: the salvage ix's 4th named account IS the receipt PDA.
      const salvageIx = prepared.tx.instructions[prepared.salvageIxIndex];
      if (!salvageIx) return { ok: false, reason: "salvage instruction missing from prepared tx" };
      const receiptPda = salvageIx.keys[3]?.pubkey;
      if (!receiptPda) return { ok: false, reason: "receipt PDA missing from salvage ix keys" };
      const info = await this.client.connection.getAccountInfo(receiptPda);
      if (!info) return { ok: false, reason: "salvage receipt not found yet" };
      const receipt = decodeSalvageReceipt(info.data);
      return {
        ok: true,
        receipt: {
          totalProceedsLamports: receipt.totalProceedsLamports,
          salvorAmountLamports: receipt.salvorAmountLamports,
          lpHolderAmountLamports: receipt.lpHolderAmountLamports,
          protocolAmountLamports: receipt.protocolAmountLamports,
          slot: receipt.issuedAtSlot,
        },
      };
    } catch (err) {
      return { ok: false, reason: `receipt verification failed: ${String(err)}` };
    }
  }
}

/**
 * Extract a program custom error code from web3.js's structured
 * `InstructionError` shape: `{ InstructionError: [index, { Custom: n }] }`
 * (recursing one level into nested InstructionError forms). Returns
 * `null` when the shape does not carry one.
 */
export function extractCustomErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const inner = (err as Record<string, unknown>)["InstructionError"];
  if (!Array.isArray(inner) || inner.length < 2) return null;
  let node: unknown = inner[1];
  for (let depth = 0; depth < 4 && typeof node === "object" && node !== null; depth++) {
    const rec = node as Record<string, unknown>;
    const custom = rec["Custom"];
    if (typeof custom === "number") return custom;
    const nested = rec["InstructionError"];
    if (Array.isArray(nested) && nested.length >= 2) {
      node = nested[1];
      continue;
    }
    break;
  }
  return null;
}

/**
 * Route validation — route data is UNTRUSTED until these hold:
 *   * mints match the conversion the salvage performs;
 *   * the quote's slippage bps ≤ the effective ceiling (tighten-only);
 *   * the route accounts include the vault's WSOL destination
 *     (the on-chain vetting requires it — and the vault's own accounts
 *     must not be abused as intermediate hop custody accounts);
 *   * the expected floor is achievable: quoted out ≥ the estimator's
 *     floor (with the quote's own slippage already applied upstream).
 */
export function validateRouteForSalvage(
  quote: RouteQuote,
  expect: {
    inputMint: PublicKey;
    outputMint: PublicKey;
    expectedOutLamports: bigint;
    vaultAuthority: PublicKey;
    vaultWsolAta: PublicKey;
  },
): string | null {
  if (quote.inputMint !== expect.inputMint.toBase58()) {
    return `route input mint ${quote.inputMint} != pool memecoin ${expect.inputMint.toBase58()}`;
  }
  if (quote.outputMint !== expect.outputMint.toBase58()) {
    return `route output mint ${quote.outputMint} != WSOL ${expect.outputMint.toBase58()}`;
  }
  if (quote.outAmount < expect.expectedOutLamports) {
    return `route quote out ${quote.outAmount} below the estimator's floor ${expect.expectedOutLamports}`;
  }
  const includesDestination = quote.routeAccounts.some(
    (a) => a.pubkey.equals(expect.vaultWsolAta) && a.isWritable,
  );
  if (!includesDestination) {
    return `route accounts do not include the vault WSOL destination ${expect.vaultWsolAta.toBase58()}`;
  }
  return null;
}

/** Re-export for bots that decode receipts directly. */
export { decodeSalvageReceipt, salvageReceiptPda, eligibilityCertPda, decodeGraveYieldError };
