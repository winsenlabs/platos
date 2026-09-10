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

test("contract methods are read from the contract file, and the two the mints use are there", () => {
  const methods = contractMethods("identity-access");
  assert.ok(methods.includes("mintBearerCredential"), "the mint routes reach this method");
  assert.ok(methods.includes("authenticateBearer"));
  assert.ok(!methods.includes("listBearerCredentials"), "listing is NOT published — that is the finding");
  assert.ok(!methods.includes("revokeBearerCredential"));
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
