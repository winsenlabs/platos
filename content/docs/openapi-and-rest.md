---
slug: openapi-and-rest
title: OpenAPI and REST
description: The HTTP REST surface auto-generated from controllers, with a downloadable OpenAPI spec.
category: dx
order: 60
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where do I find the OpenAPI spec?"
  - "Which endpoints are public vs internal?"
  - "How do I authenticate REST calls?"
  - "Can I generate a client from the spec?"
  - "What is versioned in the API surface?"
related:
  - sdks
  - auth-modes
  - webhooks
source_files_referenced:
  - apps/agent/src/openapi/openapi.controller.ts
  - apps/agent/src/openapi/openapi.spec.ts
---

# OpenAPI and REST

Platos's REST surface is generated from the NestJS controllers and exposed as an OpenAPI 3.1 spec. The spec is the source of truth for the SDKs, the docs, and any third-party client. It lives at `/openapi.json` and the Swagger UI at `/openapi`.

## What it is

`OpenAPIController` ships the generated spec; `openapi.spec.ts` augments it with auth, server, and tag metadata. The generation includes:

- Every endpoint under `apps/agent/src/agent-runtime/agent.controller.ts` (and the other controllers).
- Request and response schemas inferred from Zod validators on the controller methods.
- Auth schemes documented per endpoint (PAT, session token, internal headers).

Endpoints are tagged by domain: `agents`, `threads`, `messages`, `monitoring`, `entities`, `providers`, `evals`, `memory`. The OpenAPI tag is what powers the Swagger UI's section grouping.

The surface is versioned at `/agent/v1/`. Backwards-incompatible changes go to `/agent/v2/` when needed; v1 endpoints stay behind for at least one major release after deprecation.

## Why it matters

A typed REST surface is the contract between Platos and the world. The OpenAPI spec is what lets a customer generate a Go client without a Platos engineer in the loop. The Swagger UI is what lets an engineer experiment without writing code first. Both raise the floor of "I can integrate Platos in 30 minutes" by an order of magnitude.

## How to use it

### Browse

`https://platos.example.com/openapi` for the Swagger UI. The page is auth-gated; provide a PAT in the upper-right "Authorize" button and it will be sent on every try-it-out call.

### Download the spec

```bash
curl https://platos.example.com/openapi.json -H "Authorization: Bearer $PAT" > platos.json
```

The same spec is in the repo at `apps/agent/src/openapi/openapi.spec.ts`; either source is fine.

### Generate a client

```bash
npx openapi-typescript-codegen --input platos.json --output ./platos-client --client fetch
```

Or feed the spec into your language's standard generator. The generated client targets the same endpoints `@platos/client` wraps; for production code, prefer the first-party SDK.

### Authenticate

PAT bearer is the simplest path. See [Auth modes](/docs/auth-modes) for the three options. Internal callers using header-based scope must pass `X-Platos-Organization-Id`, `X-Platos-Project-Id`, `X-Platos-Environment-Id`.

## Common pitfalls

- Some endpoints under `monitoring/*` are admin-scope only. The OpenAPI spec marks them with the `admin: true` extension; auto-generated clients without scope-awareness will hit 403.
- The spec includes deprecated endpoints with a `deprecated: true` flag. The `/agent-orgs/*` shim is one of them (drift D-001); use `/agent-entities/*` instead.
- Generated clients sometimes mishandle streaming endpoints (they expect JSON, get SSE). Use `@platos/client` for streaming; only fall back to a generated client for unary calls.
- The spec does not include the WebSocket surface (`/connections`, `/streaming`). Those have separate documentation in [Connected entities](/docs/connected-entities) and [Streaming](/docs/streaming).

## Related

- [SDKs](/docs/sdks): first-party clients that already wrap the spec.
- [Auth modes](/docs/auth-modes): the three modes the spec documents.
- [Webhooks](/docs/webhooks): the outbound REST surface (events Platos pushes to you).
