// The refusal parser, against the THREE shapes a refusal actually arrives in.
//
// Every fixture below is a real error object copied off a PostgreSQL container,
// not a shape somebody imagined, and the three are genuinely different:
//
//   a delegate call the client KNOWS about — `code` is `P2002`/`P2003` and
//     `meta.target` is the COLUMN LIST, not the index name;
//   a delegate call it does not — `code` is undefined and the driver's own
//     `PostgresError { code: "23514", message: "…" }` is inside the message
//     text, which is how EVERY rule the migrations install arrives;
//   a raw statement — `code` is `P2010` and `meta` carries `{ code, message }`.
//
// THE THIRD SHAPE IS THE ONE A SWEEP CAUGHT. Its two branches survived the first
// mutation run, because no path through the adapter happens to map a REFUSAL
// from a raw statement today — every refusable write is a delegate call. A guard
// nothing can turn red is a guard that is not there, so the branches are
// falsified here, where the shape can be presented directly.

import { describe, expect, test } from "vitest";

import {
  CANARY_PERCENT_OUT_OF_RANGE,
  CHECK_VIOLATION,
  checkRefusal,
  CROSSES_OWNER_ANCESTRY,
  FOREIGN_KEY_VIOLATION,
  looksLikeUuid,
  namesConstraint,
  OWNER_KEY_IMMUTABLE,
  raisedMessageOf,
  sqlstateOf,
  UNIQUE_VIOLATION,
} from "./agents-guards.js";

/** A delegate unique violation, as the client reports one. */
const uniqueViolation = {
  name: "PrismaClientKnownRequestError",
  code: "P2002",
  meta: { modelName: "Agent", target: ["projectId", "slug"] },
  message: "Invalid `db.agent.create()` invocation … Unique constraint failed on the fields: (`projectId`,`slug`)",
};

/** A delegate call refused by a plpgsql rule the client has no code for. */
const ancestryViolation = {
  name: "PrismaClientUnknownRequestError",
  code: undefined,
  meta: undefined,
  message:
    'Invalid `db.agentBinding.create()` invocation … Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "AgentBinding crosses its canonical owner ancestry", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
};

const immutableOwner = {
  name: "PrismaClientUnknownRequestError",
  message:
    'Invalid `db.agent.update()` invocation … ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "Agent ownership/authorization key projectId is immutable", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
};

const canaryOutOfRange = {
  name: "PrismaClientUnknownRequestError",
  message:
    'Invalid `db.agentBinding.create()` invocation … QueryError(PostgresError { code: "23514", message: "new row for relation \\"AgentBinding\\" violates check constraint \\"AgentBinding_canaryPercent_check\\"", severity: "ERROR" })',
};

/** A RAW statement, which arrives in a third shape entirely. */
const rawAncestry = {
  name: "PrismaClientKnownRequestError",
  code: "P2010",
  meta: { code: "23514", message: "ERROR: AgentSkill crosses its canonical owner ancestry" },
  message:
    "Invalid `prisma.$executeRawUnsafe()` invocation: Raw query failed. Code: `23514`. Message: `ERROR: AgentSkill crosses its canonical owner ancestry`",
};

const rawForeignKey = {
  name: "PrismaClientKnownRequestError",
  code: "P2010",
  meta: {
    code: "23503",
    message:
      'update or delete on table "AgentVersion" violates foreign key constraint "AgentBinding_activeAgentVersionId_fkey" on table "AgentBinding"',
  },
  message: "Invalid `prisma.$executeRawUnsafe()` invocation: Raw query failed. Code: `23503`.",
};

describe("sqlstateOf", () => {
  test("reads the client's own codes", () => {
    expect(sqlstateOf(uniqueViolation)).toBe(UNIQUE_VIOLATION);
    expect(sqlstateOf({ code: "P2003" })).toBe(FOREIGN_KEY_VIOLATION);
  });

  test("reads the driver's code out of an UNKNOWN request error's text", () => {
    expect(sqlstateOf(ancestryViolation)).toBe(CHECK_VIOLATION);
  });

  test("reads the code a RAW statement carries in meta", () => {
    expect(sqlstateOf(rawAncestry)).toBe(CHECK_VIOLATION);
    expect(sqlstateOf(rawForeignKey)).toBe(FOREIGN_KEY_VIOLATION);
  });

  test("answers null for anything it does not recognise, rather than guessing", () => {
    expect(sqlstateOf(new Error("connection reset"))).toBeNull();
    expect(sqlstateOf(null)).toBeNull();
    expect(sqlstateOf("not an error")).toBeNull();
  });
});

describe("raisedMessageOf", () => {
  test("reads the message a rule raised, from the text", () => {
    expect(raisedMessageOf(ancestryViolation)).toBe("AgentBinding crosses its canonical owner ancestry");
  });

  test("reads the message a RAW statement carries in meta", () => {
    expect(raisedMessageOf(rawAncestry)).toBe("ERROR: AgentSkill crosses its canonical owner ancestry");
  });

  test("answers the empty string when nothing raised", () => {
    expect(raisedMessageOf(uniqueViolation)).toBe("");
  });
});

describe("namesConstraint", () => {
  test("matches the COLUMN LIST a known unique violation reports", () => {
    expect(namesConstraint(uniqueViolation, "projectId,slug")).toBe(true);
    expect(namesConstraint(uniqueViolation, "environmentId,slug")).toBe(false);
  });

  test("matches a constraint named anywhere in the text", () => {
    expect(namesConstraint(canaryOutOfRange, "AgentBinding_canaryPercent_check")).toBe(true);
  });

  test("matches a constraint named in a RAW statement's meta message", () => {
    expect(namesConstraint(rawForeignKey, "AgentBinding_activeAgentVersionId_fkey")).toBe(true);
  });
});

describe("checkRefusal", () => {
  test("tells the three refusals that share SQLSTATE 23514 apart", () => {
    expect(checkRefusal(ancestryViolation)).toBe(CROSSES_OWNER_ANCESTRY);
    expect(checkRefusal(immutableOwner)).toBe(OWNER_KEY_IMMUTABLE);
    expect(checkRefusal(canaryOutOfRange)).toBe(CANARY_PERCENT_OUT_OF_RANGE);
  });

  test("answers null for a check it has not been taught", () => {
    expect(
      checkRefusal({
        message:
          'QueryError(PostgresError { code: "23514", message: "new row for relation \\"Macro\\" violates check constraint \\"Macro_steps_json_root\\"" })',
      }),
    ).toBeNull();
  });
});

describe("looksLikeUuid", () => {
  test("accepts a uuid the schema could hold", () => {
    expect(looksLikeUuid("aa000000-0000-4000-8000-000000000001")).toBe(true);
    expect(looksLikeUuid("AA000000-0000-4000-8000-00000000000F")).toBe(true);
  });

  test("REFUSES anything a uuid column would fail the whole read over", () => {
    expect(looksLikeUuid("not-an-identifier")).toBe(false);
    expect(looksLikeUuid("")).toBe(false);
    expect(looksLikeUuid("aa000000-0000-4000-8000-00000000000")).toBe(false);
    expect(looksLikeUuid("aa000000-0000-4000-8000-000000000001x")).toBe(false);
  });
});
