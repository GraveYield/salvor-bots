// SPDX-License-Identifier: Apache-2.0
//
// Test-only stub over the ClaimsSnapshotter seam — lets executor/monitor
// tests drive pipeline behavior WITHOUT exercising artifact verification
// (verification coverage lives in fleet-core/test/snapshotter.test.ts and
// the pipeline end-to-end CLI test). NEVER import from production code.

import type {
  ClaimsSnapshotter,
  SnapshotterRequest,
  VerifiedClaimsSnapshot,
} from "../../src/index.js";

export function stubSnapshotter(
  world: { lpSupply: bigint; holders: ReadonlyArray<unknown> },
  opts?: { failWith?: Error; snapshotSlot?: number },
): ClaimsSnapshotter {
  return {
    async produceSnapshot(_req: SnapshotterRequest): Promise<VerifiedClaimsSnapshot> {
      if (opts?.failWith) throw opts.failWith;
      return {
        root: new Uint8Array(32).fill(7),
        totalSupply: world.lpSupply,
        snapshotSlot: opts?.snapshotSlot ?? 1_000_000,
        holderCount: world.holders.length,
        artifactSha256: "stub-artifact-digest",
        sinkLedgerSha256: "stub-ledger-digest",
        sinkLedgerId: "GY-SINK-STUB",
      };
    },
  };
}
