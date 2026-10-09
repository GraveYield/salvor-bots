# `@graveyield/experimental`

Part of the GraveYield Salvor Fleet (Phase 11). See the repo root
README for the architecture overview and the CHANGELOG for details.

}
}
}
}
## What this bot is

The isolated strategy sandbox. Alternative economics run under hard,
measurable risk caps enforced by a fail-closed guard BEFORE any
simulation or submission:

| Cap | Default | Effect |
|---|---|---|
| \`maxPriorityFeeBudgetLamports\` | 20,000,000 (0.02 SOL) per attempt | over-cap fee plans are rejected \`risk-cap-exceeded\` |
| \`maxLpFractionBps\` | 2,000 (20% of live LP supply) | limits position blast radius |

Every strategy event carries \`experimentId\` + \`riskCaps\` for
attribution in the Monitor's feed. Experimental ships its OWN defaults
object; nothing it does touches Conservative's or Sniper's behavior,
and protocol rules (eligibility, Charter guard, certificate validity,
snapshot integrity, slippage limits) are enforced upstream in the
shared engine and are NOT hook-accessible — the sandbox cannot weaken
them.

## Test commands

\`\`\`bash
pnpm --filter @graveyield/experimental typecheck
pnpm --filter @graveyield/experimental test
\`\`\`

9 offline tests: fee-budget caps, position caps, pre-simulation gating,
attribution, defaults isolation, store namespace isolation, dry-run
gating, and eligibility enforcement (expired certs re-certify
atomically). No network, no keys.
