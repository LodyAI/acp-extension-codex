# Repository Guidelines

## Pull Requests

- Always open pull requests against the `LodyAI` organization repository
  (`LodyAI/acp-extension-codex`), not a personal fork.

## Project Structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — Vitest suite (behavior-focused tests around ACP/Codex events).
- `src/app-server/` — generated Codex app-server API types (regenerate via `npm run generate-types`).
- `dist/bin/` — release-ready single-file executables and `*.zip` archives.

## Coding Style

- Keep edits consistent with existing formatting.
- When adding env/config knobs, document them in `readme-dev.md`.
- Managed-profile process tokens identify independent native uses, not exclusive leases.
  Write only the matching host-owned record's proof and remove the token from native env.
  Never restrict same-profile concurrency or implement credential refresh in the adapter.
- Classify managed ChatGPT refresh failures on new, resume, fork, and stable load without
  logging out; mark only reused-token contention. Legacy load retains its original error path.
- Lody may launch the adapter from an Electron or daemon process with no Windows console.
  Set `windowsHide: true` on every adapter-owned console-subsystem child process spawn;
  `ELECTRON_RUN_AS_NODE` is a separate runtime-mode concern.
- The adapter serves ACP v1 and v2. A change that is not meant for one protocol version only must work correctly in both.
- Return `null` for "looked it up, found nothing". Use `undefined` for optional parameters and `?:` properties. For state that is not set yet, follow the surrounding type (`SessionState` uses `| null`).
- Treat an incoming `null` in an optional field like an absent value (ACP allows `_meta: null`).
- When updating discriminated-union/event `switch` statements, do not add a trailing fallback like `return null` only to satisfy TypeScript.
- Handle each variant with an explicit `case`; if intentionally ignored, use an explicit no-op case.
- Code comments should be concise and in plain language; avoid verbosity and overly specific detail.
- When adding env/config knobs, document them in `readme-dev.md`.

## Architecture & Design Fit

- Before coding, read the code the change plugs into and find the module that owns the state or concept. Build on that module, not beside it.
- Prefer extending an existing mechanism over adding a new one, even if it takes a small refactor (moving a helper, generalizing a function). Add a parallel path, special case, or flag only when the existing structure can't support the change.
- Before writing new logic, check whether it already exists in sibling handlers of the same flow, in the other protocol version's handler, or in helpers that already work with the same data. Reuse or extend it instead of adding a second version.
- Put shared logic in the module that owns the concept, not in one caller or an unrelated file. The same goes for guards, filters and cleanup, so every caller gets them. If guards, flags or fallbacks pile up in one place, restructure instead of adding another.
- If a result is meant to match another request's output, reuse that request's logic.
- The adapter serves ACP v1 and v2. A change that is not meant for one protocol version only must work correctly in both. v2 handlers convert the request to v1 types and reuse the v1 logic; keep v2-only differences in the conversion.
- New optional request fields and `_meta` keys must not reject requests that were valid before.
- If a workaround or new path is unavoidable (e.g. a Codex limitation), say why in a short code comment and in the PR description.

## Testing Guidelines

- Tests live under `src/__tests__/` and use Vitest.
- Favor event-driven assertions (see `src/__tests__/CodexACPAgent/*`).
- Prefer snapshot-based tests using `toMatchFileSnapshot()` over inline assertions.
- When snapshot response data drifts, prefer replacing that response payload with a stable placeholder over asserting fragile fields (except for 'model/list').
- Focus on behavior and outputs rather than implementation details.
- Cover both ACP v1 and v2 when a change affects what a client receives (updates, responses, replay). A change to internal logic only does not need its tests duplicated per version.
- Before adding a test, search for existing tests of the same API and scenario. Don't add cases that take the same code path. Tests that differ only in input belong in one `it.each`. Don't repeat a unit test's assertion in a wire/router test unless the wire level checks something more.
- For each behavior the docs promise, including what is omitted or rejected, have a test that would fail if it broke.
- Use `/run-codex` skill (`.claude/skills/run-codex/`) to test with real Codex and observe actual events.

## Docs

- `/plan` with text or attachments enables planning and follows the normal prompt insertion
  and cancellation lifecycle. Preserve every content block after removing the command prefix;
  only a standalone `/plan` is a local mode toggle.

- Usage reports assign native root-thread counter increments to the model frozen
  from the submitted turn parameters, not the UI model at notification time.
  Each native turn is a separate accounting lifetime: notification-local
  `_meta.lody.usageScopeId` (Core scope; legacy duplicate `_meta.codex.usageTurnId`)
  lets Lody persist cumulative turn snapshots under a stable turn key; `delta` carries
  each notification's own increment. Never sum repeated snapshots or include restored history.
  Keep only the native snapshot and current turn in memory; no sidecar, session
  metadata baseline, historical model ledger, raw-response accounting or child totals.
  If a resume snapshot is missing, anchor the first notification without billing it.

- Manual `/compact` owns the native turn reported by `turn/started` until matching
  `turn/completed`. Cancel sends `turn/interrupt`; a pre-start cancellation waits for
  the turn id and interrupts it on arrival. Never release the prompt on the compact
  start/interrupt ACK, local synthetic completion, `item/completed`, or
  `thread/compacted` alone.
- Review owns the prompt from submission, including the interval before its native
  turn id arrives. Stop and request abort latch cancellation, interrupt the observed
  native turn, and await the `review/start` response turn's terminal notification
  or connection closure. The control and completion ids are not aliases.
- ACP v1 prompt completion follows native Goal continuations across turn boundaries. Keep
  the prompt and interaction handlers open until the goal stops and its last native turn
  drains, or the turn fails/is cancelled. Never issue another `turn/start` after a routed
  `/goal` turn; Codex owns continuation. Cancellation also pauses the goal before returning.
- A persistent active goal does not create a prompt or live presence by itself. Goal metadata
  remains a separate Core snapshot; do not add a private execution lifecycle protocol.
- Keep `README.md` short. Put a feature's wire contract in `docs/<feature>.md` and link to it. Describe the whole method (capability, request, every outcome), not only the new option.
- Codex app-server usage: see https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md when touching protocol/transport details, adding or consuming JSON-RPC methods, handling approvals/turn events, or updating generated schema/clients.
- App-server events: prefer `thread/*`, `turn/*`, and `item/*` event surfaces; avoid the deprecated `codex/event/*` API (planned removal). Keep implementations aligned with generated types in `src/app-server` (including `v2` exports).
- Steer uses app-server `turn/steer` on the tracked active turn. Acknowledge only a
  matching `item/completed(userMessage)` or persisted user item with the original
  thread id, turn id, and `clientId = clientUserMessageId`. Retain in-flight identity
  through prompt completion and bounded error reconciliation; live/history evidence
  emits one acknowledgement. Never emulate steer with a second `turn/start`.
- Acknowledged steer is inject-or-refuse: use JSON-RPC `invalid request` (`-32600`)
  for proven non-delivery so Lody can requeue the same message as a normal prompt.
  Preserve unexpected or transport-ambiguous errors; they never authorize replay.
- Turn completion, cancellation, missing history, and history-read failures are not
  proof of steer non-delivery. Reconciliation reads history once without resuming or
  resending; it does not provide cross-restart recovery or idempotency.
- Session fork uses app-server `thread/fork` and installs the returned child as an independent ACP
  session. Agent message updates expose their Codex turn id as `_meta.lody.turnId`;
  `_meta.lody.forkAtTurn.turnId` is passed directly to `thread/fork.lastTurnId`. Do not maintain
  a message-id mapping or emulate fork by replaying source history.
- Codex reasoning summaries can echo trailing empty HTML comments from model instructions. Keep
  that provider-specific cleanup in `src/ReasoningText.ts` across live deltas and history replay;
  do not filter assistant text, raw reasoning, or HTML globally in the client renderer.
- App-server `warning` and `configWarning` notifications are structured ACP session info updates:
  put `{ level, message, source }` under `_meta.lody.notice`. Never emit them as agent message text;
  Lody persists that metadata as an `agent_warning` system notice, and text chunks would pollute
  assistant history, generated titles, and replayed prompts.
- App-server terminal `error` notifications are also control-plane state, never agent message text.
  Record a prompt failure for every non-retry error and publish structured `_meta.codex.error`
  metadata only. Redact any Lody internal-instruction tail at this adapter boundary before putting
  provider errors in ACP metadata or `RequestError` data. Session title updates must identify
  `_meta.lody.titleSource` as `explicit`,
  `fallback`, or `unset` so hosts can accept real names without mistaking prompt previews for
  generated titles. Automatic generation belongs to the ACP client; never advertise
  `sessionTitle` or start an auxiliary title turn here.
- Account rate-limit windows are dynamic. Read the full `account/rateLimits/read` snapshot when a
  session opens, merge sparse `account/rateLimits/updated` values into that snapshot, and preserve
  each native window's `windowDurationMins` when mapping it to Core's
  `windowDurationSeconds`. Never infer 5-hour/7-day meaning from `primary`/`secondary` position.
- Core `worktreeProject` derives a deterministic native project idempotency key from
  the canonical logical root. Let Codex persist that identity through `project/create`;
  never infer it from user project roots or add adapter-side bindings. Existing native
  assignments are authoritative on load, resume, and fork. Recover deleted adapter-owned
  projects by probing deterministic `:gN` idempotency generations; only Codex's specific
  tombstone error advances a generation. Project protocol fields omitted by stable
  generation live in `ProjectApi.ts`, based on the pinned runtime's experimental schema.

## Prompt suggestions

- Gate Core suggestion notifications on the client's `promptSuggestions` v1.
  Keep them outside assistant content and prompt lifecycle. Preserve native
  identity; never assign the receiving turn as the suggestion's source.
