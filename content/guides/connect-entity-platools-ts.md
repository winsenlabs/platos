---
slug: connect-entity-platools-ts
title: Connect an entity (TypeScript)
description: Stand up an entity backend with @platools/sdk, declare your tools, and wire it to Platos.
category: integrations
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I install @platools/sdk?"
  - "How do I declare a tool in TypeScript?"
  - "How does the SDK reconnect on a dropped WebSocket?"
  - "Where do I put my entity service secret?"
  - "How do I handle the X-Platos-User-Token claim?"
related:
  - connect-entity-platools-py
  - consume-platos-mcp
  - chat-stream-disconnects
source_files_referenced:
  - packages/platools-ts
  - references/entity-hello-world
  - apps/agent/src/tool-gateway/tool-sync-ws.service.ts
---

# Connect an entity (TypeScript)

Stand up an entity backend with `@platools/sdk`, declare your tools, and wire it to Platos.

## The goal

A Node service that holds a long-lived WebSocket to Platos and serves tool calls. After this, your agent can call tools that touch your data without Platos ever seeing the data itself.

## Steps

1. **Register the entity in Platos.**

   Sidebar -> Entities -> "New entity". Pick a slug (`my-entity`), name. The dialog mints a `serviceSecret`; copy it. The plaintext is shown once via Redis GETDEL; do not refresh the page before saving.

2. **Install the SDK.**

   ```bash
   npm install @platools/sdk
   ```

3. **Connect.**

   ```ts
   import { connect } from "@platools/sdk";

   const conn = connect({
     url: process.env.PLATOS_URL ?? "wss://platos.example.com/connections",
     serviceSecret: process.env.PLATOS_SERVICE_SECRET!,
   });

   conn.tool(
     "send_email",
     {
       type: "object",
       properties: {
         to: { type: "string", format: "email" },
         body: { type: "string" },
       },
       required: ["to", "body"],
     },
     async (args, ctx) => {
       // ctx.userToken is X-Platos-User-Token, opaque to us, verified by our auth.
       await mailer.send(args);
       return { ok: true };
     },
   );

   await conn.start();
   console.log("entity connected");
   ```

4. **Run.**

   ```bash
   PLATOS_SERVICE_SECRET=ent_secret_... node ./entity.js
   ```

5. **Wire to an agent.**

   In the dashboard, open the agent's Tools tab. The new entity's tools (just `send_email` for now) appear in the list. Toggle on. Save.

## Verify

- The entity's status badge in the dashboard flips to "online".
- The agent's Tools tab shows `send_email`.
- A chat turn that prompts "send an email to alice@example.com saying hi" produces a tool call to your entity. You see the call in your entity logs and the result in the chat panel.
- Wire-test the entity from `/agent-entities/{id}/wire-test`.

## Reconnection

The SDK reconnects automatically with exponential backoff. The connect race is handled by the early-message-buffer in `tool-sync-ws.service.ts:130-135, 281-284`; do not bypass.

## Reference

The reference entity backend lives at `references/entity-hello-world/`. Drift D-010 noted this is outside the workspace; install with its own `package.json` rather than via pnpm root install:

```bash
cd references/entity-hello-world
npm install
npm start
```

## Next steps

- [Connect an entity (Python)](/guides/connect-entity-platools-py) for the Python variant.
- [Consume Platos via MCP](/guides/consume-platos-mcp) once you want external clients to use your tools.
- [Chat stream keeps disconnecting](/guides/chat-stream-disconnects) if you see frequent reconnects.
