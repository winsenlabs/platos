---
slug: consume-platos-mcp
title: Consume Platos via MCP
description: Connect Claude Desktop, Cursor, or any MCP client to Platos with a PAT.
category: integrations
order: 30
questions:
  - "How do I use Platos as an MCP server?"
  - "Where do I get a PAT?"
  - "Which Platos tools show up in my MCP client?"
  - "How do I scope which tools are exposed?"
  - "Why is my Bearer token rejected?"
related:
  - connect-entity-platools-ts
  - embed-public-agent
---

# Consume Platos via MCP

Point Claude Desktop, Cursor, or any MCP client at Platos to use its tools and meta-tools from a chat that lives outside Platos.

## The goal

An MCP client connected to your Platos instance. The client's tool catalogue federates entity tools, Platos skills, start meta-tools, and the Platos control plane.

## Steps

1. **Mint a PAT.**

   Settings -> MCP tokens -> "New token". Name it (`claude-desktop-pat`), pick scope, pick permission scopes (`tools:execute`, `agents:read` is a good starter set). Copy the `plt_ent_...` string.

2. **Configure your MCP client.**

   Claude Desktop's `~/Library/Application Support/Claude/claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "platos": {
         "url": "https://platos.example.com/mcp",
         "headers": {
           "Authorization": "Bearer plt_ent_abc123..."
         }
       }
     }
   }
   ```

   Restart Claude Desktop.

3. **List tools.**

   In the MCP client, list available tools. You should see entity tools, skill tools, meta-tools, and control-plane tools all in one catalogue.

4. **Scope per-entity (optional).**

   If you only want one entity's tools, point at the per-entity endpoint instead:

   ```
   https://platos.example.com/mcp/entity/my-entity
   ```

   Branding (PIFSP-24) means the connector shows the entity's own name.

## Verify

- The client's tool list shows tools from your Platos instance.
- A tool call works end-to-end (e.g. `agents.list` returns your agents).
- The "Last used" column on the PAT row in `/settings/mcp-tokens` updates.

## Why the bearer is rejected

- Token must start with `plt_ent_`. The recent fix (commit `adfe32e6b`) accepts both PAT and OAuth bearers; older installations may only accept the OAuth shape.
- Token must have the right `scopes`. A PAT scoped only `agents:read` cannot execute tools.
- Token must be in the right scope (org/project/env). MCP gateway picks the scope from the PAT.
- Anonymous entity endpoints require `?environmentId=<canonical-id>` on every request. OAuth clients must use only the scopes advertised by discovery; the browser consent URL contains an opaque one-time transaction rather than mutable OAuth authority fields.
- The PAT's environment is fixed at mint. The gateway never substitutes production or the oldest project environment.

## Next steps

- [Connect an entity (TypeScript)](/guides/connect-entity-platools-ts) to add your own tools to the federation.
- [Embed a public agent](/guides/embed-public-agent) for the consumer-facing alternative.
