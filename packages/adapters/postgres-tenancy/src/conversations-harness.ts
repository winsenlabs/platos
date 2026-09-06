// What the `conversations` suites need on top of the shared container: a fresh
// tenant chain per suite, and the SIX peer rows this context's four tables hang
// off.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this same
// directory (ADR M0.3 §15), so a scope is created by calling `saveOrganization`,
// `saveProject` and `saveEnvironment` rather than by writing SQL. A fresh chain
// per suite is what keeps a listing that returns everything in an environment
// from seeing another suite's rows.
//
// THE PEER CHAIN CANNOT, AND THE LIST IS LONGER HERE THAN ANYWHERE ELSE IN THIS
// DIRECTORY, because a turn touches everything:
//
//   Thread            -> Environment, Agent, EndUser, AgentCluster?
//   Turn              -> Thread, AgentVersion
//   Step              -> Turn, ModelPrice?
//   PostmanExecution  -> Environment, Agent, User, PostmanTemplate?, EndUser?,
//                        Thread?, Turn?
//
// `Agent`, `AgentVersion`, `AgentCluster` and `PostmanTemplate` are `agents`'
// rows (ADR M0.3 §1 row 5); `EndUser` and `User` are `identity-access`' (row 1);
// `Model` and `ModelPrice` are `providers`' (row 4). `providers` has NO entry in
// `CANONICAL_STORE_ADAPTERS`, so `sole-writer.mjs` refuses a write to a price
// card from this directory — correctly, and that refusal is the gate doing its
// job rather than an obstacle to route around. Every one of them is seeded
// through the ORM's own CLI (`prisma db execute`) instead, which is runtime and
// therefore out of the scanner's scope by construction.
//
// AND THAT INCLUDES THE THREE THIS DIRECTORY *COULD* NOW WRITE. `agents` and
// `identity-access` are both delegated here, so `Agent`, `AgentVersion` and
// `EndUser` could have gone through their own repositories. They do not,
// deliberately, for the reason `governance-harness.ts` gives of its own: the
// fixture would then have TWO mechanisms for one chain — half through ports
// belonging to contexts this suite is not testing, half through SQL — and a
// fixture whose failures can come from either is a fixture that has to be
// debugged before a suite can be read.
//
// ---------------------------------------------------------------------------
// THE PRICE CARD IS THE ONE PEER THAT IS NOT OPTIONAL SCENERY
// ---------------------------------------------------------------------------
//
// `Step_price_snapshot` re-reads `ModelPrice` from INSIDE the step's own insert
// and refuses the row unless SIXTEEN columns match it exactly — four rates, four
// sources, four observation instants and four source references. So a priced
// step cannot be seeded at all without a real card, and a card whose rates
// differ from the fixture's in their twelfth decimal place is refused for a step
// that is otherwise correct. `CONFORMANCE_RATES` below is the single place those
// numbers are written, and both the card and every step fixture read it.
//
// `enforce_domain_ancestry` IS WHY THE CHAIN IS A CHAIN. It fires BEFORE INSERT
// OR UPDATE on `Thread`, `Turn` and `PostmanExecution`, and for a thread it
// demands that the agent belong to the environment's PROJECT and the end user to
// its ORGANIZATION. So a thread cannot be seeded against somebody else's agent,
// which is exactly the cross-tenant case the containment proofs need — and the
// only way to build one is to seed a second, foreign chain, which
// `foreignChain()` below does.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  EnvironmentScope,
  RateSource,
} from "@platos/context-conversations/application/ports/index.js";
import type {
  EnvironmentId,
  ProjectId,
  Slug,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { ConversationsStores } from "./conversations-repository.js";
import type { TenancyHarness } from "./harness.js";
import { AT, OWNER_USER, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

const STAMP = "'2026-05-01T09:00:00Z'";

/** The instant every rate in the fixture was observed at, both sides. */
export const RATE_OBSERVED_AT = new Date("2026-04-01T00:00:00.000Z");

/**
 * The four rates, written ONCE.
 *
 * `Step_price_snapshot` compares a step's rate columns to the card's, so a
 * second copy of these numbers anywhere would be a second chance for the two to
 * disagree in a digit no reader would spot.
 */
export const CONFORMANCE_RATES = Object.freeze({
  input: "0.000003000000",
  output: "0.000015000000",
  cacheRead: "0.000000300000",
  cacheWrite: "0.000003750000",
});

/** The source every rate in the fixture carries. Never `UNAVAILABLE` by default. */
export const RATE_SOURCE: RateSource = "LITELLM";

/**
 * The provenance reference every rate carries, and it is NOT optional.
 *
 * FOUND BY THE FIRST INTEGRATION RUN, from a constraint that exists only in the
 * migrations: `ModelPrice_rate_check` demands
 * `(source = 'UNAVAILABLE' OR sourceRef IS NOT NULL)` for all four rates, so a
 * card whose sources are real cannot be seeded without one. And because
 * `Step_price_snapshot` compares a step's four `*RateSourceRef` columns to the
 * card's, the requirement propagates: a priced `Step` whose rate source is not
 * `UNAVAILABLE` must carry a non-null `sourceRef` too.
 *
 * NOTHING SAYS SO ON THE STEP'S SIDE. `Step_usage_check` ties twelve rate
 * columns to `costCents` and leaves the four references out; `domain/step-rates.ts`
 * types `sourceRef` as `string | null`; and the context's own `stepFixture` sets
 * all four to `null`. That fixture is green in every use-case suite in the
 * context and cannot be stored against a real price card.
 */
export const RATE_SOURCE_REF = "litellm@2026-04-01";

/** One seeded conversation, and everything it hangs off. */
export interface PeerChain {
  readonly scope: EnvironmentScope;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly secondAgentVersionId: string;
  readonly clusterId: string;
  readonly endUserId: string;
  /** A SECOND subject in the SAME organization. The subject-immutability proof. */
  readonly secondEndUserId: string;
  readonly templateId: string;
  readonly actorUserId: string;
  readonly modelPriceId: string;
}

export interface ConversationsHarness {
  readonly base: TenancyHarness;
  readonly stores: ConversationsStores;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** An agent, two versions, a cluster, an end user, a template and a price card. */
  seedChain(scope: EnvironmentScope): Promise<PeerChain>;
  /** A whole second tenant with its own chain, for the cross-tenant proofs. */
  foreignChain(): Promise<PeerChain>;
  /** Rows this package may not write, applied by the ORM's own CLI. */
  applyPeerRows(sql: string): void;
  stop(): Promise<void>;
}

export async function startConversationsHarness(): Promise<ConversationsHarness> {
  const base = await startTenancyHarness();
  const stores = base.adapter as unknown as ConversationsStores;

  function applyPeerRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  function agentSql(agentId: string, projectId: string): string {
    return `INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
            VALUES ('${agentId}', '${projectId}', 'turn agent', 'turn-${agentId.slice(-12)}', true, ${STAMP}, ${STAMP});`;
  }

  function versionSql(versionId: string, agentId: string, versionNumber: number): string {
    // The five JSON columns are spelled out because each carries its own
    // `_json_root` CHECK — three arrays, two objects — and `toolsBlockConfig`
    // carries a SECOND check forbidding an `enabledTools` key. A version seeded
    // with the wrong root is refused by the database, not by Prisma.
    return `INSERT INTO "AgentVersion"
              ("id", "agentId", "versionNumber", "model", "maxSteps", "contextLimit",
               "toolDefaultPolicy", "promptBlocks", "dynamicBlocks", "toolsBlockConfig",
               "modelRoutes", "memoryConfig", "createdBy", "createdAt")
            VALUES ('${versionId}', '${agentId}', ${String(versionNumber)}, 'anthropic:claude-test', 10, 128000,
                    'NONE', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
                    'fixture', ${STAMP});`;
  }

  /**
   * A `Model` and the `ModelPrice` every priced step in the suites is charged
   * against.
   *
   * `Model.key` and `[provider, name]` are both UNIQUE INSTALLATION-WIDE, so the
   * key carries the model id's own tail — a second chain seeded in the same
   * container would otherwise collide on a row that has nothing to do with the
   * tenant it was seeded for.
   */
  function priceSql(modelId: string, priceId: string): string {
    const observed = `'${RATE_OBSERVED_AT.toISOString()}'`;
    return `INSERT INTO "Model" ("id", "key", "provider", "name", "sourceUpdatedAt", "createdAt", "updatedAt")
            VALUES ('${modelId}', 'anthropic:claude-test-${modelId.slice(-12)}', 'anthropic',
                    'claude-test-${modelId.slice(-12)}', ${STAMP}, ${STAMP}, ${STAMP});
            INSERT INTO "ModelPrice"
              ("id", "modelId", "effectiveFrom",
               "inputRate", "outputRate", "cacheReadRate", "cacheWriteRate",
               "inputSource", "outputSource", "cacheReadSource", "cacheWriteSource",
               "inputObservedAt", "outputObservedAt", "cacheReadObservedAt", "cacheWriteObservedAt",
               "inputSourceRef", "outputSourceRef", "cacheReadSourceRef", "cacheWriteSourceRef",
               "createdAt")
            VALUES ('${priceId}', '${modelId}', ${STAMP},
                    ${CONFORMANCE_RATES.input}, ${CONFORMANCE_RATES.output},
                    ${CONFORMANCE_RATES.cacheRead}, ${CONFORMANCE_RATES.cacheWrite},
                    '${RATE_SOURCE}', '${RATE_SOURCE}', '${RATE_SOURCE}', '${RATE_SOURCE}',
                    ${observed}, ${observed}, ${observed}, ${observed},
                    '${RATE_SOURCE_REF}', '${RATE_SOURCE_REF}',
                    '${RATE_SOURCE_REF}', '${RATE_SOURCE_REF}',
                    ${STAMP});`;
  }

  const harness: ConversationsHarness = {
    base,
    stores,
    applyPeerRows,

    async freshScope(): Promise<EnvironmentScope> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a
      // slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`conv-${base.freshId("0021")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0022")}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0023"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId: projectId as ProjectId,
            slug: asTenancyIdentifier<Slug>("prod"),
            name: "prod",
            archivedAt: null,
            accessKeyRevocationVersion: 0,
            memoryFeedbackBackfillCursor: null,
            memoryFeedbackBackfillCompletedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return {
        level: "environment",
        organizationId,
        projectId,
        environmentId,
      } as unknown as EnvironmentScope;
    },

    async seedChain(scope: EnvironmentScope): Promise<PeerChain> {
      const agentId = base.freshId("0024");
      const agentVersionId = base.freshId("0025");
      const secondAgentVersionId = base.freshId("0026");
      const clusterId = base.freshId("0027");
      const endUserId = base.freshId("0028");
      const secondEndUserId = base.freshId("002c");
      const templateId = base.freshId("0029");
      const modelId = base.freshId("002a");
      const modelPriceId = base.freshId("002b");
      applyPeerRows(
        [
          agentSql(agentId, scope.projectId),
          versionSql(agentVersionId, agentId, 1),
          versionSql(secondAgentVersionId, agentId, 2),
          `INSERT INTO "AgentCluster" ("id", "environmentId", "name", "slug", "createdAt", "updatedAt")
           VALUES ('${clusterId}', '${scope.environmentId}', 'support', 'support', ${STAMP}, ${STAMP});`,
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${endUserId}', '${scope.organizationId}', 'the subject', ${STAMP}, ${STAMP});`,
          // The SECOND subject shares the organization on purpose. Moving a
          // thread to it satisfies `Thread_ancestry` — which checks the ORG —
          // so the only rule left to refuse the write is
          // `Thread_subject_immutable`, and the case that sends it is measuring
          // that trigger rather than the ancestry rule in front of it.
          `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
           VALUES ('${secondEndUserId}', '${scope.organizationId}', 'another subject', ${STAMP}, ${STAMP});`,
          `INSERT INTO "PostmanTemplate"
             ("id", "environmentId", "agentId", "name", "simulateUserId", "createdBy", "createdAt", "updatedAt")
           VALUES ('${templateId}', '${scope.environmentId}', '${agentId}', 'saved request',
                   '${endUserId}', 'fixture', ${STAMP}, ${STAMP});`,
          priceSql(modelId, modelPriceId),
        ].join("\n"),
      );
      return {
        scope,
        agentId,
        agentVersionId,
        secondAgentVersionId,
        clusterId,
        endUserId,
        secondEndUserId,
        templateId,
        // The operator `User` the shared identity fixture already seeds.
        // `PostmanExecution_ancestry` asks only that the row EXIST — it joins
        // `"User" actor ON actor.id = NEW."actorUserId"` with no membership
        // clause — so an execution needs no organization membership, which is
        // itself worth knowing: the forensic actor is not scoped by the rule.
        actorUserId: OWNER_USER,
        modelPriceId,
      };
    },

    async foreignChain(): Promise<PeerChain> {
      return harness.seedChain(await harness.freshScope());
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
