#!/bin/sh
# backup.sh — default rclone sync of the configured paths to the configured
# remote. The daemon passes SYLVIA_MODULE_* settings (backup.remote/paths come
# from module.json; this script reads the env the daemon writes). Forced --json.
REMOTE="${SYLVIA_TAVERN_REMOTE:-gdrive:sylvia/backups/sillytavern}"
for p in "${SYLVIA_TAVERN_DATA:-$HOME/SillyTavern/data}" "${SYLVIA_TAVERN_CONFIG:-$HOME/SillyTavern/config}"; do
	[ -e "$p" ] || continue
	rclone sync "$p" "$REMOTE/$(basename "$p")" --json
done
