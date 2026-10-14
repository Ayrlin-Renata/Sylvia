import assert from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rcloneJson } from "../src/rclone.js";
import { loadConfig } from "../src/config.js";

// Echo argv back as JSON so we can assert on exactly what rcloneJson built.
// rcloneJson runs: <binary> <args...>. Set binary = node, and the first arg is
// this script; everything after lands in process.argv.slice(2).
const dir = await mkdtemp(path.join(tmpdir(), "sylvia-rclone-"));
const printer = path.join(dir, "printargs.mjs");
await writeFile(printer, "console.log(JSON.stringify(process.argv.slice(2)))\n");

const cfg = loadConfig({ SYLVIA_RCLONE_PATH: process.execPath });

// 1. --json appended when the caller didn't pass it.
let r = await rcloneJson(cfg, [printer, "sync", "src:dst"]);
assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode} stderr=${r.stderr}`);
assert.deepEqual(r.json, ["sync", "src:dst", "--json"], "appends --json, parses stdout");
assert.ok(r.args.includes("--json"), "args array carries --json");

// 2. --json NOT duplicated when already present.
r = await rcloneJson(cfg, [printer, "size", "remote:x", "--json"]);
assert.equal(r.exitCode, 0, "exit 0 with explicit --json");
assert.deepEqual(r.json, ["size", "remote:x", "--json"], "does not duplicate --json");

// 3. no --json added for --help (flagLike guard).
r = await rcloneJson(cfg, [printer, "--help"]);
assert.equal(r.exitCode, 0, "exit 0 for --help");
assert.ok(!r.json.includes("--json"), "does not append --json to --help");

// 4. rejects empty args.
await assert.rejects(() => rcloneJson(cfg, []), /non-empty/, "rejects empty args");

await rm(dir, { recursive: true, force: true });
console.log("rclone: OK (json append / dedup / help / validation)");
