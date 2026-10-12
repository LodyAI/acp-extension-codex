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


## Upstream merge (2026-10-12)

Upstream main `202e66e` (2.2.2) temporarily reverts ACP v2. This adapter follows
that rollback and serves ACP v1, while retaining Core 0.1.9 contracts. Hosts that
previously opted into ACP v2 must initialize with version 1 again. The package
retains its independent Lody release version and the SDK stays on 1.5.x.

Codex moves to 0.160.1. Upstream adds negotiated AIR session indexes and list
subscriptions, explicit rename/archive operations, hook trust before session open,
MCP live status and `/mcp reconnect`, custom session instructions, and app-server
crash recovery. AIR extensions require the corresponding client capabilities;
installing the adapter alone does not enable them in Core clients.

Core steering remains inject-or-refuse; usage remains scoped to native turns;
compact/review cancellation waits for native completion; managed profiles,
worktree projects, startup model selection, and structured notices remain intact.
Automatic title generation remains the ACP client's responsibility: the adapter
never starts an auxiliary title turn. Explicit session-index renames are supported.

## Startup model selection

Core's `_meta.lody.sessionConfig` version 1 supplies optional `modelId` and a `configOptionValues` dictionary on new/load/resume/fork. The adapter applies model and reasoning to native configuration before establishing the thread. Explicit `modelId` wins over the `model` option; `reasoning_effort` wins over a legacy `model[effort]` suffix. Missing selection preserves native defaults, while malformed selection fails with invalid params. Other options still use live ACP configuration. Native model-mismatch warnings are preserved for intentional switches.

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
