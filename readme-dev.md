This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

### Lody subagent event transport

The event contract is supplied by the published Core 0.1.9 dependency.

Clients advertising `_meta.lody.subagentEvents: {version: 1}` receive Core
`_lody/subagents/event` notifications. Child execution IDs are scoped to the root
ACP session and generated afresh for reactivated terminal children. Child text,
thinking, tool and plan output stays in that run's stream. Legacy task metadata
is suppressed for normalized runs. Clients without this capability retain the
existing native-subagent or ordinary tool-call representation.

A snapshot precedes child output, including when output arrives before the
activity name. Later activity notifications refresh the name without replacing
the run. Monitoring timeouts and prompt cleanup report incomplete, unknown
observation; only native child completion proves success/failure/cancellation.
There is no durable run recovery or output replay. This adapter currently advertises
no run cancellation, output query, or numerical progress support.

Known child permission and elicitation requests use the root ACP session with
`_meta.lody.subagentRunId` and `subagentToolCallId`. Consent tool IDs are namespaced
by run, while canonical child output retains native tool IDs. Only consent tools
are mirrored into root updates for the existing permission UI. Unknown child
interactions are rejected; no permission or root cancellation is inferred from
child output.

| Workflow | Native lifecycle | Completion boundary |
| --- | --- | --- |
| Manual `/compact` | `thread/compact/start`, then `turn/started` | Matching `turn/completed`, including failure or interruption |
| Stop during compaction | `turn/interrupt` for the captured thread and turn | The prompt remains owned until the native turn ends or the connection closes |

The compact start and interrupt responses only acknowledge their requests.
Cancellation before the native turn arrives is retained and interrupts that turn
when its id becomes known. Only the matching native terminal notification can
complete compaction; local interruption fallbacks and compaction item notifications
cannot release its prompt. See the [cancellation boundary decision](.agents/notes/implemented/bug-fix/2026-09-12-native-compaction-cancellation.md).

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config. `hooks` move to App Server startup (`-c hooks=...`) for AIR review; Codex rejects malformed hooks at startup and `initialize` reports its error.
- `LODY_CODEX_PROFILE_CONFIG` - host-owned nonsecret JSON config also supplied as native startup `-c` options, so keyring and provider selection apply before app-server initialization. Managed profiles use a per-launch loopback capability instead of an upstream API key.
- `LODY_CODEX_PROCESS_TOKEN` - optional nonsecret host-generated UUID identifying one native process use. With managed config and `CODEX_HOME`, the host must first create `../processes/<token>.json` containing `{version: 1, token}`. The adapter writes only the corresponding `<token>.native.json` PID/exit proof and removes the token from native child env. Independent tokens permit concurrent processes for the same home; unknown state delays host credential deletion only. Windows command shims use cross-spawn argument escaping and hide their console; a profile without a process token emits no usage proof. See [the process boundary decision](.agents/notes/proposed/architecture/2026-09-26-managed-profile-process-usage.md).
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, `agent-auto-review`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs. App-server stderr always forwards to the adapter's own stderr while the child lives, independent of this variable; the file copy under `<dir>/app-server.log` stays opt-in. stdout remains JSON-RPC only.

For a managed ChatGPT profile, a native session-open error never triggers the
adapter's legacy automatic logout: another process may already have refreshed
the shared keyring entry. The failing session reports the native error without
deleting credentials. This does not coordinate native refreshes across processes.
`node --import tsx scripts/probe-refresh-contention.mjs` demonstrates the
remaining race with two pinned native processes, synthetic file-backed tokens,
and an isolated local refresh endpoint; it uses no real account or keyring.
- `CODEX_ACP_APP_SERVER_CRASH_LIMIT` - how many crashes of the Codex app-server in the crash window stop its automatic restart (default `5`).
- `CODEX_ACP_APP_SERVER_CRASH_WINDOW_MS` - the crash window in milliseconds (default `300000`, 5 minutes).

### Quick start

#### Develop on Windows?

- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

#### Adjust ACP client config

Run from sources

1. Install dependencies `npm install`
2. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/path/to/project/"],
      "env": {
        "CODEX_PATH": "node_modules/.bin/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries

1. Download an `acp-extension-codex-<arch>-<platform>.zip` archive from https://github.com/Leeeon233/acp-extension-codex/releases (`<arch>` is `x64` or `arm64`; `<platform>` is `linux`, `darwin`, or `windows`).
2. Unzip the archive:
   ```bash
   unzip acp-extension-codex-<arch>-<platform>.zip
   ```
3. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/acp-extension-codex",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Build binaries

Building standalone binaries requires [bun](https://bun.com/docs/installation).

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Update the `@openai/codex` version in `package.json` (under `dependencies`).
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`

### Test suites

- `npm test`: behavior tests, primarily with a mocked Codex app-server; the native client suite also starts Codex.
- `npm run test:integration`: real codex-acp plus a real `codex app-server`. The model is a local mock of the
  OpenAI Responses API (`src/__tests__/integration/mock-responses-server.ts`) reached through the `gateway`
  auth method, so no API key or network is needed. Tests script model replies with `textResponse`,
  `execCommandResponse` and `applyPatchResponse`.
- `npm run test:e2e`: real OpenAI model. Builds first and requires `RUN_E2E_TESTS=true` (set by the script)
  plus `OPENAI_API_KEY` or `CODEX_API_KEY` in the environment.

## Plan configuration

Codex translates Core’s boolean `plan_mode` option to its native default/plan collaboration state. Approval and sandbox settings are retained. The `/plan` command uses the same boolean configuration path. A standalone `/plan` toggles the mode without starting a turn. `/plan <prompt>` enables plan mode (including when already enabled), removes only the command prefix, and submits the remaining text and attachments through the normal prompt lifecycle. A following content block also counts as a prompt. Configuration failures do not submit the prompt.

## Steering delivery reconciliation

After a failed `turn/steer` response, the adapter keeps the original thread id,
turn id, and steer id while draining received notifications. Unless Codex explicitly
refused the steer, it then performs one history lookup: metadata via `thread/read`,
followed by `thread/turns/list` pages for paginated stores, or
`thread/read(includeTurns: true)` for legacy stores. A matching
`userMessage.clientId` in the original turn emits the same applied notification as
the live event, at most once. Normal successful responses retain the existing live
notification path.

Notification drain and history lookup share a five-second budget; a live applied
event can finish reconciliation while the read is pending. Missing history, an
unsupported/failed read, timeout, or a completed/interrupted turn do not prove
non-delivery. Without positive evidence, an ambiguous response still rejects the
request so the host preserves `unknown`. Late read results cannot acknowledge after
that verdict. No steer retry, new turn, session resume, or cross-restart recovery is
performed. See [the protocol](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming).

## Codex 0.154 compatibility

The production `createAcpAgentRouter` registers Core `sessionHistoryRead` and
`rateLimitsGet` on both ACP v1 and v2. History transport tests must use this router,
not the legacy `createCodexAcpApp` assembly, so advertised capabilities are tested
against the entry point used by `src/index.ts`.

The Core session-history endpoint and steer reconciliation use the same read-only
history reader as session loading. Paging never resumes a thread or replays input.
Loading uses the resume cursor to separate stored history from live events.

Core v1 elicitation retains short headers, question descriptions, optional choice
fields with `customAnswerFor`, secret flags, and timeouts expressed in seconds.
A custom answer takes precedence over a selected option and is translated to
Codex's `["None of the above", "user_note: ..."]` convention. It is not presented
as an additive note for legacy clients.

With Core 0.1.6, clients advertising both ACP form elicitation and
`clientCapabilities._meta.lody.elicitation: { version: 1, answerNotes: true }`
receive a required choice (including an explicit, nonduplicated "None of the
above" option) and an optional string property carrying `noteFor`. A selected
answer and its nonempty note become `["<selected answer>", "user_note: ..."]`
without replacing the selection. Notes without a selection or with a non-string
value are ignored; empty notes are omitted. Secret flags, collision-safe field
keys, short headers, question text, and timeouts retain their Core meanings.
Missing, malformed, or unsupported capability declarations use the legacy
`customAnswerFor` flow. Installing Core alone does not enable this capability
in Lody: the client must implement editing, submission, persistence, and replay
before advertising support. AIR extensions are unaffected.

Standard ACP tool-call `name` values coexist with Core's provider-neutral image
generation marker. Plan mode, usage accounting, goal continuations, fork turn IDs,
worktree project ownership, and structured notices retain their Core contracts.

### AIR diff statistics

See the [diff statistics specification](docs/diff-statistics-extension.md) for the
`_meta.jetbrains.air.diffStats` payload and its compatibility rules.


### Native instant steering

Codex 0.160.1 includes the experimental, default-off `features.instant_interrupt` flag.
For an opt-in trial, merge `{"features":{"instant_interrupt":true}}` into `CODEX_CONFIG`.
The adapter still sends `turn/steer`; the native runtime controls delivery timing.
This flag preempts model sampling and yields foreground code-mode observations on new
user input. It does not promise immediate preemption of every native tool: ordinary
in-flight tool outputs can still be drained before the next sampling request.
See [the pinned feature definition](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/features/src/lib.rs)
and [the sampling loop](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/session/turn.rs).

## Upstream merge (2026-10-27)

Merged upstream main `0539d3d` (28 commits). The adapter now uses ACP SDK 2.0.2
and Codex 0.164.0; Lody package version 1.12.0 and Core 0.1.9 are retained.
SDK extension imports use `/unstable` (v1) and `/experimental/v2/unstable` (v2).

Client integration changes to review:

- Standard subagent conversations support live and recorded output, historical outcomes,
  read-only configuration, and cancellation of observable owned children. Core clients
  advertising Lody subagent events keep that transport; AIR keeps its existing contract.
- V2 session responses include initial commands. Later command changes are refreshed and
  deduplicated; skills discovery no longer runs on every prompt.
- V2 reports structured prompt failures and foreground state, including autonomous native
  turns. Hosts must not assume every running/idle pair corresponds to a submitted prompt.
- Session instruction changes append client system prompts and serialize reloads against
  prompts and configuration changes.
- AIR `sessionBatchGet` enables `_session/batch_get` to refresh metadata for saved session
  IDs without paging through history. Missing IDs are omitted, not proof of deletion.
- Visualize is disabled by the adapter. Native image-generation events can carry file IDs
  instead of inline image results.

Conflict resolution preserves Core steering acknowledgements, native turn usage accounting,
managed profiles, project trust and identity, title ownership, and compact/review cancellation.
Provider errors remain structured metadata with internal instruction tails removed.
Recorded child configurations from older runtimes may omit reasoning effort; those values
remain unknown rather than preventing session load. Historical children do not gain live
state or cancellation capabilities merely because their parent resumes.

## Upstream merge (2026-10-16)

Upstream main `59974c7` restores ACP v2 alongside v1. Protocol negotiation happens
at initialize; v2 prompt responses acknowledge insertion with a message id, while
`state_update` reports running and idle. Hosts using v1 retain its prompt-completion
contract. The package keeps its Lody release version, Core 0.1.9, SDK 1.5.x, and
Codex 0.160.1.

This merge adds v2 AIR session indexes, Codex-created worktree markers, held fork
list notifications until the fork response, gateway model-list filtering, clearer
errors for deleted working directories, and subagent follow-up turns and edit reports.
AIR-specific features still require negotiated client capabilities. A gateway's
successful model listing can narrow available models; see the gateway contract below.

Core steering remains inject-or-refuse; usage remains scoped to native turns;
compact/review cancellation waits for native completion; managed profiles,
worktree projects, startup model selection, and structured notices remain intact.
Automatic title generation remains the ACP client's responsibility: the adapter
never starts an auxiliary title turn. Explicit session-index renames are supported.

## Project trust

Opening a new, loaded, resumed, or forked session automatically persists trust for its
canonical execution directory in the running Codex process's user configuration, before
skills, MCP discovery, and thread configuration load. This also covers externally created
worktrees. The adapter uses `config/read` and `config/batchWrite`, follows the native user
configuration layer (including managed `CODEX_HOME`), and merges only that directory's
`trust_level`. Existing explicit `untrusted` entries for the directory remain untrusted
in both stored and session configuration.

Additional directories retain their existing session-only behavior. Logical project roots
from `worktreeProject` and parent directories receive no persistent grant. Configuration
is read once and written at most once with an expected version. Conflicts and other
read/write failures abort session establishment; the caller decides whether to try again.
The execution directory must already exist; path-resolution errors are propagated. There
is no process cache, so subsequent opens observe edits made by another client. Trust is not rolled back when a
later session-open step fails, and worktree deletion does not remove its saved entry.

This policy is internal to the Codex adapter; ACP Core gains no new interface. It does not
suppress warnings or retroactively change app-server initialization that happened before
the ACP client supplied a cwd. See the [decision note](.agents/notes/implemented/bug-fix/2026-10-14-project-trust-persistence.md).

## Startup model selection

Core's `_meta.lody.sessionConfig` version 1 supplies optional `modelId` and a `configOptionValues` dictionary on new/load/resume/fork. The adapter applies model and reasoning to native configuration before establishing the thread. Explicit `modelId` wins over the `model` option; `reasoning_effort` wins over a legacy `model[effort]` suffix. Missing selection preserves native defaults, while malformed selection fails with invalid params. Other options still use live ACP configuration. Native model-mismatch warnings are preserved for intentional switches.

### Unsupported skills

The adapter disables Codex skills whose output ACP clients cannot show, and leaves them out of the skill commands and
`/skills`. The list is in `src/UnsupportedSkills.ts`. Today it holds Codex's bundled Visualize skill: it ends a reply
with a content reference that only the OpenAI apps render, so ACP clients show raw `visualize{...}` text.

The adapter matches skills by name, so it needs no `skills/list` request when a session starts. The cost: a skill from
another plugin with the same qualified name, such as a `visualize` skill in some other plugin named `visualize`, is
disabled too.

### App-server recovery

The adapter restarts the Codex app-server when it dies (for example, killed for lack of memory). Its code is in
`src/app-server-recovery/`.

- A request that was waiting on the dead app-server fails with error `1001` and the cause, such as "was killed by
  SIGKILL, which usually means it ran out of memory". A running prompt ends at once: open tool calls become `failed`,
  open permission dialogs are cancelled, and an AIR client gets the `transport_lost` session failure.
- An app-server that exits before its `initialize` handshake succeeded, such as one that rejects its startup config,
  fails the request with "Codex process has exited with code N:" and its stderr, and no promise of a restart.
- The next request starts a new app-server with the same `initialize` handshake and provider routing. A session that
  was open is resumed on its next use, with the model, mode and settings that the adapter kept.
- Codex writes a thread to disk only with its first message, so a session without messages cannot be resumed in a new
  app-server, after a crash or a provider restart. Its next use fails with "had no messages yet and was lost"; the
  client starts a new session. A provider restart still completes for the agent and the other sessions.
- After `CODEX_ACP_APP_SERVER_CRASH_LIMIT` crashes in the crash window the adapter stops restarting it and says so,
  with the stderr of the last crash.
  A session that the app-server died opening twice in 30 minutes is not opened again for the rest of that time, so
  one session that is too large for the memory cannot take the other sessions down with it.

### ACP v2 support

The agent speaks both ACP v1 and the unstable ACP v2 (Draft) protocol from the same process; the
version is negotiated on the first `initialize` request and fixed for the connection's lifetime.

The v2 chain registers: `initialize`, `session/new|list|close|delete|resume` (v2 folds `session/load`
into `session/resume` with `replayFrom`), `session/set_config_option`, `session/cancel`,
`auth/login|logout`, `session/prompt` (plus `$/cancel_request`), `session/fork`, and
`providers/list|set|disable`. Unstable extension methods on top of that: `_session/steering`,
`_session/goal` (set/pause/resume/clear), `_session/async_task/stop`, and the AIR session index
requests (`_session/rename`, `_session/archive|unarchive`, `_session/list/subscribe|unsubscribe`).
`session/fork` drops the
v1 `modes` field (v2 removed the modes API in favor of config options), and forked sessions do not
get an `available_commands_update`, matching v1. There are no new environment/config knobs specific
to v2; it reuses the runtime environment variables above.

#### Client system prompts

Both ACP versions advertise `systemPrompt: {}`: text-only `append` mode. Override and non-text
content are rejected with `-32602` before a session is created or a fork is made.
Text blocks are joined with a blank line and appended to the existing developer-instruction
baseline: AIR `customInstructions` when supplied, otherwise configured Codex developer instructions.
Codex's base instructions and workspace context remain intact. Requests without `systemPrompt`
keep the legacy AIR behavior.

New sessions use the instructions on their first turn. A changed prompt on an idle, persisted
session detaches and reloads that thread under the same session ID. **The retained model context
changes at the next compaction**, not immediately after resume; the adapter does not force a
compaction. Forks with changed instructions have the same deferred behavior.

Changed prompts are rejected while session work or background terminals are running, when a live
session has no saved rollout yet, or when Codex cannot confirm a reload. Existing work is not
cancelled. Retry after work finishes, or create a new session for immediate instructions.
New prompts, steering, and config changes cannot race an instruction reload.

Omitted/null prompts keep the instructions known to the currently open adapter session, including
through app-server recovery and provider restarts. After closing a session or restarting the
adapter, clients should resend their prompt on load/resume/fork; without it, Codex's retained
context and configured defaults determine the instructions.

#### Manual compaction

`/compact` finishes foreground work only after Codex reports `turn/completed` for the compact
turn. Item completion still reports compaction progress, but does not release the next prompt.
The v1 prompt response and v2 idle state wait for the turn to finish; v2's early prompt-acceptance
response is unchanged.

#### AIR v2 client contract

These are behaviors the AIR (JetBrains) ACP client relies on that aren't obvious from the wire
schema alone:

- Initial commands come from `availableCommands` in v2 `session/new`, `session/resume`, and
  `session/fork` responses, not an initial `available_commands_update`. Later command changes still
  use notifications. Text inputs use `type: "text"`, and AIR command actions and skill paths are
  preserved. Skill discovery is best-effort: setup succeeds without initial commands if it fails.
- Failed foreground work ends with `state: "idle"`, `stopReason: "error"` and a standard `error`
  object containing `code` and a user-facing `message`. Before insertion, the prompt also fails
  with a JSON-RPC error; after insertion, its successful `messageId` response is not revoked.
  Cancellation remains `cancelled`. Retries, individual failed tools, and idle background errors
  do not become terminal session failures. Raw process stderr and opaque error data are not sent
  in the standard error object.
- On a failed prompt, read `sessionFailure` (`_meta.jetbrains.air.sessionFailure`) and `quota`
  (`_meta.quota`) from the idle `state_update` that ends the turn, not from a separate error
  channel. The same `_meta` v1 attaches to `PromptResponse` is copied onto the v2 idle update.
- Custom session updates are renamed on v2: `subagent_spawned`/`subagent_state_update` become a
  single `_subagent_update` (gated on the AIR `nativeSubagentSessions` capability; this contract is
  retained independently of standard subagent sessions), and
  `async_task_spawned`/`async_task_state_update` become `_async_task_spawned`/`_async_task_state_update`
  (gated on the AIR `asyncTasks` capability). Payload shapes are unchanged.
- The SDK client treats any `idle` state update as the stop of whichever prompt is pending, not just
  one paired 1:1 with a `session/prompt` call.
- A steer (`_session/steering`) requires the host-provided `steerId` on both versions.
  It shows a v2 user message only after matching `item/completed(userMessage)` or history evidence;
  the same identity emits `_lody/session/steer_applied`. Proven non-delivery is `-32600`; the adapter never
  starts a fallback turn. See steering delivery reconciliation above.

- Foreground state is independent of prompt acceptance. `running` can precede the user-message
  echo, including while Codex runs hooks. A successful prompt response still waits for insertion.
- Every successful `session/resume` sends a current-state snapshot after any replay and before its
  response. An idle snapshot is not another completed turn and repeats no usage or failure metadata.
- Permission and elicitation requests affect aggregate foreground state: another runnable item keeps
  the session running, and answering one wait does not resume work that remains blocked. Withdrawing
  a request on cancellation does not resume the workflow; late answers cannot revive an ended turn.
- On cancel, any permission or elicitation request still waiting on a client response is withdrawn
  with `$/cancel_request`, not just the underlying Codex turn.
- Turns Codex starts on its own (goal auto-turns, e.g. after `session/resume` or `session/new`) are
  rendered the same as prompted turns (`running` then one `idle`) but with no corresponding
  `session/prompt` call — clients should not assume every `running`/`idle` pair has a matching
  outbound prompt.
- After a tool call streams terminal output as `terminal_output_chunk`s, completion does not resend a
  full `output` snapshot; the streamed chunks are the only copy of the output.
- The AIR tool call contract (`docs/air-extensions.md`) does not apply on v2: every v2 client gets
  the standard tool call reports, so `rawInputRendering`, `planContentDelta` and `diffPatch` are not
  offered there. A read, search or list command has no terminal; its output arrives as `content`
  text when it completes. A file change sends one diff per file whose Git patch is built from the
  Codex diff.
- The AIR `sessionIndex` extension (`docs/air-extensions.md`, "Session index") works as on v1: a
  client that declares `sessionIndex` gets it, `session/list` reads `_meta.jetbrains.air.list`, and
  rows, `session_info_update`s and `_session/list/changes` carry the same `_meta`.
- Other AIR `_meta` keys (goal, message phase, mode kind, permission presentation) go only to AIR
  clients, as on v1. Every v2 permission request still gets its prompt `title` and `description`.

#### Live standard subagent sessions

Clients advertising Lody subagent events keep the Core transport described above. Otherwise,
non-AIR v1 clients opt in with `clientCapabilities.subagents: {}` and non-AIR v2 clients use
standard `subagent_update` associations automatically. AIR keeps its existing opt-in, updates,
and generation-based identities; clients do not receive multiple contracts.

A standard child keeps one opaque conversation ID across assignments and parent handler changes.
Its ancestors are announced before its output, tool updates, or interactions. Permissions and
elicitation use the child's ID and survive parent replay; actual work endings withdraw obsolete
requests locally, even if the client returns a late answer. Child tools, terminals, plans, titles,
and observed configuration stay separate from the parent.

Only cancellation is advertised, and only while an owned, observable child's current turn can be
identified. Send `session/cancel` with its opaque ACP child ID to interrupt that work and observed
owned descendant work, not its parent or siblings. Raw provider IDs cannot bypass the restriction.
Prompting, loading, configuration changes, closing, and other child mutations remain disabled.
Parent cancellation still interrupts observed live descendants.
An observed work ending reports `idle`; loss of observability reports `unknown`, not a fabricated
failure or a permanently closed conversation.

Cancellation withdraws affected permission/elicitation requests, but an interrupt acknowledgement
does not fabricate a cancelled outcome. Actual provider completion reports the ending; the same
conversation may receive later work. Idle or unobservable children have no cancel capability.
Reattachment suspends child controls until the latest successful response is actually written,
including complete JSON-RPC batches; historical or copied child records never grant control.

Child `config_option_update` notifications contain complete reported snapshots. Observed model and
reasoning effort use singleton selects, including changes between assignments. Unknown or unset values
are omitted; no values are inferred from the parent or requested spawn arguments. These reports do not
enable configuration changes, even to the current value. Replayed configuration is historical, not
confirmed current. Reattachment drops cached confirmation and refreshes loaded children after the
response. Optional reads do not block child delivery; newer observations or attachment changes discard
stale results.

Replay follows both recorded spawn formats and replays available child transcripts once per conversation,
including nested children, using legacy or paginated history. Announcements and all selected history
precede the response. Completed snapshots reconcile tool and rendering state before duplicate live
payloads are suppressed; live bookkeeping still runs. In-progress commands retain classification without
resetting streamed output. Incomplete text has no safe delta cursor; it and other records without a safe
partial representation are omitted rather than replayed over newer content. Agent-owned input is not
rendered as human input. Missing, omitted, or incomplete child history produces a parent advisory;
an empty transcript alone does not invent a gap.

Replay reports the latest recorded child turn's known success, cancellation, or failure as historical
`idle` before the response. A missing or still-running turn invents no outcome. Legacy history reuses
its turn data; paginated history reads the latest turn summary separately, retaining available text
and reporting a gap if that summary is unavailable. Recorded outcomes do not enter the live foreground
cache, withdraw current interactions, confirm runtime ownership, or grant controls.
Rejoining a loaded child still requires current provider parentage; copied fork history can be displayed
but cannot acquire the original runtime's subscriptions.
After replay, current child work/configuration snapshots follow the actual response write, including whole
JSON-RPC batches. Parent setup operations serialize without waiting on each other's batch delivery.

#### Models of a `providers/set` gateway

`providers/set` lists the models of the gateway (`GET {baseUrl}/models`, with the headers Codex sends to it)
before it responds. The models reported to the client are then only the Codex models whose `model` or `id` the
gateway lists, matched without case and date suffix. A session whose thread model the gateway does not list uses
the default of these models; a thread model that the gateway lists but Codex does not know is kept. A gateway that
lists none of the Codex models leaves no model option at all, and the session keeps the thread's model as current.
Sessions already open get the models of the new routing when the provider restart resumes them, after
`providers/disable` too. A 4xx answer means the gateway has no listing: `providers/set` succeeds and nothing is
narrowed. A failed listing (network error, a status other than 2xx or 4xx, malformed body, or the timeout) fails
`providers/set` with `internal_error` and keeps the current routing; a base URL that is not http(s) fails with
`invalid_params`. A listing that finishes after a newer `providers/set` or `providers/disable` was applied is
dropped. The `gateway` auth method and providers from
the Codex config are not listed.

#### Known gaps

- After `providers/disable("openai")`, `providers/list` still reports native OpenAI routing as the
  current provider. The providers RFD says a disabled provider's `current` should be `null`; this is
  left as-is and documented here rather than fixed.
- Open question for AIR: AIR's fork points match Codex item ids, but on v2 a user message's
  rendered id is the client-minted `clientId` (when the client supplied one), not the Codex item id.
  A fork at a user message would not resolve. This is flagged for AIR, not fixed here.

### Prompt suggestions

ACP v1 and v2 advertise `_meta.lody.promptSuggestions: {version: 1}` in their
agent capability object. Clients declaring the same capability receive
`_lody/session/prompt_suggestion` notifications for the owning root thread,
including after a prompt finishes. `thread/prediction/updated` preserves
`sourceTurnId` and its completed/text-null/failed result without creating assistant
messages or changing prompt outcomes. No request is made to generate predictions;
native runtime settings and availability remain authoritative.

The prompt-suggestion contract is provided by the pinned
`acp-extension-core@0.3.0` dependency.
