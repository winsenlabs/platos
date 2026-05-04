---
slug: official-skills
title: Official skills catalog
description: First-party skills shipped with Platos including code execution, csv-ops, and platos-rag.
category: platform
order: 50
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Which official skills ship with Platos?"
  - "How do I enable the code execution skill?"
  - "What does the csv-ops skill do?"
  - "How is platos-rag different from a plain retrieval block?"
  - "Are official skills tested differently from imported ones?"
  - "How do I disable a seeded skill in my self-host?"
related:
  - skills
  - artifacts
  - attachments-and-files
source_files_referenced:
  - apps/agent/src/skills/official
  - apps/agent/src/skills/official-skills-seeder.service.ts
  - packages/skills/platos-code-runner
  - docs/pra/PRA_SPEC_CODE_EXECUTION.md
---

# Official skills catalog

Platos ships with a small set of first-party skills you can toggle on without authoring a manifest. Each one is seeded on agent boot, lives under `apps/agent/src/skills/official/`, and follows the same Claude-skills format any imported skill uses.

## What it is

The official catalogue currently includes:

- **platos-code-runner**: sandboxed Python and shell execution via E2B. Tools include `execute_python`, `execute_shell`, `read_file`, `write_file`, `list_dir`, plus a MinIO bridge so the agent can reference uploaded attachments and emit output files. Requires `E2B_API_KEY`.
- **csv-ops**: streaming CSV operations (filter, group, aggregate, pivot, join) without loading the file into the LLM context. Useful for the "30k-row Excel" workload that would otherwise blow the context window. No external env required.
- **file-operations**: read, write, and edit files inside the conversation's attachment scope. Pairs naturally with code-runner.
- **image-generation**: generate images via OpenAI or Anthropic image endpoints. Requires the matching provider key.
- **web-search**: search the web through a configurable provider. Requires `WEB_SEARCH_API_KEY`.
- **parallel-web**: multi-result fetch with parallel requests, rate-limited.
- **platos-rag**: retrieval over a project-scoped vector index, with a `retrieve` tool plus a prompt block that tells the model when to query.

Each skill ships a `*.skill.md` manifest, a typed handler in `skill-handlers.ts`, and a token estimator. The `OfficialSkillsSeederService` reads the directory at boot and upserts a `PlatosSkill` row per slug for every project that does not already have one.

## Why it matters

Official skills are how Platos solves the "I want my agent to crunch a CSV" or "I want the agent to run a Python script in a sandbox" problem without each fork re-implementing the wrapper. They are tested against pinned versions, run inside the same scope and budget rails as any other tool, and are the first things you turn on for a fresh agent.

`platos-rag` deserves a callout: it is not just a retrieval block, it is a tool the model decides to call. That means the model can choose to skip retrieval on simple turns, fan out across multiple sub-queries, or chain retrieval with code execution, all while the runtime tracks cost and citations.

## How to use it

### Enable for an agent

From the dashboard, navigate to the Skills tab on an agent's detail page, then toggle the skill on. If the skill has `required_env` and any are missing, the toggle stays off and points you at [Providers](/docs/providers) or the environment variables panel.

### Code-runner sandbox lifecycle

`platos-code-runner` provisions an E2B sandbox at first tool call within a turn and reuses it for the remainder of that turn. Files uploaded to the conversation are mounted at `/mnt/attachments`. Output files written to `/mnt/outputs` are picked up at turn end and uploaded to MinIO as artifacts. Wall-clock and CPU caps are enforced by E2B itself; Platos enforces a token budget on top.

### Disable a seeded skill

Set the `PLATOS_DISABLED_SKILLS` env var to a comma-separated list of slugs. The seeder skips disabled slugs at boot. Agents that already had the skill toggled on retain the row but the runtime refuses to attach its tools.

### Test a skill before shipping

The official catalogue lives next to its tests (`*.test.ts`). When you fork and add a skill, ship a parallel `.test.ts` that runs against testcontainers (no mocks). The Platos test bar is the same for official and imported skills.

## Common pitfalls

- E2B charges per-second of sandbox runtime. A long-lived turn that holds a sandbox open is more expensive than two short turns. Code-runner releases the sandbox at turn end automatically, but `spawn_bgo` calls inherit the pricing.
- `platos-rag` only retrieves from indices the agent has access to. Cross-project retrieval is rejected at the auth layer.
- The seeder runs every boot. If you renamed a slug locally, the old row stays and a new row is created. Clean up old rows before relying on slug uniqueness.
- `csv-ops` opens files via the file-operations bridge. It does not pull from external URLs; upload first.

## Related

- [Skills](/docs/skills): the manifest format and import flow shared by all skills.
- [Artifacts](/docs/artifacts): code-runner output files and image-generation results land as artifacts.
- [Attachments and files](/docs/attachments-and-files): code-runner reads the conversation's attachment scope.
