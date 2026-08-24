---
slug: skills
title: Skills
description: Reusable agent behaviors with manifests, required env vars, and Claude-skills compatibility.
category: platform
order: 40
questions:
  - "What is a skill and how does it differ from a tool?"
  - "How do I import a Claude skill from a URL?"
  - "What goes in a skill manifest?"
  - "How does a skill declare required environment variables?"
  - "How are skills enabled per agent?"
  - "Can I write my own skill and ship it inside my fork?"
  - "What is the difference between an official skill and an imported one?"
related:
  - official-skills
  - tools
  - providers
  - encryption-and-secrets
---

# Skills

A skill is a reusable agent behaviour packaged as a manifest plus a tool implementation. Where a tool is one function with one schema, a skill is the bundle: its manifest declares the env vars it needs, the tools it ships, the prompt block to inject, and the format the agent should use it in. Skills are Claude-skills format compatible, so anything in the upstream catalog works in Platos.

## What it is

A `Skill` row plus a manifest. The manifest fields:

- `slug` and `name`: human-readable identifiers, unique per scope.
- `tools`: an array of tool definitions (name, description, JSON Schema). Each becomes a tool exposed to agents that enable the skill.
- `required_env`: a list of environment variable names the skill needs to run (`E2B_API_KEY`, `OPENAI_API_KEY`, etc.). At enable time, the runtime checks that each is present in the scope's environment variables; if any are missing, the toggle is blocked with a clear "link these keys first" message.
- `prompt_block`: optional markdown injected into the system prompt when the skill is enabled. This is how `platos-rag` adds its retrieval instructions and how `platos-code-runner` documents the sandbox.
- `format_instructions`: optional output formatting hints layered into the prompt.
- `version` and `source`: imported skills carry their origin URL plus a content hash.

Skills are registered with `SkillRegistryService`, run by `SkillRuntimeService`, and imported by `SkillImporterService`. Manifests are parsed and validated by `SkillManifestParser` before they ever land in the database.

## Why it matters

Every agent that wants to crunch a CSV ends up writing the same five tool wrappers, the same prompt about output formatting, and the same env-var checklist. Skills factor that out: install once, enable per agent, and the runtime handles the prompt, the schema, the env enforcement, and the cost attribution.

The Claude-skills compatibility means the catalogue you build for Anthropic's hosted agent runtime works on a self-hosted Platos with no rewriting.

## How to use it

### Enable an official skill

From the dashboard, navigate to `/orgs/{org}/projects/{project}/env/{env}/skills`. Toggle "platos-code-runner". The dialog walks you through the env vars you must link (`E2B_API_KEY`). Without them, the toggle stays off.

Once enabled at scope level, open an agent, go to the Tools tab, and toggle the skill on for that agent. The skill's tools and prompt block now appear in turn assembly.

### Import a Claude skill from a URL

```ts
await platos.platos_call("skills.import", {
  url: "https://example.com/skills/my-skill.zip",
});
```

The importer fetches the URL, validates it has not been redirected to a private IP (SSRF defence), parses the manifest, and writes the skill row plus its manifest blob. Imports run with the user's scope; the resulting skill is scoped to the project.

### Write a skill in your fork

A skill lives under `packages/skills/{slug}/` with a `manifest.json` plus a TypeScript module exporting tool implementations. The seeder picks up new entries on agent boot and registers them. See [Official skills catalog](/docs/official-skills) for the seeder behaviour.

```json
{
  "slug": "my-skill",
  "name": "My skill",
  "version": "1.0.0",
  "required_env": ["MY_API_KEY"],
  "prompt_block": "When the user asks to fetch X, use the my-skill tools.",
  "tools": [
    { "name": "fetch_x", "description": "...", "input_schema": { "type": "object", "properties": { "id": { "type": "string" } } } }
  ]
}
```

## Common pitfalls

- `required_env` is enforced at toggle time, not turn time. If you rotate an env var to an empty string after enabling, turns will fail with the skill's own runtime error. Keep keys present.
- Imports are size-capped and SSRF-guarded. URLs that resolve to private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) are rejected.
- A skill's `prompt_block` adds tokens to every turn. Long blocks hurt cache hit rate. Keep blocks tight and rely on tool descriptions for the rest.
- A skill enabled at scope level is not auto-enabled per agent. Each agent toggles its own skill set.

## Related

- [Official skills catalog](/docs/official-skills): the first-party skills shipped with Platos and how the seeder bootstraps them.
- [Tools](/docs/tools): the four tool families; skill tools land in the "skill" family.
- [Providers](/docs/providers): provider keys are the most common `required_env` source.
- [Encryption and secrets](/docs/encryption-and-secrets): how skill `required_env` values are stored.
