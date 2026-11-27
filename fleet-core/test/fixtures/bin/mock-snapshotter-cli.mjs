#!/usr/bin/env node
// D3 test fixture — a mock `grave-snapshotter-cli` boundary.
//
// Behaviour is selected with GY_MOCK_MODE:
//   success    — copy GY_MOCK_ARTIFACT bytes to the --out path, exit 0
//   exit       — emit a message on stderr, exit 3
//   garbage    — write non-JSON bytes to the --out path, exit 0
//   hang       — ignore SIGTERM (defer it), forcing the runner's escalation
//   oversize   — write GY_MOCK_OVERSIZE_BYTES junk bytes to --out, exit 0
//
// When GY_MOCK_ARGV_DUMP is set, the process writes its argv (JSON) to
// that path first — tests use it to prove explicit-argv, no-shell
// invocation and that --lock-evidence rpc / --sink-ledger are always
// supplied. The mock NEVER touches the network.

import { readFileSync, writeFileSync } from "node:fs";

const argvDump = process.env.GY_MOCK_ARGV_DUMP;
if (argvDump) {
  writeFileSync(argvDump, JSON.stringify(process.argv.slice(2)));
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.env.GY_MOCK_MODE ?? "success";
const out = argOf("--out");

if (mode === "hang") {
  // Defer SIGTERM by ~10s so the runner's SIGKILL escalation is exercised.
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(1), 10_000).unref();
  });
  setInterval(() => {}, 1000);
} else if (mode === "leak") {
  // Adversarial: echo the credential-bearing URL handed via --url to
  // stderr, then exit nonzero — proves the runner redacts CLI stderr.
  const url = argOf("--url") ?? "";
  process.stderr.write(`connect failed: dial tcp: lookup ${url}: no such host\n`);
  process.stderr.write(`retrying https://user: hunter2@example-internal.invalid/rpc?token=zzz\n`);
  process.exit(3);
} else if (mode === "exit") {
  process.stderr.write("mock: simulated snapshot build failure\n");
  process.exit(3);
} else if (mode === "garbage") {
  writeFileSync(out, "this is not json");
  process.exit(0);
} else if (mode === "oversize") {
  const n = Number(process.env.GY_MOCK_OVERSIZE_BYTES ?? "1024");
  writeFileSync(out, Buffer.alloc(n, 0x41));
  process.exit(0);
} else {
  // success
  const artifactPath = process.env.GY_MOCK_ARTIFACT;
  if (!artifactPath) {
    process.stderr.write("mock misconfigured: GY_MOCK_ARTIFACT missing\n");
    process.exit(4);
  }
  writeFileSync(out, readFileSync(artifactPath));
  process.exit(0);
}
