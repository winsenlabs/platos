# `@platos/embed`

Single-script `<platos-agent>` web component for dropping a [Platos](https://platos.dev) agent chatbot into any HTML page.

## Use

```html
<script src="https://platos.example.com/embed/v1.js"></script>

<platos-agent
  base-url="https://platos.example.com"
  agent-id="agt_demo123"
  theme="auto"
  width="400px"
  height="600px"></platos-agent>
```

- **base-url** (required): the Platos deployment hosting your agent.
- **agent-id** (required): the public agent id. The agent must have `visibility: "public-guest"` (set via the Share page in the dashboard).
- **theme**: `"light"` | `"dark"` | `"auto"` (default).
- **width** / **height**: CSS-compatible strings. Defaults `400px` × `600px`.
- **token-url** (optional): a server endpoint on your own domain that mints guest tokens and returns `{ token }`. When omitted, the component calls the Platos deployment's built-in `/api/v1/public/guest-token` endpoint — which is rate-limited per-IP by the agent.

## Isolation

The component opens a shadow DOM containing an `<iframe>` pointed at
`${base-url}/embed/${agentId}`. The parent page's CSS and globals cannot
leak into the chat UI and vice versa. The iframe exchanges `postMessage`
with the parent for theme + resize events only.

## Licence

Apache 2.0.
