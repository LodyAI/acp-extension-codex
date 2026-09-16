# Separate review completion from native cancellation ownership

Status: implemented
Translation: pending

## Decision

`review/start` returns the logical review completion turn. A later
`turn/started` notification may expose the native turn that must receive
`turn/interrupt`; the two identifiers are not aliases. `CodexAppServerClient`
buffers scoped native starts until the review response identifies the review
thread, then exposes only the native start to the cancellation owner. Review
completion waits only for the response turn's matching `turn/completed`.

The review command is standalone, so its authoritative completion is not fed
back through `GoalPromptLifecycle` as a goal continuation. Goal and prompt
lifecycle state retain one current turn handle; review-specific correlation
does not change the generic meaning of a current turn.

## Evidence and limits

Deterministic tests cover a native start before the `review/start` response,
an unrelated terminal on the same thread, exact native interrupt ownership,
authoritative completion, and a recovery prompt after cancellation. The
implementation intentionally does not resolve a review from a different
native terminal ID because no supported Codex trace established that
equivalence.

Real Codex 0.153.4 runs with `delivery: inline` covered Stop requested before
the response, after the response, and after native start. Each observed
sequence was response A, native start B, interrupt B, and completed A with
`interrupted`; the cancelled prompt was followed by a successful recovery
prompt. No B-terminal sequence was observed.

Protocol reference: [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
