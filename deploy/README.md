# Deploy config — test.platos.dev edge

Host-level infra config for the `test.platos.dev` VPS (`srv1549678`, `187.127.142.170`).
These files live on the host **outside** `/opt/platos`, so they are NOT part of the
`docker compose` tar-deploy — they are tracked here so the edge routing survives a
box rebuild and is reviewable.

## `Caddyfile` → `/etc/caddy/Caddyfile`

Caddy runs on the **host** (systemd service, not a container) and terminates TLS for
`test.platos.dev`. It reverse-proxies by path:

- Agent (`localhost:3100`): `/mcp/platform*`, `/agent-io/*`, `/api/v1/memory/*`,
  `/api/v1/channels/*`, `/api/v1/agent/*`, **`/tools/sync*`**.
- Everything else → the webapp (`localhost:3030`).
- `agent.test.platos.dev` → the agent directly (`localhost:3100`).

**`/tools/sync*` is the platools tool-sync WebSocket** (entity/artifacts connectors dial
`wss://test.platos.dev/tools/sync`). It MUST route to the agent. Without this block the
upgrade falls through the catch-all to the webapp and returns 404 — Caddy proxies WS
upgrades transparently, so the only requirement is that the path points at `:3100`.
(Added 2026-07-24 after the artifacts connector was failing its WS upgrade.)

### Apply / update

```bash
scp deploy/Caddyfile root@187.127.142.170:/etc/caddy/Caddyfile
ssh root@187.127.142.170 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy'
```

`systemctl reload caddy` is zero-downtime. Back up the existing file first.
