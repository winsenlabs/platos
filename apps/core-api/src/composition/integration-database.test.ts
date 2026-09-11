// THE URL TRANSLATION'S OWN CASES.
//
// Joined to the REAL canonical url rather than to a string invented here: the
// first case reads `.github/workflows/ci.yml` and takes the value CI actually
// sets, so the case that mattered — `?schema=public`, the parameter that made
// `psql` refuse — cannot stop being tested by someone editing a fixture.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PRISMA_ONLY_URL_PARAMETERS,
  psqlConnectionUrl,
  psqlRows,
} from "./integration-database.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("psqlConnectionUrl", () => {
  it("strips the Prisma-only parameter the repository's OWN ci.yml sets", () => {
    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const match = /PLATOS_POSTGRES_INTEGRATION_DATABASE_URL:\s*(postgresql:\S+)/.exec(workflow);
    expect(match, "ci.yml no longer sets a Prisma integration url").not.toBeNull();
    const canonical = match?.[1] ?? "";
    expect(canonical).not.toBe("");
    // The precondition this whole helper exists for. If ci.yml ever stops
    // carrying it, this expectation says so rather than the suite quietly
    // testing nothing.
    expect(canonical).toContain("?schema=public");

    const translated = psqlConnectionUrl(canonical);
    expect(translated).not.toContain("schema=public");
    expect(translated).not.toContain("?");
    // Everything that identifies the server is carried through untouched.
    const before = new URL(canonical);
    const after = new URL(translated);
    expect(after.protocol).toBe(before.protocol);
    expect(after.username).toBe(before.username);
    expect(after.password).toBe(before.password);
    expect(after.host).toBe(before.host);
    expect(after.pathname).toBe(before.pathname);
  });

  it("removes every Prisma-only parameter it declares", () => {
    for (const parameter of PRISMA_ONLY_URL_PARAMETERS) {
      const url = `postgresql://u:p@127.0.0.1:5432/db?${parameter}=x`;
      expect(psqlConnectionUrl(url), parameter).toBe("postgresql://u:p@127.0.0.1:5432/db");
    }
  });

  it("LEAVES real libpq parameters alone, because dropping them changes the connection", () => {
    const url = "postgresql://u:p@127.0.0.1:5432/db?sslmode=require&application_name=platos";
    expect(psqlConnectionUrl(url)).toBe(url);
  });

  it("keeps libpq parameters while removing Prisma ones from the same query string", () => {
    const translated = psqlConnectionUrl(
      "postgresql://u:p@127.0.0.1:5432/db?sslmode=require&schema=public&connection_limit=5",
    );
    const after = new URL(translated);
    expect(after.searchParams.get("sslmode")).toBe("require");
    expect(after.searchParams.has("schema")).toBe(false);
    expect(after.searchParams.has("connection_limit")).toBe(false);
  });

  it("returns a url with nothing to strip UNCHANGED, byte for byte", () => {
    const url = "postgresql://u:p@127.0.0.1:5432/db";
    expect(psqlConnectionUrl(url)).toBe(url);
  });

  it("returns what it cannot parse unchanged rather than repairing it", () => {
    // `psql` accepts a bare database name and a key=value conninfo string, and a
    // helper that threw here would break a working invocation.
    expect(psqlConnectionUrl("platos_dev")).toBe("platos_dev");
    expect(psqlConnectionUrl("host=127.0.0.1 dbname=platos")).toBe("host=127.0.0.1 dbname=platos");
    expect(psqlConnectionUrl("")).toBe("");
  });

  it("does not touch a url for a different server family", () => {
    const url = "mysql://u:p@127.0.0.1:3306/db?schema=public";
    expect(psqlConnectionUrl(url)).toBe(url);
  });
});

describe("psqlRows", () => {
  it("drops the trailing blank line `psql -t` emits and trims each row", () => {
    expect(psqlRows("a|1\n b|2 \n\n")).toEqual(["a|1", "b|2"]);
    expect(psqlRows("")).toEqual([]);
    expect(psqlRows("\n\n")).toEqual([]);
  });
});
