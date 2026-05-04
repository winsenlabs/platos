# @platools/sdk

## 0.2.0 — 2026-05-06

### What changed

- Bump from `0.1.0` to mirror Python `platools` 0.2.0.
- **Confirmed correct `_context` handling** in `transport/client.ts`:
  the dispatcher pops both `__platos` and `_context` from `call.params`
  before Zod-validating the handler input (`PlatoolsClient.dispatchCall`
  at `src/transport/client.ts:333-358`). Neither key reaches the
  handler's typed input.
- AsyncLocalStorage frame established via `runWithContext()` so handlers
  reading `currentContext()` / `currentUserId()` / `currentScope()` see
  the per-call values without parameter threading. Frame is scoped to
  the `tool.handler` call and torn down automatically on resolution or
  rejection.

### Architectural contract (TypeScript entity backends)

Platos always injects `_context` into tool-call arguments. Your handler's
Zod input schema must NOT declare `_context` — the SDK strips it before
validation. Read identity via:

```ts
import {
  currentUserId,
  currentScope,
  currentUserToken,
  currentContext,
  type PlatosContext,
} from "@platools/sdk";

platools.tool({
  name: "list_orders",
  input: z.object({ customerId: z.string() }),
  handler: async ({ customerId }, ctx /* PlatosContext */) => {
    const userId = currentUserId();
    const [org, project, env] = currentScope();
    const tenantId = ctx?.context["tenant.id"];
    return ...;
  },
});
```

The optional second `ctx: PlatosContext` argument receives the unpacked
CTX.2 envelope (entity-defined keys like `user.id`, `entity_ids`).

### Tests

All 92 tests pass (`pnpm --filter @platools/sdk run test`), including
`tests/context.test.ts` which exercises envelope pop, AsyncLocalStorage
isolation across concurrent calls, and handler-error reset.

## 0.1.0

Initial pre-release.
