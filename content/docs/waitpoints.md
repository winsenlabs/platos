---
slug: waitpoints
title: Waitpoints
description: Durable wait-for-token primitive that lets a run pause for hours or days awaiting human or external input.
category: engine
order: 60
trigger_dev_primitive: true
trigger_dev_link: "https://trigger.dev/docs/v3/wait-for-token"
questions:
  - "What is a waitpoint?"
  - "How do I make an agent pause for a human approval?"
  - "How long can a waitpoint stay open?"
  - "How do I resume a waitpoint from an external system?"
  - "What is the relationship between waitpoints and the request_durable_approval meta-tool?"
related:
  - runs
  - approvals-and-hitl
  - platos-tasks
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.tokens/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.tokens.$waitpointParam/route.tsx
---

# Waitpoints

A waitpoint is a durable pause inside a [run](/docs/runs). The run calls `wait.forToken({ idempotencyKey, timeout })`, the engine snapshots the run state, and the run resumes when the token is completed (`wait.completeToken`) or the timeout expires.

Platos uses trigger.dev as the durable execution engine. Waitpoints are a trigger.dev concept that Platos surfaces in the dashboard for visibility. The wait/resume semantics, idempotency keys, and timeout handling are unchanged from upstream.

## In Platos

The Waitpoints page at `/orgs/{org}/projects/{project}/env/{env}/waitpoints/tokens` lists every open token with its expiry, the run holding it, and a "complete" action. Click a token to see the run context and the body that will be returned to the run on resume.

The Platos primitive that uses waitpoints is `request_durable_approval` (see [Approvals and HITL](/docs/approvals-and-hitl)). An agent calls the meta-tool, the runtime opens a waitpoint, sends a notification (Slack DM, email, dashboard alert), and the run holds open for hours-to-days until a human resolves the approval. On resolve, `wait.completeToken` returns the decision (approve / deny + reason); the run continues with the result.

Waitpoints survive deploys, restarts, and scale events. The only thing that ends an unresolved waitpoint is the timeout.

## Reference

The full reference for waitpoints lives in the trigger.dev docs:

**[trigger.dev/docs/v3/wait-for-token](https://trigger.dev/docs/v3/wait-for-token)**

## Related

- [Runs](/docs/runs): the run that holds the waitpoint open.
- [Approvals and HITL](/docs/approvals-and-hitl): the Platos surface that consumes waitpoints for human approval.
- [Platos tasks](/docs/platos-tasks): durable BGOs that use waitpoints for "wait for the user" patterns.
