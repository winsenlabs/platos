// The error-taxonomy gate, proven on a fixture repository.
//
// Every case is a PAIR: a tree that must fire the rule, and a tree that must
// not. A gate proven only on its failing half can still be one that rejects
// everything, and a gate proven only on the real repository proves nothing about
// what it would do to a tree that is wrong.
//
// The fixture is a whole miniature repo — a context, the runtime module, the
// kernel's ErrorCategory declaration, and a taxonomy file — because the gate's
// entire value is the JOIN across those four. A test that fed it one string
// would be testing a parser.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { CATEGORY_STATUSES, RULES, checkTaxonomy, scanSource } from "./error-taxonomy.mjs";

const KERNEL = `export type ErrorCategory =
  | "invalid_input"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  | "rate_limited"
  | "unavailable"
  | "internal";
`;

const RUNTIME = `export const CATEGORY_STATUS: Record<ErrorCategory, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};
export const STATUS_OVERRIDES: Record<string, number> = {
  DEMO_SLOW: 504,
};
`;

const ERRORS = `import { domainError } from "@platos/kernel";
export function demoMissing(id: string) {
  return domainError("DEMO_MISSING", "not_found", "gone", { details: { id } });
}
export function demoSlow(ms: number) {
  return domainError("DEMO_SLOW", "unavailable", "slow", { details: { ms } });
}
`;

const TAXONOMY = {
  codes: {
    DEMO_MISSING: { category: "not_found", status: 404, contexts: ["demo"] },
    DEMO_SLOW: { category: "unavailable", status: 504, contexts: ["demo"] },
  },
  uniformGuards: [],
};

/** Build a fixture repository and return its root. Overrides replace files. */
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "pl-taxonomy-"));
  const files = {
    "packages/kernel/src/vo/error.ts": KERNEL,
    "apps/core-api/src/transports/error-status.ts": RUNTIME,
    "packages/contexts/demo/domain/errors.ts": ERRORS,
    "docs/error-taxonomy.json": JSON.stringify(TAXONOMY, null, 2),
    ...overrides,
  };
  for (const [path, body] of Object.entries(files)) {
    if (body === null) continue;
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  return root;
}

function rulesFired(overrides = {}) {
  const root = fixture(overrides);
  try {
    return [
      ...new Set(checkTaxonomy(root).problems.map((problem) => problem.slice(0, problem.indexOf(" ")))),
    ].sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withTaxonomy(mutate) {
  const taxonomy = JSON.parse(JSON.stringify(TAXONOMY));
  mutate(taxonomy);
  return { "docs/error-taxonomy.json": JSON.stringify(taxonomy, null, 2) };
}

test("the clean fixture fires nothing", () => {
  assert.deepEqual(rulesFired(), []);
});

test("E1 — a minted code with no taxonomy entry is refused", () => {
  assert.deepEqual(
    rulesFired(withTaxonomy((taxonomy) => delete taxonomy.codes.DEMO_SLOW)),
    ["E1"],
  );
  // The negative control: the same code, mapped, fires nothing.
  assert.deepEqual(rulesFired(), []);
});

test("E2 — a taxonomy entry for a code nobody mints is refused", () => {
  assert.deepEqual(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.codes.DEMO_GHOST = { category: "internal", status: 500, contexts: ["demo"] };
      }),
    ),
    ["E2"],
  );
});

test("E3 — a category that drifted from the mint site is refused", () => {
  // The status stays 404, which `forbidden` also permits and which the runtime
  // module still resolves for the code's REAL category, so E4 and E9 are both
  // satisfied and the category drift is the only thing left to fire. A case that
  // tripped three rules at once would not show that E3 works.
  assert.ok(CATEGORY_STATUSES.forbidden.includes(404));
  assert.deepEqual(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.codes.DEMO_MISSING.category = "forbidden";
      }),
    ),
    ["E3"],
  );
});

test("E3 — one code minted with two categories is refused", () => {
  assert.ok(
    rulesFired({
      "packages/contexts/other/domain/errors.ts": `import { domainError } from "@platos/kernel";
export function alsoMissing() {
  return domainError("DEMO_MISSING", "conflict", "gone");
}
`,
    }).includes("E3"),
  );
});

test("E4 — a status the runtime module would not resolve is refused", () => {
  // 410 is a status `not_found` PERMITS, so E9 is satisfied and only the
  // disagreement with the runtime module is left. Without that, this case would
  // pass for the wrong reason.
  assert.ok(CATEGORY_STATUSES.not_found.includes(410));
  assert.deepEqual(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.codes.DEMO_MISSING.status = 410;
      }),
    ),
    ["E4"],
  );
});

test("E4 — moving the runtime CATEGORY_STATUS entry breaks the join from the other side", () => {
  assert.deepEqual(
    rulesFired({
      "apps/core-api/src/transports/error-status.ts": RUNTIME.replace("not_found: 404", "not_found: 410"),
    }),
    ["E4"],
  );
});

test("E5 — a runtime category table that does not cover the kernel union is refused", () => {
  assert.ok(
    rulesFired({
      "apps/core-api/src/transports/error-status.ts": RUNTIME.replace("  rate_limited: 429,\n", ""),
    }).includes("E5"),
  );
  assert.ok(
    rulesFired({
      "packages/kernel/src/vo/error.ts": `${KERNEL.replace(
        '  | "internal";',
        '  | "internal"\n  | "teapot";',
      )}`,
    }).includes("E5"),
  );
});

test("E5 — a category status outside the permitted set is refused", () => {
  assert.ok(
    rulesFired({
      "apps/core-api/src/transports/error-status.ts": RUNTIME.replace("forbidden: 403", "forbidden: 500"),
    }).includes("E5"),
  );
});

test("E6 — two identical raises in one function are refused unless registered", () => {
  const twice = `import { domainError } from "@platos/kernel";
export function demoMissing(id: string) {
  return domainError("DEMO_MISSING", "not_found", "gone", { details: { id } });
}
export function demoSlow(ms: number) {
  return domainError("DEMO_SLOW", "unavailable", "slow", { details: { ms } });
}
export function lookUp(row: string | null, allowed: boolean) {
  if (row === null) return demoMissing("x");
  if (!allowed) return demoMissing("x");
  return row;
}
`;
  assert.deepEqual(rulesFired({ "packages/contexts/demo/domain/errors.ts": twice }), ["E6"]);

  // Registered with a reason: admitted. This is the half that keeps the rule
  // from being "never repeat", which the tree could not satisfy and which would
  // force the security-required uniformity in identity-access to be rewritten.
  assert.deepEqual(
    rulesFired({
      "packages/contexts/demo/domain/errors.ts": twice,
      ...withTaxonomy((taxonomy) => {
        taxonomy.uniformGuards.push({
          file: "packages/contexts/demo/domain/errors.ts",
          function: "lookUp",
          code: "DEMO_MISSING",
          sites: 2,
          shapes: 1,
          reason: "absent and forbidden must answer identically",
        });
      }),
    }),
    [],
  );
});

test("E6 — two raises that DIFFER in their arguments are not uniform and need no allowance", () => {
  // The rule is not "never repeat a code": it is "never repeat it in a way
  // nothing can tell apart". This is the negative control that keeps the gate
  // from demanding an allowance for every validator in the tree.
  const distinguished = `import { domainError } from "@platos/kernel";
export function demoMissing(id: string) {
  return domainError("DEMO_MISSING", "not_found", "gone", { details: { id } });
}
export function demoSlow(ms: number) {
  return domainError("DEMO_SLOW", "unavailable", "slow", { details: { ms } });
}
export function lookUp(row: string | null, allowed: boolean) {
  if (row === null) return demoMissing("absent");
  if (!allowed) return demoMissing("forbidden");
  return row;
}
`;
  assert.deepEqual(rulesFired({ "packages/contexts/demo/domain/errors.ts": distinguished }), []);
});

test("E6 — a registered allowance whose site count moved is refused", () => {
  const thrice = `import { domainError } from "@platos/kernel";
export function demoMissing(id: string) {
  return domainError("DEMO_MISSING", "not_found", "gone", { details: { id } });
}
export function demoSlow(ms: number) {
  return domainError("DEMO_SLOW", "unavailable", "slow", { details: { ms } });
}
export function lookUp(row: string | null, allowed: boolean, fresh: boolean) {
  if (row === null) return demoMissing("x");
  if (!allowed) return demoMissing("x");
  if (!fresh) return demoMissing("x");
  return row;
}
`;
  assert.deepEqual(
    rulesFired({
      "packages/contexts/demo/domain/errors.ts": thrice,
      ...withTaxonomy((taxonomy) => {
        taxonomy.uniformGuards.push({
          file: "packages/contexts/demo/domain/errors.ts",
          function: "lookUp",
          code: "DEMO_MISSING",
          sites: 2,
          shapes: 1,
          reason: "two of them",
        });
      }),
    }),
    ["E6"],
  );
});

test("E6 — a registered allowance with an empty reason is refused", () => {
  const twice = `import { domainError } from "@platos/kernel";
export function demoMissing(id: string) {
  return domainError("DEMO_MISSING", "not_found", "gone", { details: { id } });
}
export function demoSlow(ms: number) {
  return domainError("DEMO_SLOW", "unavailable", "slow", { details: { ms } });
}
export function lookUp(row: string | null, allowed: boolean) {
  if (row === null) return demoMissing("x");
  if (!allowed) return demoMissing("x");
  return row;
}
`;
  assert.deepEqual(
    rulesFired({
      "packages/contexts/demo/domain/errors.ts": twice,
      ...withTaxonomy((taxonomy) => {
        taxonomy.uniformGuards.push({
          file: "packages/contexts/demo/domain/errors.ts",
          function: "lookUp",
          code: "DEMO_MISSING",
          sites: 2,
          shapes: 1,
          reason: "",
        });
      }),
    }),
    ["E6"],
  );
});

test("E7 — an allowance for a guard that no longer exists is refused", () => {
  assert.deepEqual(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.uniformGuards.push({
          file: "packages/contexts/demo/domain/errors.ts",
          function: "goneAway",
          code: "DEMO_MISSING",
          sites: 2,
          shapes: 1,
          reason: "was once required",
        });
      }),
    ),
    ["E7"],
  );
});

test("E8 — a status override for a code nobody mints is refused", () => {
  assert.deepEqual(
    rulesFired({
      "apps/core-api/src/transports/error-status.ts": RUNTIME.replace(
        "  DEMO_SLOW: 504,",
        "  DEMO_SLOW: 504,\n  DEMO_VANISHED: 410,",
      ),
    }),
    ["E8"],
  );
});

test("E9 — a code with no status at all is refused", () => {
  assert.deepEqual(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.codes.DEMO_SLOW.status = null;
      }),
    ),
    ["E9"],
  );
});

test("E9 — a status the category does not permit is refused", () => {
  assert.ok(!CATEGORY_STATUSES.not_found.includes(418));
  assert.ok(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.codes.DEMO_MISSING.status = 418;
      }),
    ).includes("E9"),
  );
});

test("E10 — a code that moved context without the taxonomy noticing is refused", () => {
  assert.deepEqual(
    rulesFired(
      withTaxonomy((taxonomy) => {
        taxonomy.codes.DEMO_MISSING.contexts = ["elsewhere"];
      }),
    ),
    ["E10"],
  );
});

test("tests and hand-written doubles are not held to the taxonomy", () => {
  // `tools`' in-memory peer mints UNAUTHENTICATED to stand in for a context it
  // must not import. Registering codes that no transport will ever answer with
  // would make the taxonomy a list of things that are not on the wire.
  assert.deepEqual(
    rulesFired({
      "packages/contexts/demo/domain/errors.test.ts": `import { domainError } from "@platos/kernel";
export const probe = () => domainError("DEMO_ONLY_IN_A_TEST", "internal", "x");
`,
      "packages/contexts/demo/application/testing/doubles.ts": `import { domainError } from "@platos/kernel";
export const stub = () => domainError("DEMO_ONLY_IN_A_DOUBLE", "internal", "x");
`,
    }),
    [],
  );
});

test("the rule list and the fixture agree on which rules exist", () => {
  // A rule added to RULES with no case here, or a case firing an id RULES does
  // not declare, is itself a finding.
  const declared = RULES.map((rule) => rule.id).sort();
  assert.deepEqual(declared, ["E1", "E10", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]);
});

test("the real repository's scan finds codes in every context that declares them", () => {
  // Anchors the scan against the tree rather than the fixture: a scanner that
  // silently matched nothing would still pass every case above, because an empty
  // inventory satisfies E1 and E6 vacuously.
  const { inventory } = scanSource();
  assert.ok(inventory.length > 300, `expected 300+ canonical codes, found ${inventory.length}`);
  const contexts = new Set(inventory.flatMap((row) => row.contexts));
  assert.ok(contexts.size >= 17, `expected all 17 contexts to mint codes, found ${contexts.size}`);
  for (const row of inventory) {
    assert.equal(row.categories.length, 1, `${row.code} carries ${row.categories.length} categories`);
  }
});
