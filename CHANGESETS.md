# Changesets: package version intent

Platos uses [Changesets](https://github.com/changesets/changesets) only to record maintainer-authorized version intent for current non-private packages.

## Scope

Add a Changesets entry only when a change requires the version of a publishable package to move. The current package name must appear in a non-private `packages/*/package.json`.

Do not add an entry for:

- `apps/*`, `internal-packages/*`, documentation, examples, infrastructure, or private packages;
- OCI image changes or environment operations;
- historical package names that no longer exist in the workspace.

## Record intent

```bash
pnpm changeset:add
pnpm changeset:status
```

Review the generated `.changeset/*.md` file manually. Its front matter must name only current publishable packages, and its bump type and summary must match the approved scope.

Pending entries are package-version intent only. This repository has no Changesets release workflow, npm publication workflow, prerelease helper, or automatic npm authority. Running Changesets does not authorize publication.

The ten invalid entries that named retired package identities were preserved byte-for-byte under `docs/audits/history/win-252/stale-changesets/`; they are history, not pending intent.

WIN-252 also reconciled every current non-private first-party package to the repository's governing `Apache-2.0` metadata and replaced the four conflicting package-local MIT licence files. That legal metadata correction does not itself create package-version intent or authorize npm publication; future package manifests are checked by `scripts/license-distribution.test.mjs`.

## The CI gate

`scripts/sdk/changeset-gate.mjs` runs in `.github/workflows/ci.yml` (`pnpm audit:changesets --base <merge target>`, with `pnpm test:changesets` proving its rules can fail). It compares the pull request, or the push, with its merge base and checks version intent in both directions:

- every non-private `packages/*` package with a shipped change, and the owner of every generated SDK artifact `scripts/sdk/v1-contract.mjs` writes, must be named by a changeset the diff adds or edits;
- every package such a changeset names must be a current non-private `packages/*` package, and must have changed in the diff or be named with the commit that changed it. A release an edited changeset already declared, with the same bump, at the merge base is carried intent and needs neither.

The two Python SDKs in `packages/*` (`platos-client` and `platools` on PyPI) have no npm identity, so their version intent is recorded under their TypeScript twins, `@platosdev/client` and `@platosdev/platools-sdk`; a shipped change to either Python tree requires a changeset naming the twin. A `packages/*` directory that is neither an npm package, a mapped Python SDK nor a workspace container of private packages is refused.

Paths that are test-only (tests, test configuration, the Python suites' CI requirements) never require intent. Two changes are exempt because this document says they are not version intent: a generated fixture diff confined to its `sourceDigests`, and legal metadata reconciled to the governing licence — a package `LICENSE` byte-identical to the repository `LICENSE`, and a `package.json` whose only change is `license` set to `Apache-2.0`. A licence moved anywhere else, or together with any other change, still requires intent.

Once the rule holds, the gate computes the release plan with `changeset status --output` as a dry run. It never versions, tags or publishes anything.

## Relationship to application releases

[RELEASE.md](./RELEASE.md) governs OCI candidate creation, image publication, and environment operations. Those approvals do not authorize npm publication. Conversely, a Changesets entry does not authorize an OCI build, image publication, or any environment change.
