// SPDX-License-Identifier: Apache-2.0
//
// Reporter tests — event construction, memory sink assertions, JSONL file
// persistence, and the fail-open fan-out contract.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  MemoryReportSink,
  JsonlFileReportSink,
  ConsoleReportSink,
  composeSinks,
  makeEvent,
} from "../src/index.js";

describe("makeEvent", () => {
  test("pool + data are optional; tsMs is stamped", () => {
    const bare = makeEvent("info");
    assert.equal(bare.type, "info");
    assert.equal(typeof bare.tsMs, "number");
    assert.equal("pool" in bare, false);
    assert.equal("data" in bare, false);

    const full = makeEvent("candidate", "PoolAddr", { score: 1.5 });
    assert.equal(full.pool, "PoolAddr");
    assert.deepEqual(full.data, { score: 1.5 });
  });
});

describe("MemoryReportSink", () => {
  test("records everything and filters by type/pool", () => {
    const sink = new MemoryReportSink();
    sink.emit(makeEvent("cycle-start"));
    sink.emit(makeEvent("candidate", "PoolA", { score: 1 }));
    sink.emit(makeEvent("candidate", "PoolB", { score: 2 }));
    sink.emit(makeEvent("opportunity:salvageable", "PoolA"));

    assert.equal(sink.events.length, 4);
    assert.equal(sink.ofType("candidate").length, 2);
    assert.equal(sink.first("PoolA", "opportunity:salvageable")?.pool, "PoolA");
    assert.equal(sink.first("PoolB", "opportunity:salvageable"), undefined);
  });
});

describe("JsonlFileReportSink", () => {
  test("appends one JSON line per event and parses back", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-report-"));
    const file = join(dir, "events.jsonl");
    try {
      const sink = new JsonlFileReportSink(file);
      sink.emit(makeEvent("cycle-start"));
      sink.emit(makeEvent("opportunity:certification-ready", "PoolX", { firstEligibleEpoch: "10" }));

      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      const parsed = JSON.parse(lines[1] as string) as { type: string; pool?: string; data?: Record<string, unknown> };
      assert.equal(parsed.type, "opportunity:certification-ready");
      assert.equal(parsed.pool, "PoolX");
      assert.equal(parsed.data?.firstEligibleEpoch, "10");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("composeSinks", () => {
  test("fans out to every sink", () => {
    const a = new MemoryReportSink();
    const b = new MemoryReportSink();
    const composed = composeSinks(a, b);
    composed.emit(makeEvent("cycle-end"));
    assert.equal(a.events.length, 1);
    assert.equal(b.events.length, 1);
  });

  test("a throwing sink never blocks the others", () => {
    const good = new MemoryReportSink();
    const bad: { events: unknown[] } & { emit(e: unknown): void } = {
      events: [],
      emit(_e: unknown): void {
        throw new Error("disk full");
      },
    };
    const composed = composeSinks(bad as never, good);
    assert.doesNotThrow(() => composed.emit(makeEvent("info")));
    assert.equal(good.events.length, 1);
  });
});

describe("ConsoleReportSink", () => {
  test("is constructible and emits without throwing", () => {
    const sink = new ConsoleReportSink();
    assert.doesNotThrow(() => sink.emit(makeEvent("info", undefined, { quiet: true })));
  });
});
