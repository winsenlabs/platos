# `platos-nextjs-starter`

Minimal Next.js 15 App Router starter that integrates a [Platos](https://platos.dev) agent.

What's in here:

- **Server action** (`app/platos/token/route.ts`) that mints a Platos session token via `@platosdev/token-mint` using your entity's `PLATOS_ENTITY_SERVICE_SECRET`.
- **Client page** (`app/chat/page.tsx`) that fetches the token, opens a `PlatosClient`, and streams chat via `useAgentStream` from `@platos/react-hooks`.

## Setup

```bash
cp .env.example .env.local
# Fill in:
#   PLATOS_BASE_URL           - your Platos service URL
#   PLATOS_ENTITY_ID          - the entity id you registered
#   PLATOS_ENTITY_SERVICE_SECRET - the entity's serviceSecret
#   PLATOS_AGENT_ID           - the agent to chat with
#   PLATOS_ORG_ID / PROJECT_ID / ENV_ID - the scope the session token resolves to

npm install
npm run dev
# → http://localhost:3000/chat
```

## Where to go from here

- **Auth**: the example demo-user passes `userId` directly from `cookies()` — replace with your auth system.
- **Token refresh**: the Platos client calls `onTokenRefresh` on 401; the server action re-mints using the same logic.
- **Public chat**: if your agent has `visibility: "public-guest"`, skip the token route and use the `@platosdev/embed` package instead.

## Licence

Apache 2.0.
