---
slug: connect-entity-platools-py
title: Connect an entity (Python)
description: Same as the TypeScript guide, but using the platools Python package.
category: integrations
order: 20
questions:
  - "How do I install platools in Python?"
  - "How do I declare a tool with type hints?"
  - "How do I run my entity backend behind asyncio?"
  - "How do I sign HMAC nonces in Python?"
related:
  - connect-entity-platools-ts
  - consume-platos-mcp
---

# Connect an entity (Python)

Same flow as the TypeScript guide, but with the `platools` Python package.

## The goal

A Python `asyncio` service that connects to Platos and serves tool calls. Same architecture as the TS version; pick whichever runtime your stack already runs.

## Steps

1. **Register the entity in Platos.**

   Sidebar -> Entities -> "New entity". Copy the `serviceSecret` shown once.

2. **Install.**

   ```bash
   pip install platools
   ```

   Python 3.10+ required.

3. **Connect.**

   ```python
   import asyncio
   import os
   from platools import Platools

   async def main():
       platools = Platools(
           url=os.environ.get("PLATOS_URL", "wss://platos.example.com/tools/sync?entity=my-entity"),
           secret=os.environ["PLATOS_SERVICE_SECRET"],
       )

       @platools.tool(name="send_email", auth="user")
       async def send_email(to: str, body: str, ctx=None) -> dict[str, bool]:
           await mailer.send({"to": to, "body": body})
           return {"ok": True}

       await platools.connect()

   asyncio.run(main())
   ```

4. **Run.**

   ```bash
   PLATOS_SERVICE_SECRET=ent_secret_... python -m my_entity
   ```

5. **Wire to an agent.**

   Same as the TS path: agent's Tools tab, toggle the entity's tools on.

## Verify

- The entity's status flips to "online" in the dashboard.
- A turn that prompts "send an email" calls into your Python handler.
- Wire-test from `/agent-entities/{id}/wire-test`.

## HMAC nonce signing

The Python SDK signs `{ts}.{nonce}.{body}` with the service secret and keeps an LRU of recent nonces (100k, matching the TS SDK). Replays within the window are rejected. You do not call this directly; the SDK wraps it.

## Asyncio integration

The SDK is asyncio-native. To run alongside an existing event loop (FastAPI, aiohttp), `await platools.connect()` inside a long-lived coroutine; do not block the loop.

## Next steps

- [Connect an entity (TypeScript)](/guides/connect-entity-platools-ts) for the Node variant.
- [Consume Platos via MCP](/guides/consume-platos-mcp).
