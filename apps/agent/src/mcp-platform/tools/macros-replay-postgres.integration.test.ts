/**
 * WIN-268 P3 — a recorded macro step's params survive PostgreSQL and reach the
 * replayed tool.
 *
 * THE DEFECT THIS PINS, CARRIED FORWARD INTO THIS TRANCHE. `Macro.steps[i].params`
 * was once read through a helper that answered null, and `macros.replay` then
 * re-dispatched `send` WITH NO PARAMETERS and reported the step successful. The
 * shape that allows it is still here — `substitutePlaceholders(step.params ?? {}, …)`
 * turns an absent params object into `{}` silently, and the replay result says
 * `ok: true` for whatever the tool then did with no arguments.
 *
 * WHY A DOUBLE CANNOT PIN IT. `Macro.steps` is a Json column. The whole defect
 * lives in the round trip: what the recorder pushed, what Prisma serialised, what
 * PostgreSQL stored, and what came back. A doubled client returns the object it
 * was handed and proves none of that — which is why the existing unit suite,
 * which does exactly that, was green while the bug shipped.
 *
 * So this drives the REAL router, through the REAL recorder, into a REAL
 * `Macro` row, and asserts on the arguments the replayed tool actually received.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpRouter } from "../mcp-router";
import { MacroRecordingState, buildMacroToolHandlers } from "./macros";
import type { VerifiedToken } from "../token.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const baseDatabaseUrl =
  process.env.END_USER_TENANCY_TEST_DATABASE_URL ??
  process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL ??
  process.env.DATABASE_URL;

if (process.env.END_USER_TENANCY_REQUIRED === "1" && !baseDatabaseUrl) {
  throw new Error("END_USER_TENANCY_REQUIRED=1 but no database URL is set");
}

const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;
const { Client } = require("pg") as { Client: new (options: unknown) => any };

/** The nested, non-trivial params the round trip has to preserve exactly. */
const RECORDED_PARAMS = {
  to: "ops@example.invalid",
  body: "deploy ${var.release} to ${var.stage}",
  options: { retries: 2, tags: ["urgent", "release"], dryRun: false },
} as const;

describeWithDatabase("macros.replay parameter round trip through PostgreSQL", () => {
  let admin: any;
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let environmentId: string;
  let foreignEnvironmentId: string;
  let router: McpRouter;
  let state: MacroRecordingState;
  let received: Array<Record<string, unknown>>;
  let token: VerifiedToken;
  let foreignToken: VerifiedToken;

  async function seedTenant(label: string): Promise<{ environmentId: string; operatorUserId: string }> {
    const operator = await prisma.user.create({
      data: { email: `${schemaName}-${label}@test.invalid`, displayName: `${label} operator` },
    });
    const organization = await prisma.organization.create({
      data: { slug: `${schemaName}-${label}`, name: `${label} org` },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: operator.id, role: "OWNER" },
    });
    const project = await prisma.project.create({
      data: { organizationId: organization.id, slug: `${schemaName}-${label}`, name: `${label} project` },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    return { environmentId: environment.id, operatorUserId: operator.id };
  }

  // `mintedByUserId` becomes `Macro.createdBy`, which is a real foreign key to
  // `User`. A fixture that invents the id gets an FK violation reported as
  // "internal error" from the tool, which is how the first draft of this suite
  // failed — a reminder that the store is what is being tested here.
  function tokenFor(
    environment: string,
    organizationId: string,
    projectId: string,
    operatorUserId: string,
  ): VerifiedToken {
    return {
      id: `token-${environment}`,
      scope: { organizationId, projectId, environmentId: environment },
      permissions: ["*"],
      mintedByUserId: operatorUserId,
      expiresAt: null,
      tier: "scope",
    } as VerifiedToken;
  }

  beforeAll(async () => {
    schemaName = `macros_${process.pid}_${Date.now()}`;
    admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    adminConnected = true;

    const migrationsRoot = resolve(
      process.cwd(),
      "../../internal-packages/tenancy-database/prisma/migrations",
    );
    for (const migration of readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      await admin.query(
        readFileSync(resolve(migrationsRoot, migration, "migration.sql"), "utf8")
          .replaceAll('"public"', `"${schemaName}"`),
      );
    }

    const url = new URL(baseDatabaseUrl!);
    url.searchParams.set("schema", schemaName);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    const homeTenant = await seedTenant("home");
    const foreignTenant = await seedTenant("foreign");
    environmentId = homeTenant.environmentId;
    foreignEnvironmentId = foreignTenant.environmentId;

    const home = await prisma.environment.findUniqueOrThrow({
      where: { id: environmentId },
      select: { projectId: true, project: { select: { organizationId: true } } },
    });
    const foreign = await prisma.environment.findUniqueOrThrow({
      where: { id: foreignEnvironmentId },
      select: { projectId: true, project: { select: { organizationId: true } } },
    });
    token = tokenFor(
      environmentId,
      home.project.organizationId,
      home.projectId,
      homeTenant.operatorUserId,
    );
    foreignToken = tokenFor(
      foreignEnvironmentId,
      foreign.project.organizationId,
      foreign.projectId,
      foreignTenant.operatorUserId,
    );

    received = [];
    state = new MacroRecordingState();
    router = new McpRouter(
      { buildScope: (verified) => ({ ...verified.scope, userId: verified.mintedByUserId }) } as any,
      { resolve: vi.fn().mockResolvedValue({ state: "auto_allow", tier: 1, reason: "fixture" }) } as any,
    );
    router.setMacroRecorder(state);
    router.register({
      name: "fixture.send",
      description: "Fixture tool that records the arguments it was actually given.",
      inputSchema: { type: "object", additionalProperties: true },
      async execute(params) {
        received.push(params as Record<string, unknown>);
        return { delivered: true };
      },
    });
    router.registerAll(buildMacroToolHandlers({ state, prisma, getRouter: () => router }));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  async function call(name: string, args: Record<string, unknown>, as: VerifiedToken = token) {
    const response = await router.handle(
      { jsonrpc: "2.0", id: `${name}-${Date.now()}`, method: "tools/call", params: { name, arguments: args } },
      as,
    );
    if (response.error) return { error: response.error };
    const text = (response.result as any)?.content?.[0]?.text;
    return { result: typeof text === "string" ? JSON.parse(text) : text };
  }

  let macroId: string;

  it("records a call, persists it, and the row carries the params", async () => {
    const started = await call("macros.record_start", {});
    const recordingId = started.result.recordingId;
    expect(recordingId).toBeTruthy();

    await call("fixture.send", { ...RECORDED_PARAMS });
    expect(received).toHaveLength(1);

    const stopped = await call("macros.record_stop", { recordingId, name: "deploy" });
    macroId = stopped.result.macro.id;
    expect(macroId).toBeTruthy();

    // Read the column back through a SEPARATE client path, so the assertion is
    // about what PostgreSQL holds and not about what the recorder still has in
    // memory.
    const row = await prisma.macro.findUniqueOrThrow({ where: { id: macroId }, select: { steps: true } });
    const steps = row.steps as unknown as Array<{ tool: string; params: Record<string, unknown> }>;
    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe("fixture.send");
    expect(steps[0].params).toEqual(RECORDED_PARAMS);
  });

  it("REPLAY: the tool receives the recorded params, not an empty object", async () => {
    // THE CARRIED DEFECT. A helper that answered null for `steps[i].params`
    // replayed with `{}` and still reported the step ok, so `ok: true` alone is
    // not evidence — the arguments the tool actually saw are.
    received.length = 0;
    const replayed = await call("macros.replay", { macroId, params: { release: "v9", stage: "canary" } });

    expect(replayed.result.stepCount).toBe(1);
    expect(replayed.result.results[0].ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).not.toEqual({});
    expect(received[0]).toEqual({
      to: RECORDED_PARAMS.to,
      body: "deploy v9 to canary",
      options: { retries: 2, tags: ["urgent", "release"], dryRun: false },
    });
  });

  it("REPLAY: nested and array values survive the round trip unflattened", async () => {
    // The `options` object above is the part a Json read that answers a shallow
    // value would lose while still producing a plausible-looking call.
    expect(received[0].options).toEqual({ retries: 2, tags: ["urgent", "release"], dryRun: false });
    expect(Array.isArray((received[0].options as any).tags)).toBe(true);
  });

  it("macros.get returns the persisted steps with their params", async () => {
    const fetched = await call("macros.get", { macroId });
    const steps = fetched.result.macro.steps as Array<{ tool: string; params: Record<string, unknown> }>;
    expect(steps[0].params).toEqual(RECORDED_PARAMS);
  });

  it("a macro recorded in one environment is not replayable from another", async () => {
    // The macroId is REAL here. An earlier draft passed an undefined id and
    // "passed" on a schema-validation error, which would also have passed
    // against a tool with no scoping at all.
    expect(macroId).toBeTruthy();
    received.length = 0;
    const replayed = await call("macros.replay", { macroId, params: {} }, foreignToken);
    expect(replayed.error).toBeDefined();
    expect(String(replayed.error?.message ?? "")).not.toContain("required property");
    expect(received).toHaveLength(0);
  });

  it("record_stop persists a recording that supplies NO paramSchema", async () => {
    // THE LIVE DEFECT THIS SUITE FOUND. `paramSchema` is optional, and the
    // handler used to send JavaScript `null` for it. Prisma writes that to a
    // nullable Json column as the JSON VALUE null, and
    // `Macro_paramSchema_json_root` accepts only SQL NULL or a JSON object — so
    // every recording without a schema, which is the default, died on SQLSTATE
    // 23514 and surfaced as "internal error".
    const started = await call("macros.record_start", {});
    await call("fixture.send", { to: "nobody@example.invalid" });
    const stopped = await call("macros.record_stop", {
      recordingId: started.result.recordingId,
      name: "no-schema",
    });
    expect(stopped.error, "record_stop refused a recording with no paramSchema").toBeUndefined();

    // SQL NULL, not JSON null. `jsonb_typeof` tells the two apart and the check
    // constraint is the reason it matters.
    const row: any = await prisma.$queryRawUnsafe(
      `SELECT "paramSchema" IS NULL AS sqlnull, jsonb_typeof("paramSchema") AS typ
         FROM "${schemaName}"."Macro" WHERE "id" = $1::uuid`,
      stopped.result.macro.id,
    );
    expect(row[0].sqlnull).toBe(true);
    expect(row[0].typ).toBeNull();
  });

  it("record_stop still stores a paramSchema when one IS supplied", async () => {
    // Without this, the fix above could have been "drop the field entirely".
    const started = await call("macros.record_start", {});
    await call("fixture.send", { to: "nobody@example.invalid" });
    const stopped = await call("macros.record_stop", {
      recordingId: started.result.recordingId,
      name: "with-schema",
      paramSchema: { type: "object", properties: { release: { type: "string" } } },
    });
    expect(stopped.error).toBeUndefined();
    const persisted = await prisma.macro.findUniqueOrThrow({
      where: { id: stopped.result.macro.id },
      select: { paramSchema: true },
    });
    expect(persisted.paramSchema).toEqual({
      type: "object",
      properties: { release: { type: "string" } },
    });
  });
});
