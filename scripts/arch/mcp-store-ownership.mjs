#!/usr/bin/env node
// WIN-268 (M4.2) — THE MCP SURFACE'S ORM REGISTER, AND WHAT EACH SITE IS WAITING ON.
//
// M4.2 moves the MCP surface into `apps/core-api/src/transports/mcp` and routes
// every call to its owning context's published contract. A move that cannot be
// completed in one tranche has exactly two honest outcomes: the part that moved,
// and a NAMED list of the part that did not, with the reason each site is stuck.
// This file is the second one, made checkable so it cannot go stale.
//
// The rule the tranche is built to is: WHERE A USE CASE IS NOT ON A CONTRACT,
// STOP AT THE CALL SITE AND NAME IT WITH ITS OWNING CONTEXT. A register that a
// human wrote by hand would be a memory. This one is derived, every time, from
// four artifacts NONE of which it controls:
//
//   1. THE PRISMA SCHEMA — `internal-packages/tenancy-database/prisma/schema.prisma`.
//      Delegate names are the schema's models, camel-cased the way the generated
//      client does it. A model added or renamed moves this register. The scanner
//      therefore cannot invent a delegate, and cannot miss one that exists.
//   2. `scripts/arch/table-ownership.mjs` — ADR M0.3 §5.2's owner column as data.
//      Model -> owning context, joined; never guessed from the file it sits in.
//   3. `apps/core-api/src/app.module.ts` — which contexts the composition root
//      ACTUALLY composes, read off the `ComposedContexts` object literal by AST.
//      A context whose contract is fully written but that nothing composes is
//      not reachable from a transport, and saying so is the whole point.
//   4. `packages/contexts/<context>/contracts/index.ts` — the published METHODS
//      of each contract, read off the `<Pascal>Contract` interface by AST.
//
// WHAT COUNTS AS A SITE. Three shapes, and the second is the one a `prisma.`
// grep misses:
//
//   `prisma.<delegate>.<operation>(`   the direct client call
//   `tx.<delegate>.<operation>(`       the same call inside `$transaction`
//   `<client>.$transaction(` / `$queryRaw*` / `$executeRaw*`
//                                      a client-level reach with no model
//
// A count that says `prisma.` and means "the ORM" undercounts by every
// transaction-scoped write in the tree. `--check` fails when the register drifts.
//
//   node scripts/arch/mcp-store-ownership.mjs            # human report
//   node scripts/arch/mcp-store-ownership.mjs --json     # machine-readable
//   node scripts/arch/mcp-store-ownership.mjs --write    # regenerate evidence
//   node scripts/arch/mcp-store-ownership.mjs --check    # fail on drift

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { OWNER, CANONICAL_SCHEMA } from "./table-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const MANIFEST = "docs/audits/win-268-mcp-store-ownership.json";
export const REPORT = "docs/audits/win-268-mcp-store-ownership.md";

/**
 * THE MCP SURFACE, AS PATHS AND NOT AS A GREP.
 *
 * Every root is a CONSTANT, because a fix found by grepping one literal has
 * already broken this repository once on the next file, which held its path in a
 * constant. `apps/core-api/src/transports/mcp` is here even though it holds zero
 * ORM calls today: it is the DESTINATION, and a register that only scanned the
 * origin could not notice the day a moved module arrived carrying a client.
 */
export const SURFACE_ROOTS = Object.freeze([
  "apps/agent/src/mcp-platform",
  "apps/agent/src/mcp-docs",
  "apps/core-api/src/transports/mcp",
  "apps/mcp-stdio/src",
]);

/**
 * The Prisma delegate operations. A closed set, from the client's own API.
 *
 * Closed rather than "any call", because `prisma.$on(...)`, `rows.map(...)` and
 * `this.byToken.delete(...)` are all `<x>.<y>.<z>(` and none of them is a store
 * reach. The pairing of a SCHEMA MODEL with one of these names is what makes a
 * match a delegate call rather than a coincidence.
 */
export const DELEGATE_OPERATIONS = Object.freeze([
  "aggregate",
  "count",
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
  "update",
  "updateMany",
  "upsert",
]);

/** Client-level reaches that name no model. Counted, and never delegate sites. */
export const CLIENT_OPERATIONS = Object.freeze([
  "$transaction",
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
  "$runCommandRaw",
]);

/** How the generated client camel-cases a model name. */
export function delegateFor(model) {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Every model in the canonical schema, read from the schema itself. */
export function schemaModels(root = repositoryRoot) {
  const source = readFileSync(join(root, CANONICAL_SCHEMA), "utf8");
  const models = [];
  for (const match of source.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gmu)) {
    models.push(match[1]);
  }
  if (models.length === 0) throw new Error(`no models parsed from ${CANONICAL_SCHEMA}`);
  return models;
}

/** Files under the surface roots, excluding tests. */
export function surfaceFiles(root = repositoryRoot) {
  const found = [];
  for (const surfaceRoot of SURFACE_ROOTS) {
    const absolute = join(root, surfaceRoot);
    let entry;
    try {
      entry = statSync(absolute);
    } catch {
      continue;
    }
    if (!entry.isDirectory()) continue;
    const walk = (directory) => {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts") || /\.(test|spec)\.tsx?$/u.test(path)) continue;
        found.push(relative(root, path));
      }
    };
    walk(absolute);
  }
  return found;
}

/**
 * The contexts `composeApplication` ACTUALLY composes.
 *
 * Read off the `ComposedContexts` object literal by AST, not from a list here.
 * The properties are conditional spreads (`...(x === undefined ? {} : { x })`),
 * so the names are taken from the spread's own object literal.
 */
export function composedContexts(root = repositoryRoot) {
  const path = "apps/core-api/src/app.module.ts";
  const source = ts.createSourceFile(
    path,
    readFileSync(join(root, path), "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const names = new Set();
  let seen = false;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "contexts" &&
      node.type !== undefined &&
      node.type.getText(source).includes("ComposedContexts")
    ) {
      seen = true;
      const collect = (inner) => {
        if (ts.isPropertyAssignment(inner) || ts.isShorthandPropertyAssignment(inner)) {
          names.add(inner.name.getText(source));
        }
        ts.forEachChild(inner, collect);
      };
      ts.forEachChild(node, collect);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!seen) throw new Error(`could not find the ComposedContexts literal in ${path}`);
  return [...names].sort();
}

/** `identity-access` -> `identityAccess`, the key `ComposedContexts` uses. */
export function contextKey(directory) {
  return directory.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

/** `identity-access` -> `IdentityAccessContract`. */
export function contractInterfaceName(directory) {
  return `${directory
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Contract`;
}

/** The published method names of one context's contract, read by AST. */
export function contractMethods(directory, root = repositoryRoot) {
  const path = `packages/contexts/${directory}/contracts/index.ts`;
  let text;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const wanted = contractInterfaceName(directory);
  const methods = [];
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === wanted) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member) && member.name !== undefined) {
          methods.push(member.name.getText(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methods.sort();
}

/**
 * Every ORM site in one file.
 *
 * The AST is walked rather than the lines: `a.b.c(` is a call expression whose
 * callee is a property access whose own expression is a property access, and
 * reading it that way is what lets a delegate call spanning three lines be found
 * and a string containing `prisma.user.create(` be ignored.
 */
export function sitesIn(path, delegates, root = repositoryRoot) {
  const text = readFileSync(join(root, path), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const sites = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const outer = node.expression;
      const operation = outer.name.text;
      if (CLIENT_OPERATIONS.includes(operation)) {
        sites.push({
          file: path,
          line: lineOf(node),
          shape: "client",
          receiver: outer.expression.getText(source).split("\n")[0].trim(),
          delegate: null,
          model: null,
          operation,
        });
      } else if (
        DELEGATE_OPERATIONS.includes(operation) &&
        ts.isPropertyAccessExpression(outer.expression)
      ) {
        const delegate = outer.expression.name.text;
        const model = delegates.get(delegate);
        if (model !== undefined) {
          sites.push({
            file: path,
            line: lineOf(node),
            shape: "delegate",
            receiver: outer.expression.expression.getText(source).split("\n")[0].trim(),
            delegate,
            model,
            operation,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/**
 * The four verdicts, in the order a site becomes movable.
 *
 * `unowned` is not a fifth verdict for "we could not classify it": every model
 * in the canonical schema HAS an owner in `table-ownership.mjs` — a model added
 * without one already fails `sole-writer.mjs` — so an unowned model here means
 * the two artifacts have drifted and that is a hard failure, not a category.
 */
export const VERDICTS = Object.freeze({
  moved: "MOVED — the site is already inside apps/core-api/src/transports and reaches a contract",
  blockedOnContext:
    "BLOCKED-ON-CONTEXT — the owning context publishes a contract that the composition root does not compose, so no transport can reach it",
  blockedOnContract:
    "BLOCKED-ON-CONTRACT — the owning context IS composed, and publishes no method for this use case",
  blockedOnAdapter:
    "BLOCKED-ON-ADAPTER — the row is written by the kernel outbox adapter, not by a context",
});

/**
 * WHY EACH FILE'S SITES ARE STILL WHERE THEY ARE — one entry per file, written
 * by a human and REQUIRED.
 *
 * The verdicts above are derived, and a derived verdict can only say which of
 * four structural states a site is in. It cannot say WHICH use case is not on a
 * contract, and that sentence is the whole of "stop at the call site and name
 * it". So every file that holds a site must have a row here naming the owning
 * contexts and the specific thing missing; a file that appears without one is a
 * hard failure, exactly as an undispositioned secret-response site is.
 *
 * `waitingOn` is one of:
 *   `context-composition`  the owner's contract is written and `composeApplication`
 *                          does not compose it, so no transport can reach it
 *   `contract-method`      the owner IS composed and publishes nothing for this
 *                          use case
 *   `outbox-adapter`       the row belongs to the kernel outbox, not a context
 *   `transport-move`       every method it needs exists; only the move is left
 */
export const DISPOSITIONS = Object.freeze({
  "apps/agent/src/mcp-platform/events.service.ts": {
    contexts: ["eventing", "<kernel-outbox-adapter>"],
    waitingOn: "context-composition",
    note: "`NotificationRule` CRUD is `eventing`'s, which publishes 9 methods and is not composed. The two `Event` sites are the kernel outbox's own table and may not become a context call at all: ADR M0.3 §7 decision 8 gives `Event` one writer, the outbox adapter, so this file's event append belongs behind `OutboxWriter` and its event READ behind `observability`.",
  },
  "apps/agent/src/mcp-platform/identity-resolver.service.ts": {
    contexts: ["identity-access", "tenancy", "tools"],
    waitingOn: "contract-method",
    note: "`McpAnonymousSession` find/update/create is the anonymous MCP caller's session lifecycle. `identity-access` is composed and publishes `authenticateBearer` for the four BEARER kinds only; an anonymous MCP session is a fifth credential shape with no published mint, no published lookup and no published touch. `EntityMcpConfig` is `tools`' and `Environment.findMany` is `tenancy`'s listing of the environments an entity is exposed in, which `listVisibleProjects`/`listProjectEntities` do not answer.",
  },
  "apps/agent/src/mcp-platform/mcp-bearer-token.service.ts": {
    contexts: ["identity-access", "tenancy", "observability", "<client-level>"],
    waitingOn: "contract-method",
    note: "MINT and VERIFY are already on `identity-access` — `mintBearerCredential` and `authenticateBearer`, both reached by the two moved mint routes. LIST and REVOKE are not: there is no `listBearerCredentials` and no `revokeBearerCredential`, so `GET /mcp/entity/:entityId/tokens` and `DELETE /mcp/entity/:entityId/tokens/:tokenId` cannot be served from a contract. `Entity.findFirst` is `tenancy.findEntity`. The `AdminAudit` writes are `observability`'s and it is not composed.",
  },
  "apps/agent/src/mcp-platform/mcp-entity.controller.ts": {
    contexts: ["identity-access", "tenancy", "tools"],
    waitingOn: "context-composition",
    note: "The entity MCP gateway's config, tool exposure and ACL surfaces are `tools`' — `describeMcpSurface`, `configureMcpSurface`, `listEntityToolPolicies`, `setEntityToolPolicy` and `listCallableForMcpCaller` are all PUBLISHED and none of them is reachable, because `composeApplication` does not compose `tools`. Its `McpOidcSession` and `McpAnonymousSession` reads share the identity-resolver's missing session lifecycle.",
  },
  "apps/agent/src/mcp-platform/mcp-tool-acl.service.ts": {
    contexts: ["tools", "<client-level>"],
    waitingOn: "context-composition",
    note: "Every site is `tools`', and every use case is on `ToolsContract` already: `listEntityToolPolicies` and `setEntityToolPolicy` are exactly this service. The blocker is composition, not design — see `apps/core-api/src/composition/adapter-bindings.ts`, where `postgres-tenancy:ToolsRepository` is a declared, satisfied binding and `ToolDispatch` has no adapter directory at all.",
  },
  "apps/agent/src/mcp-platform/permission-gateway.service.ts": {
    contexts: ["tools", "agents", "tenancy"],
    waitingOn: "context-composition",
    note: "`ToolsContract.resolvePermission`, `listOrganizationPolicies`, `setOrganizationPolicy` and `deleteOrganizationPolicy` are the published form of this entire service, and `packages/contexts/tools/application/index.ts` names it as one of the three files that layer replaces. The `AgentBinding` read is tier 3's, reached through the same context. The `Environment` read is this tranche's tier-2 forged-scope refusal and is `tenancy.resolveEnvironmentScope` — a method that EXISTS and is composed; it stays here only because the service around it cannot move until `tools` is composed. Blocked on composing `tools`.",
  },
  "apps/agent/src/mcp-platform/token.service.ts": {
    contexts: ["identity-access", "tenancy", "<client-level>"],
    waitingOn: "contract-method",
    note: "Same split as the entity bearer service: `mint` is `mintBearerCredential`, `verify` is `authenticateBearer`, `resolveScope` is `tenancy.resolveEnvironmentScope` and the admin-tier gate is `tenancy.findOrganizationMembership` — all published. `list` and `revoke` are not published by `identity-access` at all, which is what keeps `GET /mcp/platform/tokens` and `POST /mcp/platform/tokens/:id/revoke` in this deployable.",
  },
  "apps/agent/src/mcp-platform/tools/admin.ts": {
    contexts: ["tenancy", "agents"],
    waitingOn: "contract-method",
    note: "`loadOrgScopes` walks every (organization, project, environment) triple an admin token holds. `tenancy` publishes `listOperatorOrganizations`, `listVisibleProjects` and `listProjectEntities` — all keyed on a USER — and nothing keyed on an organization, which is what an admin-tier MCP token holds instead of a user. The `AgentBinding` fan-out is `agents`', which is not composed.",
  },
  "apps/agent/src/mcp-platform/tools/alert_channels.ts": {
    contexts: ["cost-monitoring", "<client-level>"],
    waitingOn: "context-composition",
    note: "Alert channels, their configurations, deliveries and retries are all `cost-monitoring` rows and it publishes 24 methods; the composition root composes four contexts and this is not one of them. The `$queryRawUnsafe` site is the only raw SQL on the MCP surface and must not survive the move in any form.",
  },
  "apps/agent/src/mcp-platform/tools/channel-apps.ts": {
    contexts: ["agents"],
    waitingOn: "context-composition",
    note: "One `AgentBinding` read, used to resolve the agent an external workspace installation routes to. `agents` is not composed. The channel rows this file otherwise writes are reached through services outside this surface and are not sites here.",
  },
  "apps/agent/src/mcp-platform/tools/channels.ts": {
    contexts: ["agents"],
    waitingOn: "context-composition",
    note: "Two `AgentBinding` reads that check the agent a channel doorway binds to is deployed in the caller's environment. `agents` is not composed.",
  },
  "apps/agent/src/mcp-platform/tools/end-users.ts": {
    contexts: ["identity-access", "conversations"],
    waitingOn: "contract-method",
    note: "`identity-access` is composed and publishes `listEndUsers` — a LISTING, and there is no `end_users.list` tool here. The four tools that exist are get, link_identity, bind_external_id and unlink_identity, and the contract publishes no read of one end user and no write of an `EndUserIdentity` at all. The `Thread.aggregate` that supplies threadCount/lastActiveAt is `conversations`', whose contract publishes zero methods.",
  },
  "apps/agent/src/mcp-platform/tools/entities.ts": {
    contexts: ["tools", "identity-access"],
    waitingOn: "context-composition",
    note: "`EntityMcpConfig` and `ToolHealth` are `tools`' and covered by `describeMcpSurface`/`discoverEntityTools`; the `McpBearerToken.count` is `identity-access`' and shares the missing listing. Blocked on composing `tools`.",
  },
  "apps/agent/src/mcp-platform/tools/jobs.ts": {
    contexts: ["jobs"],
    waitingOn: "context-composition",
    note: "Eleven `Job` sites against a `jobs` contract that publishes 14 methods and is not composed. `packages/contexts/jobs` is also where the approval-timeout clamp lives, and its MCP-vs-generic split is already correct there — see `approvalRequestFrom`.",
  },
  "apps/agent/src/mcp-platform/tools/macros.ts": {
    contexts: ["agents"],
    waitingOn: "context-composition",
    note: "`Macro` is an `agents` row per ADR M0.3 §1 row 5. `agents` publishes 41 methods and is not composed, so macro record/list/update/share/replay stay here. The JSON-shape defect this tranche fixes in `record_stop` is a PostgreSQL check constraint, not a contract question, and is fixed in place.",
  },
  "apps/agent/src/mcp-platform/tools/mcp.ts": {
    contexts: ["identity-access"],
    waitingOn: "contract-method",
    note: "`mcp_list_clients` and `mcp_list_tokens` read `OAuthClient` and `OAuthAccessToken`. `identity-access` owns both rows and publishes `exchangeOauthRefreshToken`-shaped use cases in `application/` only; its contract publishes no listing of either, so neither tool can reach one.",
  },
  "apps/agent/src/mcp-platform/tools/orchestration.ts": {
    contexts: ["tools"],
    waitingOn: "context-composition",
    note: "`Tool` and `EnvironmentEntityTool` writes performed by the `entities.provision` composite. `ToolsContract.registerTools` and `discoverEntityTools` are the published form; blocked on composing `tools`.",
  },
  "apps/agent/src/mcp-platform/tools/platos-control.ts": {
    contexts: ["<client-level>"],
    waitingOn: "contract-method",
    note: "One `$transaction` with no delegate call of its own inside this file's scan — a client-level reach that names no row. It cannot be classified by owner and must not survive the move: a transport does not open transactions, a use case does.",
  },
  "apps/agent/src/mcp-platform/tools/providers.ts": {
    contexts: ["providers"],
    waitingOn: "transport-move",
    note: "The ONE site on this surface whose owner is composed and whose method exists: `ProviderKey.findMany` scoped to the environment is `ProvidersContract.listProviderKeys`. Nothing about it is blocked; it is here because `providers.set_routes` also writes `AgentVersion.modelRoutes`, which is `agents`', so moving the read alone would split one tool across two deployables.",
  },
  "apps/agent/src/mcp-platform/tools/reflection.ts": {
    contexts: ["tenancy", "tools", "conversations", "governance"],
    waitingOn: "context-composition",
    note: "`platos.explain_turn` joins a `Turn` (`conversations`, zero published methods), its `SafetyEvent`s (`governance`, not composed), the `EnvironmentEntityTool` exposures it used (`tools`, not composed) and the `Entity` rows behind them (`tenancy`, composed). Four owners, three uncomposed: this tool cannot move until the turn record itself is on a contract.",
  },
  "apps/agent/src/mcp-platform/tools/settings.ts": {
    contexts: ["tenancy"],
    waitingOn: "transport-move",
    note: "`projects.list_all` is `TenancyContract.listVisibleProjects(userId)` exactly — same filter, same soft-delete exclusion, same membership join. Owner composed, method published: this is a MOVE with no missing piece, held only by the fact that the MCP tool table it is registered in has not moved.",
  },
});

export function buildRegister(root = repositoryRoot) {
  const delegates = new Map();
  for (const model of schemaModels(root)) delegates.set(delegateFor(model), model);

  const composed = new Set(composedContexts(root));
  const contracts = new Map();
  for (const model of Object.keys(OWNER)) {
    const owner = OWNER[model];
    if (owner.startsWith("<")) continue;
    if (!contracts.has(owner)) contracts.set(owner, contractMethods(owner, root));
  }

  const sites = [];
  const unowned = [];
  for (const file of surfaceFiles(root)) {
    for (const site of sitesIn(file, delegates, root)) {
      const inDestination = site.file.startsWith("apps/core-api/src/transports/");
      let owner = null;
      let verdict;
      if (site.shape === "client") {
        owner = null;
        verdict = inDestination ? "moved" : "blockedOnContract";
      } else {
        owner = OWNER[site.model] ?? null;
        if (owner === null) {
          unowned.push(site);
          continue;
        }
        if (owner.startsWith("<")) verdict = "blockedOnAdapter";
        else if (inDestination) verdict = "moved";
        else if (!composed.has(contextKey(owner))) verdict = "blockedOnContext";
        else verdict = "blockedOnContract";
      }
      sites.push({ ...site, owner, verdict });
    }
  }

  const files = [...new Set(sites.map((site) => site.file))].sort();
  const undispositioned = files.filter((file) => DISPOSITIONS[file] === undefined);
  const orphanDispositions = Object.keys(DISPOSITIONS).filter((file) => !files.includes(file));

  if (unowned.length > 0) {
    throw new Error(
      `the schema and table-ownership.mjs have drifted: ${unowned
        .map((site) => `${site.model} at ${site.file}:${String(site.line)}`)
        .join(", ")}`,
    );
  }

  if (undispositioned.length > 0) {
    throw new Error(
      `every file holding an ORM site needs a disposition naming what it is waiting on; missing: ${undispositioned.join(", ")}`,
    );
  }
  if (orphanDispositions.length > 0) {
    throw new Error(
      `these files have a disposition and no ORM site — delete the row or the register is describing a tree that is gone: ${orphanDispositions.join(", ")}`,
    );
  }

  const byOwner = {};
  for (const site of sites) {
    const key = site.owner ?? "<client-level>";
    byOwner[key] ??= { sites: 0, delegate: 0, client: 0, models: [], composed: false, contractMethods: null };
    byOwner[key].sites += 1;
    byOwner[key][site.shape] += 1;
    if (site.model !== null && !byOwner[key].models.includes(site.model)) {
      byOwner[key].models.push(site.model);
    }
  }
  for (const [owner, row] of Object.entries(byOwner)) {
    row.models.sort();
    if (owner.startsWith("<")) continue;
    row.composed = composed.has(contextKey(owner));
    row.contractMethods = contracts.get(owner) ?? null;
  }

  const byVerdict = {};
  for (const site of sites) byVerdict[site.verdict] = (byVerdict[site.verdict] ?? 0) + 1;

  return {
    issue: "WIN-268",
    milestone: "M4.2",
    surfaceRoots: [...SURFACE_ROOTS],
    canonicalSchema: CANONICAL_SCHEMA,
    composedContexts: [...composed].sort(),
    totals: {
      sites: sites.length,
      delegateSites: sites.filter((site) => site.shape === "delegate").length,
      clientSites: sites.filter((site) => site.shape === "client").length,
      files: [...new Set(sites.map((site) => site.file))].length,
    },
    byVerdict,
    byOwner,
    verdicts: { ...VERDICTS },
    dispositions: Object.fromEntries(files.map((file) => [file, DISPOSITIONS[file]])),
    sites,
  };
}

function renderReport(register) {
  const lines = [];
  lines.push("# WIN-268 (M4.2) — the MCP surface's ORM register");
  lines.push("");
  lines.push(
    "Generated by `scripts/arch/mcp-store-ownership.mjs`. Do not edit by hand: `pnpm audit:mcp-store-ownership` regenerates it and `--check` fails when the tree and this file disagree.",
  );
  lines.push("");
  lines.push(
    `**${String(register.totals.sites)} ORM call sites** across ${String(register.totals.files)} files — ${String(register.totals.delegateSites)} model-delegate calls and ${String(register.totals.clientSites)} client-level reaches (\`$transaction\`, \`$queryRaw*\`).`,
  );
  lines.push("");
  lines.push("## Verdicts");
  lines.push("");
  lines.push("| verdict | sites | meaning |");
  lines.push("| --- | ---: | --- |");
  for (const [verdict, meaning] of Object.entries(register.verdicts)) {
    lines.push(`| \`${verdict}\` | ${String(register.byVerdict[verdict] ?? 0)} | ${meaning} |`);
  }
  lines.push("");
  lines.push("## What unblocks the most, computed rather than asserted");
  lines.push("");
  // DERIVED, so the recommendation cannot go stale while the tree moves. The
  // question a reader has is not "how many sites are stuck" but "which ONE
  // decision frees the largest number", and that is an arithmetic over the
  // ownership split rather than an opinion.
  const uncomposed = Object.entries(register.byOwner)
    .filter(([owner, row]) => !owner.startsWith("<") && !row.composed)
    .sort((a, b) => b[1].sites - a[1].sites);
  const composedBlocked = Object.entries(register.byOwner)
    .filter(([owner, row]) => !owner.startsWith("<") && row.composed)
    .sort((a, b) => b[1].sites - a[1].sites);
  lines.push("| decision | frees | why it is the next one |");
  lines.push("| --- | ---: | --- |");
  for (const [owner, row] of uncomposed.slice(0, 3)) {
    lines.push(
      `| compose \`${owner}\` in \`composeApplication\` | ${String(row.sites)} | its contract already publishes ${String(
        (row.contractMethods ?? []).length,
      )} methods and the composition root composes ${String(register.composedContexts.length)} of 17 |`,
    );
  }
  for (const [owner, row] of composedBlocked.slice(0, 2)) {
    lines.push(
      `| publish the missing methods on \`${owner}\` | up to ${String(row.sites)} | the context IS composed; ${String(
        (row.contractMethods ?? []).length,
      )} methods are published and none serves these use cases |`,
    );
  }
  lines.push("");
  lines.push("## Ownership split");
  lines.push("");
  lines.push("| owning context | sites | composed | contract methods published | rows touched |");
  lines.push("| --- | ---: | --- | ---: | --- |");
  const owners = Object.entries(register.byOwner).sort((a, b) => b[1].sites - a[1].sites);
  for (const [owner, row] of owners) {
    lines.push(
      `| \`${owner}\` | ${String(row.sites)} | ${owner.startsWith("<") ? "n/a" : row.composed ? "yes" : "**no**"} | ${
        row.contractMethods === null ? "n/a" : String(row.contractMethods.length)
      } | ${row.models.map((model) => `\`${model}\``).join(", ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push("## What each file is waiting on");
  lines.push("");
  lines.push("| file | owning contexts | waiting on | what is missing |");
  lines.push("| --- | --- | --- | --- |");
  for (const [file, disposition] of Object.entries(register.dispositions)) {
    lines.push(
      `| \`${file}\` | ${disposition.contexts.map((context) => `\`${context}\``).join(", ")} | \`${disposition.waitingOn}\` | ${disposition.note} |`,
    );
  }
  lines.push("");
  lines.push("## Every site");
  lines.push("");
  lines.push("| file:line | shape | row | operation | owner | verdict |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const site of register.sites) {
    lines.push(
      `| \`${site.file}:${String(site.line)}\` | ${site.shape} | ${
        site.model === null ? "—" : `\`${site.model}\``
      } | \`${site.operation}\` | ${site.owner === null ? "—" : `\`${site.owner}\``} | \`${site.verdict}\` |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

function main(argv) {
  const register = buildRegister();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(register, null, 2)}\n`);
    return 0;
  }
  if (argv.includes("--write")) {
    writeFileSync(join(repositoryRoot, MANIFEST), `${JSON.stringify(register, null, 2)}\n`);
    writeFileSync(join(repositoryRoot, REPORT), renderReport(register));
    process.stdout.write(`wrote ${MANIFEST} and ${REPORT}\n`);
    return 0;
  }
  if (argv.includes("--check")) {
    let recorded;
    try {
      recorded = readFileSync(join(repositoryRoot, MANIFEST), "utf8");
    } catch {
      process.stderr.write(`FAIL ${MANIFEST} is missing — run --write\n`);
      return 1;
    }
    const expected = `${JSON.stringify(register, null, 2)}\n`;
    if (recorded !== expected) {
      process.stderr.write(
        `FAIL ${MANIFEST} is stale: the tree holds ${String(register.totals.sites)} ORM sites and the register does not match. Run --write.\n`,
      );
      return 1;
    }
    const report = readFileSync(join(repositoryRoot, REPORT), "utf8");
    if (report !== renderReport(register)) {
      process.stderr.write(`FAIL ${REPORT} is stale. Run --write.\n`);
      return 1;
    }
    process.stdout.write(
      `OK ${String(register.totals.sites)} MCP-surface ORM sites, register current\n`,
    );
    return 0;
  }
  process.stdout.write(renderReport(register));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
