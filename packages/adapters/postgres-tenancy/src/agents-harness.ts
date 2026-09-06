// The real-PostgreSQL fixture the `agents` suites share, over the SAME container
// every other tranche uses.
//
// It builds on `startTenancyHarness` rather than starting a fourth PostgreSQL,
// because ADR M0.3 §15's whole argument is that there is one database behind one
// client, and a suite that stood up its own container would be measuring an
// arrangement that does not ship. What it adds is `fixtures/agents-rows.sql` —
// the tenant tree and the skill chain, applied by `prisma db execute` before any
// code runs. That file's own header says why the skill rows cannot be written
// from this package.
//
// IT FAILS WHEN DOCKER IS ABSENT rather than skipping, inherited from the
// harness it builds on. A skipped integration suite and a passing one are
// indistinguishable in a CI summary.
//
// EVERY SEEDER GOES THROUGH THE PORT. An agent, a version, a binding, a cluster,
// a macro and a template are all written by the repository under test, inside a
// real `UnitOfWork.run`. A fixture that inserted them with SQL would be a
// fixture that skipped the code it exists to exercise — and, in this context in
// particular, would skip `packVersionRow`, which is where every carried field of
// a version actually lives.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  ActorId,
  Agent,
  AgentBinding,
  AgentBindingId,
  AgentCluster,
  AgentClusterId,
  AgentId,
  AgentsRepository,
  AgentVersion,
  AgentVersionId,
  AgentVersionSnapshot,
  EnvironmentId,
  EnvironmentScope,
  EnvironmentSkillId,
  Macro,
  MacroId,
  OrganizationId,
  PostmanTemplate,
  PostmanTemplateId,
  ProjectId,
  ScaffoldingRepository,
  Slug,
} from "@platos/context-agents/application/ports/index.js";
import { asAgentsIdentifier, DEFAULT_AGENTS_POLICY } from "@platos/context-agents/application/ports/index.js";

import type { PostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";
import { startTenancyHarness, type CapturedStatement, type TenancyHarness } from "./harness.js";
import { buildAgentsScenarioSnapshot } from "./agents-conformance.js";

/** Rows `fixtures/agents-rows.sql` creates. Named so no suite spells a uuid twice. */
export const AGENTS_ORGANIZATION = "aa000000-0000-4000-8000-000000000001";
export const HOME_PROJECT = "aa000000-0000-4000-8000-000000000002";
export const FOREIGN_PROJECT = "aa000000-0000-4000-8000-000000000003";
export const HOME_ENVIRONMENT = "aa000000-0000-4000-8000-000000000004";
export const PEER_ENVIRONMENT = "aa000000-0000-4000-8000-000000000005";
export const FOREIGN_ENVIRONMENT = "aa000000-0000-4000-8000-000000000006";
export const FIRST_SKILL = "aa000000-0000-4000-8000-00000000000c";
export const SECOND_SKILL = "aa000000-0000-4000-8000-00000000000d";
export const PEER_SKILL = "aa000000-0000-4000-8000-00000000000e";
export const FOREIGN_SKILL = "aa000000-0000-4000-8000-00000000000f";

/** The one instant every seeded row is stamped with, so nothing is time-dependent. */
export const AT = new Date("2026-05-01T09:00:00.000Z");

export const agentIdOf = (value: string): AgentId => asAgentsIdentifier<AgentId>(value);
export const versionIdOf = (value: string): AgentVersionId => asAgentsIdentifier<AgentVersionId>(value);
export const bindingIdOf = (value: string): AgentBindingId => asAgentsIdentifier<AgentBindingId>(value);
export const clusterIdOf = (value: string): AgentClusterId => asAgentsIdentifier<AgentClusterId>(value);
export const macroIdOf = (value: string): MacroId => asAgentsIdentifier<MacroId>(value);
export const templateIdOf = (value: string): PostmanTemplateId =>
  asAgentsIdentifier<PostmanTemplateId>(value);
export const skillIdOf = (value: string): EnvironmentSkillId =>
  asAgentsIdentifier<EnvironmentSkillId>(value);
export const actorOf = (value: string): ActorId => asAgentsIdentifier<ActorId>(value);
export const agentSlugOf = (value: string): Slug => asAgentsIdentifier<Slug>(value);

/** An environment scope over the fixture tree. */
export function scopeOf(environmentId: string, projectId: string = HOME_PROJECT): EnvironmentScope {
  return {
    level: "environment",
    organizationId: asAgentsIdentifier<OrganizationId>(AGENTS_ORGANIZATION),
    projectId: asAgentsIdentifier<ProjectId>(projectId),
    environmentId: asAgentsIdentifier<EnvironmentId>(environmentId),
  };
}

export interface SeededAgent {
  readonly agent: Agent;
  readonly version: AgentVersion;
  readonly binding: AgentBinding;
}

export interface AgentsHarness {
  readonly client: TenancyDatabaseClient;
  readonly databaseUrl: string;
  readonly adapter: PostgresTenancyAdapter;
  readonly repository: AgentsRepository;
  readonly scaffolding: ScaffoldingRepository;
  statements(): readonly string[];
  /** The same statements with the values bound to them. WIN-258 T7. */
  events(): readonly CapturedStatement[];
  resetStatements(): void;
  freshId(kind: string): string;
  /** An agent, its first version and a binding, all through the port. */
  seedAgent(input: {
    readonly slug: string;
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly createdAt?: Date;
    readonly isActive?: boolean;
    readonly snapshot?: Partial<AgentVersionSnapshot>;
  }): Promise<SeededAgent>;
  /** One more version for an agent that already exists. */
  seedVersion(agent: SeededAgent, number: number, note?: string | null): Promise<AgentVersion>;
  seedCluster(input: { readonly slug: string; readonly environmentId?: string }): Promise<AgentCluster>;
  seedMacro(input: {
    readonly name: string;
    readonly environmentId?: string;
    readonly createdBy?: string;
    readonly shared?: boolean;
    readonly updatedAt?: Date;
  }): Promise<Macro>;
  seedTemplate(input: {
    readonly name: string;
    readonly agent: SeededAgent;
    readonly environmentId?: string;
    readonly isDefault?: boolean;
    readonly updatedAt?: Date;
  }): Promise<PostmanTemplate>;
  stop(): Promise<void>;
}

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

export async function startAgentsHarness(): Promise<AgentsHarness> {
  const base: TenancyHarness = await startTenancyHarness();
  execFileSync(
    prismaBinary,
    ["db", "execute", "--url", base.databaseUrl, "--file", resolve(packageRoot, "fixtures/agents-rows.sql")],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: base.databaseUrl }, stdio: "pipe" },
  );

  // The two ports come OFF THE ADAPTER rather than being rebuilt here. A
  // harness that called the two factories itself would give them a second
  // `TenancyTransactions` — a lock taken on one ambient frame and the write it
  // serialises issued on another.
  const repository: AgentsRepository = base.adapter;
  const scaffolding: ScaffoldingRepository = base.adapter;
  const defaults = DEFAULT_AGENTS_POLICY.defaults;

  const harness: AgentsHarness = {
    client: base.client,
    databaseUrl: base.databaseUrl,
    adapter: base.adapter,
    repository,
    scaffolding,
    statements: base.statements,
    events: base.events,
    resetStatements: base.resetStatements,
    freshId: base.freshId,

    async seedAgent(input): Promise<SeededAgent> {
      const environmentId = input.environmentId ?? HOME_ENVIRONMENT;
      const projectId = input.projectId ?? HOME_PROJECT;
      const createdAt = input.createdAt ?? AT;
      const agent: Agent = {
        agentId: agentIdOf(base.freshId("0201")),
        projectId: asAgentsIdentifier<ProjectId>(projectId),
        name: input.slug,
        slug: agentSlugOf(input.slug),
        description: null,
        isActive: input.isActive ?? true,
        createdAt,
        updatedAt: createdAt,
      };
      const version: AgentVersion = {
        agentVersionId: versionIdOf(base.freshId("0202")),
        agentId: agent.agentId,
        versionNumber: 1,
        toolDefaultPolicy: "NONE",
        note: "Initial version",
        createdBy: actorOf("operator-1"),
        createdAt,
        snapshot: buildAgentsScenarioSnapshot(defaults, input.snapshot ?? {}),
      };
      const binding: AgentBinding = {
        agentBindingId: bindingIdOf(base.freshId("0203")),
        environmentId: asAgentsIdentifier<EnvironmentId>(environmentId),
        agentId: agent.agentId,
        activeVersionId: version.agentVersionId,
        canaryVersionId: null,
        clusterId: null,
        canaryPercent: 0,
        createdAt,
        updatedAt: createdAt,
      };
      await base.adapter.unitOfWork.run(async (transaction) => {
        expectOk(await repository.insertAgent(agent, transaction));
        expectOk(await repository.insertVersion(version, transaction));
        expectOk(await repository.insertBinding(binding, transaction));
      });
      return { agent, version, binding };
    },

    async seedVersion(agent, number, note = null): Promise<AgentVersion> {
      const version: AgentVersion = {
        ...agent.version,
        agentVersionId: versionIdOf(base.freshId("0204")),
        versionNumber: number,
        note,
      };
      await base.adapter.unitOfWork.run(async (transaction) => {
        expectOk(await repository.insertVersion(version, transaction));
      });
      return version;
    },

    async seedCluster(input): Promise<AgentCluster> {
      const cluster: AgentCluster = {
        clusterId: clusterIdOf(base.freshId("0205")),
        environmentId: asAgentsIdentifier<EnvironmentId>(input.environmentId ?? HOME_ENVIRONMENT),
        name: input.slug,
        slug: agentSlugOf(input.slug),
        description: null,
        metadata: null,
        createdAt: AT,
        updatedAt: AT,
      };
      await base.adapter.unitOfWork.run(async (transaction) => {
        expectOk(await repository.insertCluster(cluster, transaction));
      });
      return cluster;
    },

    async seedMacro(input): Promise<Macro> {
      const macro: Macro = {
        macroId: macroIdOf(base.freshId("0206")),
        environmentId: asAgentsIdentifier<EnvironmentId>(input.environmentId ?? HOME_ENVIRONMENT),
        name: input.name,
        description: null,
        steps: [{ tool: "send", params: { to: "${user.email}" } }],
        paramSchema: null,
        sharedWithOrganization: input.shared ?? false,
        createdBy: actorOf(input.createdBy ?? "operator-1"),
        createdAt: AT,
        updatedAt: input.updatedAt ?? AT,
      };
      await base.adapter.unitOfWork.run(async (transaction) => {
        expectOk(await scaffolding.insertMacro(macro, transaction));
      });
      return macro;
    },

    async seedTemplate(input): Promise<PostmanTemplate> {
      const template: PostmanTemplate = {
        templateId: templateIdOf(base.freshId("0207")),
        environmentId: asAgentsIdentifier<EnvironmentId>(input.environmentId ?? HOME_ENVIRONMENT),
        agentId: input.agent.agent.agentId,
        name: input.name,
        simulateUserId: "simulated-1",
        sessionContext: null,
        isDefault: input.isDefault ?? false,
        createdBy: actorOf("operator-1"),
        createdAt: AT,
        updatedAt: input.updatedAt ?? AT,
      };
      await base.adapter.unitOfWork.run(async (transaction) => {
        expectOk(await scaffolding.insertTemplate(template, transaction));
      });
      return template;
    },

    stop: base.stop,
  };
  return harness;
}

/** A seeder that refuses is a broken fixture, not a case. Fail loudly. */
function expectOk<Value>(result: { readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }): void {
  if (!result.ok) {
    throw new Error(`fixture write refused: ${result.error?.code} ${result.error?.message}`);
  }
}
