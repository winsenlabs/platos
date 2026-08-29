# Platos Agent — multi-stage build using pnpm deploy for workspace bundling.
#
# Stage 1 (builder): install the full monorepo, build the clean tenancy client
# and explicit internal dependencies, compile the agent's own
# TypeScript, then run `pnpm deploy` which produces a self-contained directory
# with only the prod dependency tree and no symlinks.
#
# Stage 2 (runtime): thin node image that just copies the deployed bundle and
# build output.
# External base index audited and pinned 2026-08-24.

# ───────────────────────────────────────────────────────────
# Builder
# ───────────────────────────────────────────────────────────
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

# openssl/ca-certificates for Prisma + TLS; python3/make/g++ so node-gyp can
# compile native modules pulled in transitively at install time (e.g.
# better-sqlite3 via the `evalite` dev tool). These live ONLY in the builder
# stage — the runtime image below stays slim and never sees the toolchain.
RUN apt-get update && apt-get install -y openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /build

# Copy the full monorepo (respects .dockerignore — no node_modules, dist, etc.)
COPY . .

# Install all deps across the workspace
# docs isn't in the Docker context (.dockerignore) so the lockfile
# has more importers than the copied workspace. Drop that entry from
# pnpm-workspace.yaml so --frozen-lockfile works against the trimmed tree.
RUN sed -i '/docs/d' pnpm-workspace.yaml
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Explicit Platos agent graph: clean tenancy client, runtime-only internal
# packages, then the agent's strict declaration build.
# This intentionally does not claim the deferred webapp/run-engine closure is
# gone; WIN-132 owns that destructive extraction.
RUN pnpm run build:platos:agent

# Produce a self-contained prod deploy at /deploy — symlinks flattened,
# only prod deps, with all workspace packages resolved to real copies.
RUN pnpm --filter platos-agent deploy --prod --legacy /deploy

# ───────────────────────────────────────────────────────────
# Runtime
# ───────────────────────────────────────────────────────────
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

RUN apt-get update && apt-get install -y openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deployed node_modules + package.json
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./package.json

# Compiled agent JS
COPY --from=builder /build/apps/agent/dist ./dist

# Phase 3 — docs + guides catalog. The DocsMcpService walks up from cwd
# (here `/app`) looking for `content/docs` + `content/guides` and indexes
# their markdown for the public docs MCP + the public REST API. Without
# this copy, search_docs returns 0 results and resources/list is empty.
COPY --from=builder /build/content ./content
ENV PLATOS_DOCS_CONTENT_ROOT=/app

# Apache-2.0 s4(a)/s4(d) — the License and the NOTICE attributions must travel
# with every distributed copy of the work. A shipped image IS a distribution.
COPY --from=builder /build/LICENSE ./LICENSE
COPY --from=builder /build/NOTICE ./NOTICE

# Entrypoint + platos-specific init SQL
COPY apps/agent/entrypoint.sh ./entrypoint.sh
# prisma-init.sql removed — migrations handle table creation now
RUN chmod +x ./entrypoint.sh

EXPOSE 3100

CMD ["./entrypoint.sh"]
