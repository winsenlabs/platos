# React chat widget example

Embeddable chat widget using `@platos/client` + `@platos/react-hooks`.
Demonstrates:

- `PlatosProvider` + `usePlatosClient`
- `useAgentStream` — streaming tokens into the UI
- `<PlatosArtifact>` — rendering artifacts the agent emits

```bash
npm install
npm run dev
```

The widget reads `VITE_PLATOS_BASE_URL`, `VITE_PLATOS_SESSION_TOKEN`,
and `VITE_PLATOS_AGENT_ID` at build time. For production, mint the
session token on your backend and inject it via your own token-refresh
endpoint — see the `onTokenRefresh` option on `PlatosClient`.
