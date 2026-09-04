import { asIdentifier, type OrganizationId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  ALIAS_DIGEST_NAMESPACE,
  CANONICAL_ALIAS_CHANNEL,
  DIGEST_SEPARATOR,
  aliasDigestInput,
  canonicalAlias,
  normalizeAlias,
  normalizeAliases,
  rawHandles,
  subjectAlias,
  subjectDigestInput,
} from "./alias.js";

const ORGANIZATION: OrganizationId = asIdentifier("org-1");
const OTHER_ORGANIZATION: OrganizationId = asIdentifier("org-2");

describe("normalizeAlias", () => {
  it("folds case so a handle cannot come back with different capitals", () => {
    expect(normalizeAlias(subjectAlias("Email", "Alice@Example.com"))).toEqual({
      channel: "email",
      subject: "alice@example.com",
    });
  });

  it("trims, so a stray space cannot mint a second identity for one person", () => {
    expect(normalizeAlias(subjectAlias("  slack ", " U08JTN5FX39 "))).toEqual({
      channel: "slack",
      subject: "u08jtn5fx39",
    });
  });

  it("REJECTS a blank subject, which would otherwise seal every blank-handle person", () => {
    expect(normalizeAlias(subjectAlias("email", "   "))).toBeNull();
  });

  it("rejects a blank channel for the same reason", () => {
    expect(normalizeAlias(subjectAlias("", "alice@example.com"))).toBeNull();
  });
});

describe("the digest separator", () => {
  it("is NUL, which cannot occur inside a handle", () => {
    expect(DIGEST_SEPARATOR).toHaveLength(1);
    expect(DIGEST_SEPARATOR.charCodeAt(0)).toBe(0);
  });

  it("keeps ('ab','c') and ('a','bc') apart", () => {
    const left = aliasDigestInput(subjectAlias("ab", "c"), ORGANIZATION);
    const right = aliasDigestInput(subjectAlias("a", "bc"), ORGANIZATION);
    expect(left).not.toBe(right);
  });
});

describe("aliasDigestInput", () => {
  it("composes organization, namespace, channel and subject in that order", () => {
    expect(aliasDigestInput(subjectAlias("email", "a@b.c"), ORGANIZATION)).toBe(
      ["org-1", ALIAS_DIGEST_NAMESPACE, "email", "a@b.c"].join(DIGEST_SEPARATOR),
    );
  });

  it("scopes by organization, so one person in two tenants is not correlatable", () => {
    const alias = subjectAlias("email", "a@b.c");
    expect(aliasDigestInput(alias, ORGANIZATION)).not.toBe(aliasDigestInput(alias, OTHER_ORGANIZATION));
  });

  it("namespaces by channel, so an erased email does not refuse the same external id", () => {
    expect(aliasDigestInput(subjectAlias("email", "x"), ORGANIZATION)).not.toBe(
      aliasDigestInput(subjectAlias("external", "x"), ORGANIZATION),
    );
  });
});

describe("subjectDigestInput", () => {
  it("is organization then handle, with no namespace segment", () => {
    expect(subjectDigestInput("walle-1", ORGANIZATION)).toBe(["org-1", "walle-1"].join(DIGEST_SEPARATOR));
  });

  it("does not collide with the alias composition for the same handle", () => {
    expect(subjectDigestInput("walle-1", ORGANIZATION)).not.toBe(
      aliasDigestInput(subjectAlias("external", "walle-1"), ORGANIZATION),
    );
  });
});

describe("normalizeAliases", () => {
  it("de-duplicates aliases that differ only by case or padding", () => {
    const aliases = normalizeAliases([
      subjectAlias("email", "A@B.c"),
      subjectAlias("email", " a@b.C "),
      subjectAlias("EMAIL", "a@b.c"),
    ]);
    expect(aliases).toEqual([{ channel: "email", subject: "a@b.c" }]);
  });

  it("orders stably, so two passes over one person produce identical sets", () => {
    const forward = normalizeAliases([
      subjectAlias("slack", "u1"),
      subjectAlias("email", "a@b.c"),
      canonicalAlias("eu-1"),
    ]);
    const reversed = normalizeAliases([
      canonicalAlias("eu-1"),
      subjectAlias("email", "a@b.c"),
      subjectAlias("slack", "u1"),
    ]);
    expect(forward).toEqual(reversed);
  });

  it("drops the aliases that normalize away rather than digesting a blank", () => {
    expect(normalizeAliases([subjectAlias("email", ""), subjectAlias("", "x")])).toEqual([]);
  });
});

describe("canonicalAlias", () => {
  it("uses the synthetic channel, so a captured row id is checkable too", () => {
    expect(canonicalAlias("eu-1")).toEqual({ channel: CANONICAL_ALIAS_CHANNEL, subject: "eu-1" });
  });
});

describe("rawHandles", () => {
  it("yields the normalized subjects, which is what a hold register is matched on", () => {
    expect(rawHandles([subjectAlias("email", "A@B.c"), subjectAlias("slack", "U1")])).toEqual([
      "a@b.c",
      "u1",
    ]);
  });
});
