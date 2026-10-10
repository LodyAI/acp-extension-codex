# Log Codex title failures without conversation events

Status: implemented
Translation: current

[中文](2026-10-10-codex-title-failure-logging.zh.md)

## Abstract

Codex title generation could fail silently even when its native turn carried an
error: `runTurn` resolves with failed turns, while the title generator inspected
only output items. The adapter now logs failed turns, exceptions, and missing
usable title output without publishing conversation events. Native turn errors
retain their fields and correlation IDs. Model selection and retry behavior stay
unchanged, so this change enables diagnosis rather than claiming to fix routing.

## Decision and evidence

`src/TitleGenerator.ts` uses the existing Logger:
`APP_SERVER_LOGS/app-server.log` when configured, stderr otherwise. Failed turns
include the main and ephemeral thread IDs, turn ID, model, status, and serialized
native error. No extra source prompt or generated output is logged. An empty catch
or only catching exceptions would still lose resolved failed-turn diagnostics.

Title generation stays best effort; no ACP message or main-prompt error is added.

## Validation

The title generator suite covers file and stderr diagnostics, native error
preservation, no title publication on failure, no stdout writes, exceptions,
and unusable output. Its nine tests and adapter typecheck passed. No affected
user machine was available for a real provider reproduction; the runtime must be
rebuilt and installed before these diagnostics can be collected there.
