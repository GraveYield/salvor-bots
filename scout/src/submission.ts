// SPDX-License-Identifier: Apache-2.0
//
// Scout transaction assembly — the two transactions the Scout may submit:
//
//   1. `record_launch_price`  (C2 oracle path — only when the pool's
//      LaunchPrice PDA is missing; phase 1 hard-requires that account)
//   2. `evaluate_pool_phase_1` (C1 oracle path — the on-chain evaluation
//      request that writes the EligibilityAnchor)
//
// Transaction shape (instructions in order):
//
//   0..k   compute-budget ixs (limit then price — Charter-guarded)
//   k+1    ed25519_program verify (the oracle attestation precompile)
//   k+2    GraveScanner instruction (phase1 or record_launch_price)
//
// The precompile's `message_instruction_index` MUST equal the GraveScanner
// instruction's ACTUAL index in the assembled transaction (the on-chain
// validator requires `msg_ix_index == current_index` where `current_index`
// comes from the instructions sysvar — see
// `programs/grave-scanner/src/attestation.rs::load_instruction_pair`).
// The SDK's convenience builders hardcode index 1 (bare [precompile, ix]
// transactions); because the Scout prepends compute-budget instructions,
// the precompile is built here with the dynamically computed index using
// the SDK's underlying (parameterised) precompile builders. No SDK change.
//
// The Charter guard is non-negotiable: `client.computeBudgetIxs` runs the
// SDK's charterGuard on the requested compute-unit price and throws
// before anything reaches the network if it exceeds the on-chain ceiling.

import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  GraveYieldClient,
  RAYDIUM_V4_PROGRAM_ID,
  buildAttestationMessage,
  buildEd25519VerifyInstruction,
  buildLaunchPriceEd25519VerifyInstruction,
  buildLaunchPriceMessage,
  buildEvaluatePoolPhase1Ix,
  buildRecordLaunchPriceIx,
  fetchSlotHash,
  IX_DATA_MSG_OFFSET,
  type LaunchPriceDerivation,
} from "@graveyield/sdk";

import type { FeeSettings, OracleIdentity } from "./types.js";

/** Injectable transaction sender (tests replace the network call). */
export type TxSender = (
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
) => Promise<string>;

/** Default sender — the standard web3.js confirm-once helper. */
export const defaultTxSender: TxSender = (connection, tx, signers) =>
  sendAndConfirmTransaction(connection, tx, signers);

/** Sign a message with an oracle identity (Ed25519, detached). */
export function signAttestation(message: Uint8Array, oracle: OracleIdentity): Uint8Array {
  return nacl.sign.detached(Buffer.from(message), Buffer.from(oracle.secretKey64));
}

/** Assemble [compute…, precompile, target] with the precompile index pinned. */
function assembleAttestedTransaction(
  computeIxs: TransactionInstruction[],
  precompileIx: TransactionInstruction,
  targetIx: TransactionInstruction,
): { tx: Transaction; targetIxIndex: number } {
  const targetIxIndex = computeIxs.length + 1;
  const tx = new Transaction();
  for (const ix of computeIxs) tx.add(ix);
  tx.add(precompileIx);
  tx.add(targetIx);
  return { tx, targetIxIndex };
}

/**
 * Compute-budget instructions for a Scout transaction. A zero fee skips
 * the ixs entirely (a zero priority fee trivially satisfies the Charter
 * ceiling); any other value goes through the SDK's charterGuard, which
 * throws on an over-ceiling fee before anything reaches the network.
 */
async function charterGuardedComputeIxs(
  client: GraveYieldClient,
  fee: FeeSettings,
): Promise<TransactionInstruction[]> {
  if (fee.feeLamportsPerCu.isZero()) return [];
  return client.computeBudgetIxs({
    lamportsPerCu: fee.feeLamportsPerCu,
    ...(fee.computeUnitLimit !== undefined ? { computeUnitLimit: fee.computeUnitLimit } : {}),
  });
}

/** One assembled phase-1 transaction, ready to sign + send. */
export interface Phase1TxBundle {
  tx: Transaction;
  /** The 112-byte attestation message the oracle signed. */
  attestationMessage: Uint8Array;
  /** The oracle's 64-byte signature over `attestationMessage`. */
  attestationSignature: Uint8Array;
  /** Slot at which the attestation was issued (SlotHashes-checked on chain). */
  issuedSlot: number;
  /** Index of the phase-1 instruction inside the assembled transaction. */
  phase1IxIndex: number;
}

/**
 * Build the (compute budget, C1 precompile, evaluate_pool_phase_1)
 * transaction. Throws on Charter-guard rejection.
 */
export async function buildPhase1Transaction(opts: {
  connection: Connection;
  client: GraveYieldClient;
  scannerProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Real last-swap unix timestamp from the Scout's activity record. */
  lastSwapUnixTs: number;
  oracle: OracleIdentity;
  /** Writer (signer) that pays the EligibilityAnchor rent. */
  writer: PublicKey;
  fee: FeeSettings;
}): Promise<Phase1TxBundle> {
  const issuedSlot = await opts.connection.getSlot();
  const slotHash = await fetchSlotHash(opts.connection, issuedSlot);
  if (!slotHash) {
    throw new Error(
      `could not fetch slot hash for issuance slot ${issuedSlot} — attestation cannot be anchored`,
    );
  }

  const attestationMessage = buildAttestationMessage({
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    poolAddress: opts.poolAddress,
    lastSwapUnixTs: opts.lastSwapUnixTs,
    issuedSlot,
    slotHash,
  });
  const attestationSignature = signAttestation(attestationMessage, opts.oracle);

  const phase1Ix = buildEvaluatePoolPhase1Ix({
    scannerProgramId: opts.scannerProgramId,
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    poolAddress: opts.poolAddress,
    msg: attestationMessage,
    writer: opts.writer,
  });

  const computeIxs = await charterGuardedComputeIxs(opts.client, opts.fee);

  // The precompile must be constructed with the phase-1 ix's FINAL index.
  const phase1IxIndex = computeIxs.length + 1;
  const precompileIx = buildEd25519VerifyInstruction({
    signature: attestationSignature,
    oraclePublicKey: opts.oracle.publicKey,
    message: attestationMessage,
    scannerInstructionIndex: phase1IxIndex,
    messageAddressOffset: IX_DATA_MSG_OFFSET,
  });

  const { tx } = assembleAttestedTransaction(computeIxs, precompileIx, phase1Ix);
  return { tx, attestationMessage, attestationSignature, issuedSlot, phase1IxIndex };
}

/** One assembled record-launch-price transaction, ready to sign + send. */
export interface RecordLaunchPriceTxBundle {
  tx: Transaction;
  /** The 168-byte attestation message the launch-price oracle signed. */
  attestationMessage: Uint8Array;
  /** The oracle's 64-byte signature over `attestationMessage`. */
  attestationSignature: Uint8Array;
  /** Slot at which the attestation was issued. */
  issuedSlot: number;
  /** Index of the record instruction inside the assembled transaction. */
  recordIxIndex: number;
}

/**
 * Build the (compute budget, C2 precompile, record_launch_price)
 * transaction. Unlike C1 there is no SlotHashes freshness check on chain
 * (the launch price is a time-invariant historical fact), but the
 * attestation still carries the issuance slot for audit purposes.
 */
export async function buildRecordLaunchPriceTransaction(opts: {
  connection: Connection;
  client: GraveYieldClient;
  scannerProgramId: PublicKey;
  poolAddress: PublicKey;
  /** Launch-price derivation from `deriveLaunchPriceV4`. */
  derivation: LaunchPriceDerivation;
  oracle: OracleIdentity;
  /** Payer for the LaunchPrice PDA rent. */
  payer: PublicKey;
  fee: FeeSettings;
}): Promise<RecordLaunchPriceTxBundle> {
  const issuedSlot = await opts.connection.getSlot();

  const attestationMessage = buildLaunchPriceMessage({
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    poolAddress: opts.poolAddress,
    baseMint: opts.derivation.baseMint,
    quoteMint: opts.derivation.quoteMint,
    firstSwapSlot: opts.derivation.firstSwapSlot,
    firstSwapUnixTs: opts.derivation.firstSwapUnixTs,
    launchPriceQ64x64: opts.derivation.launchPriceQ64x64,
    issuedSlot,
  });
  const attestationSignature = signAttestation(attestationMessage, opts.oracle);

  const recordIx = buildRecordLaunchPriceIx({
    scannerProgramId: opts.scannerProgramId,
    ammProgramId: RAYDIUM_V4_PROGRAM_ID,
    poolAddress: opts.poolAddress,
    baseMint: opts.derivation.baseMint,
    quoteMint: opts.derivation.quoteMint,
    launchPriceQ64x64: opts.derivation.launchPriceQ64x64,
    msg: attestationMessage,
    payer: opts.payer,
  });

  const computeIxs = await charterGuardedComputeIxs(opts.client, opts.fee);

  const recordIxIndex = computeIxs.length + 1;
  const precompileIx = buildLaunchPriceEd25519VerifyInstruction({
    signature: attestationSignature,
    oraclePublicKey: opts.oracle.publicKey,
    recordInstructionIndex: recordIxIndex,
  });

  const { tx } = assembleAttestedTransaction(computeIxs, precompileIx, recordIx);
  return { tx, attestationMessage, attestationSignature, issuedSlot, recordIxIndex };
}

/**
 * Sign + send a transaction with the operator keypair through the
 * configured sender. The Charter guard has ALREADY run inside
 * `computeBudgetIxs` — this helper does not re-check.
 */
export async function sendBundle(opts: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
  sender?: TxSender;
}): Promise<string> {
  const sender = opts.sender ?? defaultTxSender;
  return sender(opts.connection, opts.tx, opts.signers);
}
