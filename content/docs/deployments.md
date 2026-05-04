---
slug: deployments
title: Deployments
description: Code-level deployments of trigger.dev task bundles. The engine equivalent of an agent version, but for the task code itself.
category: engine
order: 40
trigger_dev_primitive: true
trigger_dev_link: "https://trigger.dev/docs/v3/deploying"
questions:
  - "What is a deployment in trigger.dev terms?"
  - "How is a deployment different from an agent version?"
  - "How do I promote a deployment to production?"
  - "How do I roll back to a previous deployment?"
  - "What does a failed deployment look like?"
related:
  - runs
  - agent-versions
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments.$deploymentParam/route.tsx
---

# Deployments

A deployment is one published version of your task code bundle. Each deployment carries a version id; runs target a specific deployment to run against.

Platos uses trigger.dev as the durable execution engine. Deployments are a trigger.dev concept that Platos surfaces in the dashboard for visibility. The build, push, and promote lifecycle is unchanged from upstream.

## In Platos

The Deployments page at `/orgs/{org}/projects/{project}/env/{env}/deployments` lists every published deployment with build status, version id, and the date it became current. Click a deployment to see its tasks list, environment variables snapshot, and the runs that targeted it.

A trigger.dev deployment is the code-level equivalent of an [agent version](/docs/agent-versions). The two are independent: an agent version snapshots prompt, tools, model. A deployment snapshots the task source bundle. They evolve on different cadences. An agent version can change without a new deployment; a new deployment can land without affecting any agent.

For Platos-shipped BGOs (`agent-tool-block.task.ts`, `agent-batch.task.ts`), deployments happen as part of the Platos image build itself; you do not deploy them by hand. For BGOs you author in-dashboard (PIFSP-12), the runtime auto-deploys on save into a vm2 sandbox and skips the trigger.dev deploy lifecycle.

## Reference

The full reference for deployments lives in the trigger.dev docs:

**[trigger.dev/docs/v3/deploying](https://trigger.dev/docs/v3/deploying)**

## Related

- [Runs](/docs/runs): runs target a specific deployment.
- [Agent versions](/docs/agent-versions): the Platos-side equivalent for agent config.
