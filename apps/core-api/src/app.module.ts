// THE COMPOSITION ROOT.
//
// One function, `composeApplication`, turns validated configuration plus whatever
// adapters an install supplied into the `AppModule` every transport is handed.
// It is the only place in V1 where a port meets its implementation.
//
// IT HOLDS NO FRAMEWORK ON PURPOSE. `@nestjs/*` lives in `src/http/` and
// `src/main.ts`; this file is plain TypeScript. Composition is the decision that
// must stay legible when the HTTP framework is replaced, and a decision
// expressed as container metadata is legible only to the container. It also
// means the composition root is exercisable in a unit test with no server, which
// is how `app.module.test.ts` proves the mis-wire detection without binding a
// port.
//
// WHY THE CONTEXTS ARE `Partial`. Seventeen contexts are declared; four are real
// (WIN-256) and thirteen are still declaration-only placeholders. Even the four
// cannot be constructed here yet — see FINDING below. Modelling that as
// `Partial<ContextContracts>` states the truth in the type instead of shipping
// seventeen `null!` casts that would compile and then explode.
//
// ---------------------------------------------------------------------------
// FINDING (WIN-297, reported not absorbed): a context's construction function is
// unreachable from the composition root.
//
// ADR M0.3 §4 says core-api's transports "call application/ use-cases only", and
// the real work of composing a context is `createTenancyService(...)` /
// `createFilesContract(...)` in each context's `application/`. But every context
// manifest — generated scaffolding — publishes exactly two subpaths:
//
//     "."                              -> dist/contracts/index.js   (types only)
//     "./application/ports/index.js"   -> the driven ports          (types only)
//
// `application/index.js` is not among them, and `v1-project-graph.mjs` fails any
// import of an unexported subpath. So the factories exist, are correct, are
// tested — and cannot be reached from the one place entitled to call them.
//
// Adding the subpath is a two-line generator change. It is deliberately NOT made
// here: publishing an entry point that nothing yet imports is dead surface, and
// the issue that first composes a context for real (WIN-257 for identity/
// tenancy, WIN-258 for the repositories underneath them) is the one that can
// prove the export is right. Recorded here, and in the REVIEW READY comment, so
// it is a decision rather than a discovery.
// ---------------------------------------------------------------------------

import type { Clock, IdGenerator, Logger } from "@platos/kernel";

import type { IdentityAccessContract } from "@platos/context-identity-access";
import type { TenancyContract } from "@platos/context-tenancy";
import type { SecretsContract } from "@platos/context-secrets";
import type { ProvidersContract } from "@platos/context-providers";
import type { AgentsContract } from "@platos/context-agents";
import type { SkillsContract } from "@platos/context-skills";
import type { ToolsContract } from "@platos/context-tools";
import type { MemoryContract } from "@platos/context-memory";
import type { ChannelsContract } from "@platos/context-channels";
import type { FilesContract } from "@platos/context-files";
import type { ObservabilityContract } from "@platos/context-observability";
import type { CostMonitoringContract } from "@platos/context-cost-monitoring";
import type { GovernanceContract } from "@platos/context-governance";
import type { JobsContract } from "@platos/context-jobs";
import type { ConversationsContract } from "@platos/context-conversations";
import type { EventingContract } from "@platos/context-eventing";
import type { PrivacyContract } from "@platos/context-privacy";

import { ADAPTER_BINDINGS, type SuppliedAdapters } from "./composition/adapter-bindings.js";
import { reportAdapterSupply, type AdapterSupplyReport } from "./composition/registry.js";
import type { CoreApiConfiguration } from "./config/schema.js";
import { createInFlightRegister, type InFlightRegister } from "./runtime/in-flight.js";

/** The seventeen published context surfaces, exactly as ADR M0.3 §4 names them. */
export interface ContextContracts {
  readonly identityAccess: IdentityAccessContract;
  readonly tenancy: TenancyContract;
  readonly secrets: SecretsContract;
  readonly providers: ProvidersContract;
  readonly agents: AgentsContract;
  readonly skills: SkillsContract;
  readonly tools: ToolsContract;
  readonly memory: MemoryContract;
  readonly channels: ChannelsContract;
  readonly files: FilesContract;
  readonly observability: ObservabilityContract;
  readonly costMonitoring: CostMonitoringContract;
  readonly governance: GovernanceContract;
  readonly jobs: JobsContract;
  readonly conversations: ConversationsContract;
  readonly eventing: EventingContract;
  readonly privacy: PrivacyContract;
}

/** What has actually been composed. See "WHY THE CONTEXTS ARE Partial" above. */
export type ComposedContexts = Partial<ContextContracts>;

/**
 * What every transport is handed. Transports read from it; they never reach past
 * it to an adapter, which is what keeps rule (j) true as M4 adds surfaces.
 */
export interface AppModule {
  readonly configuration: CoreApiConfiguration;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly adapters: SuppliedAdapters;
  readonly bindings: AdapterSupplyReport;
  readonly contexts: ComposedContexts;
  readonly inFlight: InFlightRegister;
}

export interface CompositionInput {
  readonly configuration: CoreApiConfiguration;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly adapters?: SuppliedAdapters;
  readonly inFlight?: InFlightRegister;
}

/**
 * Raised when composition cannot proceed. Carries no configuration values: it is
 * rendered into a log line, and the redaction promise made in `config/load.ts`
 * would be worthless if the failure path leaked what the success path hides.
 */
export class CompositionFault extends Error {
  readonly faults: readonly string[];

  constructor(faults: readonly string[]) {
    super(`composition root refused to build: ${faults.length} fault(s)`);
    this.name = "CompositionFault";
    this.faults = Object.freeze([...faults]);
  }
}

export function composeApplication(input: CompositionInput): AppModule {
  const adapters = input.adapters ?? {};
  const bindings = reportAdapterSupply(adapters);
  if (bindings.faults.length > 0) throw new CompositionFault(bindings.faults);

  // Contexts are composed here as adapters become available. The map is empty
  // today for the reason recorded in FINDING above, and it is built from
  // `bindings.satisfied` rather than from `adapters` so that a context can never
  // be constructed from a binding that failed validation.
  const contexts: ComposedContexts = Object.freeze({});

  return Object.freeze({
    configuration: input.configuration,
    clock: input.clock,
    ids: input.ids,
    logger: input.logger,
    adapters: Object.freeze({ ...adapters }),
    bindings,
    contexts,
    inFlight: input.inFlight ?? createInFlightRegister(),
  });
}

/** How many bindings the architecture declares. Used by readiness and by tests. */
export const DECLARED_BINDING_COUNT = ADAPTER_BINDINGS.length;
