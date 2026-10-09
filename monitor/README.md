# `@graveyield/monitor`

Part of the GraveYield Salvor Fleet (Phase 11). See the repo root
README for the architecture overview and the CHANGELOG for details.

}
## What this bot is

Monitor/Risk — the fleet observer and verification layer. It consumes
the Scout's and every executor's structured events, tracks opportunity
age / certificate expiry / execution attempts / signatures, verifies
confirmed salvage transactions against the live chain and the
GraveVault SalvageReceipt (total + 40/40/20 shares + reported-vs-chain),
and emits machine-readable diagnostics (stale opportunities, cert
expiry windows, repeated attempts, conflicting claims, receipt
mismatches, unverified confirmations).

## Hard boundary

The Monitor has NO keypair, NO transaction builder, and NO submission
path. It is read-only by construction (asserted by tests over its API
surface).

## Reconciliation

After an executor reports a confirmation, \`monitor.reconcile(identity,
bot, signature)\` reads the SalvageReceipt PDA for the pool and checks:
the three legs sum to the total; each leg matches its 40/40/20 share
(± 1 lamport for rounding); the executor's reported amounts match the
chain. Verdicts: \`receipt-verified\`, \`receipt-anomaly\`,
\`receipt-missing\`, \`chain-unreadable\`.

## Test commands

\`\`\`bash
pnpm --filter @graveyield/monitor typecheck
pnpm --filter @graveyield/monitor test
\`\`\`

21 offline tests — 13 monitor units + 8 whole-fleet integration
scenarios (duplicate events, replay, lease races, stale certificates,
failed simulations, route failures, restarts, live settlement
reconciliation). No network, no keys.}
}
}

