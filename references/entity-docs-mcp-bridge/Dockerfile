# External-MCP bridge entity backend.
#
# Mirrors any external MCP server's tool catalog into Platos as a
# connected entity, until the agent runtime gains native external-MCP
# consumption. Default upstream is the public Platos docs MCP, so out
# of the box this brings `search_docs` into your Platos instance.
#
# IMPORTANT: this Dockerfile expects the build context to be the trigger
# repo root (not just `references/entity-docs-mcp-bridge`). The bridge
# depends on @platosdev/platools-sdk via `file:../../packages/platools-js`, which
# only resolves when both directories are present in the build context.
# When building via the `docs-mcp-bridge` service in docker-compose.platos.yml
# this is configured automatically. To build manually:
#
#   docker build \
#     -f references/entity-docs-mcp-bridge/Dockerfile \
#     -t platos-entity-docs-mcp-bridge \
#     .

# ── Build stage ─────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /work

# Copy just the @platosdev/platools-sdk workspace package and build its dist.
# The bridge's package.json points main/types at this dist via
# file:../../packages/platools-js, so `npm install` over there resolves
# successfully against this prebuilt copy.
COPY packages/platools-js/ ./packages/platools-js/
WORKDIR /work/packages/platools-js
RUN npm install --no-audit --no-fund --ignore-scripts
RUN npm run build

# Now the bridge itself.
WORKDIR /work/references/entity-docs-mcp-bridge
COPY references/entity-docs-mcp-bridge/package.json ./
COPY references/entity-docs-mcp-bridge/tsconfig.json ./
COPY references/entity-docs-mcp-bridge/src ./src
# `--install-links=true` materializes the `file:../../packages/platools-js`
# dep as a real copy under node_modules/@platosdev/platools-sdk instead of a
# symlink to the workspace path. The symlink target would otherwise
# break when node_modules is COPYed into the runtime stage.
RUN npm install --no-audit --no-fund --install-links=true
RUN npm run build
RUN npm prune --omit=dev --install-links=true

# ── Runtime stage ───────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the bridge's compiled output + its node_modules. The
# node_modules tree contains the @platosdev/platools-sdk dist (resolved via the
# file: dep) and zod, so the runtime is self-contained.
COPY --from=build /work/references/entity-docs-mcp-bridge/dist ./dist
COPY --from=build /work/references/entity-docs-mcp-bridge/node_modules ./node_modules
COPY --from=build /work/references/entity-docs-mcp-bridge/package.json ./package.json

USER node
CMD ["node", "--enable-source-maps", "dist/server.js"]
