# `@platosdev/react-widget`

Drop-in React FAB chat widget for [Platos](https://platos.dev) agents. Floating button in the corner; click → chat panel; full streaming; theme-aware; works in Next.js, Vite, CRA, Remix — anywhere React 18+ runs.

Three identity flows out of the box, every per-turn agent option exposed, fully themable via CSS variables, and a headless hook for callers that want their own UI.

## Install

```bash
npm install @platosdev/react-widget
# or
pnpm add @platosdev/react-widget
```

`react` and `react-dom` `>=18` are peer deps.

## Quick start

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

That's it. Floating button appears bottom-right; visitor clicks; sees a name + email form (default); on submit your `/api/platos-session` mints a session token; chat begins, fully streamed.

## Identity flows — pick one

The widget supports three ways to figure out who's chatting. They're chosen by which props you supply, not by a mode flag (mostly).

### 1. Anonymous public — visitor fills a form

The default. Use when adding a chat to a marketing site, blog, support page, etc.

```tsx
<PlatosFab
  baseUrl="https://platos.example.com"
  agentId="agt_xxx"
  tokenUrl="/api/platos-session"
/>
```

Your `/api/platos-session` receives `{ name?, email?, verified? }` from the widget and mints a JWT signed with your entity's `serviceSecret`, embedding `userMeta: { name, email }` so the agent sees them as `{{user.name}}` / `{{user.email}}` and the trace's identity columns get populated.

Sample backend (Next.js Route Handler, using `@platosdev/token-mint`):

```ts
// app/api/platos-session/route.ts
import { mintSessionToken } from "@platosdev/token-mint";

export async function POST(req: Request) {
  const { name, email } = await req.json();
  const token = mintSessionToken({
    serviceSecret: process.env.PLATOS_ENTITY_SERVICE_SECRET!,
    claims: {
      organizationId: process.env.PLATOS_ORG_ID!,
      projectId:      process.env.PLATOS_PROJECT_ID!,
      environmentId:  process.env.PLATOS_ENV_ID!,
      userId:         `lead-${hashEmail(email ?? "anon")}`,
      entityId:       "marketing-site",
      userMeta:       { name, email },
    },
    ttlSeconds: 3600,
  });
  return Response.json({ token });
}
```

### 2. Anonymous + email-verified — OTP gate

Add an OTP step before the chat opens. Customer-side endpoints generate, store, and verify the code; the widget just orchestrates the UI flow.

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

Sample backend (Resend + Redis):

```ts
// app/api/platos-otp/send/route.ts
import { Resend } from "resend";
import { redis } from "@/lib/redis";
import { createHash } from "node:crypto";

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function POST(req: Request) {
  const { email } = await req.json();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const hash = createHash("sha256").update(`${email}:${code}`).digest("hex");
  await redis.setex(`platos-otp:${email}`, 300, hash); // 5 min TTL

  await resend.emails.send({
    from: "noreply@your-domain.com",
    to: email,
    subject: "Your verification code",
    html: `<p>Your code: <strong>${code}</strong></p><p>Expires in 5 minutes.</p>`,
  });
  return new Response(null, { status: 204 });
}
```

```ts
// app/api/platos-otp/verify/route.ts
import { redis } from "@/lib/redis";
import { createHash, timingSafeEqual } from "node:crypto";

export async function POST(req: Request) {
  const { email, code } = await req.json();
  const stored = await redis.get(`platos-otp:${email}`);
  if (!stored) return new Response("Code expired", { status: 401 });

  const candidate = createHash("sha256").update(`${email}:${code}`).digest();
  const expected  = Buffer.from(stored, "hex");
  if (
    candidate.length !== expected.length ||
    !timingSafeEqual(candidate, expected)
  ) {
    return new Response("Invalid code", { status: 401 });
  }
  await redis.del(`platos-otp:${email}`);
  return Response.json({ ok: true });
}
```

After verification the widget POSTs `tokenUrl` again with `{ verified: true }` so your token-mint handler can include that in `userMeta`.

### 3. Backend-authenticated — your app already knows the user

Skip every form. Pass the identity directly:

```tsx
<PlatosFab
  baseUrl="https://platos.example.com"
  agentId="agt_xxx"
  tokenUrl="/api/platos-session"
  identityMode="preset"
  identity={{ name: session.user.name, email: session.user.email }}
/>
```

Your `/api/platos-session` is already inside an auth-protected route (NextAuth, Clerk, your own session middleware). It uses `req.auth` to decide what to mint instead of trusting the body.

Or skip the token-mint round-trip entirely and pass a token your server already minted:

```tsx
<PlatosFab
  baseUrl="https://platos.example.com"
  agentId="agt_xxx"
  sessionToken={mySessionToken}
/>
```

Note: `sessionToken` is short-lived (Platos default: 5 minutes). For long sessions prefer `tokenUrl` so the widget auto-refreshes on 401.

## Per-turn options

Every variable the agent accepts on a Socket.IO turn is exposed via the `perTurn` prop. The same shape `client.threads.send()` accepts — passed unchanged on every message.

```tsx
<PlatosFab
  baseUrl="https://platos.example.com"
  agentId="agt_xxx"
  tokenUrl="/api/platos-session"
  perTurn={{
    // Per-turn dynamic-content keys. Resolved into the prompt's dynamic blocks.
    dynamicBlocks: {
      product_context: "User is on the pricing page.",
      cart_total: "$249.00",
    },
    // Pick a named route from the agent's modelRoutes config.
    modelLabel: "fast",
    // Bind this turn to a specific connected entity / connection.
    contextType: "entity",
    contextId: "shopify-store-acme",
    // Pre-uploaded MinIO attachment ids for this turn (multimodal).
    attachmentIds: ["att_123"],
    // Postman-mode session-context override — replace the resolved
    // sessionContext for this single turn.
    sessionContextOverride: {
      entity_ids: ["acme-prod"],
      role: "manager",
    },
  }}
/>
```

`systemPromptOverride` is HTTP-only on the agent today (the streaming WS path doesn't accept it yet). Use the agent's stored `systemPrompt` or rotate via the dashboard for now.

## Theming

Three levels, in order of escalation:

### Level 1 — CSS variables (set on `.platos-widget-root` or globally)

```css
.platos-widget-root {
  --platos-color-primary: #FF5722;
  --platos-color-bg: #FAFAFA;
  --platos-radius: 12px;
  --platos-font-family: "Inter", system-ui, sans-serif;
}
```

The widget defines defaults for both light and dark via `prefers-color-scheme`. Set `theme="light"` or `theme="dark"` to lock one mode.

### Level 2 — `themeTokens` prop (per-instance)

```tsx
<PlatosFab
  baseUrl="…" agentId="…" tokenUrl="…"
  themeTokens={{
    primary: "#FF5722",
    background: "#FAFAFA",
    radius: "8px",
    fontFamily: "Inter, sans-serif",
  }}
/>
```

### Level 3 — `classNames` slot pass-through (Tailwind / CSS Modules)

```tsx
<PlatosFab
  baseUrl="…" agentId="…" tokenUrl="…"
  classNames={{
    fab: "shadow-2xl ring-2 ring-orange-500/40",
    panel: "border-orange-200",
    assistantBubble: "bg-orange-50 text-orange-900",
    userBubble: "bg-orange-500",
  }}
/>
```

Slot keys: `fab`, `panel`, `header`, `messages`, `assistantBubble`, `userBubble`, `inputArea`, `input`, `sendButton`, `identityForm`.

## Position + size

```tsx
<PlatosFab
  ...
  position="bottom-right"     // bottom-right (default) | bottom-left | top-right | top-left
  width="420px"
  height="640px"
/>
```

## Headless mode — `usePlatosChat`

Bring your own UI. The hook gives you the message list, status, and a `send()` function. You wire it into whatever component tree you want.

```tsx
import { usePlatosChat } from "@platosdev/react-widget";

function CustomChat() {
  const { messages, send, status, error } = usePlatosChat({
    baseUrl: "https://platos.example.com",
    agentId: "agt_xxx",
    tokenUrl: "/api/platos-session",
    identity: { name: "Tejas", email: "tejas@winsen.ai" },
    perTurn: { modelLabel: "fast" },
  });

  return (
    <div>
      {messages.map((m) => <div key={m.id}>{m.role}: {m.content}</div>)}
      <button onClick={() => send("hello!")}>Send</button>
      {status === "streaming" && <span>typing…</span>}
      {error && <span>{error.message}</span>}
    </div>
  );
}
```

## Lifecycle hooks

```tsx
<PlatosFab
  ...
  onOpen={() => track("chat-opened")}
  onClose={() => track("chat-closed")}
  onIdentity={(id) => track("lead-captured", id)}
  onError={(err) => Sentry.captureException(err)}
/>
```

## Hotkey

`⌘K` (Mac) / `Ctrl+K` (everyone else) toggles the panel anywhere on the page. `Esc` closes when open. Disable with `hotkey={false}` if it collides with your own shortcuts.

## What's not in v0.1

- File / image attachments (`attachmentIds` works, but you upload via your own flow first).
- Markdown rendering (assistant bubbles render as plain text). Wrap the bubbles via `classNames.assistantBubble` + your own markdown lib if needed; v0.2 will ship react-markdown built-in.
- `systemPromptOverride` — HTTP-only on the agent server today.
- Multi-thread switching inside a single widget instance.

## Licence

Apache 2.0 — see `LICENSE`. Same as Platos itself.

## Source + issues

- Repo: https://github.com/winsenlabs/platos
- Package directory: `packages/platos-react-widget`
- Issues: https://github.com/winsenlabs/platos/issues
- Docs: https://platos.dev/docs/react-widget
