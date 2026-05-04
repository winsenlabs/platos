# Node.js CLI example — @platos/client

Minimal Node script: connect to a Platos agent and stream a reply to
stdout. Auth via session token minted by your backend (read from the
`PLATOS_SESSION_TOKEN` env var).

## Run

```bash
npm install
export PLATOS_BASE_URL="https://agent.platos.dev"
export PLATOS_SESSION_TOKEN="<mint this with mintPlatosSessionToken on your backend>"
export PLATOS_AGENT_ID="<agent id from the dashboard>"
node --loader tsx cli.ts "What can you help me with?"
```

Works with both a hosted Platos deployment and local dev
(`PLATOS_BASE_URL=http://localhost:3100`).
