---
slug: tenancy
title: Tenancy and isolation
description: Organization, Project, Environment, Agent Version, and end-user ownership boundaries.
category: governance
order: 2
questions:
  - "What is the Platos tenant boundary?"
  - "What does an Environment isolate?"
  - "How are end users scoped?"
related:
  - scope-and-multi-tenancy
  - environments
  - auth-modes
  - encryption-and-secrets
---

# Tenancy and isolation

Platos derives authority from persisted ownership, never from an unverified resource identifier supplied by a caller.

## Ownership hierarchy

```text
Organization
└── Project
    └── Environment
        ├── Agent binding
        ├── Thread and Turn data
        ├── Entity connections
        ├── Credentials
        └── Jobs
```

The **Organization** is the tenant, membership, policy, and billing root. A **Project** is an Organization-owned grouping and access boundary. An **Environment** is a Project-scoped isolation boundary for configuration, credentials, data, traffic, and policy.

## Agents and Agent Versions

An Agent belongs to a Project. An Environment binding selects the active Agent Version and an optional canary Agent Version. This allows the same Agent identity to use different immutable configurations in isolated Environments without treating the Environment as a release stage.

## End-user scope

End-user records are resolved inside the authenticated Organization and Environment. Threads, Turns, Memories, Artifacts, approvals, and observability records inherit that ancestry. A matching user identifier in another Organization does not grant access.

## Authorization

Operator permissions are evaluated from Organization membership, Project membership, and the requested Environment ancestry. Runtime credentials are Environment-bound. Cross-Environment names and identifiers return a stable not-found or forbidden response without revealing whether a resource exists elsewhere.

## Credentials and deletion

Provider and MCP credentials are encrypted under their owning Environment. Hard erasure starts from the Organization and external user identity, then follows persisted relationships across transactional, analytical, object, and ephemeral stores.
