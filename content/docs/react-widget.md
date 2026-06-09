---
slug: react-widget
title: React widget
description: Drop-in React FAB chat widget — three identity flows (anonymous form, OTP-verified, backend-authenticated), every per-turn agent option exposed, fully themable.
category: dx
order: 35
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I add a Platos chat to my Next.js app?"
  - "How do I collect a visitor's name and email?"
  - "How do I verify the visitor's email with an OTP code?"
  - "How do I plug my own auth into the widget?"
  - "How do I theme the chat widget?"
  - "How do I pass per-turn options like modelLabel or dynamicBlocks?"
related:
  - sdks
  - public-agents-and-embed
  - auth-modes
  - official-skills
source_files_referenced:
  - packages/platos-react-widget/src/PlatosFab.tsx
  - packages/platos-react-widget/src/usePlatosChat.ts
  - packages/platos-react-widget/src/IdentityForm.tsx
---

# React widget

`@platosdev/react-widget` is a drop-in floating chat bubble for any React 18+ app — Next.js, Vite, CRA, Remix, anywhere. Three identity flows out of the box, every per-turn agent option exposed, fully themable via CSS variables, and a headless `usePlatosChat` hook for callers that want their own UI.

## What it is

A single React component, `<PlatosFab>`, that renders:

- A circular floating-action button anchored to a corner of the page (default: bottom-right)
- A chat panel that slides in on click
- An identity form (name + email; optionally OTP-verified) before chat begins, OR a pass-through when your app already knows the user
- Streaming assistant responses powered by `@platosdev/client` over Socket.IO

Plus a headless `usePlatosChat` hook for fully custom layouts.

## Why it matters

Self-hosters previously had two options for embedding a Platos agent into a customer-facing app:

1. `@platosdev/embed` — iframe-based web component. Works in any HTML page but doesn't integrate with the host app's auth, layout, or styling system.
2. `@platosdev/client` — raw SDK. Maximum flexibility, but you build the UI from scratch.

The React widget fills the gap: native React, integrates with the host app's session, themable to match any design system, and ships a sensible default UI that customers can install in five lines of code.

## How to use it

### Install

```bash
npm install @platosdev/react-widget
# or
pnpm add @platosdev/react-widget
```

### Anonymous public agent — minimum setup

```tsx
"use client";
import "@platosdev/react-widget/styles.css";
import { PlatosFab } from "@platosdev/react-widget";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <PlatosFab
        baseUrl="https://platos.example.com"
        agentId="agt_xxx"
        tokenUrl="/api/platos-session"
      />
    </>
  );
}
```

Visitor sees a name/email form, submits, the widget POSTs to `/api/platos-session` (your route), your backend mints a session token signed with your entity's `serviceSecret` (using `@platosdev/token-mint` or any JWT lib), the widget streams chat with the resulting JWT.

The visitor's name + email travel as the `userMeta` claim in the JWT and surface as `{{user.name}}` / `{{user.email}}` in the agent's prompt — no code change needed if your agent already references those.

### Anonymous + email-verified (OTP gate)

Add `verifyEmail` and point at customer-side OTP endpoints. The widget orchestrates the form → send-code → verify-code → chat flow; your backend handles the actual code generation, hashing, storage, and email send via Resend (or any other transport).

```tsx
<PlatosFab
  baseUrl="https://platos.example.com"
  agentId="agt_xxx"
  tokenUrl="/api/platos-session"
  verifyEmail
  otpEndpoints={{
    sendUrl:   "/api/platos-otp/send",
    verifyUrl: "/api/platos-otp/verify",
  }}
/>
```

The README in `packages/platos-react-widget/` ships paste-ready Next.js Route Handlers for the OTP send + verify endpoints using Resend + Redis.

### Backend-authenticated — your app already knows the user

Skip the form entirely. Two paths:

```tsx
// Path A — pass identity, widget still uses tokenUrl
<PlatosFab
  baseUrl="..." agentId="..." tokenUrl="/api/platos-session"
  identityMode="preset"
  identity={{ name: session.user.name, email: session.user.email }}
/>

// Path B — pass a token your server already minted
<PlatosFab
  baseUrl="..." agentId="..."
  sessionToken={mySessionToken}
/>
```

Path A is preferred for long sessions (the widget auto-refreshes on 401 via `tokenUrl`). Path B is fine for short-lived embeds.

### Per-turn options

Every variable the agent's Socket.IO turn endpoint accepts is exposed via the `perTurn` prop and passed unchanged on every message:

```tsx
<PlatosFab
  ...
  perTurn={{
    dynamicBlocks: { product_context: "User is on the pricing page." },
    modelLabel: "fast",
    contextType: "entity",
    contextId: "shopify-store-acme",
    attachmentIds: ["att_123"],
    sessionContextOverride: { entity_ids: ["acme-prod"], role: "manager" },
  }}
/>
```

`systemPromptOverride` is HTTP-only on the agent today (not exposed by the streaming WS path). Use the agent's stored `systemPrompt` and rotate via the dashboard for now.

### Theming

Three levels:

- **CSS variables**: set `--platos-color-primary`, `--platos-color-bg`, `--platos-radius`, etc. on `.platos-widget-root` or globally. The widget defines defaults for both light and dark via `prefers-color-scheme`.
- **`themeTokens` prop**: per-instance overrides without a stylesheet edit.
- **`classNames` prop**: pass-through className slots for `fab`, `panel`, `header`, `messages`, `assistantBubble`, `userBubble`, `inputArea`, `input`, `sendButton`, `identityForm`. Use with Tailwind / CSS Modules / styled-components.

### Headless — bring your own UI

```tsx
import { usePlatosChat } from "@platosdev/react-widget";

function CustomChat() {
  const { messages, send, rate, status, error } = usePlatosChat({
    baseUrl: "...",
    agentId: "...",
    tokenUrl: "...",
    identity: { name, email },
    perTurn: { modelLabel: "fast" },
  });
  // render however you want
}
```

### Message ratings (thumbs up/down)

`<PlatosFab>` renders thumbs up/down on each assistant bubble once the message
has persisted — no setup required. A vote calls the rating API; a thumbs-down
also quarantines the memories extracted from that message, and votes roll up
into the dashboard satisfaction views.

For the headless hook, `usePlatosChat` returns a `rate` callback and stamps a
`serverId` + `rating` onto each assistant `ChatMessage`. The widget captures the
`message_persisted` stream event internally, so `rate` just takes the message's
local id:

```tsx
const { messages, rate } = usePlatosChat({ /* ... */ });

messages
  .filter((m) => m.role === "assistant" && m.serverId) // rateable once persisted
  .map((m) => (
    <div key={m.id}>
      {m.content}
      <button onClick={() => rate(m.id, "up")} aria-pressed={m.rating === 1}>👍</button>
      <button onClick={() => rate(m.id, "down")} aria-pressed={m.rating === -1}>👎</button>
    </div>
  ));
```

`rate` is optimistic (updates `m.rating` immediately, rolls back on failure) and
toggles — calling it again with the same direction clears the vote. It returns
`false` (no-op) if the message hasn't persisted yet.

### Hotkey

`⌘K` / `Ctrl+K` toggles the panel; `Esc` closes. Disable with `hotkey={false}`.

## Common pitfalls

- **No backend for `tokenUrl`**: the widget can't talk directly to Platos with raw entity credentials — the browser must never hold a `serviceSecret`. The token-mint MUST live on your server. Use `@platosdev/token-mint` for the JWT signing primitive.
- **Cross-origin**: when running the widget on a domain different from your Platos deployment, either add the origin to your connected entity's `allowedOrigins`, OR set `PLATOS_CORS_UNIVERSAL=true` on the agent for hosted-demo flexibility.
- **`agentId` must be public-guest enabled** for `identityMode="anonymous"` to work without a token. For all other identity modes, the agent's visibility doesn't matter — your token-mint backend authorises the call.
- **Avatar images**: `avatar` accepts a URL string OR a React node. URL strings render as `<img>` and need to be on a CORS-friendly host or same-origin.
- **Markdown rendering**: v0.1 renders assistant bubbles as plain text. Wrap with `classNames.assistantBubble` and your own markdown lib (e.g. `react-markdown`) if you need rich formatting; v0.2 will ship it built-in.

## Related

- [SDKs](/docs/sdks): the underlying `@platosdev/client` the widget builds on.
- [Public agents and embed](/docs/public-agents-and-embed): the iframe-based alternative for non-React contexts.
- [Auth modes](/docs/auth-modes): the session-token + `userMeta` claim the widget uses.
- [Email skill](/docs/official-skills): paired well with the OTP flow — the agent can send the verification email itself.
