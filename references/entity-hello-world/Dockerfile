# Reference entity backend (PPR-49).
#
# Production-style image: multi-stage build, non-root runtime, small
# final layer. Intended as a drop-in starting point — copy into your
# own repo and add your tools. Build with:
#
#   docker build -t platos-entity-hello-world .
#
# Run with:
#
#   docker run --rm -it \
#     --env PLATOS_URL=ws://host.docker.internal:3100/tools/sync \
#     --env PLATOS_SECRET=<paste from /agent-entities/new> \
#     platos-entity-hello-world

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
# Dev deps needed for `tsc`.
RUN npm install --no-audit --no-fund
RUN npm run build
# Prune dev deps after build so only prod deps end up in the final stage.
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Run as the `node` user shipped with the base image — avoids running
# the entity backend as root in the container.
USER node
CMD ["node", "--enable-source-maps", "dist/server.js"]
