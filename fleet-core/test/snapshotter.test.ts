// SPDX-License-Identifier: Apache-2.0
//
// D3 claims-snapshot producer tests.
//
// Two layers, honestly labelled:
//
//   * verifyClaimsArtifact — pure TS claims-grade verification against
//     deterministic D2-v2 fixture artifacts (the SDK tree is the
//     byte-locked port of snapshotter/src/tree.rs; these are FIXTURE
//     tests, not Rust builds).
//   * RustCliClaimsSnapshotter — subprocess-boundary behaviour against a
//     mock CLI executable: fail-closed categories, explicit argv, bounded
//     time/output, secret hygiene, and governed-input requirements.
//
// There is no local Solana validator or Rust toolchain in this
// environment: nothing here talks to a chain, and the mock executable is
// a Node script — NOT the real Rust binary (see the D3 report).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";

import {
  ClaimsSnapshotterError,
  RustCliClaimsSnapshotter,
  parseClaimsArtifactJson,
  snapshotterConfigFromEnv,
  verifyClaimsArtifact,
  verifySinkLedgerBinding,
  type SnapshotterRequest,
} from "../src/snapshotter.js";
import { buildClaimsArtifact, buildSinkLedger } from "./fixtures/artifactFactory.js";

// ------------------------------------------------------------------ keys

let keyCounter = 0;
function key(prefix: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = prefix;
  bytes[1] = keyCounter = (keyCounter + 1) % 251;
  bytes[2] = keyCounter;
  return new PublicKey(bytes);
}

const POOL = key(0xaa);
const AMM = key(0xab);
const MINT = key(0x01);
const OTHER_POOL = key(0xbb);
const OTHER_MINT = key(0x02);

function holdersFixture(): Array<{ owner: PublicKey; balance: bigint }> {
  return [
    { owner: key(0x10), balance: 4_000n },
    { owner: key(0x20), balance: 2_500n },
    { owner: key(0x30), balance: 1_000n },
  ];
}

function request(overrides?: Partial<SnapshotterRequest>): SnapshotterRequest {
  return {
    pool: POOL,
    ammProgramId: AMM,
    lpMint: MINT,
    ...overrides,
  };
}

// ---------------------------------------------------------- fixture files

let tempRoot: string;
let caseCounter = 0;

function freshTempDir(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "gy-snapshotter-tests-"));
  const dir = join(tempRoot, `case-${process.pid}-${caseCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Serialize a mutated exact-parse artifact back to deterministic bytes. */
function serializeArtifact(json: ReturnType<typeof parseClaimsArtifactJson>): Buffer {
  return Buffer.from(
    JSON.stringify(json, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v), 2) + "\n",
    "utf8",
  );
}

function parseExact(text: string): ReturnType<typeof parseClaimsArtifactJson> {
  return parseClaimsArtifactJson(text);
}

interface ValidFixture {
  dir: string;
  artifactPath: string;
  ledgerPath: string;
  artifactText: string;
  ledgerBytes: Buffer;
}

/**
 * A complete, valid, claims-grade fixture: governed ledger (one sink) +
 * provenance-sealed v2 artifact + locked-LP custody report.
 */
function writeValidFixture(opts?: {
  pool?: PublicKey;
  mint?: PublicKey;
  commitment?: string;
}): ValidFixture {
  const dir = freshTempDir();
  const pool = opts?.pool ?? POOL;
  const lpMint = opts?.mint ?? MINT;
  const sinkOwner = key(0x50);
  const sinkAccount = key(0x51);
  const custodyOwner = key(0x60);
  const custodyAccount = key(0x61);
  const ledger = buildSinkLedger({
    pool,
    amm: AMM,
    lpMint,
    entries: [
      {
        owner: sinkOwner,
        tokenAccount: sinkAccount,
        rawBalance: 500n,
      },
    ],
  });
  const ledgerPath = join(dir, "sink-ledger.json");
  writeFileSync(ledgerPath, ledger.bytes);
  const { text } = buildClaimsArtifact({
    pool,
    ammProgramId: AMM,
    lpMint,
    snapshotSlot: 123,
    holders: holdersFixture(),
    sinkExclusions: [{ owner: sinkOwner, balance: 500n }],
    sinkLedger: { bytes: ledger.bytes, ledgerId: ledger.ledgerId },
    locked: {
      lockRecordsSeen: 1,
      totalLocked: 1_000n,
      attributions: [{ owner: custodyOwner, balance: 1_000n }],
      custody: { tokenAccount: custodyAccount, owner: custodyOwner },
    },
    commitment: opts?.commitment,
  });
  const artifactPath = join(dir, "artifact.json");
  writeFileSync(artifactPath, text);
  return { dir, artifactPath, ledgerPath, artifactText: text, ledgerBytes: ledger.bytes };
}

function mockCliPath(): string {
  return fileURLToPath(new URL("./fixtures/bin/mock-snapshotter-cli.mjs", import.meta.url));
}

function snapshotter(opts?: {
  fixture?: ValidFixture;
  rpcUrl?: string;
  mode?: string;
  artifactPath?: string;
  timeoutMs?: number;
  maxArtifactBytes?: number;
  argvDump?: string;
}): { snap: RustCliClaimsSnapshotter; fixture: ValidFixture } {
  const fixture = opts?.fixture ?? writeValidFixture();
  const snap = new RustCliClaimsSnapshotter({
    executablePath: mockCliPath(),
    rpcUrl: opts?.rpcUrl ?? "http://127.0.0.1:8899",
    commitment: "confirmed",
    sinkLedgerPath: fixture.ledgerPath,
    timeoutMs: opts?.timeoutMs ?? 10_000,
    maxArtifactBytes: opts?.maxArtifactBytes,
    env: {
      PATH: process.env["PATH"] ?? "",
      GY_MOCK_MODE: opts?.mode ?? "success",
      GY_MOCK_ARTIFACT: opts?.artifactPath ?? fixture.artifactPath,
      ...(opts?.argvDump ? { GY_MOCK_ARGV_DUMP: opts.argvDump } : {}),
    },
  });
  return { snap, fixture };
}

// --------------------------------------------------- verification (pure)

describe("verifyClaimsArtifact (claims-grade TS verification, fixture artifacts)", () => {
  test("accepts a valid D2 claims-grade artifact bound to the supplied ledger", () => {
    const f = writeValidFixture();
    const result = verifyClaimsArtifact(Buffer.from(f.artifactText, "utf8"), request(), {
      sinkLedgerBytes: f.ledgerBytes,
      commitment: "confirmed",
    });
    assert.equal(result.holderCount, 3);
    assert.equal(result.snapshotSlot, 123);
    assert.equal(result.totalSupply, 8_000n); // 4000+2500+1000 leaf + 500 sink
    assert.equal(result.root.length, 32);
  });

  test("rejects a v1-labeled or unknown format_version", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.format_version = 1;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "schema-invalid",
    );
  });

  test("rejects a provenance-less artifact as never claims-grade", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.provenance = null;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "provenance-invalid",
    );
  });

  test("rejects a wrong pool / amm / mint", () => {
    const f = writeValidFixture();
    const bytes = Buffer.from(f.artifactText, "utf8");
    assert.throws(
      () => verifyClaimsArtifact(bytes, request({ pool: OTHER_POOL })),
      (e: ClaimsSnapshotterError) => e.category === "pool-mismatch",
    );
    assert.throws(
      () => verifyClaimsArtifact(bytes, request({ lpMint: OTHER_MINT })),
      (e: ClaimsSnapshotterError) => e.category === "mint-mismatch",
    );
    const json = parseExact(f.artifactText);
    json.amm_program_id = key(0xac).toBase58();
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "amm-mismatch",
    );
  });

  test("rejects a tampered root (root does not derive from the entries)", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    const rootBytes = Buffer.from(json.merkle_root, "hex");
    rootBytes[31] ^= 0x01;
    json.merkle_root = rootBytes.toString("hex");
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "tree-mismatch",
    );
  });

  test("rejects a tampered holder balance (root re-derivation drift)", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.entries[0]!.lp_balance += 1n;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "tree-mismatch",
    );
  });

  test("rejects a tampered per-entry proof", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    const entry = json.entries[0]!;
    if (entry.proof.length > 0) {
      const p = Buffer.from(entry.proof[0]!, "hex");
      p[0] ^= 0x02;
      entry.proof[0] = p.toString("hex");
    } else {
      entry.proof = ["00".repeat(32)];
    }
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "tree-mismatch",
    );
  });

  test("rejects duplicate owners and a non-positive balance", () => {
    const f = writeValidFixture();
    const bytes = Buffer.from(f.artifactText, "utf8");
    const dupe = parseExact(f.artifactText);
    dupe.entries = [dupe.entries[0]!, dupe.entries[0]!];
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(dupe), request()),
      (e: ClaimsSnapshotterError) => e.category === "schema-invalid",
    );
    const zero = parseExact(f.artifactText);
    zero.entries[0]!.lp_balance = 0n;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(zero), request()),
      (e: ClaimsSnapshotterError) => e.category === "schema-invalid",
    );
    void bytes;
  });

  test("rejects an empty leaf set", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.entries = [];
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "schema-invalid",
    );
  });

  test("rejects a broken reconciliation identity", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.reconciliation.enumerated_total += 1n;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "reconciliation-invalid",
    );
  });

  test("rejects an unknown exclusion reason", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.exclusions[0]!.reason = "whim";
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "exclusion-ledger-invalid",
    );
  });

  test("rejects locked attributions that do not sum to the locked total", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.locked.attributions[0]!.lp_balance += 1n;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "locked-report-invalid",
    );
  });

  test("rejects a custody owner that also holds a claimable leaf", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.locked.custody!.owner = json.entries[0]!.owner;
    assert.throws(
      () => verifyClaimsArtifact(serializeArtifact(json), request()),
      (e: ClaimsSnapshotterError) => e.category === "locked-report-invalid",
    );
  });

  test("rejects unsupported lock-evidence provenance (source, program, commitment, anchor)", () => {
    const f = writeValidFixture();
    const bytes = Buffer.from(f.artifactText, "utf8");
    assert.throws(
      () => {
        const json = parseExact(f.artifactText);
        json.provenance!.lock_evidence.source = "file";
        return verifyClaimsArtifact(serializeArtifact(json), request());
      },
      (e: ClaimsSnapshotterError) => e.category === "lock-evidence-invalid",
    );
    assert.throws(
      () => {
        const json = parseExact(f.artifactText);
        json.provenance!.lock_evidence.program_id = key(0xcd).toBase58();
        return verifyClaimsArtifact(serializeArtifact(json), request());
      },
      (e: ClaimsSnapshotterError) => e.category === "lock-evidence-invalid",
    );
    assert.throws(
      () => {
        const json = parseExact(f.artifactText);
        json.provenance!.lock_evidence.commitment = "finalized";
        return verifyClaimsArtifact(serializeArtifact(json), request(), {
          commitment: "confirmed",
        });
      },
      (e: ClaimsSnapshotterError) => e.category === "lock-evidence-invalid",
    );
    assert.throws(
      () => {
        const json = parseExact(f.artifactText);
        json.provenance!.lock_evidence.anchor_slot = 999n;
        return verifyClaimsArtifact(serializeArtifact(json), request());
      },
      (e: ClaimsSnapshotterError) => e.category === "lock-evidence-invalid",
    );
    assert.throws(
      () => verifyClaimsArtifact(bytes, request(), { commitment: "finalized" }),
      (e: ClaimsSnapshotterError) => e.category === "lock-evidence-invalid",
    );
  });

  test("rejects sink-ledger provenance that does not match the supplied ledger bytes", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    // Same shape, different bytes → different digest.
    const otherLedger = buildSinkLedger({
      pool: POOL,
      amm: AMM,
      lpMint: MINT,
      ledgerId: "GY-SINK-FIXTURE-001",
      entries: [],
    });
    assert.notEqual(
      createHash("sha256").update(otherLedger.bytes).digest("hex"),
      json.provenance!.sink_ledger!.input_sha256,
    );
    assert.throws(
      () =>
        verifyClaimsArtifact(Buffer.from(f.artifactText, "utf8"), request(), {
          sinkLedgerBytes: otherLedger.bytes,
        }),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
  });

  test("rejects sink exclusions whose provenance block is absent", () => {
    const f = writeValidFixture();
    const json = parseExact(f.artifactText);
    json.provenance!.sink_ledger = null;
    assert.throws(
      () =>
        verifyClaimsArtifact(serializeArtifact(json), request(), {
          sinkLedgerBytes: f.ledgerBytes,
        }),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
  });

  test("u64 fields are parsed EXACTLY beyond the Number safe range (no float rounding)", () => {
    // A handcrafted artifact whose supply exceeds 2^53: plain JSON.parse
    // would round it; the exact reviver must not.
    const raw = `{
      "format_version": 2,
      "pool_address": "${POOL.toBase58()}",
      "amm_program_id": "${AMM.toBase58()}",
      "lp_mint": "${MINT.toBase58()}",
      "snapshot_slot": 5,
      "lp_total_supply_at_snapshot": 9223372036854775807,
      "merkle_root": "00",
      "leaf_count": 1,
      "tree_depth": 0,
      "entries": [
        { "owner": "${key(0x71).toBase58()}", "lp_balance": 9223372036854775807, "leaf": "00", "proof": [] }
      ],
      "reconciliation": {
        "entries_total": 9223372036854775807,
        "sink_exclusions_total": 0,
        "enumerated_total": 9223372036854775807
      },
      "exclusions": [],
      "locked": { "lock_records_seen": 0, "total_locked": 0, "attributions": [], "custody": null },
      "provenance": {
        "sink_ledger": null,
        "lock_evidence": {
          "source": "rpc",
          "program_id": "${"GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo"}",
          "commitment": "confirmed",
          "anchor_slot": 5,
          "records_seen": 0,
          "total_locked": 0
        }
      }
    }`;
    const exact = parseExact(raw);
    assert.equal(exact.lp_total_supply_at_snapshot, 9_223_372_036_854_775_807n);
    assert.equal(
      exact.entries[0]!.lp_balance,
      9_223_372_036_854_775_807n,
      "a 2^63-1 balance must survive as an exact bigint",
    );
    // Plain JSON.parse WOULD have lost precision — prove the danger is
    // real (the rounded value is no longer a safe integer).
    const lossy = JSON.parse(raw) as { lp_total_supply_at_snapshot: number };
    assert.ok(!Number.isSafeInteger(lossy.lp_total_supply_at_snapshot));
    // The gate itself must refuse garbage without crashing imprecisely.
    assert.throws(
      () => verifyClaimsArtifact(Buffer.from(raw, "utf8"), request()),
      (e: ClaimsSnapshotterError) =>
        e.category === "tree-mismatch" || e.category === "schema-invalid",
    );
  });
});

// --------------------------------------------------- subprocess boundary

describe("RustCliClaimsSnapshotter (subprocess boundary, mock CLI)", () => {
  test("invokes the CLI and consumes its verified artifact (success path)", async () => {
    const { snap, fixture } = snapshotter();
    const result = await snap.produceSnapshot(request());
    const json = JSON.parse(fixture.artifactText) as { merkle_root: string };
    assert.equal(Buffer.from(result.root).toString("hex"), json.merkle_root);
    assert.equal(result.totalSupply, 8_000n);
    assert.equal(result.snapshotSlot, 123);
    assert.equal(result.holderCount, 3);
    assert.equal(
      result.artifactSha256,
      createHash("sha256").update(fixture.artifactText, "utf8").digest("hex"),
    );
    assert.equal(
      result.sinkLedgerSha256,
      createHash("sha256").update(fixture.ledgerBytes).digest("hex"),
    );
    assert.equal(result.sinkLedgerId, "GY-SINK-FIXTURE-001");
  });

  test("passes --lock-evidence rpc and --sink-ledger (no empty fallback possible)", async () => {
    const fixture = writeValidFixture();
    const argvDump = join(fixture.dir, "argv.json");
    const { snap } = snapshotter({ fixture, argvDump });
    await snap.produceSnapshot(request());
    const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
    assert.ok(argv.includes("--lock-evidence"), "must request real locker evidence");
    assert.equal(argv[argv.indexOf("--lock-evidence") + 1], "rpc");
    assert.ok(argv.includes("--sink-ledger"), "must pass the governed ledger");
    assert.equal(argv[argv.indexOf("--sink-ledger") + 1], fixture.ledgerPath);
    assert.ok(argv.includes("--commitment"));
    assert.ok(argv.includes("--pool") && argv.includes("--amm") && argv.includes("--lp-mint"));
    assert.ok(argv.includes("--out"));
  });

  test("subprocess arguments are explicit argv — a credential-bearing RPC URL is ONE element, never shell-interpolated", async () => {
    // Metacharacters a shell would interpret; spawn-without-shell must
    // deliver them verbatim in a single argv element.
    const hostileUrl =
      "https://user:secret@rpc.example/v1?api-key=abc def;rm -rf /&x=$(boom)|echo pwned";
    const fixture = writeValidFixture();
    const argvDump = join(fixture.dir, "argv.json");
    const { snap } = snapshotter({ fixture, rpcUrl: hostileUrl, argvDump });
    const result = await snap.produceSnapshot(request());
    assert.ok(result.root.length === 32);
    const argv = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--url") + 1], hostileUrl);
    assert.equal(argv.filter((a) => a === hostileUrl).length, 1, "no shell fragmentation");
  });

  test("failures and error contexts never disclose the RPC URL", async () => {
    const secretUrl = "https://user:topsecret@rpc.example/v1?api-key=SECRET";
    const { snap } = snapshotter({ mode: "exit", rpcUrl: secretUrl });
    const err = await snap.produceSnapshot(request()).then(
      () => null,
      (e: unknown) => e as ClaimsSnapshotterError,
    );
    assert.ok(err, "expected a failure");
    assert.equal(err.category, "nonzero-exit");
    const rendered = `${err.message} ${JSON.stringify(err.context)}`;
    assert.ok(!rendered.includes("topsecret"), "error must not leak the credential");
    assert.ok(!rendered.includes("rpc.example"), "error must not leak the endpoint");
  });

  test("missing executable fails closed (missing-executable)", async () => {
    const fixture = writeValidFixture();
    const snap = new RustCliClaimsSnapshotter({
      executablePath: join(fixture.dir, "does-not-exist"),
      rpcUrl: "http://127.0.0.1:8899",
      commitment: "confirmed",
      sinkLedgerPath: fixture.ledgerPath,
    });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "missing-executable",
    );
  });

  test("nonzero exit fails closed (nonzero-exit)", async () => {
    const { snap } = snapshotter({ mode: "exit" });
    await assert.rejects(snap.produceSnapshot(request()), (e: ClaimsSnapshotterError) => {
      assert.equal(e.category, "nonzero-exit");
      assert.equal(e.context.exitCode, 3);
      return true;
    });
  });

  test("timeout fails closed (timeout)", async () => {
    const { snap } = snapshotter({ mode: "hang", timeoutMs: 400 });
    const started = Date.now();
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "timeout",
    );
    const elapsed = Date.now() - started;
    // SIGTERM escalation (~5s grace) bounds the wait — the run was killed
    // by the runner's own budget, not by the test timeout.
    assert.ok(elapsed < 30_000, `run took ${elapsed}ms`);
  }, 60_000);

  test("malformed output fails closed (malformed-output)", async () => {
    const { snap } = snapshotter({ mode: "garbage" });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "malformed-output",
    );
  });

  test("oversized output fails closed (artifact-too-large)", async () => {
    const { snap } = snapshotter({ mode: "oversize", maxArtifactBytes: 512 });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "artifact-too-large",
    );
  });

  test("an unspawnable executable path fails closed (spawn-failed)", async () => {
    const fixture = writeValidFixture();
    const dir = mkdtempSync(join(tmpdir(), "gy-spawn-fail-"));
    // A DIRECTORY passes the X_OK access check but spawn() fails it with
    // EACCES — the boundary between "not found" and "cannot invoke".
    const snap = new RustCliClaimsSnapshotter({
      executablePath: dir,
      rpcUrl: "http://127.0.0.1:8899",
      commitment: "confirmed",
      sinkLedgerPath: fixture.ledgerPath,
    });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "spawn-failed",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("an artifact from another pool is rejected (pool-mismatch)", async () => {
    // The run's ledger + request are for POOL, but the CLI (mock) writes
    // an artifact sealed for OTHER_POOL — the identity gate must refuse
    // before any root is consumed.
    const fixture = writeValidFixture(); // ledger + request bound to POOL
    const foreignArtifact = buildClaimsArtifact({
      pool: OTHER_POOL,
      ammProgramId: AMM,
      lpMint: MINT,
      snapshotSlot: 123,
      holders: holdersFixture(),
      sinkExclusions: [],
      locked: { lockRecordsSeen: 0, totalLocked: 0n, attributions: [], custody: null },
    });
    const foreignPath = join(fixture.dir, "foreign-artifact.json");
    writeFileSync(foreignPath, foreignArtifact.bytes);
    const { snap } = snapshotter({ fixture, artifactPath: foreignPath });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "pool-mismatch",
    );
  });

  test("a run whose sink ledger is not the artifact's governed ledger is rejected", async () => {
    // Artifact bound to ledger A; run supplies ledger B (both valid files).
    const fixtureA = writeValidFixture();
    const ledgerB = buildSinkLedger({
      pool: POOL,
      amm: AMM,
      lpMint: MINT,
      ledgerId: "GY-SINK-FIXTURE-002",
      entries: [],
    });
    const ledgerBPath = join(fixtureA.dir, "ledger-b.json");
    writeFileSync(ledgerBPath, ledgerB.bytes);
    const { snap } = snapshotter({ fixture: fixtureA });
    const rebound = new RustCliClaimsSnapshotter({
      executablePath: mockCliPath(),
      rpcUrl: "http://127.0.0.1:8899",
      commitment: "confirmed",
      sinkLedgerPath: ledgerBPath,
      timeoutMs: 10_000,
      env: { PATH: process.env["PATH"] ?? "", GY_MOCK_ARTIFACT: fixtureA.artifactPath },
    });
    void snap;
    await assert.rejects(
      rebound.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
  });

  test("a missing governed ledger fails closed (ledger-unreadable) — no empty fallback", async () => {
    const fixture = writeValidFixture();
    const snap = new RustCliClaimsSnapshotter({
      executablePath: mockCliPath(),
      rpcUrl: "http://127.0.0.1:8899",
      commitment: "confirmed",
      sinkLedgerPath: join(fixture.dir, "no-such-ledger.json"),
      timeoutMs: 10_000,
    });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "ledger-unreadable",
    );
  });

  test("a ledger scoped to another pool is refused before the run (sink-ledger-mismatch)", async () => {
    const fixture = writeValidFixture();
    const foreignLedger = buildSinkLedger({
      pool: OTHER_POOL,
      amm: AMM,
      lpMint: MINT,
      entries: [],
    });
    const foreignPath = join(fixture.dir, "foreign-ledger.json");
    writeFileSync(foreignPath, foreignLedger.bytes);
    const snap = new RustCliClaimsSnapshotter({
      executablePath: mockCliPath(),
      rpcUrl: "http://127.0.0.1:8899",
      commitment: "confirmed",
      sinkLedgerPath: foreignPath,
      timeoutMs: 10_000,
    });
    await assert.rejects(
      snap.produceSnapshot(request()),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
  });

  test("configuration is fail-closed: no ledger path, bad commitment, no executable path", () => {
    assert.throws(
      () =>
        new RustCliClaimsSnapshotter({
          executablePath: mockCliPath(),
          rpcUrl: "http://127.0.0.1:8899",
          commitment: "confirmed",
          sinkLedgerPath: "",
        }),
      (e: ClaimsSnapshotterError) => e.category === "config-invalid",
    );
    assert.throws(
      () =>
        new RustCliClaimsSnapshotter({
          executablePath: mockCliPath(),
          rpcUrl: "http://127.0.0.1:8899",
          commitment: "processed" as "confirmed",
          sinkLedgerPath: "/tmp/ledger.json",
        }),
      (e: ClaimsSnapshotterError) => e.category === "config-invalid",
    );
    assert.throws(
      () =>
        new RustCliClaimsSnapshotter({
          executablePath: "",
          rpcUrl: "http://127.0.0.1:8899",
          commitment: "confirmed",
          sinkLedgerPath: "/tmp/ledger.json",
        }),
      (e: ClaimsSnapshotterError) => e.category === "config-invalid",
    );
  });

  test("env wiring is fail-closed on missing variables", () => {
    assert.throws(
      () => snapshotterConfigFromEnv({}),
      (e: ClaimsSnapshotterError) => e.category === "config-invalid",
    );
    const cfg = snapshotterConfigFromEnv({
      GY_SNAPSHOTTER_BIN: "/usr/local/bin/grave-snapshotter-cli",
      GY_SNAPSHOTTER_RPC_URL: "http://127.0.0.1:8899",
      GY_SNAPSHOTTER_COMMITMENT: "finalized",
      GY_SNAPSHOTTER_SINK_LEDGER: "/etc/gy/ledger.json",
    });
    assert.equal(cfg.commitment, "finalized");
    assert.throws(
      () =>
        snapshotterConfigFromEnv({
          GY_SNAPSHOTTER_BIN: "x",
          GY_SNAPSHOTTER_RPC_URL: "y",
          GY_SNAPSHOTTER_COMMITMENT: "processed",
          GY_SNAPSHOTTER_SINK_LEDGER: "z",
        }),
      (e: ClaimsSnapshotterError) => e.category === "config-invalid",
    );
  });
});

describe("D3 review fixes — strict u64 validation and stderr redaction", () => {
  function u64Probe(value: string): unknown {
    // Minimal doc carrying one u64 field with the probed raw JSON literal.
    const raw = `{"format_version":2,"snapshot_slot":${value}}`;
    return parseClaimsArtifactJson(raw).snapshot_slot;
  }

  test("negative u64 values are refused (not arithmetic-dependent)", () => {
    assert.throws(
      () => verifyClaimsArtifact(Buffer.from('{"format_version":2,"snapshot_slot":-5}'), request()),
      (e: ClaimsSnapshotterError) =>
        e.category === "schema-invalid" && e.message.includes("snapshot_slot"),
    );
    assert.throws(
      () => u64Probe("-5"),
      (e: ClaimsSnapshotterError) => e.message.includes("non-negative"),
    );
  });

  test("u64 overflow (> 2^64-1) is refused at the parse gate", () => {
    assert.throws(
      () => u64Probe("18446744073709551616"),
      (e: ClaimsSnapshotterError) => e.message.includes("outside the u64 range"),
    );
    assert.throws(
      () =>
        verifyClaimsArtifact(
          Buffer.from('{"format_version":2,"snapshot_slot":36893488147419103232}'),
          request(),
        ),
      (e: ClaimsSnapshotterError) => e.category === "schema-invalid",
    );
  });

  test("the u64 maximum is accepted exactly", () => {
    assert.equal(u64Probe("18446744073709551615"), 18446744073709551615n);
  });

  test("a credential-bearing URL written to stderr by the CLI can never reach errors or events", async () => {
    const secretUrl = "https://svc:sup3rs3cret@rpc-provider.example/v1?api-key=TOPSECRET&org=gy";
    const fixture = writeValidFixture();
    const snap = new RustCliClaimsSnapshotter({
      executablePath: mockCliPath(),
      rpcUrl: secretUrl,
      commitment: "confirmed",
      sinkLedgerPath: fixture.ledgerPath,
      timeoutMs: 10_000,
      env: { PATH: process.env["PATH"] ?? "", GY_MOCK_MODE: "leak" },
    });
    const err = await snap.produceSnapshot(request()).then(
      () => null,
      (e: unknown) => e as ClaimsSnapshotterError,
    );
    assert.ok(err);
    assert.equal(err.category, "nonzero-exit");
    const rendered = `${err.message} ${JSON.stringify(err.context)}`;
    assert.ok(!rendered.includes("sup3rs3cret"), "error must not leak the URL credential");
    assert.ok(!rendered.includes("TOPSECRET"), "error must not leak the query credential");
    assert.ok(!rendered.includes("rpc-provider.example"), "error must not leak the endpoint host");
    assert.ok(
      rendered.includes("[redacted-rpc-url]") || rendered.includes("[redacted-credentials]"),
      "redaction markers present",
    );
  });
});

describe("verifySinkLedgerBinding (pre-run governed input gate)", () => {
  test("binds schema, identity, and pool/amm/mint", () => {
    const ledger = buildSinkLedger({ pool: POOL, amm: AMM, lpMint: MINT });
    const { ledgerId } = verifySinkLedgerBinding(ledger.bytes, request());
    assert.equal(ledgerId, "GY-SINK-FIXTURE-001");
  });

  test("an explicit empty ledger is a VALID governed input (no exclusions approved)", () => {
    const ledger = buildSinkLedger({ pool: POOL, amm: AMM, lpMint: MINT, entries: [] });
    const { ledgerId } = verifySinkLedgerBinding(ledger.bytes, request());
    assert.equal(ledgerId, "GY-SINK-FIXTURE-001");
  });

  test("refuses a wrong-version, malformed, or unscoped ledger", () => {
    const ledger = buildSinkLedger({ pool: POOL, amm: AMM, lpMint: MINT });
    const bad = JSON.parse(ledger.bytes.toString("utf8")) as { schema_version: number };
    bad.schema_version = 2;
    assert.throws(
      () => verifySinkLedgerBinding(Buffer.from(JSON.stringify(bad)), request()),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
    assert.throws(
      () => verifySinkLedgerBinding(Buffer.from("not json"), request()),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
    const foreign = buildSinkLedger({ pool: OTHER_POOL, amm: AMM, lpMint: MINT });
    assert.throws(
      () => verifySinkLedgerBinding(foreign.bytes, request()),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
    const foreignMint = buildSinkLedger({ pool: POOL, amm: AMM, lpMint: OTHER_MINT });
    assert.throws(
      () => verifySinkLedgerBinding(foreignMint.bytes, request()),
      (e: ClaimsSnapshotterError) => e.category === "sink-ledger-mismatch",
    );
  });
});
