---
slug: import-claude-skill
title: Import a Claude skill from a URL
description: Paste a Claude-compatible skill manifest URL and Platos will fetch, parse, and surface it.
category: integrations
order: 40
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is the format of a Claude skill manifest?"
  - "How do I import a skill from GitHub?"
  - "How are skill secrets requested at enable time?"
  - "How do I update an imported skill when the upstream version changes?"
  - "How is the import URL validated to avoid SSRF?"
related:
  - quickstart
  - create-first-agent
source_files_referenced:
  - apps/agent/src/skills/skill-importer.service.ts
  - apps/agent/src/skills/skill-manifest.parser.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills.new/route.tsx
---

# Import a Claude skill from a URL

Paste a Claude-compatible skill manifest URL; Platos fetches, validates, registers, and exposes it. Same flow whether the manifest is a `.json` file, a zip with a `manifest.json` at the root, or a GitHub raw URL.

## The goal

An imported skill that shows up in your skills list, with its tools available for agents to enable.

## Steps

1. **Find the manifest URL.**

   Most Claude skills are hosted on GitHub. Use the raw URL (e.g. `https://raw.githubusercontent.com/example/my-skill/main/manifest.json`).

2. **Open the import page.**

   Sidebar -> Skills -> "New skill" -> "Import from URL".

3. **Paste and import.**

   Paste the URL. Click "Import". Platos:
   - Fetches the URL with SSRF guards (private IPs are rejected).
   - Parses the manifest (`SkillManifestParser`).
   - Validates `required_env` against your environment's variables.
   - Writes a `PlatosSkill` row scoped to the project.

4. **Link required env vars.**

   If the skill declares `required_env: ["STRIPE_API_KEY"]` and that key is missing, the dialog walks you to add it via [Add a provider key](/guides/add-provider-key) for that key.

5. **Enable per agent.**

   Open the agent. Skills tab -> toggle the new skill. Agent now exposes the skill's tools and prompt block.

## Verify

- The skill row appears under `/skills`.
- Toggling on for an agent surfaces the skill's tools in the agent's Tools tab.
- A test chat turn that prompts the skill to act produces tool calls visible in Postman mode.

## SSRF defence

The importer rejects URLs that resolve to private IP space:

- 10.0.0.0/8
- 172.16.0.0/12
- 192.168.0.0/16
- 169.254.0.0/16 (link-local + AWS IMDS)
- 127.0.0.0/8

Redirects are followed but each redirect target is re-validated. EOBD-9/10 closed the SSRF gaps in this path.

## Update an imported skill

Re-importing the same URL upserts the skill if the version differs. The runtime keeps the old version alongside the new and lets agents migrate at their own pace; bump the agent's skill pin to switch.

## Next steps

- [Quickstart](/guides/quickstart) if you have not enabled the skill on an agent yet.
- [Create your first agent](/guides/create-first-agent) and toggle the new skill on.
