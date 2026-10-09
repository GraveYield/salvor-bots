// SPDX-License-Identifier: Apache-2.0
//
// Route adapter tests — fake adapter determinism + the Jupiter v6 HTTP
// adapter against a MOCKED fetch (no network, ever) + route validation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  FakeRouteAdapter,
  JupiterV6RouteAdapter,
  RouteError,
  fakeRouteQuote,
  validateRouteForSalvage,
} from "../src/index.js";

const MEME = new PublicKey(new Uint8Array(32).fill(0x11));
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const VAULT_AUTH = new PublicKey(new Uint8Array(32).fill(0x22));
const VAULT_WSOL_ATA = new PublicKey(new Uint8Array(32).fill(0x33));

const REQ = {
  inputMint: MEME,
  outputMint: WSOL,
  amount: 1_000_000n,
  slippageBps: 300,
  destinationTokenAccount: VAULT_WSOL_ATA,
  authority: VAULT_AUTH,
};

describe("FakeRouteAdapter", () => {
  test("returns the canned route and records the call", async () => {
    const quote = fakeRouteQuote({ inputMint: MEME.toBase58(), outputMint: WSOL.toBase58(), inAmount: 1_000_000n, outAmount: 4_000_000_000n });
    const adapter = new FakeRouteAdapter(async () => quote);
    const out = await adapter.quote(REQ);
    assert.equal(out.outAmount, 4_000_000_000n);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0]?.amount, 1_000_000n);
  });

  test("can simulate failures deterministically", async () => {
    const adapter = new FakeRouteAdapter(async () => {
      throw new RouteError("no-route", "dead pair", 400);
    });
    await assert.rejects(() => adapter.quote(REQ), RouteError);
  });
});

describe("JupiterV6RouteAdapter (mocked fetch)", () => {
  const quoteBody = { inAmount: "1000000", outAmount: "4000000000", slippageBps: 300 };
  const swapBody = {
    swapInstruction: {
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      accounts: [
        { pubkey: VAULT_AUTH.toBase58(), isSigner: false, isWritable: true },
        { pubkey: VAULT_WSOL_ATA.toBase58(), isSigner: false, isWritable: true },
      ],
    },
  };

  function mockFetch(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
    let call = 0;
    const seen: string[] = [];
    const impl = async (url: string | URL | Request): Promise<Response> => {
      seen.push(String(url));
      const res = responses[Math.min(call, responses.length - 1)];
      call++;
      return {
        ok: res.ok,
        status: res.status,
        json: async () => res.json,
      } as unknown as Response;
    };
    return { impl, seen };
  }

  test("happy path: quote then swap, verbatim data + accounts, base64 data decoded", async () => {
    const { impl } = mockFetch([
      { ok: true, status: 200, json: quoteBody },
      { ok: true, status: 200, json: swapBody },
    ]);
    const adapter = new JupiterV6RouteAdapter({ baseUrl: "https://fake.jup", fetchImpl: impl as typeof fetch });
    const q = await adapter.quote(REQ);
    assert.equal(q.inAmount, 1_000_000n);
    assert.equal(q.outAmount, 4_000_000_000n);
    assert.deepEqual([...q.routeData], [1, 2, 3, 4]);
    assert.equal(q.routeAccounts.length, 2);
    assert.ok(q.routeAccounts.some((a) => a.pubkey.equals(VAULT_WSOL_ATA)));
  });

  test("quote 400 → RouteError(no-route); endpoint 500 → RouteError(endpoint-error)", async () => {
    const bad400 = mockFetch([{ ok: false, status: 400, json: {} }]);
    const a400 = new JupiterV6RouteAdapter({ baseUrl: "https://fake.jup", fetchImpl: bad400.impl as typeof fetch });
    await assert.rejects(() => a400.quote(REQ), (err: unknown) => err instanceof RouteError && err.reason === "no-route");

    const bad500 = mockFetch([{ ok: false, status: 500, json: {} }]);
    const a500 = new JupiterV6RouteAdapter({ baseUrl: "https://fake.jup", fetchImpl: bad500.impl as typeof fetch });
    await assert.rejects(() => a500.quote(REQ), (err: unknown) => err instanceof RouteError && err.reason === "endpoint-error");
  });

  test("malformed swap response (missing swapInstruction) → malformed-response", async () => {
    const { impl } = mockFetch([
      { ok: true, status: 200, json: quoteBody },
      { ok: true, status: 200, json: {} },
    ]);
    const adapter = new JupiterV6RouteAdapter({ baseUrl: "https://fake.jup", fetchImpl: impl as typeof fetch });
    await assert.rejects(() => adapter.quote(REQ), (err: unknown) => err instanceof RouteError && err.reason === "malformed-response");
  });

  test("network failure → endpoint-unavailable", async () => {
    const impl = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    const adapter = new JupiterV6RouteAdapter({ baseUrl: "https://fake.jup", fetchImpl: impl as unknown as typeof fetch });
    await assert.rejects(() => adapter.quote(REQ), (err: unknown) => err instanceof RouteError && err.reason === "endpoint-unavailable");
  });
});

describe("validateRouteForSalvage", () => {
  const GOOD = fakeRouteQuote({
    inputMint: MEME.toBase58(),
    outputMint: WSOL.toBase58(),
    inAmount: 1_000_000n,
    outAmount: 4_000_000_000n,
    routeAccounts: [
      { pubkey: VAULT_AUTH, isSigner: false, isWritable: true },
      { pubkey: VAULT_WSOL_ATA, isSigner: false, isWritable: true },
    ],
  });

  test("a good route passes", () => {
    assert.equal(validateRouteForSalvage(GOOD, { inputMint: MEME, outputMint: WSOL, expectedOutLamports: 3_880_000_000n, vaultAuthority: VAULT_AUTH, vaultWsolAta: VAULT_WSOL_ATA }), null);
  });

  test("wrong input mint is rejected", () => {
    const wrong = fakeRouteQuote({ ...GOOD, inputMint: WSOL.toBase58() });
    assert.match(validateRouteForSalvage(wrong, { inputMint: MEME, outputMint: WSOL, expectedOutLamports: 1n, vaultAuthority: VAULT_AUTH, vaultWsolAta: VAULT_WSOL_ATA }) ?? "", /input mint/);
  });

  test("quote below the estimator's floor is rejected", () => {
    assert.match(validateRouteForSalvage(GOOD, { inputMint: MEME, outputMint: WSOL, expectedOutLamports: 4_000_000_001n, vaultAuthority: VAULT_AUTH, vaultWsolAta: VAULT_WSOL_ATA }) ?? "", /below the estimator's floor/);
  });

  test("a route that never touches the vault WSOL destination is rejected", () => {
    const missing = fakeRouteQuote({
      ...GOOD,
      routeAccounts: [{ pubkey: VAULT_AUTH, isSigner: false, isWritable: true }],
    });
    assert.match(validateRouteForSalvage(missing, { inputMint: MEME, outputMint: WSOL, expectedOutLamports: 1n, vaultAuthority: VAULT_AUTH, vaultWsolAta: VAULT_WSOL_ATA }) ?? "", /WSOL destination/);
  });
});
