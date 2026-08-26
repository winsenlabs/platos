# `@platosdev/embed`

Drop-in `<platos-agent>` web component for embedding a [Platos](https://platos.dev) agent chatbot into any HTML page. Iframe-isolated, theme-aware, single-script — works with vanilla HTML, React, Vue, anything that supports custom elements.

## Install

Two ways to use this:

### 1. ES module via npm (bundlers, frameworks)

```bash
npm install @platosdev/embed
```

```ts
import "@platosdev/embed";
// The custom element <platos-agent> is now registered globally.
```

### 2. Single-script CDN tag (plain HTML, no build)

Self-host the bundled output from your Platos service, or use any CDN:

```html
<script type="module" src="https://platos.example.com/embed/v1.js"></script>
```

The script auto-registers `<platos-agent>` on load.

## Use

```html
<platos-agent
  base-url="https://platos.example.com"
  agent-id="agt_demo123"
  theme="auto"
  width="400px"
  height="600px"></platos-agent>
```

### Attributes

| Attribute | Required | Default | Description |
|---|---|---|---|
| `base-url` | ✅ | — | The Platos service hosting your agent. |
| `agent-id` | ✅ | — | Public agent id. The agent must have `visibility: "public-guest"` (set via the Share page in the dashboard). |
| `theme` | | `auto` | `light`, `dark`, or `auto` (follows `prefers-color-scheme`). |
| `width` | | `400px` | Any CSS-compatible string. |
| `height` | | `600px` | Any CSS-compatible string. The iframe sends resize events; the component clamps height to `[240px, 1200px]` for layout stability. |
| `token-url` | | (built-in) | Server endpoint on YOUR domain that mints guest tokens and returns `{ token }`. When omitted, the component calls `${base-url}/api/v1/public/guest-token?agentId=...` directly — convenient but rate-limited per-IP. Set `token-url` for production traffic so your own backend gates the rate limit and can attach `userMeta`. |

## Isolation

The component opens a shadow DOM containing an `<iframe>` pointed at `${base-url}/embed/${agentId}`. The parent page's CSS and globals can't leak into the chat UI; the iframe only exchanges `postMessage` with the parent for theme + resize events.

## Advanced — direct class import

If you'd rather register the element under a different tag name (e.g. for renaming or scoped registries):

```ts
import { PlatosAgentElement } from "@platosdev/embed";

customElements.define("my-chat-agent", PlatosAgentElement);
```

## Compatibility

- Modern browsers (Chrome 67+, Safari 12+, Firefox 63+ — anywhere with custom elements + shadow DOM).
- Node `>=18.20.0` for the build step (the runtime is browser-only).
- No dependencies. The whole bundle is one ~2 KB script.

## Licence

Apache 2.0 — see `LICENSE`. Same as Platos itself.

## Source + issues

- Repo: https://github.com/winsenlabs/platos
- Package directory: `packages/platos-embed`
- Issues: https://github.com/winsenlabs/platos/issues
- Docs: https://platos.dev/docs/public-agents-and-embed
