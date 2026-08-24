---
slug: create-first-agent
title: Create your first agent
description: Walk through the agent creation wizard from name to first chat turn.
category: getting-started
order: 40
questions:
  - "What fields are required when I create an agent?"
  - "Which model should I pick first?"
  - "How do I write a useful system prompt?"
  - "How do I test the agent before publishing?"
related:
  - quickstart
  - add-provider-key
  - version-and-rollback
---

# Create your first agent

Walk through the agent creation wizard end to end. The PIFSP-5 wizard is identity-first and mode-driven, so each step shows you a live preview of the agent being built.

## The goal

An agent named "Hello", built through the wizard, with a working chat turn. By the end, you understand which fields matter at create time vs. which are best left at defaults.

## Steps

1. **Open the wizard.**

   Sidebar -> Agents -> "New agent". The wizard opens at `/agents/new`.

2. **Identity.**

   - **Name**: human-readable. `Hello`.
   - **Slug**: URL-safe id, derived from the name. Override if you have a naming convention.
   - **Description**: optional; surfaces in the agents list and on the share page.

3. **Mode.**

   Pick the dispatch mode:
   - **Direct** (default): the agent calls tools directly within its turn. Best for most cases.
   - **Sub-agent**: the parent agent dispatches a sub-agent for tool work. Useful for very large tool sets.
   - **Execute-tool only**: the agent only sees `find_tools` plus `execute_tools`; pure discovery.

   Default direct.

4. **Model and provider.**

   Pick a model from the catalog. Only models whose provider has a linked key in the current environment appear. Without a linked provider, the picker is empty; jump to [Add a provider key](/guides/add-provider-key).

5. **Prompt.**

   Three options:
   - **From scratch**: write a system prompt in the text area.
   - **From a template**: pick from project-scoped prompt library entries (see [Prompts](/docs/prompts)).
   - **Block-based**: compose ordered prompt blocks for cache-friendly turns.

   For a first agent, start simple: `You are a friendly assistant. Reply concisely.` You can move to blocks once you understand the cache layers.

6. **Tools** (optional for first agent).

   Skip for now. The wizard auto-enables the standard meta-tool set (`remember`, `recall`, `find_tools`, `execute_tools`, `spawn_job`, etc.). Tools come in once you connect an entity or enable a skill.

7. **Save and chat.**

   Click "Create". The agent detail page opens; the first version snapshot is written. Click "Chat", type "Hi", watch tokens stream.

## Verify

- The agent appears in the sidebar agents list.
- A first version exists (Versions tab shows v1).
- The chat turn streams tokens; the trace tab shows a span timeline; cost lands in the monitoring tab.

## Test before publishing

Use Postman mode in the chat panel to inspect the assembled prompt and any tool calls. Save a test interaction as a Postman template (see [Publish a Postman conversation template](/guides/publish-postman-template)) so anyone on the team can replay.

## Next steps

- [Connect an entity (TypeScript)](/guides/connect-entity-platools-ts) to give the agent tools.
- [Version, canary, and roll back an agent](/guides/version-and-rollback) for safe iteration.
- [Run a golden set](/guides/run-golden-set) to evaluate representative Threads against fixed criteria.
- [Set a per-agent budget cap](/guides/set-budget-cap) before exposing the agent to traffic.
