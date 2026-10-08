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
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `LODY_CODEX_PROFILE_CONFIG` - host-owned nonsecret JSON config also supplied as native startup `-c` options, so keyring and provider selection apply before app-server initialization. Managed profiles use a per-launch loopback capability instead of an upstream API key.
- `LODY_CODEX_PROCESS_TOKEN` - optional nonsecret host-generated UUID identifying one native process use. With managed config and `CODEX_HOME`, the host must first create `../processes/<token>.json` containing `{version: 1, token}`. The adapter writes only the corresponding `<token>.native.json` PID/exit proof and removes the token from native child env. Independent tokens permit concurrent processes for the same home; unknown state delays host credential deletion only. Without managed profile configuration, legacy startup (including Windows shell launch) is unchanged; a profile without a process token emits no usage proof. See [the process boundary decision](.agents/notes/proposed/architecture/2026-09-26-managed-profile-process-usage.md).
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

Codex translates Core’s boolean `plan_mode` option to its native default/plan collaboration state. Approval and sandbox settings are retained. The `/plan` command uses the same boolean configuration path.

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


## Upstream ACP v2 merge (2026-09-30)

Upstream `agentclientprotocol/codex-acp` main at `ba7b216` adds ACP v2 routing,
streamed history replay, tool-call reporters with exact patches, terminal delta
output, MCP startup waiting, and Codex 0.159.1. The SDK is now 1.5.x;
`acp-extension-core` remains pinned to 0.1.9.

Existing Core hosts can continue initializing protocol version 1. Core extension
method names, steer IDs/applied acknowledgements, usage scopes, native fork turn
IDs, managed profiles, worktree projects, elicitation answer notes, and structured
warning/error metadata remain supported. Core mode IDs and defaults are retained.
ACP v1 prompts still wait for native completion, including goal continuations and
manual compact/review ownership. ACP v2 is selected explicitly at initialization;
its prompt response acknowledges insertion and completion arrives through session
state updates. A Core host must implement that lifecycle before opting into v2.

Core steering remains inject-or-refuse on both routes: `_lody/session/steer`
requires `steerId`, never starts a replacement turn, and retains ambiguous errors.
AIR metadata is additive when negotiated. Tool updates can omit unchanged fields;
clients must merge updates with the existing tool call. Legacy terminal output is
retained for clients declaring `_meta.terminal_output`; otherwise output uses deltas.

New request option `_meta.mcpStartupAwaitTimeoutMs` on session new/resume/fork is
an optional positive millisecond budget for awaiting requested MCP servers. Omitted
or nonpositive values do not wait; expiry does not cancel startup. Session load
ignores this option. See [MCP startup waiting](docs/mcp-startup-await-timeout.md).
