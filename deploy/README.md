# Deploy config — test.platos.dev edge

Host-level infra config for the `test.platos.dev` edge VPS.

> **Host details are deliberately not committed.** Set `PLATOS_EDGE_HOST` in your shell
> (see the private operator runbook for the current value). This repository is public;
> host addresses, hostnames and root-shell runbooks must not be published here.
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

Access is key-only (WIN-291) — password authentication is disabled on the edge
host. The normal path runs as the **unprivileged `ubuntu` account** with
`NOPASSWD` sudo. **Direct `root` login is recovery-only and must not be used
here.**

```bash
: "${PLATOS_EDGE_HOST:?set PLATOS_EDGE_HOST — see the private operator runbook}"
: "${PLATOS_EDGE_USER:=ubuntu}"

# 1. Upload the candidate to a location the unprivileged account can write.
scp deploy/Caddyfile "$PLATOS_EDGE_USER@$PLATOS_EDGE_HOST:/tmp/Caddyfile.new"

# 2. Validate the CANDIDATE before it replaces the live file, back up, install,
#    reload. Ordering matters: validating after the copy would mean an invalid
#    config is already live by the time the check fails.
ssh "$PLATOS_EDGE_USER@$PLATOS_EDGE_HOST" '
  set -eu
  sudo caddy validate --config /tmp/Caddyfile.new --adapter caddyfile
  sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
  sudo install -o root -g root -m 0644 /tmp/Caddyfile.new /etc/caddy/Caddyfile
  sudo systemctl reload caddy
  rm -f /tmp/Caddyfile.new
'
```

`systemctl reload caddy` is zero-downtime. The backup is taken automatically by
step 2 above; timestamped copies accumulate in `/etc/caddy/` and should be pruned
periodically.
