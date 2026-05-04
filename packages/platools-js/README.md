# @platools/sdk

**Your AI Arsenal.** Turn any backend function into a managed, authenticated, monitored MCP tool with a single factory call.

```ts
import { z } from "zod";
import { Platools } from "@platools/sdk";

const platools = new Platools();

const RefundResult = z.object({
  refundId: z.string(),
  amountCents: z.number().int(),
  status: z.enum(["pending", "completed", "failed"]),
});

export const processRefund = platools.tool(
  {
    name: "process_refund",
    description: "Process a refund for an order",
    auth: "user",
    roles: ["support", "admin"],
    input: z.object({ orderId: z.string(), reason: z.string() }),
    output: RefundResult,
  },
  async ({ orderId, reason }) => refundService.process(orderId, reason),
);

// In your app bootstrap:
await platools.connect();
```

## Reading the caller's scope inside a handler

Every `tool_call` the Platos platform dispatches carries a `__platos`
envelope — the Platos V2 `(organizationId, projectId, environmentId,
entityId, userId, userToken?, agentId, threadId, callId, timestamp,
signature)` tuple that uniquely scopes the invocation. The SDK
**strips** that envelope before your handler runs (Zod never sees it)
and publishes the fields onto an `AsyncLocalStorage` frame so you can
read them anywhere inside the handler without threading a context
argument through every function:

```ts
import { z } from "zod";
import {
  Platools,
  currentContext,
  currentScope,
  currentUserId,
  currentUserToken,
} from "@platools/sdk";

const platools = new Platools();

export const listOrders = platools.tool(
  {
    name: "list_orders",
    description: "List open orders for a customer",
    auth: "user",
    input: z.object({ customerId: z.string() }),
    output: z.array(z.object({ id: z.string(), totalCents: z.number().int() })),
  },
  async ({ customerId }) => {
    // Who the LLM is acting on behalf of — use this to enforce
    // row-level authorization against your database.
    const actingUser = currentUserId();

    // Optional caller access token the platform forwarded (present
    // when auth === "user" and the upstream request carried one).
    const token = currentUserToken();

    // The trigger.dev scope tuple — useful if you cache per-project.
    const { organizationId, projectId, environmentId } = currentScope();

    return db.listOrders({ customerId, actingUser, bearer: token });
  },
);

export const auditEntry = platools.tool(
  {
    name: "audit_entry",
    description: "Write an audit row with the full caller context",
    input: z.object({ action: z.string() }),
  },
  async ({ action }) => {
    const ctx = currentContext();
    if (ctx === undefined) return; // outside a dispatch (unit test, etc.)
    await audit.write({
      orgId: ctx.organizationId,
      userId: ctx.userId,
      agentId: ctx.agentId,
      threadId: ctx.threadId,
      callId: ctx.callId,
      action,
    });
  },
);
```

The accessors return `undefined` when called outside a tool dispatch
(for example from module top level or a unit test), so guard on that
if your handler can also run out-of-band.

### Strict context semantics (PPR-29)

`currentContext()` is **strict**: it returns `undefined` whenever *any*
required field on the envelope is missing, mirroring the Python SDK's
`current_context()`. Required fields are everything except `userToken`
(which is optional). This means:

- `if (ctx)` behaves identically in TS and Python on the same partial
  envelope — no more divergence where TS returns a populated object
  with empty strings and Python returns `None`.
- A handler that gets a partial envelope (older agent, broken
  middleware) sees `undefined` from `currentContext()`. Use the
  narrower accessors (`currentUserId()`, `currentScope()`, etc.) if
  you want to read whatever fields did land.

The server (`apps/agent/src/tool-gateway/tool-executor.service.ts`)
always emits a full envelope including `callId`, so production tool
calls always populate a context. The strict guard only engages on
degenerate envelopes.

Because `AsyncLocalStorage` frames are scoped to a single async
subtree, concurrent tool calls in the same worker never leak context
into each other — the invariant is tested in
`tests/context.test.ts::concurrent runWithContext frames do not leak`.

### Accepting `ctx` as a handler argument (CTX.5)

If you prefer explicit argument-passing over the ambient accessors,
declare an optional second parameter on your handler. The SDK unpacks
the agent's `_context` envelope (built from the tool's
`contextMapping.envelopeKeys` — e.g. `user.id`, caller-declared
`entity_ids` for matrix routing) and hands it in as `ctx`:

```ts
import { z } from "zod";
import { Platools } from "@platools/sdk";

const platools = new Platools();

export const getMySchedule = platools.tool(
  {
    name: "get_my_schedule",
    description: "Return today's schedule for the calling user",
    input: z.object({ dayOfWeek: z.string() }),
  },
  async (params, ctx) => {
    const userId = ctx?.context["user.id"];
    if (typeof userId !== "string") {
      throw new Error("context missing user.id");
    }
    // When routed across multiple entities that share this tool name,
    // `ctx.entityIds` carries the caller-declared narrowing list.
    const entityIds = ctx?.entityIds;
    return fetchSchedule(userId, params.dayOfWeek, entityIds);
  },
);
```

`ctx` is **optional** — existing handlers declared as `(params) => …`
keep working unchanged. The unpacked shape is:

```ts
type PlatosContext = {
  callId: string;                           // platform-assigned id
  context: Record<string, unknown>;         // the `_context` envelope
  entityIds?: readonly string[];            // when matrix-routed
  raw: unknown;                             // original envelope (escape hatch)
};
```

Both `__platos` and `_context` are stripped from `params` before your
handler runs, so your Zod schema describes only the business inputs.

## CLI

```bash
# Static tool-graph analyzer
npx platools-doctor ./dist/tools.js
npx platools-doctor ./dist/tools.js --json

# Runtime tool exerciser (batch from platools-tests.yaml)
npx platools-test --module ./dist/tools.js
npx platools-test process_refund --module ./dist/tools.js --params '{"orderId":"o1","reason":"damaged"}'
npx platools-test --module ./dist/tools.js --coverage
```

## Feature parity

Every rule the Python SDK's `platools doctor` enforces has a 1:1
TypeScript equivalent — see `src/doctor/checks.ts`. The wire
protocol (`src/transport/protocol.ts`) is byte-compatible with
`platools/transport/protocol.py` so the platform's router does not
care which SDK produced a registration.

## Status

Phase K (PLATOS-40) complete — full feature parity with `platools-py`.
