# Contributing to Platos

Thanks for contributing. Platos is a pnpm and Turbo monorepo. The primary source services are:

- `apps/agent` — the NestJS agent runtime on port 3100.
- `apps/webapp` — the Remix dashboard and API on port 3030.

The repository is licensed under Apache-2.0; see [LICENSE](./LICENSE). Contributions do not require a separate CLA.

## Before opening a pull request

Open an issue before substantial work so maintainers can confirm scope and approach. Keep each pull request focused on one concern. Public API proposals should include a short design discussion and alternatives.

## Toolchain

Use the repository pins exactly:

- Node.js 22.14.0 from `.nvmrc`.
- pnpm 10.23.0 from `package.json#packageManager`, activated through Corepack.

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm --version
pnpm install --frozen-lockfile
```

A normal Git checkout runs the repository-owned `prepare` installer and installs the pinned local Lefthook runtime. An install that cannot install the hook fails. See [Local hook boundary](#local-hook-boundary) before using any bypass.

## Local startup choices

Copy the environment template first and replace production sentinels before exposing any service:

```bash
cp .env.example .env
```

### Supporting services for source development

Start only the stateful dependencies, then run source services in separate terminals:

```bash
docker compose -f docker-compose.platos.yml up -d postgres redis clickhouse minio
pnpm --filter platos-agent dev
pnpm --filter webapp dev
```

This keeps the Agent and webapp on source watch loops. `pnpm dev` is the broader Turbo development graph; it does not start Docker services for you.

### Full compose stack

To build and start the complete local stack, including migrations, Agent, and webapp:

```bash
docker compose -f docker-compose.platos.yml up -d --build
```

This is a local build/start command. It does not publish images or authorize any environment change.

## Building and testing

Use package names that exist in the current workspace:

```bash
pnpm --filter platos-agent build:strict
pnpm --filter webapp typecheck
pnpm --filter @platosdev/client build
pnpm --filter @platosdev/client test
pnpm --filter @platosdev/platools-sdk test
pnpm build:v1
```

For the standing repository checks, run the package scripts documented in `package.json`. Integration tests may require the supporting compose services or Testcontainers.

## Package version intent

Only changes to a non-private package may carry a Changesets entry. A Changesets file records maintainer-authorized package version intent; it is not permission to publish anything.

```bash
pnpm changeset:add
pnpm changeset:status
```

Select only a current non-private package from `packages/*`. Application-only, internal-package, documentation, and infrastructure changes do not get a Changesets entry. See [CHANGESETS.md](./CHANGESETS.md).

## Pull request expectations

- Keep one concern per pull request.
- Add regression coverage for fixes and success/failure coverage for new behavior.
- Preserve organization, project, and environment scope on persisted data.
- Preserve encryption and credential boundaries.
- Match surrounding style and keep comments focused on non-obvious reasons.
- Do not add publication, release, or environment mutation authority to validation workflows.

## Candidate builds are not releases

A `main` push may build and test OCI candidate archives. Candidate creation does not publish an image, change an environment, promote an external workflow-platform version, or publish an npm package. Each operational action has a separate approval boundary described in [RELEASE.md](./RELEASE.md).

## Local hook boundary

`lefthook.yml` rejects direct commits while the checked-out ref is exactly `main` or `v1`. The hook is a local guard, not repository authorization. Git's `--no-verify` flag can bypass local hooks by design:

```bash
git commit --no-verify
```

Use that bypass only for an explicitly approved recovery procedure. Server-side branch protection, required reviews, and CI remain the authorization boundary; this repository does not claim that a client-side hook can enforce remote policy.

## Reporting problems

Use GitHub issues for non-security defects. Report security vulnerabilities through [SECURITY.md](./SECURITY.md). Report Code of Conduct incidents to `hello@winsenlabs.com` as specified in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
