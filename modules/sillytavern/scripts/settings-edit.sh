#!/bin/sh
# settings-edit.sh — read a JSON settings patch on stdin and apply it to
# SillyTavern's own config. The daemon also writes settings.env for the next
# launch; here we persist into SillyTavern's config.json so the change sticks.
# stdin = {"port":9001,"bind":"127.0.0.1","whitelist":[...],"enableApi":false,"theme":"dark"}
#
# This is intentionally minimal: parse the JSON keys we care about and rewrite
# the relevant config.json fields using node (always present with SillyTavern).
ST_DIR="${SYLVIA_TAVERN_DIR:-$HOME/SillyTavern}"
CFG="$ST_DIR/config/config.json"
PAYLOAD="$(cat)"
export PAYLOAD
export CFG
node -e '
	const fs = require("fs");
	let patch = {};
	try { patch = JSON.parse(process.env.PAYLOAD || "{}"); } catch { patch = {}; }
	let cfg = {};
	try { if (fs.existsSync(process.env.CFG)) cfg = JSON.parse(fs.readFileSync(process.env.CFG, "utf8")); } catch { cfg = {}; }
	if (patch.port != null) cfg.port = Number(patch.port);
	if (patch.bind != null) cfg.listenAddress = String(patch.bind);
	if (Array.isArray(patch.whitelist)) cfg.whitelist = patch.whitelist;
	if (patch.enableApi != null) cfg.apiEnabled = !!patch.enableApi;
	if (patch.theme != null) cfg.theme = String(patch.theme);
	fs.mkdirSync(require("path").dirname(process.env.CFG), { recursive: true });
	fs.writeFileSync(process.env.CFG, JSON.stringify(cfg, null, 2));
'
exit $?
