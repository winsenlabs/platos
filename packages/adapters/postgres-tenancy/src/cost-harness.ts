// What the `cost-monitoring` suites need on top of the shared container: a fresh
// tenant chain per suite, and the peer rows this package is NOT the writer of.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this same
// directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps `listBudgets(scope)` — which
// returns everything in an environment — from seeing another suite's caps.
//
// `Agent` AND `Credential` CANNOT, AND THAT IS THE INTERESTING HALF.
// `agents` owns `Agent` and `secrets` owns `Credential`; neither has an entry in
// `CANONICAL_STORE_ADAPTERS`, so `sole-writer.mjs` refuses a write to either
// from this directory — correctly, and the refusal is the gate doing its job
// rather than an obstacle to route around. Both rows are nonetheless real
// foreign keys the six rows under test point at: `Budget.agentId` is checked by
// `Budget_ancestry`, and `AlertChannelConfiguration.credentialId` is checked by
// `enforce_win124_credential_kind`, which demands a credential of the right kind
// that is neither revoked nor without an active secret version.
//
// They are therefore seeded THROUGH THE SAME OUT-OF-BAND MECHANISM the tenancy
// suites' own fixture uses — `prisma db execute` — rather than through any
// client this package holds. `fixtures/identity-access-rows.sql` is a static
// file because tranche 1's suites name fixed identifiers; these are piped on
// standard input instead, because every row here hangs off an environment minted
// per suite and a static file cannot name one.
//
// A `CredentialSecretVersion` comes with each credential because the rule reads
// `activeSecretVersionId IS NOT NULL`, and its own three length checks — 32-byte
// salt, 12-byte nonce, 16-byte tag — are what make the envelope below look the
// way it does. A credential with no version satisfies the column and fails the
// rule, which is exactly the case one of the constraint proofs needs.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  BudgetRepository,
  EnvironmentScope,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asIdentifier, environmentScope } from "@platos/context-cost-monitoring/application/ports/index.js";
import type { EnvironmentId, ProjectId, Slug } from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier as asTenancyIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** How a seeded credential should look to `enforce_win124_credential_kind`. */
export interface CredentialShape {
  /** `CHANNEL_SECRET` unless a suite is proving the rule refuses another kind. */
  readonly kind?: string;
  /** True to seed a credential with no `CredentialSecretVersion` at all. */
  readonly withoutSecretVersion?: boolean;
  /** True to seed one that has been revoked. */
  readonly revoked?: boolean;
}

export interface CostHarness {
  readonly base: TenancyHarness;
  readonly repository: BudgetRepository;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshScope(): Promise<EnvironmentScope>;
  /** An `Agent` in this scope's project. Returns its id. */
  seedAgent(scope: EnvironmentScope): Promise<string>;
  /** A `Credential` in this scope's environment. Returns its id. */
  seedCredential(scope: EnvironmentScope, shape?: CredentialShape): Promise<string>;
  stop(): Promise<void>;
}

/** Rows this package may not write, applied by the ORM's own CLI. */
function applyPeerRows(databaseUrl: string, sql: string): void {
  execFileSync(prismaBinary, ["db", "execute", "--url", databaseUrl, "--stdin"], {
    cwd: databasePackage,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function startCostHarness(): Promise<CostHarness> {
  const base = await startTenancyHarness();
  const repository = base.adapter as unknown as BudgetRepository;

  const harness: CostHarness = {
    base,
    repository,

    async freshScope(): Promise<EnvironmentScope> {
      const organizationId = await base.seedOrganization(`cost-${base.freshId("0005").slice(9, 13)}`);
      const projectId = await base.seedProject(organizationId, `proj-${base.freshId("0006").slice(9, 13)}`);
      const environmentId = asTenancyIdentifier<EnvironmentId>(base.freshId("0007"));
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
      return environmentScope(
        asIdentifier(organizationId),
        asIdentifier(projectId),
        asIdentifier(environmentId),
      );
    },

    async seedAgent(scope: EnvironmentScope): Promise<string> {
      const agentId = base.freshId("0008");
      applyPeerRows(
        base.databaseUrl,
        `INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
         VALUES ('${agentId}', '${scope.projectId}', 'cap subject', 'cap-subject-${agentId.slice(-8)}', true,
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      return agentId;
    },

    async seedCredential(scope: EnvironmentScope, shape: CredentialShape = {}): Promise<string> {
      const credentialId = base.freshId("0009");
      const versionId = base.freshId("000a");
      const kind = shape.kind ?? "CHANNEL_SECRET";
      const revokedAt = shape.revoked === true ? `'2026-05-02T09:00:00Z'` : "NULL";
      const statements = [
        `INSERT INTO "Credential" ("id", "environmentId", "kind", "name", "revokedAt", "createdAt", "updatedAt")
         VALUES ('${credentialId}', '${scope.environmentId}', '${kind}', 'channel secret', ${revokedAt},
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ];
      if (shape.withoutSecretVersion !== true) {
        statements.push(
          // The three length checks are the reason these are `decode(repeat(...))`
          // rather than readable placeholders: 32 bytes of salt, 12 of nonce and
          // 16 of tag, exactly, or the row is refused.
          `INSERT INTO "CredentialSecretVersion"
             ("id", "credentialId", "secretRevision", "formatVersion", "rootKeyVersion",
              "salt", "nonce", "ciphertext", "authTag", "createdAt")
           VALUES ('${versionId}', '${credentialId}', 1, 1, 1,
                   decode(repeat('a1', 32), 'hex'), decode(repeat('b2', 12), 'hex'),
                   decode(repeat('c3', 8), 'hex'), decode(repeat('d4', 16), 'hex'),
                   '2026-05-01T09:00:00Z');`,
          `UPDATE "Credential" SET "activeSecretVersionId" = '${versionId}' WHERE "id" = '${credentialId}';`,
        );
      }
      applyPeerRows(base.databaseUrl, statements.join("\n"));
      return credentialId;
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
  return harness;
}
