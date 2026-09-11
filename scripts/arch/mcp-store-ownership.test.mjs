// The register's own tests.
//
// EVERY ASSERTION BELOW JOINS TO SOMETHING THIS FILE DOES NOT CONTROL — the
// Prisma schema, `table-ownership.mjs`, the composition root, a context's
// published contract, or a named line of the tree. An assertion comparing the
// script's output to a number typed here would pass for any script.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OWNER } from "./table-ownership.mjs";
import {
  CLIENT_OPERATIONS,
  DELEGATE_OPERATIONS,
  DISPOSITIONS,
  MANIFEST,
  SURFACE_ROOTS,
  buildRegister,
  composedContexts,
  contextKey,
  contractInterfaceName,
  contractMethods,
  delegateFor,
  schemaModels,
} from "./mcp-store-ownership.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const register = buildRegister();

test("the delegate names come from the canonical schema, not from a list here", () => {
  const models = schemaModels();
  // Joined to the schema: these are models the file must have parsed.
  assert.ok(models.includes("McpToken"), "McpToken is a model in the canonical schema");
  assert.ok(models.includes("OrganizationMcpPolicy"));
  assert.ok(models.length > 50, `expected a large schema, parsed ${String(models.length)}`);
  // THE JOIN THAT MATTERS: the two artifacts cover the same rows. Every model
  // the schema declares has an owner, which is what lets the register classify a
  // site by row rather than by the directory it happens to sit in.
  const unowned = models.filter((model) => OWNER[model] === undefined);
  assert.deepEqual(unowned, [], "every canonical model must have an owner");
  assert.equal(delegateFor("McpToken"), "mcpToken");
  assert.equal(delegateFor("EndUserIdentity"), "endUserIdentity");
});

test("the register is not vacuous and covers more than one root", () => {
  assert.ok(register.totals.sites > 0, "the MCP surface holds ORM sites");
  assert.ok(register.totals.delegateSites > 0);
  assert.ok(register.totals.clientSites > 0, "client-level reaches are counted too");
  assert.ok(SURFACE_ROOTS.length >= 4);
  assert.ok(
    SURFACE_ROOTS.includes("apps/core-api/src/transports/mcp"),
    "the DESTINATION is scanned, so a moved module carrying a client is caught",
  );
});

test("transaction-scoped delegate calls are counted — the ones a `prisma.` grep misses", () => {
  // THE MEASUREMENT CORRECTION, PINNED. `this.prisma.$transaction(async (tx) =>
  // ... tx.mcpBearerToken.create(...))` is an ORM write, and a scan keyed on the
  // identifier `prisma` reports it as absent. If this ever drops to zero, either
  // the tree genuinely has no transaction-scoped writes left or the scanner has
  // stopped seeing them, and the count below says which.
  const viaTransaction = register.sites.filter(
    (site) => site.shape === "delegate" && site.receiver === "tx",
  );
  assert.ok(
    viaTransaction.length > 0,
    "expected transaction-scoped delegate calls on the MCP surface",
  );
  const direct = register.sites.filter(
    (site) => site.shape === "delegate" && site.receiver !== "tx",
  );
  assert.equal(direct.length + viaTransaction.length, register.totals.delegateSites);
});

test("the model join is what makes a match a store call, and it refuses three real near-misses", () => {
  // Three lines in the tree are `<x>.<y>.<delegate-operation>(` and none of them
  // is a store reach. `delete` and `upsert` ARE delegate operations; `byToken`,
  // `sseSessionAborts` and `toolAclService` are not schema models. A scanner that
  // dropped the schema join would report all three.
  const nearMisses = [
    ["apps/agent/src/mcp-platform/tools/macros.ts", "this.byToken.delete("],
    ["apps/agent/src/mcp-platform/mcp-platform.controller.ts", "this.sseSessionAborts.delete("],
    ["apps/agent/src/mcp-platform/mcp-entity.controller.ts", "this.toolAclService.upsert("],
  ];
  for (const [file, text] of nearMisses) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.ok(source.includes(text), `${file} still contains ${text} — the near-miss is real`);
  }
  const receivers = new Set(register.sites.map((site) => site.receiver));
  for (const receiver of ["this.byToken", "this.sseSessionAborts", "this.toolAclService"]) {
    assert.ok(!receivers.has(receiver), `${receiver} must not be counted as a store reach`);
  }
});

test("every site's owner is the one table-ownership.mjs assigns the row", () => {
  for (const site of register.sites) {
    if (site.shape !== "delegate") continue;
    assert.equal(site.owner, OWNER[site.model], `${site.file}:${String(site.line)}`);
  }
});

test("the composed set is read off the composition root and identity-access is in it", () => {
  const composed = composedContexts();
  assert.ok(composed.length > 0);
  assert.ok(composed.includes("identityAccess"), "M4.1 composed identity-access");
  assert.ok(composed.includes("tenancy"));
  // NOT EVERYTHING. If this ever becomes seventeen the register's whole
  // `blockedOnContext` verdict is empty, which is the outcome it exists to
  // measure the distance to.
  assert.ok(composed.length < 17, "the register is only interesting while some context is uncomposed");
  assert.equal(contextKey("cost-monitoring"), "costMonitoring");
  assert.equal(contractInterfaceName("identity-access"), "IdentityAccessContract");
});

/**
 * The body of one exported interface, by brace matching.
 *
 * `contractMethods` reads METHOD signatures and the case below needs the fields of
 * a VIEW, which is why this exists rather than being asked of the register. It is
 * still a join to a file this test does not control, and it is non-vacuous by
 * construction: the case asserts the fields the view DOES publish as well as the
 * two it does not, so an extraction that found the wrong block fails.
 */
function interfaceBody(directory, name) {
  const source = readFileSync(`${root}packages/contexts/${directory}/contracts/index.ts`, "utf8");
  const start = source.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `${name} is declared in ${directory}'s contract`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

test("contract methods are read from the contract file, and WIN-268's four routes have theirs", () => {
  const methods = contractMethods("identity-access");
  assert.ok(methods.includes("mintBearerCredential"), "the mint routes reach this method");
  assert.ok(methods.includes("authenticateBearer"));
  // THE FINDING THIS CASE USED TO PIN IS CLOSED, and it is replaced rather than
  // deleted. It asserted `!methods.includes("listBearerCredentials")` — "listing is
  // NOT published — that is the finding" — which was true while the four MCP token
  // lifecycle operations had an `apps/agent` implementation and none in
  // `apps/core-api`. WIN-268 (M4.2) published both and served all four, so the
  // assertion inverts. Left as it was it would have gone red on the tranche that
  // fixed it, which is the correct behaviour for a pin and the reason to revisit it
  // here rather than relax it.
  assert.ok(methods.includes("listBearerCredentials"), "GET /mcp/**/tokens reaches this method");
  assert.ok(methods.includes("revokeBearerCredential"), "the two revocations reach this method");

  // AND THE GAP THAT IS STILL OPEN, PINNED IN ITS PLACE. Both token services keep
  // their `identity-access` sites because `authenticateBearer`'s published view
  // drops two fields their verify paths return: the MCP PERMISSION tier, which
  // `apps/agent/src/mcp-platform/mcp-router.ts` branches on
  // (`token.tier !== "admin"`), and the credential's SUBJECT, which
  // `identity-resolver.service.ts` exists to resolve. Both dispositions say so; this
  // is the join that stops either sentence going stale.
  const view = interfaceBody("identity-access", "PrincipalAuthorizationView");
  assert.ok(view.includes("principalId"), "the view does publish the principal");
  assert.ok(view.includes("permissions"), "and the permission list");
  assert.ok(!view.includes("permissionTier"), "the MCP permission tier is NOT on the view");
  assert.ok(!view.includes("subjectId"), "and neither is the credential's subject");

  // The largest uncomposed owner publishes the very methods its MCP sites need.
  const tools = contractMethods("tools");
  for (const name of ["resolvePermission", "listOrganizationPolicies", "listEntityToolPolicies"]) {
    assert.ok(tools.includes(name), `ToolsContract publishes ${name}`);
  }
});

test("every file with a site carries a disposition, and every disposition has a file", () => {
  const files = [...new Set(register.sites.map((site) => site.file))];
  for (const file of files) {
    const disposition = DISPOSITIONS[file];
    assert.ok(disposition, `${file} needs a disposition`);
    assert.ok(disposition.contexts.length > 0);
    assert.ok(disposition.note.length > 80, `${file}'s disposition must say something specific`);
    assert.ok(
      ["context-composition", "contract-method", "outbox-adapter", "transport-move"].includes(
        disposition.waitingOn,
      ),
      `${file} has an unknown waitingOn`,
    );
  }
  for (const file of Object.keys(DISPOSITIONS)) {
    assert.ok(files.includes(file), `${file} has a disposition and no site`);
  }
});

test("a disposition naming a context must name one the register actually found there", () => {
  const owners = new Map();
  for (const site of register.sites) {
    const key = site.owner ?? "<client-level>";
    if (!owners.has(site.file)) owners.set(site.file, new Set());
    owners.get(site.file).add(key);
  }
  for (const [file, disposition] of Object.entries(DISPOSITIONS)) {
    const found = owners.get(file);
    assert.deepEqual(
      [...disposition.contexts].sort(),
      [...found].sort(),
      `${file}'s disposition must name exactly the contexts its sites belong to`,
    );
  }
});

test("MOVABLE is minted from the contract, never from the disposition's word", () => {
  // THE VERDICT THAT COULD BE ASSERTED INTO EXISTENCE, so this is the case that
  // stops it. `movable` means "the owner is composed AND its published contract
  // names this file's use case", and the second half is a claim a human typed —
  // the exact shape this programme keeps finding, where a gate compares two things
  // one tranche controls. Every name in every `methods` column is joined to the
  // contract read by AST from the owning context's own `contracts/index.ts`.
  const withMethods = Object.entries(DISPOSITIONS).filter(
    ([, disposition]) => disposition.methods !== undefined,
  );
  // NOT VACUOUS. A register in which no disposition named a method would pass the
  // loop below and prove nothing.
  assert.ok(withMethods.length >= 8, `at least eight dispositions must name methods, found ${withMethods.length}`);

  const composed = new Set(composedContexts(root));
  for (const [file, disposition] of withMethods) {
    for (const [owner, methods] of Object.entries(disposition.methods)) {
      assert.ok(
        disposition.contexts.includes(owner),
        `${file} names methods for ${owner}, which is not one of its owners`,
      );
      // AN UNCOMPOSED OWNER CANNOT MAKE A SITE MOVABLE, whatever its contract
      // publishes: nothing in `apps/core-api` can reach a context the root does not
      // build. A `methods` column on one would be a verdict about an unreachable
      // call.
      assert.ok(
        composed.has(contextKey(owner)),
        `${file} names methods for ${owner}, which composeApplication does not compose`,
      );
      assert.ok(methods.length > 0, `${file}'s ${owner} entry must name at least one method`);
      const published = contractMethods(owner, root) ?? [];
      for (const method of methods) {
        assert.ok(
          published.includes(method),
          `${file} claims ${owner}.${method}, which ${owner}'s contract does not publish`,
        );
      }
    }
  }

  // AND EVERY MOVABLE SITE TRACES BACK TO ONE OF THOSE COLUMNS, in the other
  // direction, so a verdict cannot appear from anywhere else.
  for (const site of register.sites.filter((candidate) => candidate.verdict === "movable")) {
    const named = DISPOSITIONS[site.file]?.methods?.[site.owner] ?? [];
    assert.ok(
      named.length > 0,
      `${site.file}:${site.line} is MOVABLE and its disposition names no ${site.owner} method`,
    );
  }
  assert.ok(register.byVerdict.movable > 0, "the register must find movable sites or the verdict is dead");
});

test("moved stays ZERO, because a moved site would be a boundary violation", () => {
  // `moved` IS A TRAP DETECTOR AND THIS IS THE ASSERTION THAT SAYS SO. A site is
  // `moved` when it sits inside `apps/core-api/src/transports/`, and
  // `transport-reaches-no-store` (ADR M0.3 §5.1 rule (k2)) forbids an ORM reach
  // there by ANY route — so a nonzero count here is not progress, it is the rule
  // this register's destination scan root exists to catch.
  //
  // IT IS NOT A TAUTOLOGY: the destination IS scanned. `SURFACE_ROOTS` names
  // `apps/core-api/src/transports/mcp`, files under it are read, and the four
  // routes already served from there hold no ORM site — which is why they are
  // absent from this register rather than counted in it.
  assert.equal(register.byVerdict.moved ?? 0, 0);
  assert.ok(SURFACE_ROOTS.includes("apps/core-api/src/transports/mcp"));
  assert.equal(
    register.sites.filter((site) => site.file.startsWith("apps/core-api/src/transports/")).length,
    0,
  );
});

test("the operation sets are closed and disjoint", () => {
  for (const operation of DELEGATE_OPERATIONS) {
    assert.ok(!CLIENT_OPERATIONS.includes(operation));
    assert.ok(!operation.startsWith("$"));
  }
  for (const operation of CLIENT_OPERATIONS) assert.ok(operation.startsWith("$"));
  // `map`, `filter`, `then` and `catch` are the four names a loose scanner picks
  // up first, and none of them is a Prisma delegate operation.
  for (const name of ["map", "filter", "then", "catch", "get", "set", "has"]) {
    assert.ok(!DELEGATE_OPERATIONS.includes(name));
  }
});

test("the committed register is a fixpoint of the tree", () => {
  const recorded = JSON.parse(readFileSync(new URL(`../../${MANIFEST}`, import.meta.url), "utf8"));
  assert.equal(recorded.totals.sites, register.totals.sites);
  assert.deepEqual(recorded.byVerdict, register.byVerdict);
  const check = execFileSync(process.execPath, ["scripts/arch/mcp-store-ownership.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(check, /^OK /u);
});
