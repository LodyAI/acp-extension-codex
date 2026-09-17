This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

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
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, `agent-auto-review`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

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
