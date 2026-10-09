# `@graveyield/conservative`

Part of the GraveYield Salvor Fleet (Phase 11). See the repo root
README for the architecture overview and the CHANGELOG for details.

}
}
## What this bot is

The REFERENCE executor. It runs the shared fleet-core orchestration
under a conservative policy:

| Knob | Default (PROPOSED, configurable) | Rationale |
|---|---|---|
| \`minNetProfitLamports\` | 50,000,000 (0.05 SOL) | stronger economics |
| \`slippageBpsOverride\` | 150 bps | headroom below the 300 bps protocol default |
| \`feeMarginRatio\` | 0.15 | conservative fee share of expected profit |
| \`maxSubmitAttempts\` | 3 | low execution uncertainty |

The roadmap does not define these numbers (recorded gap) — they are
defaults, every one configurable via \`ConservativeConfig.tunables\`.

## Modes

- \`dry-run\` (DEFAULT) — revalidate, quote, estimate, assemble, even
  simulate via the injected connection — but NEVER submit.
- \`simulation\` — the same, guaranteed non-submitting.
- \`live\` — requires BOTH \`liveEnablement: { enabled: true }\` and a
  signer keypair; construction throws otherwise. Every transaction
  goes through the shared pipeline's Charter guard and simulation gate.

## Environment / configuration

All configuration is code-first (\`ConservativeConfig\`): cluster,
mode, tunables, accepted opportunity kinds, retry backoff. Program IDs
default to the devnet deployments. There is intentionally NO env-var
path that can enable live mode without code.

## Test commands

\`\`\`bash
pnpm --filter @graveyield/conservative typecheck
pnpm --filter @graveyield/conservative test
\`\`\`

13 offline tests covering both opportunity paths, duplicate
suppression, lease coordination, stale rejection, retries, restarts,
and the live-mode single-submission guarantee. No network, no keys.}
}

