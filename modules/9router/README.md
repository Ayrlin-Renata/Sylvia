# 9Router module (example module — DESIGN.md §9)

[9Router](https://github.com/decolua/9router) is an open-source LLM router/proxy:
one local OpenAI-compatible endpoint (`/v1`) that fronts 40+ providers with
auto-fallback and token-saving. It is shipped here as the **reference module**
for Sylvia's module system: lifecycle scripts, a settings panel, and behavior
modes — nothing module-specific lives in the daemon.

## Behavior

`behavior: manual` — started only when you toggle it on (the control panel's
modules page, or `POST /api/modules/9router/on`); the last desired state is
restored when the daemon restarts. To let the **netgate** manage it (SIGSTOP on
metered/offline), change `"behavior"` to `"always"` in `module.json` and
restart the daemon — `always` modules auto-start with the daemon and register
as managed traffic.

## First start

The service is not pre-installed: the first `on` runs
`npm install --prefix <module dir> 9router` (network required, a few minutes —
its postinstall compiles a SQLite binding). Progress is in `install.log`.
Subsequent starts are instant.

## Settings (panel → settings-edit.sh)

| key | default | effect |
| --- | --- | --- |
| `port` | `20128` | service port (`PORT` env) |
| `bind` | `127.0.0.1` | bind address (`HOSTNAME` env) — keep it loopback |
| `initialPassword` | `sylvia` | dashboard password (`INITIAL_PASSWORD` env; whitespace rejected) |

Settings are written to `settings.env` by the daemon before every start and
validated by `scripts/settings-edit.sh` (bad values fail the API call with a
real error message).

## Files (in the module dir)

- `run.pid` — service pid (written by `on.sh`, removed by `off.sh`)
- `install.log` / `service.log` — first-run install output / service output
- `settings.json` — last applied settings (human-readable record)
- `node_modules/` — the 9router install (delete the module dir to uninstall)

## Using it

Dashboard: `http://127.0.0.1:20128` (login = the `initialPassword` setting).
OpenAI-compatible endpoint: `http://127.0.0.1:20128/v1` with an API key from
the dashboard — e.g. point any tool (including DSH's OpenAI-compatible provider
config) at it with `baseURL http://127.0.0.1:20128/v1`.
