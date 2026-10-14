# Persist Codex execution-directory trust

Status: implemented
Translation: current

[中文](2026-10-14-project-trust-persistence.zh.md)

## Abstract

The adapter supplied temporary trusted project entries to native thread operations, but
left externally managed worktrees absent from the user's Codex configuration. Directory
configuration discovery before those operations could therefore skip project settings.
Session preparation now persists the canonical execution directory through native config
RPC before skills and MCP discovery, while retaining explicit refusal. This stays inside
the Codex adapter until another provider needs a shared trust contract.

## Decision and scope

The ACP session-open request triggers the existing adapter directory-trust policy. The
adapter owns persistence; the native process supplies its actual configuration path and
version, so account-specific homes do not write to an assumed global path. It upserts only
`projects[canonicalCwd].trust_level` and keeps all unrelated configuration. Additional
execution roots retain session-only behavior; logical project ownership remains separate
as described in [native project identity](../simplification/2026-09-20-native-project-identity.md).
There is no Core capability, host path-prefix heuristic, or blanket repos-directory grant.

New/load/resume/fork all use the shared session configuration preparation. A configured
`untrusted` entry for the requested or canonical cwd is retained in session overrides as
well as on disk. Native optimistic version checking prevents a concurrent write from
being lost. Read once and write at most once; conflicts and other failures propagate to
the caller and abort opening the session. The execution directory must already exist;
`realpath` errors propagate without a fallback. No cache or background writer survives session preparation;
connection loss rejects the native request. A completed write remains saved if a later
operation fails or the worktree is deleted. A transport failure can therefore leave a
successful write on disk; a subsequent open reads it again before deciding to write.

Temporary overrides alone do not make trust durable. Writing TOML directly would duplicate
native configuration mutation and concurrency behavior. A universal Core interface is
deferred by product choice; future providers can motivate a common semantic contract.

## Validation and limits

Tests use a real Codex 0.160.1 app-server with temporary homes and synthetic directories.
They verify project settings become effective before each of the four session operations,
no-op repetition, preservation of explicit refusal, rejection of concurrent edits without
overwriting them, missing-directory rejection, and aborting session establishment on
write failure. Native config requests are real;
thread creation/history and model catalogs are stubbed, with no model turn needed by these
new tests. Existing adapter suites cover session metadata and project ownership.

The adapter has no cwd before the ACP session request. This change does not retract a
warning emitted at process initialization, alter sandbox/tool approvals, or provide trust
revocation/cleanup. Windows runtime behavior is not exercised by the local macOS run.

Validation results are recorded in the PR. The session-index symlink cleanup failure
was reproduced in an untouched adapter baseline. Root docs checks remain blocked by
existing broken links to uninitialized submodules and other baseline documentation errors.
No release or parent gitlink update is included.
