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

## Relationship to application releases

[RELEASE.md](./RELEASE.md) governs OCI candidate creation, image publication, and environment operations. Those approvals do not authorize npm publication. Conversely, a Changesets entry does not authorize an OCI build, image publication, or any environment change.
