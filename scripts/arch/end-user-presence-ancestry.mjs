#!/usr/bin/env node
// WIN-268 P3 — the invariant that makes `end_users.*` tenancy-safe, and which
// nothing in the tool module states.
//
// THE SHAPE OF THE GUARD. `apps/agent/src/mcp-platform/tools/end-users.ts`
// authorises every one of its four tools with a CONJUNCTION of two independently
// scoped predicates:
//
//     EndUser.organizationId = scope.organizationId
//     AND EndUser has a row in one of five relations with environmentId = scope.environmentId
//
// The second half is `currentEnvironmentPresence`. Nothing in that where-clause
// joins the environment to the organization — the tool never checks that
// `scope.environmentId` lives under `scope.organizationId`, and it never reads
// `scope.projectId` at all. `apps/agent/src/auth/scope.guard.ts` builds the scope
// from three INDEPENDENT header values, so a caller can present a triple whose
// three ids belong to different tenants.
//
// WHY IT IS SAFE ANYWAY, AND WHERE THAT SAFETY LIVES. The conjunction excludes a
// forged (organization, environment) pair only while NO PRESENCE ROW CAN EXIST
// joining one tenant's end user to another tenant's environment. That is not a
// property of this tool, of Prisma, or of any TypeScript in this repository. It
// is enforced in PostgreSQL, by the `<Model>_ancestry` triggers the canonical
// migrations install, each of which walks Environment -> Project -> Organization
// and refuses a row whose end user belongs to a different owner.
//
// SO THE INVARIANT IS: every relation `currentEnvironmentPresence` names must
// resolve to a model that carries an ancestry trigger. Add a sixth presence
// relation whose model has none, and `end_users.get` starts answering a forged
// triple with somebody else's customer — with no test failing, because every
// test in the module today uses a doubled client that has no triggers in it.
//
// The three inputs are three files this audit does not own: the tool source, the
// canonical schema, and the migration SQL. It cannot pass by agreeing with
// itself.
//
//   node scripts/arch/end-user-presence-ancestry.mjs
//   node scripts/arch/end-user-presence-ancestry.mjs --json

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { CANONICAL_SCHEMA } from "./table-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The module whose authorization the invariant belongs to. */
export const END_USERS_TOOL = "apps/agent/src/mcp-platform/tools/end-users.ts";

/** The function whose OR-list is the presence half of the conjunction. */
export const PRESENCE_FUNCTION = "currentEnvironmentPresence";

/** The model the presence relations hang off. */
export const PRESENCE_OWNER_MODEL = "EndUser";

export const MIGRATIONS_DIRECTORY = "internal-packages/tenancy-database/prisma/migrations";

const CREATE_ANCESTRY_TRIGGER =
  /CREATE\s+TRIGGER\s+"(?<trigger>[A-Za-z0-9_]+)_ancestry"[\s\S]*?ON\s+"public"\."(?<table>[A-Za-z0-9_]+)"/gu;
const DROP_ANCESTRY_TRIGGER =
  /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"(?<trigger>[A-Za-z0-9_]+)_ancestry"\s+ON\s+"public"\."(?<table>[A-Za-z0-9_]+)"/gu;

/**
 * The relation names `currentEnvironmentPresence` puts in its OR list.
 *
 * Read structurally: the function returns `{ OR: [{ threads: { some: ... } }, …] }`
 * and each element contributes ONE property name. A textual scan would also pick
 * up `environmentId`, which is the key inside `some`, not a relation.
 */
export function presenceRelations(root = repositoryRoot) {
  const path = join(root, END_USERS_TOOL);
  if (!existsSync(path)) return null;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let relations = null;

  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === PRESENCE_FUNCTION &&
      node.body
    ) {
      for (const statement of node.body.statements) {
        if (!ts.isReturnStatement(statement) || !statement.expression) continue;
        const returned = statement.expression;
        if (!ts.isObjectLiteralExpression(returned)) continue;
        for (const property of returned.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (!ts.isIdentifier(property.name) || property.name.text !== "OR") continue;
          if (!ts.isArrayLiteralExpression(property.initializer)) continue;
          relations = [];
          for (const element of property.initializer.elements) {
            if (!ts.isObjectLiteralExpression(element)) continue;
            for (const entry of element.properties) {
              if (ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name)) {
                relations.push(entry.name.text);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return relations;
}

/** `EndUser`'s relation fields, as `{ relationName: TargetModel }`. */
export function endUserRelationTargets(root = repositoryRoot) {
  const schema = readFileSync(join(root, CANONICAL_SCHEMA), "utf8");
  const block = new RegExp(`model\\s+${PRESENCE_OWNER_MODEL}\\s*\\{([\\s\\S]*?)\\n\\}`, "u").exec(schema);
  if (!block) return null;
  const targets = {};
  for (const line of block[1].split("\n")) {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?\s*(\?)?/u.exec(line);
    if (!field) continue;
    const [, name, type, list] = field;
    // A relation field's type is another MODEL — capitalised — and a scalar's is
    // a Prisma primitive or an enum. Only the list-valued relations can be a
    // "presence" for one end user, and those are what the OR list uses.
    if (!list) continue;
    targets[name] = type;
  }
  return targets;
}

/**
 * Which tables carry an ancestry trigger AFTER every migration has been applied.
 *
 * Replayed in migration order, honouring DROP: `20260824233000_m4_forward_upgrade_contract`
 * drops `Thread_ancestry` and recreates it against a different function, and a
 * scan that only counted CREATEs would report a trigger that a later migration
 * had removed as though it were still installed.
 */
export function ancestryTriggerTables(root = repositoryRoot) {
  const directory = join(root, MIGRATIONS_DIRECTORY);
  const installed = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "migration.sql");
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, "utf8");
    // Order within one file matters too: the M4 migration drops and recreates in
    // the same file, so the statements are replayed in the order they appear.
    const statements = [];
    for (const match of sql.matchAll(DROP_ANCESTRY_TRIGGER)) {
      statements.push({ at: match.index, drop: true, table: match.groups.table });
    }
    for (const match of sql.matchAll(CREATE_ANCESTRY_TRIGGER)) {
      statements.push({ at: match.index, drop: false, table: match.groups.table });
    }
    statements.sort((left, right) => left.at - right.at);
    for (const statement of statements) {
      if (statement.drop) installed.delete(statement.table);
      else installed.set(statement.table, `${entry.name}`);
    }
  }
  return installed;
}

export function check(root = repositoryRoot) {
  const problems = [];
  const relations = presenceRelations(root);
  if (relations === null || relations.length === 0) {
    problems.push(
      `${END_USERS_TOOL}: ${PRESENCE_FUNCTION}() no longer returns an OR list of relations — ` +
        "the presence half of the end_users authorization has moved and this audit is blind",
    );
    return { relations: relations ?? [], models: [], problems };
  }

  const targets = endUserRelationTargets(root);
  if (targets === null) {
    problems.push(`${CANONICAL_SCHEMA}: model ${PRESENCE_OWNER_MODEL} not found`);
    return { relations, models: [], problems };
  }

  const triggers = ancestryTriggerTables(root);
  const models = [];
  for (const relation of relations) {
    const model = targets[relation];
    if (!model) {
      problems.push(
        `${PRESENCE_FUNCTION}() names "${relation}", which is not a list relation on ${PRESENCE_OWNER_MODEL} ` +
          "in the canonical schema",
      );
      continue;
    }
    models.push({ relation, model, ancestryTrigger: triggers.get(model) ?? null });
    if (!triggers.has(model)) {
      problems.push(
        `${PRESENCE_FUNCTION}() admits "${relation}" -> ${model}, and ${model} carries NO _ancestry trigger. ` +
          "A row joining one tenant's EndUser to another tenant's Environment could then be created, " +
          "and end_users.* would answer a forged (organizationId, environmentId) pair with the other tenant's customer.",
      );
    }
  }

  return { relations, models, problems };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const result = check();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `end-user-presence-ancestry: ${result.models.length} presence relation(s) checked against the migrations\n`,
    );
    for (const row of result.models) {
      process.stdout.write(`  ${row.relation} -> ${row.model} : ${row.ancestryTrigger ?? "NO ANCESTRY TRIGGER"}\n`);
    }
    for (const problem of result.problems) process.stdout.write(`FAIL ${problem}\n`);
  }
  process.exit(result.problems.length === 0 ? 0 : 1);
}
