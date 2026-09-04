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
// WHY THE CONTEXTS ARE `Partial`. Seventeen contexts are declared; FIVE are real
// (WIN-256: identity-access, tenancy, secrets, files, providers) and twelve are
// still declaration-only placeholders. Of the five, one is composed here today —
// see the note below on what an install must still supply. Modelling that as
// `Partial<ContextContracts>` states the truth in the type instead of shipping
// seventeen `null!` casts that would compile and then explode.
//
// ---------------------------------------------------------------------------
// THE WIN-297 FINDING, CLOSED BY WIN-257 (M2.2).
//
// WIN-297 reported that a context's construction function was unreachable from
// here: every context manifest published `.` (contracts, types) and
// `./application/ports/index.js` (driven ports, types) and nothing else, so
// `createIdentityAccessService(...)` and `createTenancyService(...)` existed,
// were tested, and could not be imported by the one place entitled to call them.
// It declined to fix it on the grounds that an entry point nothing imports is
// dead surface, and named WIN-257 as the issue that could prove the export.
//
// `APPLICATION_ENTRY_PROJECTS` in `scripts/arch/gen-v1-skeleton.mjs` now
// publishes `./application/index.js` for the contexts this file ACTUALLY
// composes — one entry today, `identity-access` — and `selfCheck` refuses an
// entry that is not an adopted context. So the surface is not dead: the import
// below is the consumer that justifies it.
//
// WHAT IS STILL OPEN. identity-access is composed from a supplied PORT BUNDLE,
// not from an adapter, because `IdentityAccessRepository` has no adapter slot:
// the twelve declared bindings give `postgres-tenancy` the tenancy repository
// and give identity-access only `redis-ratelimit`. There is no identity store
// among the twelve. That is reported, not absorbed — WIN-258 owns the
// repositories — and until one exists an install supplies the bundle itself and
// readiness stays honest about every binding that is unsatisfied.
// ---------------------------------------------------------------------------

import type { Clock, IdGenerator, Logger } from "@platos/kernel";

import type { IdentityAccessContract } from "@platos/context-identity-access";
import { createIdentityAccessService } from "@platos/context-identity-access/application/index.js";
import type { IdentityAccessPorts } from "@platos/context-identity-access/application/index.js";
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

/**
 * The driven ports an install supplies for a context this root can compose.
 *
 * It is separate from `SuppliedAdapters` because these are not adapters: an
 * adapter fills ONE declared binding and is validated against the twelve-slot
 * table, whereas a context takes a whole bundle — a repository, a hasher, a
 * minter — several of which have no declared adapter yet. Merging the two would
 * mean either inventing binding slots that ADR M0.3 §4 does not declare, or
 * letting `reportAdapterSupply` see keys it cannot judge.
 */
export interface SuppliedContextPorts {
  readonly identityAccess?: IdentityAccessPorts;
}

export interface CompositionInput {
  readonly configuration: CoreApiConfiguration;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly adapters?: SuppliedAdapters;
  readonly ports?: SuppliedContextPorts;
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

  // Contexts are composed here as their ports become available. A context is
  // built ONLY from ports this call was actually handed: an absent bundle leaves
  // the context absent rather than producing a façade over undefined stores,
  // which would turn every authentication into a run-time crash instead of a
  // readiness signal a caller can see before it serves anything.
  const contexts: ComposedContexts = Object.freeze(
    input.ports?.identityAccess === undefined
      ? {}
      : { identityAccess: createIdentityAccessService(input.ports.identityAccess) },
  );

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
