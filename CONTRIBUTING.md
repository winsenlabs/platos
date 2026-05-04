# Contributing to Platos

Thanks for taking the time to contribute. Platos is built in the open and we genuinely want help — bug reports, docs fixes, new features, sharper test coverage. This guide covers the dev setup, the ways we work, and what we look for in PRs.

If anything below is unclear or wrong, open an issue. The first PR most contributors send us is a fix to this file.

---

## Quick orientation

Platos is a pnpm + Turbo monorepo. The two services that matter most are:

- **`apps/agent`** — the NestJS streaming runtime (port 3100). Handles chat, tool dispatch, MCP gateway, sub-agents.
- **`apps/webapp`** — the Remix dashboard + REST API + auth (port 3030).

Everything else is supporting infra: Postgres, ClickHouse, Redis, MinIO. The bundled `docker-compose.platos.yml` runs them all locally.

We use Apache 2.0 — see [LICENSE](./LICENSE). Don't sign a CLA for the project; the license itself is sufficient.

---

## Before you open a PR

For anything beyond a typo or doc fix, please **open an issue first** so we can talk about the approach. This saves both of us time. Look for the `good first issue` and `help wanted` labels for shovel-ready scope.

If you're proposing a new feature or a change to a public API, write a short RFC in [GitHub Discussions](https://github.com/winsenlabs/platos/discussions) — a one-page sketch of the problem, the surface, and a couple of alternatives. We respond within a week.

We only accept PRs that address a single concern. Multiple unrelated fixes belong in separate PRs.

---

## Dev setup

```bash
git clone https://github.com/winsenlabs/platos.git
cd platos
nvm use                                      # uses .nvmrc — Node 20.x
pnpm install
cp .env.example .env                         # set ANTHROPIC_API_KEY at minimum
pnpm run dev                                 # boots the dev stack
```

`pnpm run dev` brings up the supporting services and starts the agent + webapp in watch mode. Visit `http://localhost:3030` and complete the magic-link login (the dev mailer prints the link to stdout).

### Running tests

```bash
pnpm run typecheck                           # whole monorepo, ~2 min
pnpm run test --filter <package>             # vitest, no mocks (testcontainers)
```

Tests **never** mock the database. Integration tests spin up real Postgres / ClickHouse / Redis via testcontainers; unit tests stay close to pure code paths.

### Making a code change

Working in `apps/agent` or `apps/webapp`:

```bash
pnpm run typecheck --filter platos-agent     # ~60s
pnpm run typecheck --filter webapp           # ~90s
```

Working in `packages/*` (public SDK packages):

```bash
pnpm run build --filter @platos/client
pnpm run test --filter @platos/client
pnpm run changeset:add                       # required for any package change
```

Read [CHANGESETS.md](./CHANGESETS.md) for the release workflow.

---

## What we look for in a PR

- **Single concern.** One bug fix or one feature per PR.
- **Tests.** Bug fix? Add a regression test. New feature? Add a happy-path test plus the obvious failure modes. Use real services via testcontainers.
- **No mock services.** Integration tests hit real Postgres + Redis + ClickHouse. We've been burned by mocked tests passing while migrations broke.
- **Multi-tenant scope is sacred.** Every scoped row carries `(organizationId, projectId, environmentId)`. Don't bypass it. Don't add an endpoint that ignores it.
- **Encryption is sacred.** Conversations are encrypted at rest (AES-256). Don't bypass the envelope.
- **No major version bumps without discussion.** Default to a patch changeset.
- **No new mocks for things we own.** If you find yourself writing a mock for a Platos service, write a thin testable extraction instead.
- **Prefer editing existing files** over creating new ones.
- **Match the surrounding style.** We don't ship a heavy lint config; just match what's already there.
- **Comments earn their keep.** Default to no comments. Add one when the *why* is non-obvious.

---

## Areas where help is especially welcome

- **Provider integrations.** New LLM providers, embedding providers, voice models.
- **Skills.** The official skills surface is intentionally small; build a useful skill and contribute the manifest + tests.
- **Reference projects.** New examples under `references/` showing one well-scoped pattern (auth flow, RAG setup, multi-agent orchestration).
- **Docs.** Anything in `content/docs/` and `content/guides/` is hand-written. Typos, clarifications, and missing examples are all welcome.
- **Testing.** More integration tests. The runtime's tool-call path in particular has more breadth than depth.

---

## Reporting bugs

Use the bug report template on the [Issues](https://github.com/winsenlabs/platos/issues) page. Include:

- Platos version (commit SHA on `main` if you're running from source)
- The compose service that's failing
- Last 20 lines of `docker logs <service>`
- Whether you're on the bundled compose stack, a custom Helm install, or a hosted instance

For security vulnerabilities, **do not open a public issue**. Email `hello@winsenlabs.com` per [SECURITY.md](./SECURITY.md).

---

## Coding conventions

We are not strict about formatting (Prettier is configured but not enforced in CI) — match the surrounding code. A few load-bearing conventions:

- **Database queries**: prefer `findFirst` over `findUnique`. Prisma's DataLoader on `findUnique` has open bugs around uppercase UUIDs and composite keys, and `findFirst` avoids the entire class of issues.
- **Background work**: use `@platos/redis-worker`. Don't add new jobs via legacy zodworker / graphile-worker.
- **Server env**: import from `app/env.server.ts`, never `process.env` directly. Validate at boot.
- **Real-time**: Socket.io for agent streaming; Electric SQL for dashboard data sync.

---

## Releases

We cut releases via [Changesets](https://github.com/changesets/changesets). When a PR touches anything under `packages/`, run `pnpm run changeset:add` and commit the resulting `.changeset/*.md` file. Maintainers cut the release.

App-only changes don't need a changeset; we run continuous deployment on `main`.

---

## Community

- **Questions, RFCs, dogfooding stories**: [Discord](https://discord.gg/platos)
- **Long-form discussion**: [GitHub Discussions](https://github.com/winsenlabs/platos/discussions)
- **Open issues**: [github.com/winsenlabs/platos/issues](https://github.com/winsenlabs/platos/issues)

---

## Code of Conduct

Be kind. Disagree about ideas, not people. The full text is in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Violations get reported to `hello@winsenlabs.com`.

Thanks for helping make Platos better.
