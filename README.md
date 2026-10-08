# GraveYield Salvor Bots

Autonomous agents for discovering, evaluating, and executing GraveYield salvage opportunities across abandoned liquidity pools.

## Overview

Salvor Bots are the autonomous execution layer of the GraveYield ecosystem.

GraveYield is designed to create a deterministic lifecycle for abandoned liquidity:

Pool Discovery
→ Eligibility Evaluation
→ Confirmation
→ Certification
→ Salvage
→ Settlement
→ LP Claims

Salvor Bots operate on the execution side of this lifecycle. They identify eligible opportunities, evaluate their economic and technical conditions, and submit salvage operations when the required protocol conditions are satisfied.

## Architecture

The Salvor system is intended to support multiple autonomous strategies while maintaining the same GraveYield protocol rules.

Potential Salvor roles include:

- **Conservative** — prioritizes high-confidence, low-risk opportunities.
- **Experimental** — explores opportunities with higher execution or market risk.
- **Monitor** — observes candidates and tracks their lifecycle without necessarily executing salvage.
- **Specialist** — optimized for specific DEXs, pool types, or execution conditions.

These strategies should compete on execution quality rather than bypassing GraveYield's eligibility rules.

## Core Responsibilities

A Salvor may perform:

1. Pool discovery
2. Candidate filtering
3. GraveYield eligibility monitoring
4. Economic evaluation
5. Transaction preparation
6. Salvage execution
7. Result verification
8. Settlement tracking

The Salvor does **not** determine legal ownership or independently declare a pool abandoned.

Eligibility is determined by the GraveYield protocol according to its deployed rules.

## Design Principles

### Protocol-first

Salvor Bots are operators of the GraveYield protocol, not replacements for its on-chain security rules.

### Non-custodial

Salvor infrastructure should not require custody of user assets beyond the permissions necessary to execute an authorized salvage transaction.

### Deterministic execution

Bots should operate according to explicit strategies and measurable conditions rather than discretionary intervention.

### Strategy isolation

Different Salvor strategies should be independently configurable and should not weaken the protocol's eligibility or settlement guarantees.

### Verifiable execution

Bot decisions and execution results should be observable and reproducible wherever practical.

## Current Status

**Early development / architecture phase**

The GraveYield protocol is being built on Solana first, with Raydium V4 as the initial target integration.

The Salvor Bots repository is currently being established as the autonomous-agent layer. Bot implementations will be developed after the underlying GraveYield salvage lifecycle is sufficiently complete and tested.

## Planned Development

- [ ] Salvor agent architecture
- [ ] GraveYield SDK integration
- [ ] Candidate discovery
- [ ] Eligibility monitoring
- [ ] Economic opportunity evaluation
- [ ] Transaction simulation
- [ ] Salvage execution
- [ ] Settlement verification
- [ ] Monitoring and observability
- [ ] Strategy-specific Salvors
- [ ] Multi-DEX support
- [ ] Multi-chain support

## Relationship to GraveYield

This repository is part of the GraveYield ecosystem.

The core protocol is maintained separately:

https://github.com/GraveYield/graveyield-protocol

The protocol defines the rules and settlement mechanism.

Salvor Bots provide autonomous infrastructure for operating within those rules.

## Disclaimer

Salvor Bots are experimental software.

Running a Salvor may result in transaction fees, failed transactions, market losses, or loss of assets. Operators are responsible for configuring and securing their own infrastructure and wallets.

Nothing in this repository constitutes financial, legal, or investment advice.
