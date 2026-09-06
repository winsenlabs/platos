// Properties of the field TABLES, judged against something the tables do not
// control.
//
// The 2026-09-02 verification's fifth finding stands over this file: an
// assertion that compares two things you both control cannot fail. Iterating the
// specs and asserting they equal themselves would pass under any mutation that
// shrank both sides. So every case below joins the tables to an INDEPENDENT
// authority — the naming convention an operator relies on, the redaction
// contract `load.ts` renders under, the group semantics `platform.ts` decides
// with, or a value chosen here and pushed through the real loader.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadPlatformConfiguration, platformFieldNames, PLATFORM_SECTIONS } from "./platform.js";
import { CORE_API_CONFIG_FIELDS, groupFields, type ConfigFieldSpec } from "./schema.js";

const MINIMAL = { PLATOS_ENVIRONMENT: "test" } as const;

function everyField(): readonly ConfigFieldSpec[] {
  return PLATFORM_SECTIONS.flatMap((section) => section.groups.flatMap((group) => groupFields(group)));
}

describe("the naming convention an operator reads the tables through", () => {
  it("prefixes every variable with PLATOS_ and its section's own word", () => {
    const prefixes: Record<string, string> = {
      stores: "PLATOS_STORE_",
      providers: "PLATOS_PROVIDERS_",
      channels: "PLATOS_CHANNELS_",
      durableRuntime: "PLATOS_DURABLE_RUNTIME_",
      security: "PLATOS_SECURITY_",
    };
    for (const section of PLATFORM_SECTIONS) {
      const prefix = prefixes[section.id];
      expect(prefix, `no prefix declared for section ${section.id}`).toBeDefined();
      for (const group of section.groups) {
        for (const field of groupFields(group)) {
          expect(field.name.startsWith(prefix ?? "")).toBe(true);
        }
      }
    }
  });

  it("spells every variable in the shape an environment accepts", () => {
    for (const field of everyField()) expect(field.name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
  });

  it("gives every field an operator-facing description that carries no value", () => {
    for (const field of everyField()) {
      expect(field.describe.length).toBeGreaterThan(10);
      expect(field.describe).not.toContain(field.name);
    }
  });
});

describe("the anchor contract platform.ts decides with", () => {
  it("never marks an anchor `required`, because absence is a legitimate answer", () => {
    // A `required` anchor would make this process refuse to boot until every
    // store, notifier and durable service is wired, which is the opposite of
    // the readiness contract app.module.ts and readiness.ts keep.
    for (const section of PLATFORM_SECTIONS) {
      for (const group of section.groups) expect(group.anchor.required).toBe(false);
    }
  });

  it("gives every anchor a null default, so presence is the only signal", () => {
    for (const section of PLATFORM_SECTIONS) {
      for (const group of section.groups) expect(group.anchor.defaultValue).toBeNull();
    }
  });

  it("gives every requiredWithAnchor field a null default, so it cannot be filled in silently", () => {
    for (const section of PLATFORM_SECTIONS) {
      for (const group of section.groups) {
        for (const field of group.requiredWithAnchor) expect(field.defaultValue).toBeNull();
      }
    }
  });

  it("gives every OPTIONAL field a default unless it is deliberately unset", () => {
    // Two optional fields are legitimately null-by-default — an install may name
    // no embedding model at all. Naming them here means a third arriving with no
    // default is a decision somebody has to write down.
    const deliberatelyUnset = new Set(["PLATOS_PROVIDERS_EMBEDDING_MODEL"]);
    for (const section of PLATFORM_SECTIONS) {
      for (const group of section.groups) {
        for (const field of group.optional) {
          if (deliberatelyUnset.has(field.name)) {
            expect(field.defaultValue).toBeNull();
            continue;
          }
          expect(field.defaultValue, `${field.name} has no default`).not.toBeNull();
        }
      }
    }
  });

  it("proves each declared default survives the real loader, not just the table", () => {
    // The join to something outside the tables: every default is pushed through
    // `loadPlatformConfiguration` with its group declared, and read back off the
    // assembled value. A default the assembler forgot to wire fails here.
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_POSTGRES_URL: "postgresql://u:p@db.internal:5432/platos",
      PLATOS_STORE_REDIS_URL: "redis://cache.internal:6379",
      PLATOS_CHANNELS_SLACK_SIGNING_SECRET: "c".repeat(32),
      PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY: "w".repeat(32),
      PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
      PLATOS_SECURITY_SESSION_SECRET: "s".repeat(32),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stores.postgres?.statementTimeoutMs).toBe(15000);
    expect(outcome.value.stores.postgres?.schema).toBe("public");
    expect(outcome.value.stores.redis?.keyPrefix).toBe("platos");
    expect(outcome.value.channels.slack?.requestMaxAgeSeconds).toBe(300);
    expect(outcome.value.channels.webhookNotifier?.timeoutMs).toBe(10000);
    expect(outcome.value.providers.modelRouter?.requestTimeoutMs).toBe(120000);
    expect(outcome.value.providers.modelRouter?.maxRetries).toBe(2);
    expect(outcome.value.security.session?.ttlSeconds).toBe(43200);
  });
});

describe("the redaction classification, joined to what the loader actually prints", () => {
  it("marks every credential-bearing field secret", () => {
    // The authority is the NAME an operator gave the thing, not a list this file
    // also owns: anything called a secret, a key or a password is one.
    const bearsCredential = /(SECRET|_KEY$|_KEY_ID$|ACCESS_KEY|PASSWORD|_URL$)/u;
    const openByDesign = new Set([
      // An endpoint is a hostname and the credentials beside it carry the risk;
      // both files say so where the field is declared.
      "PLATOS_STORE_OBJECT_ENDPOINT",
      "PLATOS_DURABLE_RUNTIME_API_URL",
    ]);
    for (const field of everyField()) {
      if (!bearsCredential.test(field.name) || openByDesign.has(field.name)) continue;
      expect(field.secret, `${field.name} is not marked secret`).toBe(true);
    }
  });

  it("proves the mark is load-bearing: a secret's rejected value never reaches the diagnostic", () => {
    const value = "not-a-valid-url-at-all";
    for (const field of everyField()) {
      if (!field.secret) continue;
      const outcome = loadPlatformConfiguration({ ...MINIMAL, [field.name]: value });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      for (const entry of outcome.diagnostics) expect(entry.shownValue).not.toBe(value);
    }
  });

  it("proves the OPPOSITE half too: a non-secret's rejected value IS echoed", () => {
    // Without this, a redactor that printed nothing at all would pass the case
    // above and be indistinguishable from one that works.
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_DURABLE_RUNTIME_API_URL: "not-a-url-either",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const echoed = outcome.diagnostics.find((entry) => entry.field === "PLATOS_DURABLE_RUNTIME_API_URL");
    expect(echoed?.shownValue).toBe("not-a-url-either");
    expect(echoed?.redacted).toBe(false);
  });
});

describe("the constraint fields are internally coherent", () => {
  it("gives every pattern a description, so a refusal is readable", () => {
    for (const field of everyField()) {
      if (field.pattern === undefined) continue;
      expect(field.patternDescribe, `${field.name} has a pattern and no description`).toBeDefined();
    }
  });

  it("declares schemes on every url field and on nothing else", () => {
    for (const field of everyField()) {
      if (field.kind === "url") expect((field.schemes ?? []).length).toBeGreaterThan(0);
      else expect(field.schemes).toBeUndefined();
    }
  });

  it("orders every integer bound the right way round", () => {
    for (const field of everyField()) {
      if (field.kind !== "integer") continue;
      expect(field.minimum).toBeDefined();
      expect(field.maximum).toBeDefined();
      expect(field.minimum ?? 0).toBeLessThan(field.maximum ?? 0);
    }
  });

  it("keeps every integer default inside its own declared bounds", () => {
    for (const field of everyField()) {
      if (field.kind !== "integer" || field.defaultValue === null) continue;
      const value = Number(field.defaultValue);
      expect(value).toBeGreaterThanOrEqual(field.minimum ?? 0);
      expect(value).toBeLessThanOrEqual(field.maximum ?? 0);
    }
  });

  it("keeps every string default long enough to satisfy its own minimum length", () => {
    for (const field of everyField()) {
      if (field.kind !== "string" || field.defaultValue === null) continue;
      expect(field.defaultValue.length).toBeGreaterThanOrEqual(field.minimumLength ?? 0);
      if (field.pattern === undefined) continue;
      expect(new RegExp(`^(?:${field.pattern})$`, "u").test(field.defaultValue)).toBe(true);
    }
  });
});

// PROSE MUST MATCH MECHANISM, and here that is checkable rather than aspirational.
//
// `docs/env-vars.md` opens by claiming to list "every environment variable
// Platos reads". For the six sections that claim is now enforced: the
// operator-facing table and the field tables are joined, in BOTH directions, so
// a variable cannot be added to the code without appearing in the document and a
// row cannot outlive the field it describes.
describe("the operator documentation and the field tables agree", () => {
  const documentation = readFileSync(
    fileURLToPath(new URL("../../../../docs/env-vars.md", import.meta.url)),
    "utf8",
  );

  /** Every `PLATOS_*` name in a table cell of the V1 section, in order. */
  function documentedNames(): readonly string[] {
    const section = documentation.split("## V1 core-api (`apps/core-api`)")[1] ?? "";
    return [...section.matchAll(/^\| `(PLATOS_[A-Z0-9_]+)` \|/gmu)].map((match) => match[1] ?? "");
  }

  it("finds the V1 section at all, so an empty match cannot pass every case below", () => {
    expect(documentation).toContain("## V1 core-api (`apps/core-api`)");
    expect(documentedNames().length).toBeGreaterThan(30);
  });

  it("documents every variable the six sections declare", () => {
    const documented = new Set(documentedNames());
    const declared = [...CORE_API_CONFIG_FIELDS.map((field) => field.name), ...platformFieldNames()];
    expect(declared.filter((name) => !documented.has(name))).toEqual([]);
  });

  it("documents nothing the six sections do not declare", () => {
    // The other direction, which is the one a document drifts in: a variable
    // removed from the code leaves a row telling operators to set something
    // nothing reads.
    const declared = new Set([...CORE_API_CONFIG_FIELDS.map((field) => field.name), ...platformFieldNames()]);
    // The stdio binary's one variable is documented in the same section and is
    // validated by `apps/mcp-stdio/src/runtime.ts`, not by these tables.
    declared.add("PLATOS_MCP_STDIO_RUNTIME_MODULE");
    expect(documentedNames().filter((name) => !declared.has(name))).toEqual([]);
  });

  it("gives every declared default the same value the document promises", () => {
    // The join that catches the drift nobody notices: a default changed in code
    // and not in the table reads as a lie to whoever is sizing a pool.
    const rows = new Map(
      [...documentation.matchAll(/^\| `(PLATOS_[A-Z0-9_]+)` \| ([^|]*)\|/gmu)].map((match) => [
        match[1] ?? "",
        (match[2] ?? "").trim(),
      ]),
    );
    for (const section of PLATFORM_SECTIONS) {
      for (const group of section.groups) {
        for (const field of groupFields(group)) {
          const documented = rows.get(field.name);
          if (documented === undefined) continue;
          if (field.defaultValue === null) {
            expect(["—", "anchor"].includes(documented), `${field.name} shows "${documented}"`).toBe(true);
            continue;
          }
          expect(documented, field.name).toBe(`\`${field.defaultValue}\``);
        }
      }
    }
  });
});
