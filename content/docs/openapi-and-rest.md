---
slug: openapi-and-rest
title: OpenAPI and REST
description: The HTTP REST surface auto-generated from controllers, with a downloadable OpenAPI spec.
category: dx
order: 60
questions:
  - "Where do I find the OpenAPI spec?"
  - "Which endpoints are public vs internal?"
  - "How do I authenticate REST calls?"
  - "Can I generate a client from the spec?"
  - "What is versioned in the API surface?"
related:
  - sdks
  - auth-modes
  - events-and-polling
---

# OpenAPI and REST

Platos's REST surface is generated from the NestJS controllers and exposed as an OpenAPI 3.1 spec. The generated contract is the source of truth for examples and third-party clients. It lives at `/api/v1/agent/openapi.json`, with Swagger UI at `/openapi`.

## What it is

`OpenAPIController` serves `apps/agent/src/openapi/openapi.generated.json`. The generation includes:

- Every endpoint under `apps/agent/src/agent-runtime/agent.controller.ts` (and the other controllers).
- Request and response schemas inferred from Zod validators on the controller methods.
- Auth schemes documented per endpoint (PAT, session token, internal headers).

Endpoints are tagged by domain: `agents`, `threads`, `messages`, `monitoring`, `entities`, `providers`, `evals`, `memory`. The OpenAPI tag is what powers the Swagger UI's section grouping.

The currently generated Agent HTTP surface is versioned at `/api/v1/agent/`. Canonical resource names remain those in [Domain vocabulary](/docs/domain-vocabulary).

## Why it matters

A typed REST surface is the contract between Platos and the world. The OpenAPI spec is what lets a customer generate a Go client without a Platos engineer in the loop. The Swagger UI is what lets an engineer experiment without writing code first. Both raise the floor of "I can integrate Platos in 30 minutes" by an order of magnitude.

## How to use it

### Browse

`https://platos.example.com/openapi` serves the public Swagger UI. Protected operations still require an appropriate credential through the "Authorize" button.

### Download the spec

```bash
curl https://platos.example.com/api/v1/agent/openapi.json > platos.json
```

The same generated spec is committed at `apps/agent/src/openapi/openapi.generated.json`.

### Generate a client

```bash
npx openapi-typescript-codegen --input platos.json --output ./platos-client --client fetch
```

Or feed the spec into your language's standard generator. The generated client targets the same endpoints `@platosdev/client` wraps; for production code, prefer the first-party SDK.

### Authenticate

PAT bearer is the simplest path. See [Auth modes](/docs/auth-modes) for the three options. Internal callers using header-based scope must pass `X-Platos-Organization-Id`, `X-Platos-Project-Id`, `X-Platos-Environment-Id`.

## Common pitfalls

- Some endpoints under `monitoring/*` are admin-scope only. The OpenAPI spec marks them with the `admin: true` extension; auto-generated clients without scope-awareness will hit 403.
- Do not infer a route from a dashboard URL. Use only operations present in the generated document.
- Generated clients sometimes mishandle streaming endpoints (they expect JSON, get SSE). Use `@platosdev/client` for streaming; only fall back to a generated client for unary calls.
- The spec does not include the WebSocket surface (`/connections`, `/streaming`). Those have separate documentation in [Connected entities](/docs/connected-entities) and [Streaming](/docs/streaming).

## Related

- [SDKs](/docs/sdks): first-party clients that already wrap the spec.
- [Auth modes](/docs/auth-modes): the three modes the spec documents.
- [Events, streaming, and polling](/docs/events-and-polling): the supported alternatives to an outbound event-delivery API.
