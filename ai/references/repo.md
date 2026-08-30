## Repository overview

This is a Node 22.14.0 and pnpm 10.23.0 monorepo using the root `turbo.json`.

## Apps

- `<root>/apps/agent` is the NestJS Platos agent runtime.
- `<root>/apps/webapp` is the Remix Platos dashboard and API.
- `<root>/apps/core-api` and `<root>/apps/mcp-stdio` are V1 composition-root skeletons governed by the root TypeScript project graph.

## Public packages

- `<root>/packages/trigger-sdk` is the `@platos/sdk` package.
- `<root>/packages/core` is the shared `@platos/core` package.
- `<root>/packages/contexts/*`, `<root>/packages/adapters/*`, and `<root>/packages/kernel` form the V1 project graph.
- `<root>/packages/platools-js` is `@platosdev/platools-sdk`; `<root>/packages/platos-client` is `@platosdev/client`.

## Internal packages

- `<root>/internal-packages/*` contains private implementation packages.
- `<root>/internal-packages/database` exports the inherited Prisma client used by the webapp.
- `<root>/internal-packages/tenancy-database` owns the clean Platos tenancy schema used by Agent.
- `<root>/internal-packages/testcontainers` provides integration-test store fixtures.

## References

- `<root>/references/*` contains development reference workspaces.

## Other

- `<root>/docs` contains documentation and durable audit evidence.
- `<root>/docker-compose.platos.yml` is the current local full-stack compose file. From the repository root, first run `cp .env.example .env` and replace every required development sentinel documented in `content/docs/self-hosting.md` before Compose model evaluation. Then start supporting stores with `docker compose -f docker-compose.platos.yml up -d postgres redis clickhouse minio`.
- `<root>/CONTRIBUTING.md` defines the supported contributor workflow.
