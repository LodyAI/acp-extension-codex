# npm releases

`.github/workflows/publish.yml` runs Release Please on `main`. Merge conventional
commits (`fix:` for patch, `feat:` for minor), then merge the generated release
PR to create a `vX.Y.Z` GitHub release and publish `acp-extension-codex` to npm.
Do not hand-bump versions or push release tags. CI/configuration-only commits do
not create a release on their own. Pre-1.0 breaking changes bump the minor.

The publisher checks the GitHub release, main ancestry, package name and version,
and builds the resolved commit SHA. It runs in the same workflow as Release
Please, so publication does not depend on a bot-created tag triggering another
workflow. Concurrent releases are serialized without cancelling a running publish.

The initial manifest uses the package version already in this repository.
`bootstrap-sha` marks the setup baseline when there is no matching earlier release;
imported history before that commit is omitted from the first new changelog.
The setup PR itself uses `ci:` and does not publish or increment a version.

## One-time setup

- In GitHub Settings → Actions → General, allow Actions to create pull requests.
- Configure npm trusted publishing for **LodyAI / acp-extension-codex**, workflow
  **publish.yml**, environment **release**, allowing direct **npm publish**.
  These values must match exactly. The workflow uses GitHub-hosted runners,
  Node 24, npm 11 and `id-token: write`; no npm token is needed.
- If the npm package does not exist yet, a maintainer must first publish it from a
  validated checkout with their npm account, then configure the trusted publisher.
  Do not point this workflow at another project's npm package.
- Restrict the `release` environment to the selected branch `main` only (no
  tag or wildcard rules), and protect `main` and workflow edits. npm trust does
  not itself restrict the branch; an in-file branch guard is not a substitute
  for this GitHub environment rule.
- The `release` environment's deployment protection rules apply. Avoid required
  reviewers there if merging the release PR should publish without another gate.

## Retry an existing release

If npm publication failed after the GitHub release was created, run:

```sh
gh workflow run publish.yml --ref main -f ref=vX.Y.Z
```

Only an existing, non-draft, stable GitHub release whose commit belongs to `main`
and whose package version matches the tag is accepted. Do not retry a version
already present on npm; published versions are immutable. Re-running the entire
original run may no longer produce Release Please outputs, so use this dispatch.

See [Release Please](https://github.com/googleapis/release-please-action) and
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
