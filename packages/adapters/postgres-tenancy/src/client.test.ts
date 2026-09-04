// The datasource URL is a decision, so it is tested like one.
//
// Every case below runs without a database, because `buildDatasourceUrl` is
// pure. That is the reason it exists as a separate function rather than as four
// lines inside `createTenancyDatabaseClient`: connection limits and statement
// timeouts are the settings an incident is traced back to, and a setting that
// can only be observed by opening a pool is a setting nobody checks.

import { describe, expect, test } from "vitest";

import {
  AdapterConfigurationError,
  buildDatasourceUrl,
  DATABASE_URL_INVALID,
  FOREIGN_KEY_VIOLATION_CODE,
  isForeignKeyViolation,
  isUniqueViolation,
  POOL_SETTING_INVALID,
  UNIQUE_VIOLATION_CODE,
} from "./client.js";

const BASE = "postgresql://user:secret@db.internal:5432/platos";

describe("buildDatasourceUrl", () => {
  test("passes an unadorned URL through with no settings invented", () => {
    const built = new URL(buildDatasourceUrl(BASE));
    expect(built.searchParams.has("connection_limit")).toBe(false);
    expect(built.searchParams.has("pool_timeout")).toBe(false);
    expect(built.searchParams.has("statement_timeout")).toBe(false);
  });

  test("writes each setting it is given, with the driver's own parameter names", () => {
    const built = new URL(
      buildDatasourceUrl(BASE, {
        connectionLimit: 12,
        poolTimeoutSeconds: 9,
        statementTimeoutMs: 4000,
      }),
    );
    expect(built.searchParams.get("connection_limit")).toBe("12");
    expect(built.searchParams.get("pool_timeout")).toBe("9");
    expect(built.searchParams.get("statement_timeout")).toBe("4000");
    expect(built.pathname).toBe("/platos");
  });

  test("REPLACES a setting the caller already put on the URL rather than doubling it", () => {
    const built = new URL(
      buildDatasourceUrl(`${BASE}?connection_limit=1`, { connectionLimit: 30 }),
    );
    expect(built.searchParams.getAll("connection_limit")).toEqual(["30"]);
  });

  test("keeps unrelated parameters the caller set", () => {
    const built = new URL(buildDatasourceUrl(`${BASE}?schema=public`, { connectionLimit: 4 }));
    expect(built.searchParams.get("schema")).toBe("public");
    expect(built.searchParams.get("connection_limit")).toBe("4");
  });

  // --- the guards -----------------------------------------------------------

  test("refuses a URL that is not a URL, with database_url_invalid", () => {
    expect(() => buildDatasourceUrl("db.internal:5432/platos")).toThrowError(
      expect.objectContaining({ name: "AdapterConfigurationError", code: DATABASE_URL_INVALID }),
    );
  });

  test("refuses a non-postgresql scheme, with database_url_invalid", () => {
    expect(() => buildDatasourceUrl("mysql://user@db.internal:3306/platos")).toThrowError(
      expect.objectContaining({ code: DATABASE_URL_INVALID }),
    );
  });

  test("accepts the postgres:// spelling as well as postgresql://", () => {
    expect(buildDatasourceUrl("postgres://user@db.internal:5432/platos")).toContain("postgres://");
  });

  test.each([
    ["connectionLimit", { connectionLimit: 0 }],
    ["connectionLimit", { connectionLimit: -3 }],
    ["connectionLimit", { connectionLimit: 1.5 }],
    ["poolTimeoutSeconds", { poolTimeoutSeconds: 0 }],
    ["statementTimeoutMs", { statementTimeoutMs: -1 }],
  ])("refuses a %s that is not a positive whole number, with pool_setting_invalid", (_label, pool) => {
    expect(() => buildDatasourceUrl(BASE, pool)).toThrowError(
      expect.objectContaining({ code: POOL_SETTING_INVALID }),
    );
  });

  test("the two refusal codes are distinct, so a log can tell them apart", () => {
    expect(DATABASE_URL_INVALID).not.toBe(POOL_SETTING_INVALID);
  });

  test("AdapterConfigurationError carries its code as data, not only in the message", () => {
    const error = new AdapterConfigurationError(POOL_SETTING_INVALID, "x");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(POOL_SETTING_INVALID);
  });
});

describe("driver error classification", () => {
  test("recognises the unique-violation code and nothing else", () => {
    expect(isUniqueViolation({ code: UNIQUE_VIOLATION_CODE })).toBe(true);
    expect(isUniqueViolation({ code: FOREIGN_KEY_VIOLATION_CODE })).toBe(false);
    expect(isUniqueViolation(new Error("duplicate key value violates unique constraint"))).toBe(
      false,
    );
  });

  test("recognises the foreign-key code and nothing else", () => {
    expect(isForeignKeyViolation({ code: FOREIGN_KEY_VIOLATION_CODE })).toBe(true);
    expect(isForeignKeyViolation({ code: UNIQUE_VIOLATION_CODE })).toBe(false);
  });

  test("survives every shape that is not an object with a string code", () => {
    for (const value of [null, undefined, 7, "P2002", { code: 2002 }, []]) {
      expect(isUniqueViolation(value)).toBe(false);
      expect(isForeignKeyViolation(value)).toBe(false);
    }
  });
});
