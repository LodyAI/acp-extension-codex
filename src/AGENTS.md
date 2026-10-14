# Adapter source rules

The parent [AGENTS.md](../AGENTS.md) applies.

- Before new/load/resume/fork loads directory-scoped configuration, persist the canonical
  execution-directory trust through native config RPC with a version check. Preserve an
  explicit `untrusted` decision and keep additional/logical roots out of durable grants.
  This is adapter policy, not a Core capability; see [project trust](../readme-dev.md#project-trust).
