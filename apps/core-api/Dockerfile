# Platos core-api — THE V1 composition root as a container image.
#
# Modelled on apps/agent/Dockerfile. Stage 1 (builder) installs the frozen
# monorepo, builds the explicit core-api graph and runs pnpm's non-legacy
# `deploy` from the shared lockfile, which writes a self-contained directory with
# every workspace package resolved to a real copy and every external package
# resolved exactly as pnpm-lock.yaml resolves it, then proves the result against
# pnpm-lock.yaml. Stage 2 (runtime) copies that bundle, the compiled entry point
# and the legal files, and runs as an unprivileged account.
#
# External base index pinned 2026-08-24 in commit 6f5cc554 ("ci: add
# persisted-state release gate"); no review receipt for that pin exists in this
# repository, so this file claims the pin and not an audit. It is the SAME
# reference apps/agent/Dockerfile pins, reused unchanged on 2026-09-15, so this
# image adds no new supply-chain input to the repository, and
# scripts/audit-platos-build.mjs fails if any node stage here, on any registry,
# stops being exactly that reference.
#
# NO BUILDKIT-ONLY SYNTAX. The agent image mounts a pnpm store cache on its
# install step, and that mount is refused by the classic builder. This file
# omits it so the same bytes build under `docker build` without BuildKit and
# under buildx in CI. THE TRADE: with no store cache, every rebuild whose
# context changed downloads the whole frozen lockfile again, which costs build
# time and never correctness, because the lockfile is frozen either way.
#
# NO SECRET REACHES A LAYER. There is no ARG, no secret mount and no ENV holding
# a credential. Every secret the process reads — store URLs, the session secret,
# the credential root — arrives at `docker run` / compose time and is validated
# by apps/core-api/src/config before anything is constructed.

# ───────────────────────────────────────────────────────────
# Builder
# ───────────────────────────────────────────────────────────
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

# openssl/ca-certificates for the ORM engine + TLS; python3/make/g++ because the
# frozen install compiles native modules pulled in elsewhere in the workspace.
# All of it stays in this stage; the runtime image never sees the toolchain.
RUN apt-get update && apt-get install -y openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /build

# The full monorepo, minus everything .dockerignore excludes (dist, node_modules,
# /deploy, /hosting and all of /docs but three re-included files). Nothing the
# core-api build runs reads under /docs: its graph is `tsc -b` per project plus
# the tenancy database package's client generation, which reads only that
# package's own prisma/ directory.
COPY . .

# docs is not in the build context, so the lockfile has one more importer than
# the copied workspace. Drop that entry so --frozen-lockfile matches the tree.
RUN sed -i '/docs/d' pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile

# The explicit core-api graph, defined once in the root package.json.
RUN pnpm run build:platos:core-api

# SHIPPED EQUALS TESTED (D-ZOD). Self-contained production bundle at /deploy,
# installed from the shared lockfile's own resolved snapshots. The legacy deploy
# this replaces re-resolved the peers of injected workspace packages and shipped
# the Slack channel adapter's chat/ai/@ai-sdk peers against zod 3 while the
# lockfile and every workspace test used zod 4. The script's header has the
# mechanism, including the one lockfile setting it holds for the duration of the
# deploy and restores byte-for-byte.
RUN node scripts/deploy-bundle-closure.mjs deploy --importer apps/core-api --bundle /deploy

# PROVEN AGAINST THE COMMITTED LOCKFILE. `check` compares the bundle with
# apps/core-api's production closure as pnpm-lock.yaml states it, and fails the
# build on any package outside that closure, on any closure package that is
# missing (none is reviewed as absent), on any workspace package set that differs
# from the importer graph, and on any link that leaves the bundle.
RUN node scripts/deploy-bundle-closure.mjs check --bundle /deploy --importer apps/core-api

# ───────────────────────────────────────────────────────────
# Runtime
# ───────────────────────────────────────────────────────────
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

# openssl is what the ORM query engine links against at runtime.
RUN apt-get update && apt-get install -y openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deployed node_modules + package.json, then the compiled process. Owned by root
# and not writable by the account below, so the running process cannot rewrite
# its own code.
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./package.json
COPY --from=builder /build/apps/core-api/dist ./dist

# Apache-2.0 s4(a)/s4(d) — the License and the NOTICE attributions must travel
# with every distributed copy of the work. A shipped image IS a distribution.
COPY --from=builder /build/LICENSE ./LICENSE
COPY --from=builder /build/NOTICE ./NOTICE

# NODE_ENV is the framework's switch, not configuration this process reads
# (apps/core-api/src/config/environment.ts is the only environment reader, and
# PLATOS_ENVIRONMENT is its required variable). Production keeps the HTTP
# framework's default error pages free of stack traces.
ENV NODE_ENV=production
# The config default is 127.0.0.1, which inside a container is unreachable from
# every published port. The image binds every interface; WHO can reach that is
# decided where it is run (compose binds the host side to loopback only).
ENV PLATOS_CORE_API_HOST=0.0.0.0

# The account the base image ships (uid/gid 1000), stated numerically so an
# orchestrator enforcing a non-root policy can verify it without a passwd lookup.
USER 1000:1000

# PLATOS_CORE_API_PORT's default in apps/core-api/src/config/schema.ts.
EXPOSE 3030

# Exec form, exactly the package's own `start` script: node is PID 1 and
# receives SIGTERM itself, and main.ts turns that into a drained shutdown with a
# meaningful exit code (0 drained, 1 fault, 78 invalid configuration).
CMD ["node", "dist/main.js"]
