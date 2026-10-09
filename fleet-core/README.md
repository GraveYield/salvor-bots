# `@graveyield/fleet-core`

Part of the GraveYield Salvor Fleet (Phase 11). See the repo root
README for the architecture overview and the CHANGELOG for details.

## What this package is

The shared execution foundation for the executor bots (Conservative,
Sniper, Experimental) and the integration surface the Monitor consumes.
Every executor runs the SAME orchestration (`StrategyExecutor`), the
SAME transaction pipeline (`ExecutionPipeline`), the SAME economic
estimator, and the SAME coordination store interface. A strategy is
only its policy numbers plus optional hooks — no bot maintains a
private transaction-construction path.

## Modules

- `envelope` — versioned opportunity envelope (schema v1), canonical
  identity key \`cluster|amm|pool\`, tamper-evident delivery ids.
- \`lifecycle\` — 15-state executor state machine; illegal transitions
  throw (no skipping the simulation gate, no submission after terminal
  failure).
- \`store\` — \`FleetStore\` (delivery idempotency, execution records,
  leases). The shipped \`InMemoryFleetStore\` coordinates ONE PROCESS
  ONLY; multi-process deployments must supply a shared backend.
- \`events\` — \`FleetEvent\` taxonomy, failure classes (transient vs
  terminal), Memory/JSONL/Fanout/Console sinks.
- \`estimator\` — the integer economic estimator (lamports and base
  units only; no floating point). Inputs: live reserves, live LP
  supply, a route quote, the LIVE protocol config shares, cost
  assumptions. Outputs: gross proceeds, salvor share, costs, net
  profit, break-even, and the \`min_quote_output_lamports\` floor.
- \`policy\` — \`ExecutionPolicy\` + the mode ladder
  \`dry-run → simulation → live\`. Live mode REQUIRES
  \`LiveEnablement.enabled = true\` from the operator, plus a signer.
- \`route\` — \`RouteAdapter\` seam, a Jupiter v6 HTTP adapter
  (injectable \`fetch\` + base URL), and deterministic fakes for tests.
  Quotes are untrusted until \`validateRouteForSalvage\` passes.
- \`revalidate\` — live chain re-derivation of the opportunity's truth
  (configs, pool, reserves, LP supply, anchor, cert, epoch gap). The
  envelope's kind is context, not authority: a certification-ready
  sighting whose cert has since been issued flips to salvageable, and
  an expired cert flips back.
- \`raydiumAccounts\` — derives the 13 Raydium V4 CPI
  \`remaining_accounts\` from the LIVE AmmInfo + Serum market bytes
  (fork-proven offsets), validating owner programs, mint binding, and
  the market vault-signer PDA. Fails closed.
- \`pipeline\` — prepare → simulate → submit → confirm: fresh snapshot
  + live supply re-pin, route validation, the D3 fee plan + Charter
  guard (at assembly AND submit), the atomic certify+salvage bundle
  with the dynamically pinned precompile index, full-transaction
  simulation with GraveYield error decoding, and a hard submission
  gate (\`submit()\` throws unless mode = live).

## Test commands

\`\`\`bash
pnpm --filter @graveyield/fleet-core typecheck
pnpm --filter @graveyield/fleet-core test
\`\`\`

64 offline tests (node:test); no network, no keys.}
}
}
}

