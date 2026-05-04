---
slug: invite-team
title: Invite a teammate to a project
description: Add a collaborator to your Platos project and pick their role.
category: getting-started
order: 50
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I invite someone to my Platos org?"
  - "What roles are available?"
  - "How do I cap project members in self-host?"
  - "How do I revoke an invite?"
related:
  - quickstart
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.invite/route.tsx
---

# Invite a teammate to a project

Add a collaborator to your Platos org or project. Pick their role; revoke any time.

## The goal

A teammate signed in to the same project, with the right role for what they need to do.

## Steps

1. **Open the invite page.**

   Org settings -> Invite (`/orgs/{org}/invite`).

2. **Enter the email.**

   Type the teammate's email address. They will receive a magic link.

3. **Pick the role.**

   - **Owner**: full org rights including billing and member management.
   - **Admin**: full project rights, no member management.
   - **Member**: read + write on agents, read on monitoring.
   - **Viewer**: read-only.

   Default to Member; raise as needed.

4. **Send.**

   Click "Send invite". The teammate gets the link; clicking it lands them on the project.

## Verify

- The teammate's name appears in the org members list with the chosen role.
- They see the project and its agents on their dashboard.

## Member cap on self-host

Self-hosted Platos caps project members at `PLATOS_MAX_PROJECT_MEMBERS` (default 2 in the OSS distribution). To raise the cap, set the env var and restart the webapp. Recent commit `00d0f005f` introduced this cap; a CLAUDE.md change at the same time documented the default.

## Revoke an invite

If the invite has not been accepted, the members list shows "Pending"; click the row's overflow menu -> "Revoke". If the invite was already accepted, "Remove member" instead; their session is invalidated and PATs they minted are revoked.

## Next steps

- [Quickstart](/guides/quickstart) for the new teammate's first run.
- [Set a per-agent budget cap](/guides/set-budget-cap) before exposing prod agents to a wider team.
