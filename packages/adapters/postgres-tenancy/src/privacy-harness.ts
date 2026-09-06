// What the `privacy` suites need on top of the shared container, which is less
// than any other owner in this directory has needed — and that is a fact about
// the context rather than a gap in the fixture.
//
// ONE PEER ROW. `ErasureOperation.organizationId` and
// `ErasureTombstone.organizationId` are the ONLY foreign keys either table
// carries, and the `enforce_domain_ancestry` database RULE fires on neither.
// Compare `memory-harness.ts`, whose one table demands an environment under a
// project under an organization plus an end user plus an agent plus a cluster
// plus a binding. This context's whole design is that its rows point at nobody:
// the receipt documents a person's destruction WITHOUT recording who they were,
// so there is no subject row for it to hang off, and every other identifier on
// it is a salted digest that references nothing.
//
// AND THE ORGANIZATION GOES THROUGH THE PORT. `Organization` is `tenancy`'s row
// and `tenancy`'s canonical store is this same directory (ADR M0.3 §15), so a
// tenant is created by calling `saveOrganization` rather than by writing SQL. A
// fresh organization per case is what keeps `listOperationsForSubject` — which
// returns everything for one digest — from seeing another case's rows.
//
// `applyRows` EXISTS FOR THE ROWS THE STORE REFUSES TO WRITE, WHICH IS THE
// POINT. A `status` outside the `WorkStatus` enum, a `stores` whose JSON root is
// an object, a `scopes` element with no `level` — all are values an OLDER OR
// NEWER binary could have put in the table and this one must refuse to READ
// rather than cast past. Writing them through this package's delegate would be
// writing them through the guard under test, so they go through the ORM's own
// CLI, which is runtime and therefore outside the sole-writer scanner's scope by
// construction.
//
// THE PHYSICAL COLUMN BEHIND `nextRetryAt` IS NAMED DIFFERENTLY, and a
// hand-written statement has to use the physical name where a delegate call uses
// the Prisma field. It is the one place in this context where the two spellings
// diverge; `schema.prisma`'s `@map` on that field is the authority, and nothing
// in this file or its suites writes that column by hand.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  ErasureOperationId,
  IdempotencyKey,
  OrganizationId,
  PersistedErasureOperation,
  PrivacyRepository,
  SubjectKeyHash,
  TargetOutcome,
  TransactionScope,
} from "@platos/context-privacy/application/ports/index.js";
import {
  asIdentifier,
  organizationScope,
  ZERO_COUNTS,
} from "@platos/context-privacy/application/ports/index.js";
import { runResult } from "@platos/kernel";
import type { NotResult } from "@platos/kernel";

import type { TenancyHarness } from "./harness.js";
import { startTenancyHarness } from "./harness.js";

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");

/** The one instant every fixture row is stamped with, so nothing is time-dependent. */
export const REQUESTED_AT = new Date("2026-05-01T09:00:00.000Z");

/** One organization, which is the whole peer chain this context needs. */
export interface PrivacyTenant {
  readonly organizationId: OrganizationId;
}

export interface PrivacyHarness {
  readonly base: TenancyHarness;
  readonly repository: PrivacyRepository;
  /** A brand-new organization, through the tenancy port. */
  freshTenant(): Promise<PrivacyTenant>;
  /** Rows this store refuses to write, applied by the ORM's own CLI. */
  applyRows(sql: string): void;
  /** Open one transaction over the adapter's own ambient frame. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
  statements(): readonly string[];
  resetStatements(): void;
  stop(): Promise<void>;
}

/**
 * A storable operation, with everything the schema demands and nothing it does
 * not.
 *
 * The context's own `buildPrivacyTestContext()` cannot supply one: it mints
 * `org-1` for a `@db.Uuid` column and `SequenceIdGenerator` mints `id-0001` for
 * another, and both are accepted by `InMemoryPrivacyRepository` and refused by
 * PostgreSQL. This builder takes the tenant's real uuids and defaults every other
 * column to a value the schema admits, so a case states only the field it is
 * about — which is what a builder is for.
 */
export function operationDraft(
  tenant: PrivacyTenant,
  operationId: string,
  overrides: Partial<PersistedErasureOperation> = {},
): PersistedErasureOperation {
  return {
    operationId: asIdentifier<ErasureOperationId>(operationId),
    organizationId: tenant.organizationId,
    idempotencyKey: asIdentifier<IdempotencyKey>(`key-${operationId}`),
    // A digest and not a handle. `HashingSubjectHasher` produces exactly this
    // shape, and the column is plain TEXT — which is why the CONTENT-FREE rule
    // is a domain guard and not something the schema can enforce.
    subjectKeyHash: asIdentifier<SubjectKeyHash>(`d0000001`),
    workStatus: "PENDING",
    scopes: [organizationScope(tenant.organizationId)],
    outcomes: [],
    policyVersion: "privacy/1",
    legalHoldPolicyId: null,
    retryCount: 0,
    requestedAt: REQUESTED_AT,
    startedAt: null,
    completedAt: null,
    nextRetryAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

/** One settled target outcome, for the `stores` column. */
export function outcomeDraft(target: string, overrides: Partial<TargetOutcome> = {}): TargetOutcome {
  return {
    target,
    status: "done",
    verification: "passed",
    discovered: 3,
    counts: ZERO_COUNTS,
    failures: 0,
    note: null,
    ...overrides,
  };
}

export async function startPrivacyHarness(): Promise<PrivacyHarness> {
  const base = await startTenancyHarness();
  // The composite is SPREAD into the adapter, so the adapter IS the port. There
  // is no property to read here, which is what `PORT_SATISFACTION` proves at
  // compile time in the composition root.
  const repository: PrivacyRepository = base.adapter;

  function applyRows(sql: string): void {
    execFileSync(prismaBinary, ["db", "execute", "--url", base.databaseUrl, "--stdin"], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: base.databaseUrl },
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  return {
    base,
    repository,
    applyRows,
    statements: () => base.statements(),
    resetStatements: () => {
      base.resetStatements();
    },

    async freshTenant(): Promise<PrivacyTenant> {
      // The WHOLE fresh identifier, not a slice: `Organization.slug` is UNIQUE
      // installation-wide and `freshId` varies only in its LAST group, so a slice
      // of the middle is the same string on every call.
      const organizationId = await base.seedOrganization(`priv-${base.freshId("0060")}`);
      return { organizationId: asIdentifier<OrganizationId>(organizationId) };
    },

    async run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value> {
      return base.adapter.unitOfWork.run<Value>((transaction) =>
        work(transaction as unknown as TransactionScope),
      );
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
}
