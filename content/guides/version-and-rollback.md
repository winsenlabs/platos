---
slug: version-and-rollback
title: Version, canary, and roll back an agent
description: Promote a canary version, watch its evals, and roll back if it regresses.
category: recipes
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I create a canary version of my agent?"
  - "What percentage of traffic does the canary get?"
  - "How do I roll back to the previous version?"
  - "How do I gate canary promotion on an A/B eval?"
related:
  - create-first-agent
  - run-an-eval-suite
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx
---

# Version, canary, and roll back an agent

Ship prompt or model changes safely with the canary -> watch -> promote workflow.

## The goal

A change that flows through canary at a small percentage, gets watched on metrics and ratings, and either promotes or rolls back without taking the agent down.

## Steps

1. **Edit the agent.**

   Make your change (prompt, model, tools). Save. The runtime writes a new version snapshot. Add a note like "tighten reply tone".

2. **Set as canary.**

   On the agent's Canary tab, select the new version, set `canaryPercent` to 5. Save. The runtime hashes thread ids; 5% of threads now route at the new version.

3. **Watch.**

   Watch for at least an hour:
   - Cost per turn (Costs view).
   - Rating delta (Monitoring view).
   - Tool error rate (Traces view).

   If anything regresses, jump to step 5.

4. **Promote.**

   On the Canary tab, click "Promote". The runtime swaps `currentVersionId = canaryVersionId` and clears the canary fields. 100% of traffic now uses the new version.

5. **Rollback (if needed).**

   On the Versions tab, pick the previous version, click "Rollback". The runtime copies that snapshot back onto the live row in a transaction. Conversations mid-stream finish on whichever snapshot they captured at turn start.

## Verify

- Pre-promote: a request from a hashed-into-canary thread shows the new version's prompt in Postman mode; a hashed-out thread shows the old.
- Post-promote: every thread shows the new prompt.
- Post-rollback: every thread shows the old prompt within the next turn.

## Gate on an A/B eval

Configure the canary policy to require an A/B eval pass before promote. The button stays disabled until the eval clears the threshold. See [Run an A/B eval suite](/guides/run-an-eval-suite).

## Next steps

- [Run an A/B eval suite](/guides/run-an-eval-suite) for structured comparison before promote.
- [Set a per-agent budget cap](/guides/set-budget-cap) if the canary unexpectedly increases cost.
