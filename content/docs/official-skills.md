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
  - apps/agent/src/skills/official/code_execution.skill.md
  - apps/agent/src/skills/official/skill-handlers.ts
  - apps/agent/src/skills/official-skills-seeder.service.ts
---

# Official skills catalog

Platos ships with a small set of first-party skills you can toggle on without authoring a manifest. Each one is seeded on agent boot, lives under `apps/agent/src/skills/official/`, and follows the same Claude-skills format any imported skill uses.

## What it is

The official catalogue currently includes:

- **platos.code_execution** (Code Execution): Python, Node.js, **and arbitrary shell** execution in a secure E2B cloud sandbox that **persists across calls within a conversation**. Tools: `run_python`, `run_node`, `run_shell`, `install_package`, `upload_to_sandbox`. The agent can `git clone` a repo, `cd` into it, install deps, and run CLI tools (`psql`, `ffmpeg`, `duckdb`, `curl`, `pnpm`…) as separate turns — the filesystem, working directory, and installed packages all carry over. Requires `E2B_API_KEY`.
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

### Persistent sandbox sessions

The sandbox is bound to the **conversation thread**, not a single turn. On the first
tool call Platos creates an E2B sandbox tagged with the thread id (`metadata.platosThread`);
every later `run_python` / `run_node` / `run_shell` / `install_package` / `upload_to_sandbox`
call in the same thread reconnects to that one sandbox. Files you write, the working
directory, and packages you install all carry over. Each result includes
`sessionPersistent: true` to confirm state will survive to the next call.

This makes multi-step CLI workflows possible across turns:

```
run_shell: git clone https://github.com/acme/widgets && cd widgets && ls
run_shell: cd widgets && pnpm install
run_shell: cd widgets && pnpm test
```

`run_shell` is full CLI access — `git`, `psql "$DATABASE_URL" -c '…'`, `ffmpeg`, `duckdb`,
`pandoc`, `curl`, `ripgrep`, etc. A **non-zero exit code is returned as data** (`exitCode`,
`stdout`, `stderr`) rather than thrown, so the model can read `stderr` and recover.
`run_shell` is capped at 120s per command; `run_python`/`run_node` at 60s.

**Lifecycle / cost.** The sandbox auto-reaps after ~10 minutes of inactivity, after which
the next call creates a fresh one (state resets). There is no per-turn teardown — the session
is what makes the workflow above work — so long idle gaps, not active use, are what end it.
When no thread is in scope (e.g. a one-shot SDK call), the sandbox is ephemeral and torn down
immediately after the call.

**Network.** Egress is **off by default** (deny-all). Set `E2B_SANDBOX_ALLOW_INTERNET=true`
to let the sandbox reach the internet — required for `git clone`, `pip install`, and `curl`.
Leave it off for agents that take untrusted input. Optionally pin a custom microVM image with
`E2B_SANDBOX_TEMPLATE`.

**Where these vars live.** `E2B_API_KEY`, `E2B_SANDBOX_ALLOW_INTERNET`, and
`E2B_SANDBOX_TEMPLATE` are resolved **per scope** from the dashboard's environment-variables
panel (org/project/environment), the same way `RESEND_API_KEY` and the other skill keys are —
they are *not* read from the agent container's process environment. Set them on the
environment you run the agent in; each tenant brings their own E2B key.

### Disable a seeded skill

Set the `PLATOS_DISABLED_SKILLS` env var to a comma-separated list of slugs. The seeder skips disabled slugs at boot. Agents that already had the skill toggled on retain the row but the runtime refuses to attach its tools.

### Test a skill before shipping

The official catalogue lives next to its tests (`*.test.ts`). When you fork and add a skill, ship a parallel `.test.ts` that runs against testcontainers (no mocks). The Platos test bar is the same for official and imported skills.

## Common pitfalls

- E2B charges per-second of sandbox runtime. Because the sandbox now persists for the whole thread, it stays billable until the ~10-minute idle reap — not just for one turn. That is the intended trade for cross-turn state; if you only need a one-shot run, the ephemeral path (no thread in scope) tears down immediately.
- `run_shell` does not thread `cwd` between separate calls automatically — a `cd` only lasts for the command it runs in. Chain steps in one command (`cd dir && …`) or pass `cwd` explicitly to anchor where a command runs.
- With `E2B_SANDBOX_ALLOW_INTERNET=true`, the sandbox can reach the internet. Don't run commands supplied verbatim by an untrusted user with egress enabled — review them first.
- `platos-rag` only retrieves from indices the agent has access to. Cross-project retrieval is rejected at the auth layer.
- The seeder runs every boot. If you renamed a slug locally, the old row stays and a new row is created. Clean up old rows before relying on slug uniqueness.
- `csv-ops` opens files via the file-operations bridge. It does not pull from external URLs; upload first.

## Related

- [Skills](/docs/skills): the manifest format and import flow shared by all skills.
- [Artifacts](/docs/artifacts): code-runner output files and image-generation results land as artifacts.
- [Attachments and files](/docs/attachments-and-files): code-runner reads the conversation's attachment scope.
