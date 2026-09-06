// What the `providers` suites need on top of the shared container: a fresh
// tenant chain per suite, and the peer rows this package is NOT the writer of.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps `listProviderKeys(scope)` — which
// returns everything in an environment — from seeing another suite's keys.
//
// `Credential`, `Agent`, `AgentVersion` AND `AgentBinding` CANNOT, AND THAT IS
// THE INTERESTING HALF. `secrets` owns the first and `agents` owns the other
// three. `secrets` does have an entry in `CANONICAL_STORE_ADAPTERS` — the
// tranche before this one gave it one — so a `Credential` written from here
// would pass `sole-writer.mjs`; it is STILL seeded out of band, because this
// package holding a grant is not the same as this SUITE being entitled to use
// it, and a fixture that wrote another context's rows through another context's
// store would be testing that store rather than this one.
//
// EVERY `ProviderKey` NEEDS ONE OF THEM. `ProviderKey_credential_provider_integrity`
// is a BEFORE INSERT OR UPDATE rule demanding a `Credential` in the SAME
// environment whose `provider` equals the key's and whose `name` equals the
// key's `environmentKeyName`. `InMemoryProvidersRepository` stores any
// `credentialId` at all, so no use-case suite in the tree has ever met this
// rule, and the first integration run of this tranche was refused by it.
//
// THE VERSION CHAIN IS WHAT MAKES THE DELETE RULE REACHABLE.
// `reject_executable_provider_key_delete` walks `Environment -> AgentBinding ->
// Agent -> AgentVersion` and looks in TWO places a version can pin a key: the
// `{__runtime,providerKeyId}` path inside `memoryConfig`, and every entry of the
// `modelRoutes` array. Both halves also require the version's model string to
// name the key's OWN provider, so `seedPinningVersion` takes the provider and
// builds `"<provider>:<model>"` rather than letting a suite pass a bare name
// that would silently not pin anything.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  EnvironmentScope,
  ProvidersRepository,
} from "@platos/context-providers/application/ports/index.js";
import type {
  EnvironmentId,
  OrganizationId,
  ProjectId,
  Slug,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** What a seeded credential must look like to the ProviderKey rule. */
export interface CredentialShape {
  /** Must equal the key's `provider`, or the rule refuses the key. */
  readonly provider: string;
  /** Must equal the key's `environmentKeyName`, or the rule refuses the key. */
  readonly name: string;
}

/** Where in an `AgentVersion` the pin is written. Both are what the rule reads. */
export type PinSite = "memoryConfig" | "modelRoutes";

export interface ProvidersHarness {
  readonly base: TenancyHarness;
  readonly repository: ProvidersRepository;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** A `Credential` the ProviderKey rule will accept. Returns its id. */
  seedCredential(scope: EnvironmentScope, shape: CredentialShape): Promise<string>;
  /**
   * An `Agent`, an `AgentVersion` pinning `providerKeyId`, and the
   * `AgentBinding` that makes the version EXECUTABLE in this environment.
   */
  seedPinningVersion(
    scope: EnvironmentScope,
    providerKeyId: string,
    provider: string,
    site: PinSite,
  ): Promise<string>;
  /** Rows this suite may not write, applied by the ORM's own CLI. */
  applyPeerRows(sql: string): void;
  stop(): Promise<void>;
}

function applyPeerRowsTo(databaseUrl: string, sql: string): void {
  execFileSync(prismaBinary, ["db", "execute", "--url", databaseUrl, "--stdin"], {
    cwd: databasePackage,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function startProvidersHarness(): Promise<ProvidersHarness> {
  const base = await startTenancyHarness();
  const repository = base.adapter as unknown as ProvidersRepository;
  let versions = 0;

  const harness: ProvidersHarness = {
    base,
    repository,

    async freshScope(): Promise<EnvironmentScope> {
      // The WHOLE fresh identifier, not a slice of it. `Organization.slug` is
      // UNIQUE installation-wide and `freshId` varies only in its LAST group, so
      // a slice of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`prov-${base.freshId("0005")}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0006")}`);
      const environmentId = asIdentifier<EnvironmentId>(base.freshId("0007"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId: projectId as ProjectId,
            slug: asIdentifier<Slug>("prod"),
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
        organizationId: organizationId as OrganizationId,
        projectId: projectId as ProjectId,
        environmentId,
      } as unknown as EnvironmentScope;
    },

    async seedCredential(scope: EnvironmentScope, shape: CredentialShape): Promise<string> {
      const credentialId = base.freshId("0009");
      // `SERVICE_CREDENTIAL` because that is what a provider key points at, and
      // because `enforce_win124_credential_kind` — the rule that demands an
      // active secret version — is installed on `EnvironmentVariable` and
      // `AlertChannelConfiguration` and NOT on `ProviderKey`. So a credential
      // with no envelope satisfies this rule, which is the honest fixture:
      // the material is `secrets`' business and this row is not.
      applyPeerRowsTo(
        base.databaseUrl,
        `INSERT INTO "Credential" ("id", "environmentId", "kind", "name", "provider", "createdAt", "updatedAt")
         VALUES ('${credentialId}', '${scope.environmentId}', 'SERVICE_CREDENTIAL',
                 '${shape.name}', '${shape.provider}',
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      return credentialId;
    },

    async seedPinningVersion(
      scope: EnvironmentScope,
      providerKeyId: string,
      provider: string,
      site: PinSite,
    ): Promise<string> {
      versions += 1;
      const agentId = base.freshId("000a");
      const versionId = base.freshId("000b");
      const bindingId = base.freshId("000c");
      // The model string MUST begin with the key's provider: both halves of
      // `reject_executable_provider_key_delete` compare
      // `split_part(model, ':', 1)` against the key's `provider`, and a version
      // naming another provider's model pins nothing.
      const model = `${provider}:pinning-model`;
      const memoryConfig =
        site === "memoryConfig"
          ? `'{"__runtime":{"providerKeyId":"${providerKeyId}"}}'::jsonb`
          : `'{}'::jsonb`;
      const modelRoutes =
        site === "modelRoutes"
          ? `'[{"model":"${model}","providerKeyId":"${providerKeyId}"}]'::jsonb`
          : `'[]'::jsonb`;
      applyPeerRowsTo(
        base.databaseUrl,
        [
          `INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
           VALUES ('${agentId}', '${scope.projectId}', 'pinning agent', 'pin-${versions}-${agentId.slice(-8)}',
                   true, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
          `INSERT INTO "AgentVersion"
             ("id", "agentId", "versionNumber", "model", "memoryConfig", "modelRoutes", "createdBy", "createdAt")
           VALUES ('${versionId}', '${agentId}', 1, '${model}', ${memoryConfig}, ${modelRoutes},
                   'fixture', '2026-05-01T09:00:00Z');`,
          // The BINDING is what makes the version executable. Without it the
          // rule's join finds nothing and the delete it should refuse
          // succeeds, which is exactly the false green a fixture that seeded
          // only the version would have produced.
          `INSERT INTO "AgentBinding"
             ("id", "environmentId", "agentId", "activeAgentVersionId", "createdAt", "updatedAt")
           VALUES ('${bindingId}', '${scope.environmentId}', '${agentId}', '${versionId}',
                   '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
        ].join("\n"),
      );
      return versionId;
    },

    applyPeerRows(sql: string): void {
      applyPeerRowsTo(base.databaseUrl, sql);
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
