import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

// Drive a real MCP stdio handshake: initialize -> notifications/initialized ->
// tools/list, then assert the three tools are registered. This mirrors exactly
// what @deepseek-ai/dsh-mcp-client does when it connects.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const child = spawn(process.execPath, ["index.js"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});
child.on("error", (e) => { console.error("spawn error:", e.message); process.exit(1); });

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "handshake-test", version: "0.0.0" }
});
assert.equal(init.result.serverInfo.name, "sylvia-mcp", "server name");
assert.ok(init.result.capabilities.tools, "advertises tools capability");
console.log("initialize: OK ->", init.result.serverInfo.name, init.result.serverInfo.version);

notify("notifications/initialized", {});

const list = await request("tools/list", {});
const names = list.result.tools.map((t) => t.name).sort();
assert.deepEqual(
  names,
  [
    "discovery_scan",
    "network_state",
    "rclone_exec",
    "resilient_adb_exec",
    "resource_call",
    "resource_list",
    "resource_resolve",
    "tasker_write_and_reload",
    "traffic_gate"
  ],
  "exactly the nine tools registered"
);
console.log("tools/list: OK ->", names.join(", "));

// Every tool must expose a JSON-Schema object input (the DSH bridge validates).
for (const t of list.result.tools) {
  assert.equal(t.inputSchema.type, "object", `${t.name} inputSchema.type=object`);
  assert.ok(typeof t.description === "string" && t.description.length > 20, `${t.name} has a real description`);
  console.log(`  ${t.name}: ${Object.keys(t.inputSchema.properties).join(", ") || "(no params)"}`);
}

child.stdin.end();
child.kill();
console.log("HANDSHAKE: all assertions passed");
