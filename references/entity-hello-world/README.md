# entity-hello-world

A minimal reference **entity backend** for Platos. Registers a single tool (`echo`) with the Platos agent over the `platools` WebSocket protocol. Use it as:

1. A smoke test that your Platos deployment's tool gateway is wired up end-to-end.
2. A starting template — copy this directory into your own repo, drop your real tools in `src/server.ts`, ship.

The entity is written in TypeScript against `@platosdev/platools-sdk`. A Python flavor will land in a follow-up; the protocol is the same.

## Prerequisites

- A running Platos deployment (self-hosted via `docker-compose.platos.yml`, or the reference agent at `http://localhost:3100`).
- Node.js 20+ on your machine, or Docker Desktop.
- Access to the Platos dashboard as a user with permission to register entities.

## Setup

### 1. Register the entity on the Platos dashboard

1. Log into the dashboard.
2. Navigate to **Agents → Connected Entities** in the left nav.
3. Click **Connect Entity**.
4. Fill in the form:
   - **Entity ID** — a stable slug, e.g. `hello-world-local`. This is how the tool registry groups your tools.
   - **Display Name** — human-readable label, e.g. `Hello World (local)`.
   - Leave **MCP URLs** and **Custom Params** empty for this reference.
5. Click **Generate Secret & Register**.
6. On the next page (the "Entity Registered" / initial-secret screen), copy **both** values — you need them in the next step:
   - **Service Secret** — shown exactly once. If you close the tab before copying, you'll need to click **Regenerate** on the entity detail page to mint a fresh one.
   - **WebSocket URL** — usually `ws://localhost:3100/tools/sync` in local dev.

### 2. Configure the reference backend

From this directory:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PLATOS_URL=ws://localhost:3100/tools/sync
PLATOS_SECRET=<paste the Service Secret from step 1>
```

### 3. Run the backend

Pick one:

#### Option A — local Node

```bash
npm install
npm run dev        # tsx, auto-reloads on edits
```

Or for a production-style run:

```bash
npm install
npm run build
npm start
```

#### Option B — Docker

```bash
docker compose up --build
```

On Linux, if the container can't reach `host.docker.internal`, override the URL when running compose:

```bash
PLATOS_URL=ws://<your-host-ip>:3100/tools/sync docker compose up --build
```

### 4. Verify the connection

1. In the Platos dashboard, open **Agents → Tools** (the tool matrix).
2. You should see a row for `echo` with:
   - **Entity**: `hello-world-local` (or whatever you named it)
   - **Status**: `connected` (green dot)
   - **Tools**: 1
3. If the row is missing or status shows `disconnected`, check the backend's logs — the SDK prints a reconnect attempt every time it fails, with the reason.
4. Open **Agents → Connected Entities → hello-world-local** — **Last Connected** should be within the last few seconds and **Tools registered** should show 1 (`echo`).

### 5. Smoke-test the tool

Create a short-lived thread that calls `echo`:

- Via the dashboard — create or open an agent, enable the `echo` tool on it, open a chat, and ask it to "echo the word hello". You should see the tool call in the trace view with the returned `{ echoed: "hello", at: "2026-…" }` payload.
- Via the Platos API — see `docs/tool-gateway.md` for the direct invocation path.

Either way, the entity backend's stdout logs one line per call: `[entity-hello-world] echo called — user=… scope=…`.

## What this proves

- **WebSocket handshake works.** The `platools` SDK authenticated against the `serviceSecret` and upgraded to WS.
- **Schema propagation works.** Platos accepted the Zod-derived input/output schema for `echo` and stored a row in `PlatosToolDefinition` + `PlatosEntityToolMapping`.
- **Tool dispatch works.** The agent side signed the HMAC request (per PPR-71, with nonce), the SDK verified + deduped, invoked the handler, and returned the JSON result.
- **Context works.** `currentUserId()` / `currentScope()` populated correctly from the `__platos` envelope.

## Next steps

- Replace `echo` with your own tools. The full API is documented in `docs/writing-agents.md` and the `@platosdev/platools-sdk` README.
- Add more tools by calling `platools.tool({...}, handler)` any number of times before `await platools.connect()`.
- For production, bake the image, deploy to your infra, and set `PLATOS_URL` to the wss:// endpoint of your Platos cluster.
- Rotate the `serviceSecret` periodically from the entity detail page's **Regenerate** button — the SDK reconnects automatically with the new value.
