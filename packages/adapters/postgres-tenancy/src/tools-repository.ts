// The `ToolsRepository` composite — the twenty-five methods, assembled.
//
// FIVE MODULES AND NOT ONE, split by the four things `domain/index.ts` says the
// ten rows group into rather than by method count: what a tool IS
// (`./tools-catalogue.ts`, `./tools-exposures.ts`), who may call it
// (`./tools-policies.ts`), how it is reached (`./tools-mcp.ts`) and what happened
// (`./tools-transcript.ts`). The ADR M0.3 §6 budget points at the same seams,
// which is the usual sign that the seams are real.
//
// ONE ORDERING DEPENDENCY, AND IT IS DECLARED. `createToolsExposures` is handed
// the catalogue, because every resolved exposure carries `allowedAgentIds` and
// that is a fold over the environment's binding set — which is the catalogue's
// read. Building a second binding reader inside the exposures module would have
// been two implementations of one projection, and the invalidation path compares
// the result by equality.
//
// THE WHOLE COMPOSITE SHARES ONE `TenancyTransactions`, for the reason ADR M0.3
// §15 gives and `./adapter.ts` repeats: the transaction a use case opens is the
// transaction these writes have to be inside, and a second instance would give
// this context's writes one ambient frame and tenancy's the other.

import type { ToolsRepository } from "@platos/context-tools/application/ports/index.js";

import { createToolsCatalogue } from "./tools-catalogue.js";
import { createToolsExposures } from "./tools-exposures.js";
import { createToolsMcp } from "./tools-mcp.js";
import { createToolsPolicies } from "./tools-policies.js";
import { createToolsTranscript } from "./tools-transcript.js";
import type { TenancyTransactions } from "./transaction.js";

export function createToolsRepository(transactions: TenancyTransactions): ToolsRepository {
  const catalogue = createToolsCatalogue(transactions);
  // `readBindings` IS NOT SPREAD. It is the catalogue's internal projection —
  // the binding fold with the tenant clause already applied by the caller — and
  // its own comment says it is "never reachable through `ToolsRepository`". That
  // was true of the TYPE and false of the OBJECT: `...catalogue` put a method
  // that skips the scope resolve onto the adapter every app holds. The exposures
  // module still gets it, by reference, below.
  const { readBindings: _internalProjection, ...catalogueMethods } = catalogue;
  return {
    ...catalogueMethods,
    ...createToolsExposures(transactions, catalogue),
    ...createToolsPolicies(transactions),
    ...createToolsMcp(transactions),
    ...createToolsTranscript(transactions),
  };
}
