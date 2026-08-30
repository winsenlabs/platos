## Platos webapp — powered by Remix

Start the supporting stores from the repository root, then run the webapp source
development server:

```sh
cp .env.example .env
# Before Compose model evaluation, replace every required development sentinel
# documented in content/docs/self-hosting.md.
docker compose -f docker-compose.platos.yml up -d postgres redis clickhouse minio
pnpm --filter webapp dev
```

To build the complete local compose stack, including the application images:

```sh
# Reuse the populated root .env created above.
docker compose -f docker-compose.platos.yml up -d --build
```
