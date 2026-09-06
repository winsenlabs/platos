// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces the SECOND write
// of a multi-statement operation to fail and then LOOKS FOR THE FIRST ROW — over
// a SECOND client, on a connection this adapter's pool never touched, because
// durability is not "the row is there when the writer looks again" but "the row
// is there when somebody else looks".
//
// *** AND IT IS THIS CONTEXT'S OWN TRAP, IN ITS SHARPEST FORM. *** An install is
// TWO rows in two tables, written by TWO port methods:
// `upsertProjectInstallation` adopts the catalogue row into the project and
// `upsertEnvironmentInstallation` binds that adoption in the environment, and
// `install-skill.ts` composes them inside one `unitOfWork.run`. The second can
// fail for a reason the first cannot see — `EnvironmentSkill_ancestry` refuses a
// binding whose environment belongs to a different project — and if the first
// survived that failure the tree would hold a `ProjectSkill` that nothing points
// at and that the uninstall path could never remove, because
// `deleteEnvironmentInstallation` deletes only the environment row.
//
// THE `Result` HALF IS MEASURED TOO, and it is the trap `cost-monitoring`
// shipped. `refuseSkills` turns a driver error into an error `Result`, and an
// error `Result` RESOLVES — so the callback returns normally and the unit of
// work issues COMMIT. Whether that COMMIT is a commit or a rollback is a fact
// about PostgreSQL and not about this package, and the only honest way to know
// is to look for the row from outside. That is what these cases do.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ProjectInstallation,
  SkillId,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier } from "@platos/context-skills/application/ports/index.js";
import { runResult } from "@platos/context-skills/application/ports/index.js";
import type { TenancyDatabaseClient } from "./client.js";
import { conformanceDraft, conformanceIdentity } from "./skills-conformance.js";
import { startSkillsHarness, type SkillsHarness, type SkillsTenant } from "./skills-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: SkillsHarness;
let tenant: SkillsTenant;
let foreign: SkillsTenant;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;

beforeAll(async () => {
  harness = await startSkillsHarness();
  tenant = await harness.freshTenant();
  foreign = await harness.freshTenant();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

describe("an install is a project adoption and an environment binding, or neither", () => {
  test("the binding fails on ancestry and the adoption does not survive it", async () => {
    const skill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.atomic", "1.0.0"), transaction),
    );
    expect(skill.ok).toBe(true);
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");

    let adopted: ProjectInstallation | null = null;
    // THE FAILURE IS THE ADAPTER'S OWN SECOND STATEMENT, not a third one this
    // suite adds. `tenant.sibling` is an environment of a DIFFERENT project in
    // the same organization, and `EnvironmentSkill_ancestry` demands that the
    // environment and the project adoption share a project. Nothing about the
    // failure is simulated.
    await runResult(harness, async (transaction) => {
        const project = await harness.repository.upsertProjectInstallation(
          tenant.scope,
          skillId,
          transaction,
        );
        expect(project.ok).toBe(true);
        adopted = project.ok ? project.value : null;
        if (adopted === null) throw new Error("the adoption is the fixture");
        return harness.repository.upsertEnvironmentInstallation(
          tenant.sibling,
          adopted,
          transaction,
        );
      })
      .catch(() => undefined);

    const written: ProjectInstallation | null = adopted;
    expect(written).not.toBeNull();

    // OVER THE SECOND CLIENT. The adoption is gone, and so is the binding the
    // second half tried to write.
    expect(
      await observer.projectSkill.count({
        where: { projectId: tenant.projectId, skillId },
      }),
    ).toBe(0);
    expect(
      await observer.environmentSkill.count({
        where: { environmentId: tenant.siblingEnvironmentId },
      }),
    ).toBe(0);
  });

  test("and the same two writes COMMIT together when nothing fails", async () => {
    // The negative control. Without it the case above would pass against a store
    // that never wrote anything at all.
    const skill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.commits", "1.0.0"), transaction),
    );
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");
    await runResult(harness, async (transaction) => {
      const project = await harness.repository.upsertProjectInstallation(
        tenant.scope,
        skillId,
        transaction,
      );
      if (!project.ok) throw new Error("the adoption must succeed here");
      return harness.repository.upsertEnvironmentInstallation(
        tenant.scope,
        project.value,
        transaction,
      );
    });
    expect(
      await observer.projectSkill.count({ where: { projectId: tenant.projectId, skillId } }),
    ).toBe(1);
    expect(
      await observer.environmentSkill.count({
        where: { environmentId: tenant.environmentId, projectSkill: { skillId } },
      }),
    ).toBe(1);
  });
});

describe("a catalogue write and an adoption are one transaction or neither", () => {
  test("the adoption fails on a foreign skill and the catalogue row does not survive", async () => {
    const foreignSkill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(foreign.scope, "foreign.atomic", "1.0.0"), transaction),
    );
    const foreignSkillId = foreignSkill.ok ? foreignSkill.value.skillId : asIdentifier<SkillId>("x");

    await runResult(harness, async (transaction) => {
        const registered = await harness.repository.upsertSkill(
          conformanceDraft(tenant.scope, "acme.stranded", "1.0.0"),
          transaction,
        );
        expect(registered.ok).toBe(true);
        // `ProjectSkill_ancestry` refuses: the project and the skill are in two
        // different organizations.
        return harness.repository.upsertProjectInstallation(
          tenant.scope,
          foreignSkillId,
          transaction,
        );
      })
      .catch(() => undefined);

    expect(
      await observer.skill.count({
        where: { organizationId: tenant.organizationId, slug: "acme.stranded" },
      }),
    ).toBe(0);
    // And the port agrees with the second client, which is what makes the read
    // path and the durability claim one fact rather than two.
    expect(
      await harness.repository.findSkillByIdentity(
        conformanceIdentity(tenant.scope, "acme.stranded", "1.0.0"),
      ),
    ).toEqual({ ok: true, value: null });
  });
});

describe("the three scope refusals stay three DISTINCT codes", () => {
  test("a write with no transaction open is not_open", async () => {
    const outside: TransactionScope = { transactionId: asIdentifier("pg-txn-1") };
    const thrown = await harness.repository
      .upsertSkill(conformanceDraft(tenant.scope, "acme.notopen", "1.0.0"), outside)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(codeOf(thrown)).toBe(TRANSACTION_NOT_OPEN);
  });

  test("a write with a FINISHED transaction's token is scope_unknown", async () => {
    let finished: TransactionScope | null = null;
    await harness.run(async (transaction) => {
      finished = transaction;
    });
    const stale = finished as TransactionScope | null;
    expect(stale).not.toBeNull();
    const thrown = await harness
      .run((live) =>
        harness.repository
          .upsertSkill(
            conformanceDraft(tenant.scope, "acme.stale", "1.0.0"),
            stale ?? live,
          )
          .then(() => null)
          .catch((error: unknown) => error),
      )
      .catch((error: unknown) => error);
    expect(codeOf(thrown)).toBe(TRANSACTION_SCOPE_UNKNOWN);
  });

  test("a write with ANOTHER LIVE transaction's token is scope_foreign", async () => {
    // TWO LIVE TRANSACTIONS AT ONCE, so the token is open and is not this one.
    // Without the second being LIVE the refusal would be `scope_unknown`, and the
    // two mistakes would be indistinguishable in a log — which is exactly the
    // collapse tranche 1 minted three codes to prevent.
    //
    // The concurrent unit of work is opened from OUTSIDE any frame, deliberately.
    // `UnitOfWork.run` JOINS an open transaction rather than opening a second
    // one, so a nested call carries the SAME id and could never be foreign; the
    // foreign token has to come from a genuinely separate async context.
    let openConcurrent: (scope: TransactionScope) => void = () => undefined;
    let releaseConcurrent: () => void = () => undefined;
    const opened = new Promise<TransactionScope>((resolve) => {
      openConcurrent = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    const held = harness.base.adapter.unitOfWork.run(async (concurrent) => {
      openConcurrent(concurrent);
      await release;
    });

    const other = await opened;
    const thrown = await harness.run((live) => {
      expect(live.transactionId).not.toBe(other.transactionId);
      return harness.repository
        .upsertSkill(conformanceDraft(tenant.scope, "acme.foreign", "1.0.0"), other)
        .then(() => null)
        .catch((error: unknown) => error);
    });
    releaseConcurrent();
    await held;
    expect(codeOf(thrown)).toBe(TRANSACTION_SCOPE_FOREIGN);
  });

  test("the three codes are distinct strings", () => {
    // The acceptance condition stated directly: two guards sharing one code
    // cannot be told apart, whatever else a suite proves about them.
    expect(new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size).toBe(3);
  });
});
