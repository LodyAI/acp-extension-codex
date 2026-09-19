# Separate review completion from native cancellation ownership

Status: implemented
Translation: current

[中文](2026-09-16-review-turn-ownership.zh.md)

## Abstract

Codex review can return one turn id for completion and expose another for
cancellation. Confusing those roles can leave a review running after Stop.
The adapter retains the prompt from submission, interrupts the observed native
turn, and waits for the response turn's terminal notification. This includes
request abort before native startup; interrupt acknowledgement never releases
the prompt. The Lody host's existing cancellation drain remains the process
termination fallback.

## Decision

`review/start` returns the logical review completion turn. A later
`turn/started` notification may expose the native turn that must receive
`turn/interrupt`; the two identifiers are not aliases. `CodexAppServerClient`
buffers scoped native starts until the review response identifies the review
thread, then exposes only the native start to the cancellation owner. Review
completion waits only for the response turn's matching `turn/completed`.

The prompt records a native command in flight before submitting `/review`,
`/review-branch`, `/review-commit`, or `/compact`. This extends the existing
compaction guard rather than inventing a turn id before native startup. Stop
and request abort latch cancellation during that interval. Late native starts
receive `turn/interrupt`; the command remains owned after its acknowledgement.
Completion or request failure clears the guard in `finally`, and connection
closure rejects the native completion wait.

Without this guard, removing the response id from cancellation ownership leaves
`currentTurn` empty between response A and native start B. Request abort then
mistakes an accepted review for an unsubmitted prompt and returns `cancelled`
before native termination. The adapter must enforce this boundary because the
host cannot detect hidden work after the ACP request has already returned.

The review command is standalone, so its authoritative completion is not fed
back through `GoalPromptLifecycle` as a goal continuation. Goal and prompt
lifecycle state retain one current turn handle; review-specific correlation
does not change the generic meaning of a current turn.

## Evidence and limits

Deterministic tests cover Stop and request abort before the response, after the
response, after native start, and with native start preceding the response.
They hold interrupt acknowledgement separately from completion, reject another
prompt while cancellation drains, ignore a B terminal, and accept A before
running a recovery prompt. Start rejection and connection closure also settle
the command. The response-before-start abort regression failed on `676c1f9`.
No supported native trace establishes B as an alias terminal.

Real Codex 0.153.4 and 0.154.0 runs with `delivery: inline` covered both Stop
and request abort before the response, after the response, and after native
start: six cases per version. Each run interrupted B and observed A with
`interrupted` before ACP returned `cancelled`, then completed a recovery prompt.
No B-terminal sequence was observed. Native checks used an isolated synthetic
repository; captured events are not repository fixtures.

All 649 enabled adapter tests, typechecks and the build pass; 27 existing tests
remain environment-gated. This does not constitute a full Lody desktop test.

## Host integration

[Lody #618](https://github.com/LodyAI/Lody/pull/618) already keeps normal Stop in
the active ACP request and applies a shared five-second termination fallback.
The host needs the corrected adapter revision and a rebuilt bundle, not its own
review id mapping. Failed process termination continues to retain ownership.

Implementation: [adapter #46](https://github.com/LodyAI/acp-extension-codex/pull/46).
Related report: [Lody #196](https://github.com/LodyAI/Lody/issues/196).

Protocol reference: [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
