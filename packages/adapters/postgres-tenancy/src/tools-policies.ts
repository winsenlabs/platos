// `EntityToolPolicy` (tier 3, the inbound-surface exposure decision) and
// `OrganizationMcpPolicy` (tier 2, the organization's blanket opinion).
//
// ONE METHOD OF THE FIVE TAKES NO SCOPE, AND IT IS A WRITE. The port's own rule
// is that "EVERY SCOPED METHOD TAKES AN `EnvironmentScope`", and
// `upsertEntityToolPolicy(policy)` takes the record alone — whose
// `environmentId` is a LEAF. So this adapter cannot resolve the ancestry for
// that one call, and the only thing standing between a caller and another
// tenant's policy row is the migrations' `EntityToolPolicy_ancestry` trigger,
// which checks the entity against the environment's project and says nothing
// about whether the caller was entitled to either. It is implemented as the port
// declares it and reported rather than quietly widened: changing the signature
// is the port's decision, not an adapter's.
//
// THE LABELS COLUMN HOLDS TWO FIELDS AND THE DOMAIN SPLITS THEM. `scopeLabels`
// carries the free-form labels AND the `platos:pat:` token ids, and
// `encodeLabels` is the rule that merges them — including the rule that a scope
// label wearing the PAT prefix is DROPPED rather than escaped, which is a
// privilege escalation through a text field. Re-encoding here by hand would have
// been a second copy of that prefix, in the file furthest from the test that
// covers it.
//
// `addedAt` IS NULLABLE IN THE RECORD AND `NOT NULL` IN THE COLUMN. The record's
// own comment says null means "a synthesized denial — nothing was ever written",
// which is a value that by construction never reaches a write; the column has a
// `DEFAULT now()`. A null therefore leaves the field OFF the statement, so the
// default decides, and a row read back carries an instant where the caller
// passed none. That asymmetry is real and is pinned as a named case.

import type {
  EntityId,
  EntityToolPolicy,
  EnvironmentScope,
  OrganizationMcpPolicyId,
  OrganizationPolicyRecord,
  PolicyEffect,
  Result,
} from "@platos/context-tools/application/ports/index.js";
import {
  asToolsIdentifier,
  encodeLabels,
  ok,
} from "@platos/context-tools/application/ports/index.js";

import { readEffect, toEntityPolicy, type EntityPolicyRow } from "./tools-rows.js";
import { guarded, inScope } from "./tools-scope.js";
import type { TenancyTransactions } from "./transaction.js";

export interface ToolsPolicies {
  listEntityToolPolicies(
    scope: EnvironmentScope,
    entityId: EntityId,
  ): Promise<Result<readonly EntityToolPolicy[]>>;
  upsertEntityToolPolicy(policy: EntityToolPolicy): Promise<Result<EntityToolPolicy>>;
  listOrganizationPolicies(
    scope: EnvironmentScope,
  ): Promise<Result<readonly OrganizationPolicyRecord[]>>;
  upsertOrganizationPolicy(
    scope: EnvironmentScope,
    pattern: string,
    effect: PolicyEffect,
  ): Promise<Result<OrganizationPolicyRecord>>;
  deleteOrganizationPolicy(
    scope: EnvironmentScope,
    organizationMcpPolicyId: OrganizationMcpPolicyId,
  ): Promise<Result<boolean>>;
}

/** The policy row plus the joined name the record carries and the table lacks. */
const POLICY_SELECT = {
  id: true,
  environmentId: true,
  entityId: true,
  toolId: true,
  effect: true,
  minIdentityMode: true,
  scopeLabels: true,
  addedBy: true,
  addedAt: true,
  lastReviewedAt: true,
  tool: { select: { name: true } },
} as const;

interface OrganizationPolicyRow {
  readonly id: string;
  readonly pattern: string;
  readonly effect: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toOrganizationPolicy(row: OrganizationPolicyRow): OrganizationPolicyRecord {
  return {
    organizationMcpPolicyId: asToolsIdentifier<OrganizationMcpPolicyId>(row.id),
    pattern: row.pattern,
    effect: readEffect("OrganizationMcpPolicy.effect", row.effect),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createToolsPolicies(transactions: TenancyTransactions): ToolsPolicies {
  return {
    async listEntityToolPolicies(scope, entityId) {
      return inScope(transactions, scope, "listEntityToolPolicies", async () => {
        const rows = (await transactions.reader().entityToolPolicy.findMany({
          where: { environmentId: scope.environmentId, entityId },
          select: POLICY_SELECT,
          orderBy: { toolId: "asc" },
        })) as unknown as readonly EntityPolicyRow[];
        return ok(rows.map(toEntityPolicy));
      });
    },

    async upsertEntityToolPolicy(policy) {
      return guarded("upsertEntityToolPolicy", async () => {
        const labels = [...encodeLabels(policy.scopeLabels, policy.allowedPatIds)];
        const mutable = {
          effect: policy.effect,
          minIdentityMode: policy.minIdentityMode,
          scopeLabels: labels,
          addedBy: policy.addedBy,
          lastReviewedAt: policy.lastReviewedAt,
        };
        const written = (await transactions.atomic((client) =>
          client.entityToolPolicy.upsert({
            where: {
              environmentId_entityId_toolId: {
                environmentId: policy.environmentId,
                entityId: policy.entityId,
                toolId: policy.toolId,
              },
            },
            create: {
              environmentId: policy.environmentId,
              entityId: policy.entityId,
              toolId: policy.toolId,
              ...mutable,
              // Omitted when null, so the column's DEFAULT decides. See header.
              ...(policy.addedAt === null ? {} : { addedAt: policy.addedAt }),
            },
            // `addedAt` IS NOT UPDATED. It records when the policy was first
            // granted, and a review that flipped the effect must not make the
            // grant look newer than it is.
            update: mutable,
            select: POLICY_SELECT,
          }),
        )) as unknown as EntityPolicyRow;
        return ok(toEntityPolicy(written));
      });
    },

    async listOrganizationPolicies(scope) {
      return inScope(transactions, scope, "listOrganizationPolicies", async () => {
        const rows = await transactions.reader().organizationMcpPolicy.findMany({
          where: { organizationId: scope.organizationId },
          orderBy: { pattern: "asc" },
        });
        return ok(rows.map(toOrganizationPolicy));
      });
    },

    async upsertOrganizationPolicy(scope, pattern, effect) {
      return inScope(transactions, scope, "upsertOrganizationPolicy", async () => {
        const written = await transactions.atomic((client) =>
          client.organizationMcpPolicy.upsert({
            where: {
              organizationId_pattern: { organizationId: scope.organizationId, pattern },
            },
            create: { organizationId: scope.organizationId, pattern, effect },
            update: { effect },
          }),
        );
        return ok(toOrganizationPolicy(written));
      });
    },

    async deleteOrganizationPolicy(scope, organizationMcpPolicyId) {
      return inScope(transactions, scope, "deleteOrganizationPolicy", async () => {
        // `deleteMany` with the tenant clause IN THE STATEMENT, and the count
        // is the answer: `delete` by primary key alone would let one
        // organization retire another's policy by guessing a uuid, and would
        // raise rather than return `false` for a row that was never there.
        const removed = await transactions.atomic((client) =>
          client.organizationMcpPolicy.deleteMany({
            where: { id: organizationMcpPolicyId, organizationId: scope.organizationId },
          }),
        );
        return ok(removed.count > 0);
      });
    },
  };
}
