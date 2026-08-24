---
slug: scope-and-multi-tenancy
title: Scope tuple and multi-tenancy
description: The (organizationId, projectId, environmentId) tuple that gates every scoped row in Platos.
category: dx
order: 10
questions:
  - "What is the scope tuple?"
  - "How does Platos prevent cross-tenant leaks?"
  - "Which tables carry the scope tuple?"
  - "How do I scope a query inside a custom service?"
  - "What happens if a request lacks a scope claim?"
  - "How do environments fit into the scope?"
related:
  - environments
  - auth-modes
  - encryption-and-secrets
---

# Scope tuple and multi-tenancy

Every scoped row in Platos carries `(organizationId, projectId, environmentId)`. Every authenticated request resolves the same tuple. The auth guard refuses any read or write whose row tuple does not match the request tuple. This is how multi-tenant isolation works without per-customer service replicas.

## What it is

The scope tuple is the architectural invariant that every Platos table either:

1. Carries the three columns (and is filtered by the scope guard), or
2. Is a parent in the scope graph (organization, project, environment themselves).

`ScopeGuard` is the NestJS guard that resolves the tuple from auth (header, JWT, or service secret) and stamps it on the `request.scope` object. Every controller method that touches scoped data accepts `RequestScope` as a parameter (or reads it from the guard) and threads it into queries.

`cross-scope-isolation.test.ts` runs probes that assert: a request with scope A cannot read or write any row with scope B. The probes cover threads, agents, memories, tools, providers, and audit.

## Why it matters

The default failure mode for multi-tenant systems is "we forgot one query". One missing `WHERE organizationId = ?` and customer A reads customer B's chat. The scope guard plus the test bar make every code path that touches scoped data an explicit decision: either the developer threaded the scope through, or the IDOR test fails.

The three-level tuple (org, project, env) gives you flexibility without exploding installation complexity. You can scope keys per environment, separate prod from dev within the same project, and run multiple projects under one org for a team.

## How to use it

### Read scope in a controller

```ts
async function listAgents(scope: RequestScope) {
  return agentCrud.list(scope);
}
```

The guard runs first; the param decorator extracts. No manual unpacking.

### Scope a query

Always include the tuple in your `where`:

```ts
this.prisma.platosAgent.findMany({
  where: {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    isActive: true,
  },
});
```

The Prisma model has the three columns plus a composite index; the cost is one row read.

### Resolve scope from headers (Mode 1)

Internal callers pass `X-Platos-Organization-Id`, `X-Platos-Project-Id`, `X-Platos-Environment-Id`. The guard rejects external callers (presence of `X-Forwarded-For`) on this path; external auth must use Mode 2.

### Resolve scope from a session token (Mode 2)

External callers present a session JWT. Scope is in the JWT claims. The guard verifies the signature, extracts scope, and stamps `request.scope`.

### Resolve scope from a service secret (Mode 3)

Entity backends connect via WebSocket with the service secret. Scope is fixed by the entity row.

## Common pitfalls

- A query that omits even one of the three columns is a leak waiting to happen. The cross-scope IDOR test catches the obvious cases; review every new controller method against the test bar.
- Project-scope and org-scope are different. A user with org-admin can list every project; a project member can only see their own. The guard exposes both via `scope.organizationId` and a separate "is admin" check.
- Environments share an org and project; their data is isolated. A `dev` agent does not see `prod` memory, even though both belong to the same project.
- The Environment is persisted on the `Entity` record. A connection presenting authority for another Environment is rejected at the gateway.

## Related

- [Environments](/docs/environments): the third axis of the tuple.
- [Auth modes](/docs/auth-modes): the three modes that resolve scope.
- [Encryption and secrets](/docs/encryption-and-secrets): per-scope key isolation.
