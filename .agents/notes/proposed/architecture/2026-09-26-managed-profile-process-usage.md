# Host-owned native startup and process-use evidence

Status: proposed
Translation: current

[中文](2026-09-26-managed-profile-process-usage.zh.md)

## Abstract

Managed account hosts need authentication storage and provider selection applied
before app-server initialization. They also need native process-exit evidence to
defer credential deletion without restricting concurrent sessions on one account.
This adapter change supports those boundaries; it does not implement the host's
account UI, vault, endpoint broker, or credential refresh.

## Decision

`LODY_CODEX_PROFILE_CONFIG` supplies nonsecret native `-c` settings before
`app-server`. Top-level identifiers are validated and passed without TOML quoting;
nested table keys and values use TOML-compatible encoding. Managed Windows launches
use direct argv; legacy Windows shell launch remains unchanged.

An optional host-generated `LODY_CODEX_PROCESS_TOKEN` UUID selects an existing
`processes/<token>.json` beside `CODEX_HOME`. The adapter validates its ownership,
removes the token from native child env, and writes only its corresponding PID/exit
proof. Multiple tokens for the same home coexist. An unknown native state can delay
host cleanup, never another session. A prior unreleased exclusive-writer design was
removed: unverified refresh contention does not justify changing concurrent behavior.
The host owns registration, tombstones, reconciliation, and cleanup. The token is
not a secret or a caller-selected filesystem path; this is not a same-user sandbox.

## Evidence and limits

The owning connection suite launches real synthetic JSON-RPC child processes and
observes startup argv, preserved home, stripped token, independent live/exit proofs,
and a second process continuing after the first exits. It also covers invalid
ownership and legacy Windows command construction. These platform-shape assertions
are not a real Windows execution test. No native refresh race is claimed fixed.

Reproduce with `pnpm exec vitest run src/__tests__/CodexJsonRpcConnection.test.ts`,
`pnpm typecheck`, and `pnpm build`. Lody's separate built-desktop acceptance uses
real Codex 0.156.0 and synthetic external provider wires; a two-request arrival
barrier verifies same-profile overlap without real account credentials.

Environment contract: [developer README](../../../../readme-dev.md).
