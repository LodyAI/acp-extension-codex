# Positive evidence for ambiguous steer delivery

Status: implemented
Translation: current

[中文](2026-09-15-steer-history-reconciliation.zh.md)

## Abstract

A lost steering response could be reported as replay-safe when the original turn
ended, duplicating input already consumed by Codex. The adapter now retains the
submitted identity through prompt completion, drains received notifications, and
reads the original turn's history once after an ambiguous response. Matching user
identity confirms application; missing or unavailable history still leaves delivery
unknown. This is bounded positive-evidence reconciliation, not an exactly-once or
cross-restart protocol.

## Decision

The outer error fix in [#43](https://github.com/LodyAI/acp-extension-codex/pull/43)
did not fix the inner catch, which both removed identity before notification drain
and inferred refusal from local turn completion. The request now retains its original
thread id, turn id, and `clientUserMessageId`. A corresponding live user item or a
persisted `userMessage.clientId` shares one applied acknowledgement before the failed
submission's outcome settles. Stop does not invalidate positive delivery evidence.

Notification drain and one `thread/read(includeTurns: true)` share a five-second
budget. Live evidence can finish while the read is pending; late read results have
no side effects. Only an explicit refusal (or rejection before submission) is
replay-safe. Neither the local queue nor stored history supplies a negative-proof
barrier, so absent items, failed reads, timeouts, and ended turns remain unknown.

Retrying `turn/steer` was rejected because the identity field is not a documented
idempotency key. A new generic ACP status API and durable host mapping are outside
this fix. Successful responses keep the existing live-notification path; the change
does not recover every missed notification after a successful ACK.

## Evidence and limits

Deterministic tests run real adapter prompt cleanup and notification routing around
controlled app-server responses. They cover prompt completion before response failure,
queued/late live evidence, exact thread/turn/client identity, missing or failed history,
timeout with a late positive result, and Stop during reconciliation. They do not
claim persistence-flush guarantees or simulate a restart.

Restoring the old catch and prompt cleanup made all three selected regressions fail
(persisted application, queued notification, and unknown after completion). The
fixed adapter passed 630 tests with 27 existing gated skips, typecheck, and build.
A real Codex 0.153.4 prompt smoke returned `end_turn`; this smoke does not inject a
lost steering response. Its initial launch timed out and the separate rerun passed.

Protocol: [Codex app-server](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming).
