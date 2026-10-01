# Release automation

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

See [RELEASING.md](../RELEASING.md). `workflows/publish.yml` owns Release Please
and npm publication from a validated release commit SHA. Do not add a second
tag-triggered publisher or hand-bump versions. Keep the npm trusted publisher
bound to `LodyAI/acp-extension-codex`, `publish.yml`, environment `release`.
The GitHub environment must permit only the selected branch `main`.
