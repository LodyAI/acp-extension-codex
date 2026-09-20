# Native project identity through Codex idempotency

The original `worktreeProject` v1 adapter implementation treated a canonical root
as a reverse lookup key: it paged through `project/list`, reused a sole matching
project, and rejected duplicate matches. That conflated Codex project topology
with identity. Codex permits multiple projects to contain the same root; the
stable identity is `project.id`, not a unique root assignment.

Codex 0.154.0 already provides the persistence needed by the adapter. Its state
runtime stores `idempotency_key -> project_id` in `project_idempotency_keys` and
`project/create` returns the existing project on replay. The adapter now
canonicalizes `originProjectPath`, derives
`acp-project-v1:${sha256(canonicalRootKey)}`, and calls `project/create` directly.
No Lody-side provider binding or native project ID is persisted, and user-created
projects are never scanned, selected, updated, or deleted.

Lifecycle rules are deliberately asymmetric:

- New sessions resolve the deterministic project and pass its ID to
  `thread/start`.
- Load and resume keep a returned `thread.projectId`; only an unassigned thread
  is backfilled with the deterministic project.
- Codex 0.154.0 natively inherits the source project during `thread/fork` for
  persistent and ephemeral children. The adapter preserves that returned child
  assignment and only backfills an unassigned child.

Codex retains idempotency keys when projects are deleted. Replaying a tombstoned
key fails with `idempotency key refers to deleted project`. The adapter preserves
that failure and does not recover by matching roots or inventing another identity;
deletion recovery remains a separate design problem.

Source verification used the pinned `rust-v0.154.0` implementation in
`app-server/src/request_processors/projects.rs`, `state/src/runtime/projects.rs`,
and the app-server project/fork tests. Adapter coverage verifies canonical aliases,
independent resolver instances, duplicate user roots, new/load/resume/fork
lifecycle behavior, and deleted-key failure.
