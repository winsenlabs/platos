#!/usr/bin/env node
// ADR M0.3 §5.2 — the sole-writer lint.
//
// §1's cutting rule is that every canonical row has exactly ONE context
// permitted to write it. `scripts/arch/table-ownership.mjs` states that as data.
// This turns it into a gate, so the ownership map is "a non-regressable gate,
// independent of context count" rather than a table nobody re-reads.
//
// The check has two halves, and they are honestly different in maturity today:
//
//   MAP INTEGRITY — the map must cover the live canonical schema exactly: every
//   model owned, no owner invented, no phantom row, every owner a real context
//   directory. This runs against the real 93-model schema and is live NOW. It is
//   what discharges WIN-256's "current schema maps to explicit owners".
//
//   WRITE ENFORCEMENT — a file under packages/(contexts|adapters)/<X> may not
//   call a mutating Prisma delegate for a model whose owner is not <X>, where
//   <X> is the owner's context OR its canonical-store adapter. Reads
//   (findMany/findUnique/count/aggregate) are exempt by design: §1 restricts
//   WRITES. This half is LIVE as of WIN-258: `packages/adapters/postgres-tenancy`
//   is the first V1 package to import the ORM, and the check now judges its
//   mutations rather than only fixtures.
//
//   IT COULD NOT HAVE BEEN SWITCHED ON WITHOUT `ownerDirectories`. Until WIN-258
//   the only directory permitted to write a row was `packages/contexts/<owner>`,
//   and ADR M0.3 §2 forbids a context's domain/ and application/ from importing
//   the ORM — so the one package allowed to write a row was the one package
//   unable to, and any real repository would have failed this gate on its first
//   line. `CANONICAL_STORE_ADAPTERS` in table-ownership.mjs records the
//   delegation per owner, by hand, so granting one is a decision somebody made.
//
//   node scripts/arch/sole-writer.mjs          # check, exit 1 on violation
//   node scripts/arch/sole-writer.mjs --json   # machine-readable
//
// WHAT WRITE ENFORCEMENT SEES, AND WHAT IT DOES NOT
//
// The 2026-09-02 independent verification probed the write half with seven ways
// of spelling one Prisma mutation and found SIX of them invisible, because the
// matcher required a literal two-level `X.<delegate>.<mutator>()`. WIN-258 is
// about to switch this half on as the enforcement of §1's cutting rule, and a
// gate that misses six of seven evasions is worse than one that admits its
// limits — so the surface was closed rather than the banner narrowed. All seven
// probes are now caught, each with its own negative control in the test file:
//
//   db.user.create({})            direct delegate call
//   db["user"].create({})         element-access delegate
//   const { user } = db           destructured delegate binding
//   const u = db.user             aliased delegate binding
//   db.user[m]({})                computed method on a delegate
//   $executeRawUnsafe("INSERT …") raw DML through the client's write API
//   $queryRaw`INSERT INTO …`      raw DML through the client's read API
//
// FAIL-CLOSED, ON THE AXIS THAT CARRIES THE EVASION. Three things are
// UNATTRIBUTABLE — they reach a canonical surface but cannot be pinned to a row,
// so no package may do them, because no owner can be checked: a delegate chosen
// at runtime (`db[name].create()`), a raw statement whose SQL is assembled at
// runtime, and a raw mutation naming a table no canonical model claims. A
// computed METHOD on a resolved delegate (`db.user[m]()`) IS attributable, so it
// is judged a write and the ordinary owner rule decides it.
//
// The axis matters. An earlier draft of this fix also failed closed on an
// unrecognised METHOD NAME — "not a declared read, so treat it as a write". Run
// against the live tree that reported four mutations that are not Prisma at all:
// `ports.repository.impersonationAudit.append(entry)` in identity-access is a
// domain port named after the row it owns. Prisma's delegate write API is finite
// and enumerated in `MUTATING_DELEGATE_METHODS`, so a method in neither list is
// evidence the receiver was never a delegate, not evidence of a hidden write.
//
// HONEST LIMITATIONS. These are NOT covered, and no banner this file prints may
// be read as covering them:
//
//   * ANY receiver is assumed to be a Prisma client. The check is name-driven:
//     it never proves `db` is a `PrismaClient`, only that a canonical delegate
//     name is accessed on something. It always was — `X.<delegate>.<mutator>()`
//     did not identify `X` either. Binding forms widen the consequence: a local
//     literally named `user` that is NOT a delegate, mutated with `.create()`
//     inside a non-owning package, is an over-approximation and will fail. That
//     direction is deliberate for a security gate; rename the local.
//   * THE WRITE API IS ENUMERATED, NOT INFERRED. A delegate mutator Prisma adds
//     in a future release is invisible until it is added to
//     `MUTATING_DELEGATE_METHODS`. This is the price of not reporting every
//     domain port whose method the lint has not heard of, and it is the same
//     contract the check has always had.
//   * ONE FILE AT A TIME, no cross-module flow. A delegate exported from module
//     A and mutated in module B, a delegate reached through a parameter, a
//     function returning `db.user`, a delegate stashed on `this`, or one held in
//     an array/map element is invisible. Only bindings introduced in the SAME
//     file by `const/let/var x = <delegate>` or by destructuring a delegate name
//     are followed.
//   * REBINDING IS NOT TRACKED. A binding is recorded once per file; a later
//     reassignment of that name to something else is not modelled.
//   * A COMPUTED METHOD ON A NON-PRISMA PORT named after a canonical row —
//     `ports.repository.impersonationAudit[key](x)` — is over-approximated as a
//     write on that row. Only the owning package may do it. There are none in
//     the tree today; the alternative was to miss `db.user[m]({})`.
//   * NO SQL PARSER. Raw statements are matched by verb+identifier regex over
//     whitespace-normalised text, not parsed. Nested/quoted constructs that hide
//     a verb (a mutating verb inside a string literal inside the SQL, a stored
//     procedure call that writes, `SELECT … INTO`) are not recognised. Prisma's
//     interpolations are values, so a tagged template's table identifier is
//     always literal; a hand-built string's is not, and is indeterminate.
//   * NOTHING AT RUNTIME. `eval`, dynamic `import()`, a driver used directly, or
//     any write issued outside `packages/contexts` and `packages/adapters` (an
//     app, a script, a migration) is out of scope by construction.
//   * ONE PACKAGE TODAY. The half judges the mutations of exactly one V1 package
//     — `packages/adapters/postgres-tenancy`, the only one that imports the ORM.
//     Every other context still reaches its store through a port with no
//     implementation, so the gate has one adapter's worth of evidence and not a
//     tree's worth. The fixtures remain, because they cover the six evasions the
//     live tree does not happen to contain.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  BLANKET_OWNER,
  CANONICAL_SCHEMA,
  CANONICAL_STORE_ADAPTERS,
  MUTATING_DELEGATE_METHODS,
  MUTATING_SQL_STATEMENT,
  OWNER,
  RAW_SQL_METHODS,
  READ_DELEGATE_METHODS,
  UNOWNED_ADR_ROWS,
  delegateName,
  modelForDelegate,
} from "./table-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const SCAN_ROOTS = ["packages/contexts", "packages/adapters"];

/** The pseudo-owner in the map that resolves to an adapter, not a context. */
const OUTBOX_OWNER = "<kernel-outbox-adapter>";
const OUTBOX_DIRECTORY = "packages/adapters/outbox";

/** Repo-relative directory that owns writes for `owner`. */
export function ownerDirectory(owner) {
  return owner === OUTBOX_OWNER ? OUTBOX_DIRECTORY : `packages/contexts/${owner}`;
}

/**
 * EVERY repo-relative directory permitted to write `owner`'s rows.
 *
 * The context itself, plus its canonical-store adapter when it has one. This is
 * the pair the enforcement half compares against, and it is why the half can be
 * switched on at all: before WIN-258 the only permitted directory was the
 * context, and a context may not import the ORM (ADR M0.3 §2), so the one
 * package allowed to write a row was the one package unable to. The delegation
 * is declared per owner in `CANONICAL_STORE_ADAPTERS` rather than derived from
 * the adapter table's owner column — see the note there for why.
 */
export function ownerDirectories(owner) {
  const primary = ownerDirectory(owner);
  const store = CANONICAL_STORE_ADAPTERS[owner];
  return store === undefined ? [primary] : [primary, store];
}

/** Read the model names declared in the canonical schema. */
export function readSchemaModels(root = repositoryRoot) {
  const text = readFileSync(join(root, CANONICAL_SCHEMA), "utf8");
  return [...text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gmu)].map((match) => match[1]).sort();
}

/**
 * Lowercased PHYSICAL table name -> canonical model, honouring `@@map`.
 *
 * A raw statement names the table, not the model, and the two are not always
 * the same string: one model in the canonical schema carries an `@@map` to a
 * different physical name, inherited from before the vocabulary boundary.
 * Reading the map from the schema rather than assuming model-name-equals-table
 * -name is what stops a raw statement against that table from being
 * unattributable. The test derives the pair from the schema rather than
 * repeating the mapped name here.
 */
export function readSchemaTables(root = repositoryRoot) {
  const text = readFileSync(join(root, CANONICAL_SCHEMA), "utf8");
  const tables = new Map();
  for (const match of text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gmu)) {
    const mapped = /^\s*@@map\(\s*"([^"]+)"\s*\)/mu.exec(match[2]);
    tables.set((mapped ? mapped[1] : match[1]).toLowerCase(), match[1]);
  }
  return tables;
}

/** Half one: the map must describe the live schema exactly. */
export function checkMapIntegrity(root = repositoryRoot) {
  const problems = [];
  const schemaModels = readSchemaModels(root);
  const schemaSet = new Set(schemaModels);
  const mapped = Object.keys(OWNER);

  for (const model of schemaModels) {
    if (!(model in OWNER)) {
      problems.push(
        `UNOWNED ${model} is a canonical row with no owner; add it to OWNER in scripts/arch/table-ownership.mjs`,
      );
    }
  }
  for (const model of mapped) {
    if (!schemaSet.has(model)) {
      problems.push(`PHANTOM ${model} has an owner but is not in ${CANONICAL_SCHEMA}`);
    }
  }
  for (const model of Object.keys(UNOWNED_ADR_ROWS)) {
    if (schemaSet.has(model)) {
      problems.push(
        `RESOLVED ${model} is recorded as absent from the canonical schema but is now present; give it an owner and drop the UNOWNED_ADR_ROWS entry`,
      );
    }
    if (model in OWNER) {
      problems.push(`CONFLICT ${model} is both owned and recorded as unowned`);
    }
  }
  for (const [model, owner] of Object.entries(OWNER)) {
    const directory = join(root, ownerDirectory(owner));
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      problems.push(`NODIR   ${model} is owned by ${owner}, but ${ownerDirectory(owner)} does not exist`);
    }
  }
  const delegates = new Map();
  for (const model of mapped) {
    const delegate = delegateName(model);
    if (delegates.has(delegate)) {
      problems.push(`COLLIDE ${model} and ${delegates.get(delegate)} share the Prisma delegate name "${delegate}"`);
    }
    delegates.set(delegate, model);
  }
  return { schemaModelCount: schemaModels.length, mappedModelCount: mapped.length, problems };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "generated", "coverage"]);

function listSourceFiles(root, scanRoots) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(child);
      } else if (entry.isFile() && !entry.name.endsWith(".d.ts")) {
        const dot = entry.name.lastIndexOf(".");
        if (dot >= 0 && SOURCE_EXTENSIONS.has(entry.name.slice(dot))) found.push(child);
      }
    }
  };
  for (const scanRoot of scanRoots) {
    const absolute = join(root, scanRoot);
    if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) walk(absolute);
  }
  return found.sort();
}

/** The `packages/contexts/<x>` or `packages/adapters/<x>` a file belongs to. */
export function owningPackage(virtualPath) {
  const match = /^(packages\/(?:contexts|adapters)\/[^/]+)\//u.exec(virtualPath);
  return match ? match[1] : null;
}

/**
 * The physical-table map is a property of the REPOSITORY, not of a scan root:
 * a fixture supplies source files to judge, never a schema to judge them
 * against. Read once, from the real tree, and passed in so a test can override.
 */
let cachedTables = null;
export function canonicalTables() {
  cachedTables ??= readSchemaTables(repositoryRoot);
  return cachedTables;
}

const MUTATORS = new Set(MUTATING_DELEGATE_METHODS);
const READERS = new Set(READ_DELEGATE_METHODS);
const RAW_METHODS = new Set(RAW_SQL_METHODS);

/** Marks where an interpolation stood, so a hidden identifier cannot resolve. */
const INTERPOLATION = "\u0000";

/** The member reached by `a.b` or `a["b"]`; `computed` when it is `a[expr]`. */
function accessedMember(node) {
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, computed: false };
  if (!ts.isElementAccessExpression(node)) return null;
  const argument = node.argumentExpression;
  if (argument && ts.isStringLiteralLike(argument)) return { name: argument.text, computed: false };
  return { name: null, computed: true };
}

/**
 * Pass one. Local names that stand for a canonical delegate, and the receivers
 * proven to be client handles.
 *
 * A receiver earns "handle" status by being observed with a LITERAL canonical
 * delegate somewhere in the same file. That is what lets `db[name].create()` be
 * reported without also reporting `items[index].create()`: only `db`, having
 * been seen as `db.user` or destructured for `user`, is a handle.
 */
export function collectDelegateBindings(sourceFile) {
  const bindings = new Map();
  const handles = new Set();
  const bind = (local, delegate) => {
    if (!bindings.has(local)) bindings.set(local, delegate);
  };

  const visit = (node) => {
    const member = accessedMember(node);
    const proves = member && !member.computed && (modelForDelegate(member.name) || RAW_METHODS.has(member.name));
    if (proves && ts.isIdentifier(node.expression)) handles.add(node.expression.text);

    if (ts.isVariableDeclaration(node) && node.initializer) {
      // `const u = db.user` and `const u = db["user"]`.
      const aliased = accessedMember(node.initializer);
      if (aliased && !aliased.computed && modelForDelegate(aliased.name) && ts.isIdentifier(node.name)) {
        bind(node.name.text, aliased.name);
      }
      // `const { user } = db`, `const { user: u } = db`, `const { "user": u } = db`.
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const source = element.propertyName ?? element.name;
          const property = ts.isIdentifier(source) || ts.isStringLiteralLike(source) ? source.text : null;
          if (property && modelForDelegate(property) && ts.isIdentifier(element.name)) {
            bind(element.name.text, property);
            if (ts.isIdentifier(node.initializer)) handles.add(node.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { bindings, handles };
}

/** The delegate a call's receiver stands for, or a computed-delegate marker. */
function resolveReceiver(node, bindings, handles) {
  if (ts.isIdentifier(node)) {
    const delegate = bindings.get(node.text);
    return delegate ? { delegate, computed: false } : null;
  }
  const member = accessedMember(node);
  if (!member) return null;
  if (member.computed) {
    return ts.isIdentifier(node.expression) && handles.has(node.expression.text)
      ? { delegate: null, computed: true }
      : null;
  }
  return modelForDelegate(member.name) ? { delegate: member.name, computed: false } : null;
}

/** The statically visible SQL of a raw call, or null when it is assembled. */
export function staticSqlText(node) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return staticSqlText(node.expression);
  if (ts.isTaggedTemplateExpression(node)) return staticSqlText(node.template);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => INTERPOLATION + span.literal.text)].join("");
  }
  return null;
}

/** Strip quoting and any schema qualifier from a captured table identifier. */
function bareTableName(token) {
  const unqualified = token.replace(/["`[\]]/gu, "").split(".").pop() ?? "";
  return unqualified.trim();
}

/**
 * Every mutating statement in a piece of SQL, resolved to a canonical model.
 * A table the map does not claim resolves to `null`, which the caller treats as
 * unattributable rather than as absent.
 */
export function findSqlMutations(sql, tables) {
  // SQL comments are stripped first: "-- update the audit row" is prose, and
  // reporting it as a mutation would be a false positive on real repositories.
  const uncommented = sql.replace(/--[^\n]*/gu, " ").replace(/\/\*[\s\S]*?\*\//gu, " ");
  const normalized = uncommented.replace(/\s+/gu, " ").toLowerCase();
  return [...normalized.matchAll(MUTATING_SQL_STATEMENT)].map((match) => ({
    statement: match[1],
    table: match[2],
    model: match[2].includes(INTERPOLATION) ? null : (tables.get(bareTableName(match[2])) ?? null),
  }));
}

/**
 * Find every mutation a file can reach, on the AST, so a delegate name in a
 * string, a comment or a type position is not a write.
 *
 * `writes` are mutations attributed to a canonical model; the caller decides
 * whether the package may make them. `unattributable` are mutations that reach
 * a canonical surface but cannot be pinned to a row — a computed delegate, a
 * raw statement assembled at runtime, a raw statement naming an unknown table —
 * which no package may make, because no owner can be checked.
 */
export function findWrites(virtualPath, text, tables = canonicalTables()) {
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const { bindings, handles } = collectDelegateBindings(sourceFile);
  const writes = [];
  const reads = [];
  const unattributable = [];
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    const callee = ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)
      ? (ts.isCallExpression(node) ? node.expression : node.tag)
      : null;
    const method = callee ? accessedMember(callee) : null;

    if (method && !method.computed && RAW_METHODS.has(method.name)) {
      const argument = ts.isTaggedTemplateExpression(node) ? node.template : node.arguments[0];
      const sql = staticSqlText(argument);
      if (sql === null) {
        unattributable.push({
          path: virtualPath,
          line: at(node),
          reason: "raw-sql-not-static",
          detail: `${method.name}() with SQL assembled at runtime`,
        });
      } else {
        for (const mutation of findSqlMutations(sql, tables)) {
          if (mutation.model && mutation.model in OWNER) {
            writes.push({ path: virtualPath, line: at(node), model: mutation.model, method: `${method.name}: ${mutation.statement}` });
          } else {
            unattributable.push({
              path: virtualPath,
              line: at(node),
              reason: "raw-sql-unknown-table",
              detail: `${method.name}() ${mutation.statement} ${mutation.table.replaceAll(INTERPOLATION, "${…}")}`,
            });
          }
        }
      }
    } else if (method && callee) {
      const receiver = resolveReceiver(callee.expression, bindings, handles);
      if (receiver?.computed) {
        unattributable.push({
          path: virtualPath,
          line: at(node),
          reason: "computed-delegate",
          detail: "a delegate chosen at runtime",
        });
      } else if (receiver) {
        // A DECLARED mutator, or a method chosen at runtime on a resolved
        // delegate. Everything else is left alone: a name in neither Prisma list
        // is evidence the receiver was never a delegate. The live tree proves
        // why that matters — `ports.repository.impersonationAudit.append(entry)`
        // in identity-access is a domain port named after the row it owns, and
        // "unrecognised method means write" reported four such calls as Prisma
        // mutations. Fail-closed on an unknown METHOD is the wrong axis; the
        // Prisma write API is finite and enumerated in MUTATING_DELEGATE_METHODS.
        const model = modelForDelegate(receiver.delegate);
        if (model && model in OWNER) {
          if (method.computed) {
            writes.push({ path: virtualPath, line: at(node), model, method: "[computed]" });
          } else if (MUTATORS.has(method.name)) {
            writes.push({ path: virtualPath, line: at(node), model, method: method.name });
          } else if (READERS.has(method.name)) {
            reads.push({ path: virtualPath, line: at(node), model, method: method.name });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { writes, reads, unattributable };
}

/** Half two: no package writes a row it does not own. */
export function checkWriteEnforcement(root = repositoryRoot, scanRoots = SCAN_ROOTS, tables = canonicalTables()) {
  const files = listSourceFiles(root, scanRoots);
  const violations = [];
  const unattributable = [];
  let writeCount = 0;
  let readCount = 0;

  for (const absolute of files) {
    const virtualPath = relative(root, absolute).split("\\").join("/");
    const found = findWrites(virtualPath, readFileSync(absolute, "utf8"), tables);
    readCount += found.reads.length;
    for (const write of found.writes) {
      writeCount += 1;
      const actual = owningPackage(virtualPath);
      const permitted = ownerDirectories(OWNER[write.model]);
      const expected = permitted[0];
      if (!permitted.includes(actual)) {
        violations.push({
          ...write,
          expected,
          permitted,
          actual,
          message: `${write.model}.${write.method}() may be called only from ${permitted.join(" or ")}; ${OWNER[write.model]} is its sole writer`,
        });
      }
    }
    for (const entry of found.unattributable) {
      unattributable.push({
        ...entry,
        actual: owningPackage(virtualPath),
        message: `${entry.detail} cannot be attributed to a canonical row, so no sole writer can be checked; name the delegate and the table literally`,
      });
    }
  }
  return { fileCount: files.length, writeCount, readCount, violations, unattributable };
}

export function check(root = repositoryRoot) {
  const integrity = checkMapIntegrity(root);
  const enforcement = checkWriteEnforcement(root);
  return { integrity, enforcement };
}

/** Everything that makes the run fail, so the banner and the exit code agree. */
export function failures(result) {
  return (
    result.integrity.problems.length +
    result.enforcement.violations.length +
    result.enforcement.unattributable.length
  );
}

function main() {
  const result = check();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = failures(result) > 0 ? 1 : 0;
    return;
  }

  const { integrity, enforcement } = result;
  process.stdout.write(
    `sole-writer: ${integrity.mappedModelCount} owned model(s) against ${integrity.schemaModelCount} in ${CANONICAL_SCHEMA}; ` +
      `scanned ${enforcement.fileCount} source file(s) under ${SCAN_ROOTS.join(", ")}\n`,
  );

  for (const problem of integrity.problems) process.stdout.write(`${problem}\n`);
  for (const violation of enforcement.violations) {
    process.stdout.write(`FAIL ${violation.path}:${violation.line} — ${violation.message}\n`);
  }
  for (const entry of enforcement.unattributable) {
    process.stdout.write(`FAIL ${entry.path}:${entry.line} — ${entry.message}\n`);
  }

  const failed = failures(result);
  if (failed === 0) {
    // The banner states the surface, not a verdict on the codebase. The old
    // wording — "no package writes a row it does not own" — claimed more than
    // the check could support, which is finding 3 of the 2026-09-02
    // verification. It now says exactly what was judged and what was not.
    process.stdout.write(
      `ok: every canonical row has exactly one owning context. Write enforcement judged ` +
        `${enforcement.writeCount} attributable mutation(s) and exempted ${enforcement.readCount} read(s) — ` +
        `delegate calls in direct, element-access, aliased, destructured and computed-method form, plus raw ` +
        `SQL — and found none reaching a row its package does not own, and nothing unattributable.\n`,
    );
    if (enforcement.writeCount === 0) {
      process.stdout.write(
        `note: 0 mutations judged — no V1 package imports the ORM yet, so this half is proven by ` +
          `fixtures alone and goes live with WIN-258. Map integrity above IS live. It reads one file ` +
          `at a time and never proves a receiver is a Prisma client; see the honest-limitations ` +
          `paragraph at the head of scripts/arch/sole-writer.mjs for what it does not cover. ` +
          `${BLANKET_OWNER.schema} is owned wholesale by ${BLANKET_OWNER.owner} (${BLANKET_OWNER.reason}).\n`,
      );
    }
  } else {
    process.stdout.write(`\n${failed} sole-writer problem(s).\n`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("sole-writer.mjs")) main();
