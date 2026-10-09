# `@graveyield/sniper`

Part of the GraveYield Salvor Fleet (Phase 11). See the repo root
README for the architecture overview and the CHANGELOG for details.

}
}
}
## What this bot is

The latency-sensitive executor. Same shared gates as every executor —
the Sniper NEVER bypasses eligibility, revalidation, simulation, fee
ceilings, or profitability minimums. Its entire strategy delta:

| Knob | Default (PROPOSED) | Rationale |
|---|---|---|
| batch ordering | soonest cert expiry first | the cert clock decides priority |
| \`quoteMaxAgeMs\` | 5,000 | fresh quotes only |
| \`feeMarginRatio\` | 0.30 | willing to pay more to land the window (still D3-plan capped) |
| \`minNetProfitLamports\` | 20,000,000 (0.02 SOL) | the fast mover's lower floor |
| \`maxSubmitAttempts\` | 2 | speed over persistence |
| \`slippageBpsOverride\` | 200 bps | tighter than the protocol default |

Role-definition note: the roadmap's Sniper description is a proposed
interpretation (urgency-priority execution); the authoritative spec
does not define it more specifically.

## Test commands

\`\`\`bash
pnpm --filter @graveyield/sniper typecheck
pnpm --filter @graveyield/sniper test
\`\`\`

7 offline tests: urgency ordering, tighter windows, fee-share delta,
safety parity (dry-run never submits; simulation runs; lease
coordination with the other bots). No network, no keys.}

