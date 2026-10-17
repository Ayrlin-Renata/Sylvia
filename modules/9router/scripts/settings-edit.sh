#!/data/data/com.termux/files/usr/bin/bash
# 9router settings-edit.sh — apply a settings patch (§9.2 contract).
# The daemon has ALREADY persisted settings + rewritten settings.env when this
# runs and passes the JSON patch on stdin; our job is value validation and
# module-local config. Exit non-zero → the API call fails with our stderr, so
# the panel shows a real error instead of silently accepting garbage.
set -u
MOD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MOD_DIR" || exit 1

node -e '
const fs = require("node:fs");
let s = "";
try { s = fs.readFileSync(0, "utf8"); } catch { console.error("settings-edit: no JSON on stdin"); process.exit(1); }
let o;
try { o = JSON.parse(s); } catch (e) { console.error("settings-edit: invalid JSON: " + e.message); process.exit(1); }
if (o === null || typeof o !== "object" || Array.isArray(o)) { console.error("settings-edit: expected a JSON object"); process.exit(1); }
const errs = [];
if ("port" in o) {
  const p = Number(o.port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) errs.push("port must be an integer 1-65535");
}
if ("bind" in o && (typeof o.bind !== "string" || o.bind.length === 0)) errs.push("bind must be a non-empty string");
if ("initialPassword" in o) {
  if (typeof o.initialPassword !== "string" || o.initialPassword.length === 0) errs.push("initialPassword must be a non-empty string");
  // settings.env is KEY=value with unquoted values (daemon-generated) — a
  // password with whitespace would corrupt it when the module sources it.
  else if (/\s/.test(o.initialPassword)) errs.push("initialPassword must not contain whitespace");
}
if (errs.length) { console.error("settings-edit: " + errs.join("; ")); process.exit(1); }
fs.writeFileSync("settings.json", JSON.stringify(o, null, 2) + "\n");
' <<< "$(cat)"
