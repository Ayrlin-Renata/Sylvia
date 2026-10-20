# P2 SPIKE — cross-session APIs on DSH 0.2.1-alpha.5

Confirmed: `@deepseek-ai/dsh@0.2.1-alpha.5`. All `file:line` below are
`...\.pnpm\<pkg>_<hash>\node_modules\@deepseek-ai\<pkg>\lib\index.js`, abbreviated `<pkg>:line`.

## A. Skills reach

`ctx.skills` = `SkillRegistry` (`dsh-skill:119,131-135`).

**`register(skill)`** (`dsh-skill:193-215`) returns the Cordis effect disposer. Accepted shape
(validation `dsh-skill:465-469`, load-time validation `dsh-skill:471-490`, candidate projection
`dsh-skill:437-450`):

```js
{ name,            // required, /^[a-z0-9]+(?:-[a-z0-9]+)*$/  (dsh-skill:17)
  description,     // required, non-empty
  content,         // required at get() time (body markdown)
  whenToUse,       // optional
  invocation,      // optional, default {modelInvocable:true,userInvocable:true} (:203-206)
  source, provider,// optional strings; provider defaults to 'runtime' (:207)
  resourceBase,    // optional {kind:'directory',path}|{kind:'url',url}|{kind:'opaque',description}
  path, metadata } // optional passthrough
```

`register()` does **not** validate `content`; `get()` does (`dsh-skill:488`). Throws only on a bad
name or empty description.

**Where a registration lands** — `scopeOf(this.ctx)` (`dsh-skill:195`). From a plugin-level
(unscoped) ctx it enters the *global* layer; from inside an agent/preset scoped ctx it enters that
scope only. Reads merge `[global, ...viewingScopeChain]`, nearest layer winning (`:298-311`). **So:
register at plugin scope, never inside `setup(agentCtx)`.**

**Does it reach sessions created afterwards — and running ones?** Yes, both, and it is *not* a
system-prompt section. `dsh-system-prompt` has no skills section at all; the catalog is a user
message injected at `agent/pre-step` by `dsh-tool-skill` (`:931-964`): it calls
`ctx.skills.snapshot({cwd, signal, scope: agent})` on **every step of every turn** (`:935-938`),
digests the entries (`:947`), and injects either a fresh catalog (`:966-988`) or a replacement
(`:990-1013`) when the digest changes. A skill registered while a session runs lands on that
session's next step. Gate: `ctx.tools.get(skillTool.name, agent) === skillTool` (`:935`) — no `skill`
tool for that agent, no catalog.

**Subagents / `agents.create`?** Yes — each session runs its own pre-step against the same global
registry, so a globally registered skill is advertised in every child session too. A skill
registered inside a scoped ctx is *not* inherited by unrelated children.

## B. Cross-session reporting (the important one)

`ctx.agents` is `AgentRegistry` (`dsh-agent:322`), a process-local `store` Map (`:323`).

| method | citation | semantics |
|---|---|---|
| `agents.get(id)` | `dsh-agent:596-598` | **live only**, this process. Agent id === session id (enforced `:514`). |
| `agents.list()` / `roots()` | `dsh-agent:614,623` | live / live-and-unowned |
| `agents.resume({resumeSessionId, agentOptions?, setup?, signal?, parentAgent?}) → {agent, dispose}` | `dsh-agent:466-471`; `dsh-agent-loop:1963-1967,1970-2012` | loads the persisted log via `sessionPersistence.open`, appends crash closers, publishes a live root. |
| `agents.create(o)` | `dsh-agent:453-457` | as today |

There is **no** `sessions` lookup that yields a live agent (`SessionStore.get` returns the session
object, `dsh-session:1980`) and no cross-process lookup. The canonical resolve pattern is exactly the
shipped controller's (`dsh-api-session-controller:365-368,392-404`):

```js
const live = ctx.agents.get(sessionId)                        // fast path
if (live === undefined)
  ({ agent } = await ctx.agents.resume({ resumeSessionId: sessionId,
                                         agentOptions: { provider, model } }))
```

`resume` throws if a live session with that id already exists (`dsh-session:1805`), so always try
`get` first.

**Injection.** `agent.inject(input)` → `send(input, "next-step", false)`
(`dsh-agent-loop:812-814,800-805`). The inbox is **durable**: a session projection folded from
`agent/inbox/spliced` events (`:14-62`), so an injected message survives a restart and is replayed on
`resume`. With `wakeup:false` it **does not start a turn**: on an idle agent the message waits for the
next turn; on a *busy* agent it is claimed at the **next step boundary** (`:906,1007`), i.e. mid-turn.

**Starting a turn.** `followup(input)` → `("next-turn", true)` (`:806-808`); `steer(input)` →
`("next-step", true)` (`:809-811`). Idle ⇒ a turn opens immediately (`wakeDriver:854-875`). Busy ⇒
**nothing throws**: the message is queued and `wakeRequested` is latched (`:854-858`); a `next-turn`
message is consumed after the current turn ends (`:1037-1041`), a `next-step` message at the next
step boundary. `steer` is the supported "interrupt-ish" call; `cancel({kind:'user'})` clears the
inbox unless `{keepInbox:true}` (`:815-821`).

**Lifetime.** Nothing survives the process: re-resolve with `get() ?? resume()`. Worse, the handle is
*fiber-owned* — `create`/`resume` register a lifecycle effect on the **calling** ctx
(`dsh-agent-loop:1749-1764`), so reloading dsh-nuncia disposes every agent it created or resumed
(cancel cause `disposed`, `:1714`). Hold a *session id*, never an `Agent`.

**Visibility.** `session/event` is dispatched through the SessionStore's own ctx
(`dsh-session:1585-1592`, `emitCtx` `:1862`) with a `scopeTarget(session, …)` carrier; the scope
filter admits any **untagged** listener (`dsh-scope:327-338`). A plugin-level `ctx.on('session/event')`
therefore already receives events for *every* live session — including ones it never created. Only
`record.agent.session !== session` in the current listener hides them (index.js:626).

Sketch for dsh-nuncia:

```js
const CHATELAINE = 'session-…'                       // config, not created by us

async function chatelaine() {                         // never cache across turns
  const live = ctx.agents.get(CHATELAINE)
  if (live !== undefined) return live
  return (await ctx.agents.resume({ resumeSessionId: CHATELAINE,
    agentOptions: { provider, model } })).agent       // plugin fiber now owns it
}

async function report(text, { wake = false } = {}) {
  const agent = await chatelaine()
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-nuncia', form: 'notice',
              summary: boundContextSummary(text.split('\n')[0]) },
  })
  wake ? agent.followup(message) : agent.inject(message)   // durable either way
}
```

Caveat: if the same session is already live under another owner (the Web UI), `get()` returns it and
injection works; `resume` would throw.

## C. Question forwarding

`ask()` (`dsh-user-questions:668-691`) dispatches `this.ctx.waterfall(scopeTarget(agent, agent),
"user-questions/request", {...request, agent}, noAnswerer)` (`:681-684`), `noAnswerer` rejecting
`NO_PROVIDER` (`:679`). Cordis `waterfall` (`cordis:317-325`) runs listeners outermost-first with
signature **`(request, next)`**; `request = {questions, agent?, signal?, wait?}`. Return a value and
that value *is* `ask()`'s result; call `next()` to fall through to the real UI; do neither and the
built-in behaviour is vetoed.

Returning `{ answers: [{ id, selected: string[], custom? }] }` is what the caller accepts
(`dsh-user-questions:58-66`; copy-out `dsh-tool-ask-user:52-58,195-198`). A "skipped" answer is
`{id, selected: []}`; `{pending:true, callId}` is only for the timed variant
(`dsh-user-questions:640-643`).

You do **not** need to share the asker's fiber: `scopeTarget(agent, agent)` admits any listener whose
ctx is untagged (i.e. a plain plugin) plus listeners tagged inside that agent's scope chain
(`dsh-scope:331-334`); a listener tagged to a *different* agent is excluded. Registering with
`{global: true}` also bypasses the filter, as `dsh-user-questions` itself does for
`session/event` (`:498,511,515`).

Caller constraints: `ask()` requires the **exact live root** — `agents.get(agent.id) === agent` and
`agents.roots().includes(agent)` (`dsh-user-questions:531-535`), else `CALLER_NOT_LIVE` /
`DELEGATED_CALLER`. The operator session must be live and unowned or `ask` fails before your handler
runs.

```js
ctx.on('user-questions/request', async (request, next) => {
  const id = request.agent?.id
  if (id === undefined || !isOperator(id)) return next()    // never block the real UI
  const reply = await forwardToChatelaine(request)          // A2A round-trip
  return { answers: request.questions.map(q => ({ id: q.id, selected: [reply[q.id]] })) }
})
```

For a *human* answer that arrives late, the supported path is `userQuestions.answer(agent, callId,
{answers})` (`:552-588`), which steers a `user-question-reply` message — but that only works for
`continued` (timed-out) questions, not an open foreground wait.

## D. Unexpected ends

`turn/end` is appended exactly once per turn with `{turn, reason}` (`dsh-agent-loop:1029-1032`).
Live-observable `reason.kind` values:

| kind | when / payload | cite |
|---|---|---|
| `completed` | normal stop, or no tool calls | `:966,1163-1167` |
| `max-tokens` | finish reason max-tokens | `:1163` |
| `blocked` | first `agent/pre-step` returned `{kind:'reject'}` (e.g. archived-session gate) | `:961`; `dsh-api-session-controller:2516` |
| `aborted` | `{reason:{kind:'user'\|'parent'\|'disposed'\|'hook', reason?}}` | `:1010-1018,731-745` |
| `error` | `{error: LlmFailure \| {message, code:'UNKNOWN'}}` | `:1019-1025` |

`cancel()` maps to `user`; owner/fiber teardown to `disposed`; a pre-step hook veto to
`hook:{reason}`. Those five are live-observable. Two more exist **only in the stored log**, appended
by crash recovery and never published on `session/event` (seed events do not publish,
`dsh-session:1349`): `{kind:'interrupted'}` (`dsh-session:907-909,788-796`) and `{kind:'forked'}`.

**Available at that moment:** the event itself; the last assistant text via
`session.deriveMessages()` (`dsh-session:1672`) or your accumulated `assistant/message` parts;
per-message `usage` (`dsh-agent-loop:1156-1162`); `agent.status` (`:790-798`); the `agent/error` emit
with `{agent, turn, step, error}` (`:876-886`); `ctx.tokenMeter.measure(session, header)`
(`dsh-token-meter:722`).

**Death signals:** `session/disposed` (`dsh-session:1925-1937`) and `agent/disposed`
(`dsh-agent:549-563`). There is **no process-level death signal** and no "session deleted" event; a
killed process leaves an open turn that the next `resume` closes synthetically
(`dsh-agent-loop:1992-1993`).

**Existing bug to fix in P2:** index.js:643 tests only `kind === 'error'`, so an A2A
`cancelTask` (`aborted`) publishes `TASK_STATE_COMPLETED`. `aborted`, `blocked` and `max-tokens` are
all currently reported as success.

## E. Pruning + presets

`ctx.workspaceRegistry` = `WorkspaceRegistry extends Service` (`dsh-workspace:354-376`).

- `create(path, title)` (`:408-412`) — realpath-canonicalizes, needs an existing directory,
  idempotent per canonical path, returns the **entity**; `get(id)` / `list()` (`:445,454`).
- **Workspace entity** (not the registry) carries `attachSession(sessionId)` (`:111-129`) — validates
  the session's *stored header* `cwd` realpath equals the workspace path and prepends the id; also
  `detachSession` (`:148-153`), `setTitle` (`:105`), `insertSessionBefore` (`:130`).
- `delete(id)` (`:469-471`) — removes the **registration only**, retaining directory and every session
  log (`:461-468`).
- `archiveSession(sessionId, {stopActivity})` (`:526-541`) — durable set membership. Without
  `stopActivity` it asks `workspace/session-activity` and throws `WorkspaceActiveSessionError` if
  anyone reports activity ⇒ **idle required**. With `stopActivity:true` it writes first, then asks
  `workspace/session-stop`. It does **not** end the agent, delete files, or touch the log; the archive
  set gates future work — an archived session's `agent/pre-step` returns `{kind:'reject'}`
  (`dsh-api-session-controller:2516-2535`), surfacing as a `blocked` turn end.
- `unarchiveSession(sessionId)` (`:553`).

**No supported session-data deletion.** `sessionPersistence` is an append-only handle API
(`open`/`create`/`append`/`flush`/`close`, `dsh-session-persistence:241-267`); the only `delete` in
the shipped surface is `workspaceRegistry.delete(workspaceId)`. **Archive is the ceiling**; deleting
a session's events means going around the API.

**Presets.** A preset need **not** be a file in `$DSH_HOME/config/agent-presets`: the shipped
`dsh-agent-preset` plugin is just a Cordis row whose init calls `ctx.agentPresets.register(config)`
(`dsh-agent-preset:14-33`), config `{id, name?, description?, order?, plugins:[…]}`. So dsh-nuncia
can call `ctx.get('agentPresets').register({id, name, plugins})` itself
(`dsh-agent-preset-registry:470-494`, eager `activate` `:495-521`); `mount(ctx, id)` is the per-agent
binding used in `setup` (`:686-695`); `list()` `:570`, `resolve(id)` `:596`.

Constraint: rows mount via `prepareProfileEntries(ctx, plugins, ctx.baseUrl)` (`:226`) based on
`record.context.baseUrl` = the **agentPresets service ctx** (`:471,501`), not the calling plugin's.
Relative entries resolve from the profile root, so a preset in P2's own config directory must use
**absolute paths / `file:` URLs**.

## Verdict

**P2 can:** resolve any session to a live agent (`get` → `resume`) regardless of who created it;
deliver durable, silent reports into an idle chatelaine (`inject`) or wake it (`followup`/`steer`)
even mid-turn; observe every live session's events without owning it; auto-answer an operator's
`ask_user_question`; register skills globally (all sessions, subagents, and already-running ones) and
register presets programmatically; archive sessions so they stop waking.

**P2 cannot:** delete a session's persisted data (archive only); hold an `Agent` across a process
restart or a plugin reload (a reload *disposes* every agent the plugin created/resumed); see the
synthetic `interrupted` turn end of a crashed process via `session/event`; answer for an agent that is
not the exact live root.

**Smallest change forced on the design:**

1. Replace `record.agent` with `async resolveAgent(sessionId)` = `agents.get(id) ?? (await
   agents.resume({resumeSessionId:id, agentOptions})).agent`; call it per delivery, never cache.
2. Route chatelaine traffic through that resolver, defaulting to `inject` (silent, durable) and using
   `followup` only for explicit questions.
3. Drop the `record.agent.session !== session` ownership filter in the `session/event` listener and
   key routing on session id; otherwise the chatelaine's replies are invisible.
4. Register the `user-questions/request` handler at plugin scope and always `next()` for ids it does
   not own.
5. Widen the `turn/end` triage to `aborted` / `blocked` / `max-tokens` and read
   `reason.error?.message ?? reason.message`; treat `aborted` as not-completed.
6. Register skills at plugin scope, never inside `setup`.
