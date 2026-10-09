// SPDX-License-Identifier: Apache-2.0
//
// Route adapter interface + the Jupiter v6 adapter (FLEET-M1).
//
// The SDK's salvage_pool builder deliberately does NOT fetch quotes or
// build routes — the salvor supplies `jupiterRouteData` (verbatim swap
// instruction data the vault forwards to the Jupiter v6 program) and
// the route accounts. This module is the fleet's single seam for that:
//
//   * `RouteAdapter` — the interface every executor goes through.
//   * `JupiterV6RouteAdapter` — an HTTP adapter for a Jupiter v6
//     quote/swap-compatible endpoint (base URL injectable; operators
//     point it at their own gateway). NOT used by tests — tests inject
//     `FakeRouteAdapter`, and no automated test ever hits an external
//     API (mandate §10).
//
// Route data is UNTRUSTED until validated: the pipeline checks mint
// orientation, freshness, consistency (in/out amounts), and re-derives
// the min-output floor itself before a quote may be used in a tx.

import { PublicKey, type AccountMeta } from "@solana/web3.js";

/** A validated route quote for one conversion leg. */
export interface RouteQuote {
  /** Input mint (base58) — the memecoin. */
  inputMint: string;
  /** Output mint (base58) — WSOL for the salvage swap leg. */
  outputMint: string;
  /** Quoted input amount (input-mint base units). */
  inAmount: bigint;
  /** Quoted output amount (lamports for WSOL out). */
  outAmount: bigint;
  /** Slippage bps the QUOTE was computed with. */
  slippageBps: number;
  /** Verbatim swap instruction data the vault CPIs to Jupiter v6. */
  routeData: Uint8Array;
  /** The route accounts (verbatim order), vault WSOL destination included. */
  routeAccounts: ReadonlyArray<AccountMeta>;
  /** When the route was produced (epoch ms) — freshness is enforced downstream. */
  quotedAtMs: number;
  /** Adapter name for attribution. */
  adapter: string;
}

/** Quote request — the conversion the salvage swap leg must perform. */
export interface RouteQuoteRequest {
  inputMint: PublicKey;
  outputMint: PublicKey;
  /** Amount to convert (input-mint base units). */
  amount: bigint;
  /** Slippage bps to quote with (the pipeline's effective value). */
  slippageBps: number;
  /**
   * The WSOL destination the vault controls — the route's output
   * account. The on-chain vetting requires the vault's WSOL ATA to be
   * present in the route accounts.
   */
  destinationTokenAccount: PublicKey;
  /** The route's payer/authority (the vault authority PDA on chain). */
  authority: PublicKey;
}

/** The route seam every executor shares. */
export interface RouteAdapter {
  readonly name: string;
  /** Produce a quote + verbatim route, or throw `RouteError`. */
  quote(req: RouteQuoteRequest): Promise<RouteQuote>;
}

/** Typed route failure — classified into the fleet taxonomy. */
export class RouteError extends Error {
  constructor(
    public readonly reason:
      | "no-route"
      | "quote-stale"
      | "unsupported-pair"
      | "endpoint-unavailable"
      | "endpoint-error"
      | "malformed-response",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

/**
 * Jupiter v6 quote/swap HTTP adapter. The endpoint contract is the
 * public Jupiter v6 shape: `GET {base}/quote?…` → { inAmount,
 * outAmount, … } and `POST {base}/swap` → { swapInstruction: { data,
 * accountKeyList } } (the assembled swap instruction for the aggregator
 * program). Operators may point `baseUrl` at any compatible gateway.
 *
 * This adapter NEVER runs in tests; it exists so the fleet's live mode
 * has a real, auditable implementation of the seam.
 */
export class JupiterV6RouteAdapter implements RouteAdapter {
  readonly name = "jupiter-v6";
  constructor(
    private readonly opts: {
      baseUrl: string;
      /** Injectable fetch (Node 24 global by default). */
      fetchImpl?: typeof fetch;
      /** Timeout per HTTP call (ms). */
      timeoutMs?: number;
    },
  ) {}

  async quote(req: RouteQuoteRequest): Promise<RouteQuote> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const url =
      `${this.opts.baseUrl}/quote?inputMint=${req.inputMint.toBase58()}` +
      `&outputMint=${req.outputMint.toBase58()}` +
      `&amount=${req.amount.toString()}` +
      `&slippageBps=${req.slippageBps}` +
      `&onlyDirectRoutes=true&maxAccounts=64`;
    const quoteRes = await this.call(fetchImpl, url);
    if (!quoteRes.ok) {
      if (quoteRes.status === 400) throw new RouteError("no-route", `no route for ${req.inputMint.toBase58()}→${req.outputMint.toBase58()}`, 400);
      throw new RouteError("endpoint-error", `quote endpoint returned ${quoteRes.status}`, quoteRes.status);
    }
    const quoteBody = (await quoteRes.json()) as { inAmount?: string; outAmount?: string; slippageBps?: number };
    if (typeof quoteBody.inAmount !== "string" || typeof quoteBody.outAmount !== "string") {
      throw new RouteError("malformed-response", "quote response missing inAmount/outAmount");
    }

    // Assemble the swap instruction for the vault authority.
    const swapRes = await this.call(fetchImpl, `${this.opts.baseUrl}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteBody,
        userPublicKey: req.authority.toBase58(),
        destinationTokenAccount: req.destinationTokenAccount.toBase58(),
        wrapAndUnwrapSol: false, // the vault manages its own WSOL ATA
      }),
    });
    if (!swapRes.ok) {
      throw new RouteError("endpoint-error", `swap endpoint returned ${swapRes.status}`, swapRes.status);
    }
    const swapBody = (await swapRes.json()) as {
      swapInstruction?: { data?: string; accounts?: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> };
    };
    const ix = swapBody.swapInstruction;
    if (!ix || typeof ix.data !== "string" || !Array.isArray(ix.accounts)) {
      throw new RouteError("malformed-response", "swap response missing swapInstruction.data/accounts");
    }
    return {
      inputMint: req.inputMint.toBase58(),
      outputMint: req.outputMint.toBase58(),
      inAmount: BigInt(quoteBody.inAmount),
      outAmount: BigInt(quoteBody.outAmount),
      slippageBps: quoteBody.slippageBps ?? req.slippageBps,
      routeData: Uint8Array.from(Buffer.from(ix.data, "base64")),
      routeAccounts: ix.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      quotedAtMs: Date.now(),
      adapter: this.name,
    };
  }

  private async call(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      return await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) throw new RouteError("endpoint-unavailable", `route endpoint timed out: ${url}`);
      throw new RouteError("endpoint-unavailable", `route endpoint unreachable: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Deterministic fake for tests — canned routes with controllable
 * failures. NEVER leaves the process.
 */
export class FakeRouteAdapter implements RouteAdapter {
  readonly name = "fake";
  /** Calls observed (test assertions). */
  readonly calls: RouteQuoteRequest[] = [];
  constructor(private readonly responder: (req: RouteQuoteRequest) => Promise<RouteQuote>) {}

  async quote(req: RouteQuoteRequest): Promise<RouteQuote> {
    this.calls.push(req);
    return this.responder(req);
  }
}

/** Build a healthy fake quote for a memecoin→WSOL leg. */
export function fakeRouteQuote(opts: {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps?: number;
  quotedAtMs?: number;
  routeData?: Uint8Array;
  routeAccounts?: ReadonlyArray<AccountMeta>;
}): RouteQuote {
  return {
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    inAmount: opts.inAmount,
    outAmount: opts.outAmount,
    slippageBps: opts.slippageBps ?? 100,
    routeData: opts.routeData ?? Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    routeAccounts: opts.routeAccounts ?? [],
    quotedAtMs: opts.quotedAtMs ?? Date.now(),
    adapter: "fake",
  };
}
