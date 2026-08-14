import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma as ControlPrisma } from "../generated/control";
import { Prisma as EndUserPrisma } from "../generated/end-user";
import { describe, expect, test } from "vitest";

const packageRoot = resolve(__dirname, "..");
const schema = readFileSync(resolve(packageRoot, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  resolve(packageRoot, "prisma/migrations/00000000000000_initial/migration.sql"),
  "utf8"
);

const forbiddenNouns = [
  "run",
  "task",
  "deployment",
  "waitpoint",
  "queue",
  "attempt",
  "worker",
];

describe("clean-slate tenancy schema", () => {
  test("contains none of the external runtime nouns in persisted identifiers", () => {
    const identifiers = [
      ...ControlPrisma.dmmf.datamodel.models.flatMap((model) => [
        model.name,
        ...model.fields.map((field) => field.name),
      ]),
      ...ControlPrisma.dmmf.datamodel.enums.flatMap((entry) => [
        entry.name,
        ...entry.values.map((value) => value.name),
      ]),
    ];

    for (const identifier of identifiers) {
      for (const noun of forbiddenNouns) {
        expect(identifier.toLowerCase()).not.toContain(noun);
      }
    }
  });

  test("states an onDelete policy for every Prisma-owned foreign key", () => {
    const owningRelations = schema
      .split("\n")
      .filter((line) => line.includes("@relation(") && line.includes("fields:"));

    expect(owningRelations.length).toBeGreaterThan(0);
    for (const relation of owningRelations) {
      expect(relation).toContain("onDelete:");
    }

    const sqlForeignKeys = migration.match(/ FOREIGN KEY /g) ?? [];
    const sqlDeletePolicies = migration.match(/ ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)/g) ?? [];
    expect(sqlDeletePolicies).toHaveLength(sqlForeignKeys.length);
    expect(sqlForeignKeys).toHaveLength(owningRelations.length);
  });

  test("keeps persisted names canonical and has one initial migration", () => {
    expect(schema).not.toContain("@@map(");
    expect(schema).not.toContain("@map(");

    const migrationDirectories = readdirSync(resolve(packageRoot, "prisma/migrations"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(migrationDirectories.map((entry) => entry.name)).toEqual(["00000000000000_initial"]);
  });

  test("limits the generated end-user relation graph to data-plane models", () => {
    const models = EndUserPrisma.dmmf.datamodel.models;
    expect(models.map((model) => model.name).sort()).toEqual([
      "EndUser",
      "EndUserIdentity",
      "EndUserSession",
    ]);

    const relationTargets = models.flatMap((model) =>
      model.fields.filter((field) => field.kind === "object").map((field) => field.type)
    );
    expect(new Set(relationTargets)).toEqual(new Set(["EndUser", "EndUserIdentity", "EndUserSession"]));
  });

  test("records database-enforced tier and organization boundaries", () => {
    expect(migration).toContain('CONSTRAINT "OperatorSession_tier_check"');
    expect(migration).toContain('CONSTRAINT "EnvironmentSession_tier_check"');
    expect(migration).toContain('CONSTRAINT "EndUserSession_tier_check"');
    expect(migration).toContain('CREATE TRIGGER "EndUserSession_organization_check"');
    expect(migration).toContain('CREATE TRIGGER "Environment_end_user_session_organization_check"');
    expect(migration).toContain('CREATE TRIGGER "Project_end_user_session_organization_check"');
    expect(migration).toContain('CREATE TRIGGER "EndUser_session_organization_reparent_check"');
  });
});
