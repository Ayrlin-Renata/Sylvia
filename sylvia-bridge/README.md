# sylvia-bridge

DeepSeek Harness plugin that makes the agent network-aware: when the phone is on
metered data (or has no usable network), the harness pauses — and on reconnect
it tells the model exactly how long it was paused and what work is parked.

Pausing the *harness* is one of Sylvia's two independent stops; pausing
*rclone / mDNS / mitmproxy* is sylvia-daemon's netgate (SIGSTOP), see
`../sylvia-daemon`. This plugin never touches external services.

## What it does

1. Every `pollIntervalMs` it samples network state from **sylvia-daemon**
   (`GET /api/network`), falling back to `~/.sylvia/netstate.json` if the
   daemon HTTP API is down. Stale samples (> `staleAfterMs`) count as unknown.
2. On a transition into **metered / no-network** it gates every agent:
   - `pauseMode: 'finish-stream'` — the in-flight model stream is allowed to
     commit, then the turn is cancelled with `keepInbox: true` (queued work
     survives for a later turn).
   - `'immediate'` — the running turn is cancelled at once.
   - New work arriving while held is cancelled in both modes.
3. On return to unmetered, with the locked defaults
   (`resumeOnReconnect: false`, `notifyPausedWork: true`) it **injects** a
   pending notice — no model request is spent — describing the pause duration
   and the held-task count, so the next user message carries
   *time-elapsed-while-offline* context. No automatic resume: the user asks.

## Config

Set in the profile's `cordis.patch.yml` (see `cordis.patch.yml` in this package
for the full annotated template). All keys optional:

| Key                  | Default                     | Meaning                                                    |
| -------------------- | --------------------------- | ---------------------------------------------------------- |
| `enabled`            | `true`                      | Master switch.                                             |
| `onMetered`          | `pause`                     | `pause` gates agents; `allow` observes only.               |
| `pauseMode`          | `finish-stream`             | `finish-stream` \| `immediate`.                            |
| `resumeOnReconnect`  | `false`                     | `true` releases held work via `followup` (spends a turn).  |
| `notifyPausedWork`   | `true`                      | Inject the pause notice on reconnect.                      |
| `onUnknown`          | `allow`                     | Daemon unreachable: `allow` (desktop-safe) \| `pause`.     |
| `daemonUrl`          | `http://127.0.0.1:3090`     | sylvia-daemon control API.                                 |
| `stateFile`          | `~/.sylvia/netstate.json`   | Fallback snapshot.                                         |
| `pollIntervalMs`     | `10000`                     | Sample cadence.                                            |
| `staleAfterMs`       | `60000`                     | Older samples = unknown.                                   |

## Install

```sh
cd ~/.dsh/profiles/web
npm install <path-or-git-url-to-this-package>
# add to package.json dsh.profile.bundles: "sylvia-bridge"
# patch file ships an insert row for cordis.patch.yml (see dsh plugin add)
```

Or from a profile directory: `dsh plugin --profile web add <source>` — the
package declares `dsh.bundle`, so the bundles entry and patch row are applied
automatically.

## Notes

- Cancel cause is `{ kind: 'hook', reason: 'sylvia-netgate: …' }` — visible in
  the session timeline as a plugin-originated interruption.
- `keepInbox: true` means parked messages are not thrown away; with
  `resumeOnReconnect: false` nothing releases them automatically — a followup
  message from the user (or the future control panel) resumes the work.
- If the daemon dies while the gate is held, `onUnknown: 'allow'` releases the
  harness so a desktop dev session is never bricked by a missing daemon.
- Tests: `npm test` (pure core + sample sourcing; no harness required).
