// WIN-302 — every context's contract factory resolves from `apps/core-api`,
// PROVED BY IMPORT, one named case per context.
//
// WHAT THE ISSUE ASKED, AND THE THREE THINGS THIS FILE HOLDS.
//
//   1. SEVENTEEN CASES, ONE PER CONTEXT, each of which IMPORTS that context's
//      factory from this package. The module graph settles whether a manifest
//      publishes an entry point; a paragraph cannot.
//
//   2. THE PARTITION, derived from the seventeen manifests and barrels rather
//      than typed, and joined to `UNIMPORTABLE_CONTEXT_FACTORIES`, which is now
//      empty. It lived in `installation.test.ts` until this tranche.
//
//   3. A READBACK OF THE PROSE. The count of importable factories was stated in
//      comments across the tree and went stale four times, each time while the
//      constant beside it was right. The last describe block reads every such
//      count back against the constant.
//
// WHY A FILE OF ITS OWN, MEASURED. `installation.test.ts` imports
// `app.module.ts`, which imports `identity-access`' and `tenancy`'
// `./application/index.js` statically, and `context-ports.ts`, which does the
// same for `governance`'. Remove one of those three entry points and that suite
// fails at LOAD, reporting "no tests" rather than naming what broke. This file
// imports neither module at its top, so each context's case stands alone.
//
// WHY EVERY CASE GOES THROUGH `factory-entries/`, ALSO MEASURED, FOR BOTH ROUTES.
// The obvious shape, a literal `await import("@platos/context-channels/application/index.js")`
// inside the case, does not fail the case when the manifest stops publishing
// that entry point. Vite resolves every literal specifier while TRANSFORMING the
// test file, so it fails the whole file. Reproduced at vitest 3.1.4 / vite 5.4.21
// before this file existed: `Missing "./application/index.js" specifier in
// "@platos/context-channels" package`, `Plugin: vite:import-analysis`,
// `Tests  no tests`.
//
// THE `.` ROUTE IS NO DIFFERENT, and this file once said it was. Its first
// version imported the seven `.`-route factories with a literal
// `await import("@platos/context-memory")` in each case, on the stated belief
// that a package's `.` resolves whenever the package exists. It does not:
// resolution needs `.` in `exports`. Deleting `exports["."]` from `memory`'s
// manifest failed this whole file at load (`Missing "." specifier in
// "@platos/context-memory" package`, `Tests 30 passed (30)` across this file
// and `installation.test.ts`, none of them here), so no named case went red.
//
// So all seventeen cases import a RELATIVE module, one per context, that
// re-exports the factory. The relative specifier resolves at transform time
// because the module file exists. That module's own transform runs only when
// the case loads it, so a rejected package specifier lands in the case.
// Measured both ways: deleting `channels`' subpath, or `memory`'s `.`, turned
// that one case red and left its sixteen siblings green (`mutations-win302.json`
// M04 and M11). A specifier assembled at run time would dodge the transform
// too, and rule (C4) in `scripts/arch/composition-root.mjs` refuses it for
// being invisible to every boundary check. Every import in this file and in
// `factory-entries/` is a literal the checks can read.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/** The subpath route twelve publish, spelled once. */
const APPLICATION_ENTRY = "./application/index.js";

/**
 * The seventeen ADR M0.3 §4 names, spelled out rather than globbed. A directory
 * listing would shrink with the tree and turn the partition into a statement
 * about whatever happened to be on disk.
 */
const CONTEXTS = [
  "identity-access", "tenancy", "secrets", "providers", "agents", "skills",
  "tools", "memory", "channels", "files", "observability", "cost-monitoring",
  "governance", "jobs", "conversations", "eventing", "privacy",
] as const;

type Route = "." | typeof APPLICATION_ENTRY;

const manifestOf = (context: string): { readonly exports?: Record<string, unknown> } =>
  JSON.parse(readFileSync(`${ROOT}packages/contexts/${context}/package.json`, "utf8")) as {
    readonly exports?: Record<string, unknown>;
  };

/**
 * The factory NAMES a context may publish, derived from its DIRECTORY NAME:
 * `cost-monitoring` gives `costMonitoringContract`, `createCostMonitoringContract`,
 * `costMonitoringService` and `createCostMonitoringService`. So nothing here is a
 * list of names somebody has to remember to extend.
 */
const factoryNames = (context: string): readonly string[] => {
  const pascal = context
    .split("-")
    .map((part) => `${(part[0] ?? "").toUpperCase()}${part.slice(1)}`)
    .join("");
  const camel = `${(pascal[0] ?? "").toLowerCase()}${pascal.slice(1)}`;
  return [`${camel}Contract`, `create${pascal}Contract`, `${camel}Service`, `create${pascal}Service`];
};

/**
 * Which of `wanted` a barrel exports as a VALUE, following `export *` up to two
 * levels.
 *
 * `tenancy`, `agents` and `privacy` all star-export inside their root barrels,
 * so a rule that stopped at the barrel's own text would answer "no factory" for
 * a context that publishes one through a star. It READS the files rather than
 * importing them, because the question is what the barrel says, and the import
 * half is the seventeen cases below.
 */
const exportedFactory = (file: string, wanted: readonly string[], depth = 0): string | null => {
  if (depth > 2 || !existsSync(file)) return null;
  const source = readFileSync(file, "utf8");
  for (const name of wanted) {
    if (new RegExp(`^export function ${name}\\s*(?:<|\\()`, "mu").test(source)) return name;
    if (new RegExp(`^export const ${name}\\b`, "mu").test(source)) return name;
    if (new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\} from `, "msu").test(source)) return name;
  }
  for (const match of source.matchAll(/^export \* from "(\.[^"]+)";/gmu)) {
    const relative = (match[1] ?? "").replace(/\.js$/u, ".ts");
    const target = new URL(relative, new URL(file, "file:///"));
    const found = exportedFactory(fileURLToPath(target), wanted, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

const barrelOf = (context: string): string => `${ROOT}packages/contexts/${context}/contracts/index.ts`;
const applicationOf = (context: string): string => `${ROOT}packages/contexts/${context}/application/index.ts`;

const onDotBarrel = (context: string): boolean => exportedFactory(barrelOf(context), factoryNames(context)) !== null;

const publishesApplicationEntry = (context: string): boolean =>
  manifestOf(context).exports?.[APPLICATION_ENTRY] !== undefined;

/**
 * The assertion every one of the seventeen cases makes about the module it
 * IMPORTED.
 *
 * The import has already happened by the time this runs. A manifest that does
 * not publish the entry point rejects inside the case, which is the red the
 * issue asks for. This helper then checks that the module holds EXACTLY ONE
 * factory the directory name implies, that the factory takes one bundle like its
 * sixteen siblings, and that the ROUTE the case declares is the route the
 * manifest and barrel actually offer. That last check is the join: a case cannot
 * claim the `.` route for a context whose barrel has no factory, and it cannot
 * use the subpath for a context whose barrel has one.
 */
function expectFactoryImport(context: (typeof CONTEXTS)[number], route: Route, imported: object): void {
  const module = imported as Readonly<Record<string, unknown>>;
  const found = factoryNames(context).filter((name) => typeof module[name] === "function");
  expect(found, `${context} must publish exactly one factory its directory name implies`).toHaveLength(1);
  const factory = module[found[0] ?? ""] as (...bundle: never[]) => unknown;
  expect(factory, `${context}'s factory takes its dependency bundle and nothing else`).toHaveLength(1);

  if (route === ".") {
    expect(onDotBarrel(context), `${context} is imported from \`.\`, so its barrel must export the factory`).toBe(true);
  } else {
    expect(publishesApplicationEntry(context), `${context}'s manifest must publish ${APPLICATION_ENTRY}`).toBe(true);
    expect(onDotBarrel(context), `${context}'s factory is on \`.\`, so it must be imported from there`).toBe(false);
  }
}

describe("every context's contract factory resolves from apps/core-api, proved by import", () => {
  // ROUTE ONE, THE `.` BARREL. Seven contexts re-export their factory there.
  it("agents: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("agents", ".", await import("./factory-entries/agents.js"));
  });
  it("conversations: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("conversations", ".", await import("./factory-entries/conversations.js"));
  });
  it("cost-monitoring: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("cost-monitoring", ".", await import("./factory-entries/cost-monitoring.js"));
  });
  it("memory: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("memory", ".", await import("./factory-entries/memory.js"));
  });
  it("providers: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("providers", ".", await import("./factory-entries/providers.js"));
  });
  it("secrets: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("secrets", ".", await import("./factory-entries/secrets.js"));
  });
  it("tools: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("tools", ".", await import("./factory-entries/tools.js"));
  });

  // ROUTE TWO, THE `./application/index.js` SUBPATH.
  // `channels`, `eventing`, `files`, `jobs`, `observability` and `privacy`
  // resolve only because WIN-302 added them to `APPLICATION_ENTRY_PROJECTS`.
  it("channels: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("channels", APPLICATION_ENTRY, await import("./factory-entries/channels.js"));
  });
  it("eventing: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("eventing", APPLICATION_ENTRY, await import("./factory-entries/eventing.js"));
  });
  it("files: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("files", APPLICATION_ENTRY, await import("./factory-entries/files.js"));
  });
  it("governance: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("governance", APPLICATION_ENTRY, await import("./factory-entries/governance.js"));
  });
  it("identity-access: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("identity-access", APPLICATION_ENTRY, await import("./factory-entries/identity-access.js"));
  });
  it("jobs: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("jobs", APPLICATION_ENTRY, await import("./factory-entries/jobs.js"));
  });
  it("observability: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("observability", APPLICATION_ENTRY, await import("./factory-entries/observability.js"));
  });
  it("privacy: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("privacy", APPLICATION_ENTRY, await import("./factory-entries/privacy.js"));
  });
  it("skills: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("skills", APPLICATION_ENTRY, await import("./factory-entries/skills.js"));
  });
  it("tenancy: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("tenancy", APPLICATION_ENTRY, await import("./factory-entries/tenancy.js"));
  });
});

/** One declared case above, read off this file's own text. */
interface DeclaredCase {
  readonly title: string;
  readonly context: string;
  readonly route: string;
  readonly specifier: string;
}

/**
 * The cases above as WRITTEN, so the partition can join to them.
 *
 * Without this, deleting a case would go unnoticed: the partition would still
 * derive every context's route from the manifests and pass, while one of them
 * was no longer imported by anything.
 */
function declaredCases(): readonly DeclaredCase[] {
  const source = readFileSync(THIS_FILE, "utf8");
  const shape =
    /it\("([^"]+)", async \(\) => \{\s*expectFactoryImport\("([a-z-]+)", ("\."|APPLICATION_ENTRY), await import\("([^"]+)"\)\);\s*\}\);/gu;
  return [...source.matchAll(shape)].map((match) => ({
    title: match[1] ?? "",
    context: match[2] ?? "",
    route: match[3] === '"."' ? "." : APPLICATION_ENTRY,
    specifier: match[4] ?? "",
  }));
}

describe("the importability partition, derived rather than typed", () => {
  it("partitions all seventeen by DERIVING both routes, and leaves none unimportable", async () => {
    // ROUTE ONE, FROM THE BARRELS. `conversations` sat on the unimportable list
    // for two tranches while its barrel re-exported `createConversationsContract`,
    // because this half was a literal compared to another literal. It is derived
    // now, and pinned to what the derivation MEASURES at this head.
    const derivedOnDot = CONTEXTS.filter(onDotBarrel);
    expect([...derivedOnDot].sort()).toEqual([
      "agents", "conversations", "cost-monitoring", "memory", "providers", "secrets", "tools",
    ]);

    // ROUTE TWO, FROM THE MANIFESTS the resolver reads. WIN-302 moved six
    // contexts onto it, so it grew from six manifests to twelve.
    const publishesEntry = CONTEXTS.filter(publishesApplicationEntry);
    expect([...publishesEntry].sort()).toEqual([
      "agents", "channels", "eventing", "files", "governance", "identity-access",
      "jobs", "observability", "privacy", "secrets", "skills", "tenancy",
    ]);
    // `agents` and `secrets` are on both routes. They publish their in-memory
    // doubles from the subpath for the adapter's conformance differentials.
    expect(derivedOnDot.filter((context) => publishesEntry.includes(context)).sort()).toEqual([
      "agents",
      "secrets",
    ]);

    // THE PARTITION OVER ALL SEVENTEEN. Importable is the union of the two
    // routes, and the complement must be the constant, compared as sets. A
    // context cannot fall out of both halves and be counted by neither.
    const importable = new Set<string>([...derivedOnDot, ...publishesEntry]);
    expect(importable.size).toBe(17);
    // Imported inside the case and not at the top: `context-ports.ts` imports
    // `governance`' subpath statically, so a top-level import would make that
    // context's entry point fail this whole file at load.
    const { UNIMPORTABLE_CONTEXT_FACTORIES } = await import("./context-ports.js");
    expect(CONTEXTS.filter((context) => !importable.has(context)).sort()).toEqual(
      [...UNIMPORTABLE_CONTEXT_FACTORIES].sort(),
    );
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).toEqual([]);

    // THE JOIN TO THE CASES. Every context has exactly one case, each case loads
    // that context's module under `factory-entries/`, and each module re-exports
    // ONE name through the route the derivation gives it: `.` wherever the
    // barrel carries the factory, and the subpath otherwise. The name must be
    // the one the barrel or `application/index.ts` actually exports, so a module
    // cannot import a route whose source holds no such factory.
    const cases = declaredCases();
    expect(cases.map((row) => row.context).sort()).toEqual([...CONTEXTS].sort());
    for (const row of cases) {
      expect(row.title, "a case is named by the context it imports").toBe(
        `${row.context}: its contract factory resolves from apps/core-api, proved by import`,
      );
      expect(row.specifier, "a case loads its context's own module").toBe(`./factory-entries/${row.context}.js`);
      const onDot = derivedOnDot.includes(row.context as (typeof CONTEXTS)[number]);
      expect(row.route).toBe(onDot ? "." : APPLICATION_ENTRY);

      const entry = readFileSync(join(HERE, "factory-entries", `${row.context}.ts`), "utf8");
      expect(
        [...entry.matchAll(/\bfrom "([^"]+)"/gu)].map((match) => match[1]),
        `factory-entries/${row.context}.ts imports one specifier and nothing else`,
      ).toHaveLength(1);
      expect([...entry.matchAll(/^export \{ (\w+) \} from "([^"]+)";$/gmu)].map((match) => [match[1], match[2]])).toEqual([
        onDot
          ? [exportedFactory(barrelOf(row.context), factoryNames(row.context)), `@platos/context-${row.context}`]
          : [
              exportedFactory(applicationOf(row.context), factoryNames(row.context)),
              `@platos/context-${row.context}${APPLICATION_ENTRY.slice(1)}`,
            ],
      ]);
    }
    // One module per case and no stray one: a module nobody loads is dead surface.
    expect(readdirSync(join(HERE, "factory-entries")).sort()).toEqual(
      cases.map((row) => `${row.context}.ts`).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// THE PROSE READBACK.
//
// The count of importable factories has been printed in comments and has gone
// stale four times, twice in files whose constant beside it was right. The
// fifth time should be a red case, not a reader's catch. So this block reads
// every sentence in the repository that counts importable or unimportable
// factories and compares the figure to `UNIMPORTABLE_CONTEXT_FACTORIES`.
//
// WHERE IT READS. Every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` and
// `.md` file under the repository root, skipping `node_modules`, `dist`,
// `generated` and the tool caches. Not V1 projects only: its first version
// read those plus `scripts/arch`, and a stale count in `docs/` or a legacy app
// would have passed. JSON is not read. It is data, and the mutation ledgers
// quote each stale wording verbatim as the text a mutation put back.
//
// WHAT IT READS IN A FILE. In code, every comment, found by a scanner that
// knows string, template and regular-expression literals. So a `//` inside a
// URL string is not a comment, and a trailing comment after code IS one. Its
// first version read whole comment lines only, and a trailing comment evaded
// it. Comments separated by nothing but whitespace form one block. The titles
// of cases and groups are read too. In Markdown, every paragraph outside fenced
// code.
//
// WHAT COUNTS AS A CLAIM. A figure is a number word or a one- or two-digit
// numeral ("one" after "the", "every", "each", "any", "this", "that", "which",
// "is", "a" or "no" is a pronoun, not a figure). It counts only beside a word
// that makes the claim:
//
//   ADJECTIVES "importable", "reachable", "resolvable" and "nameable", negative
//   with "un" or after "not", "n't", "no longer" or "never". PASSIVES "can be
//   imported", "reached", "resolved" or "named", negative after "cannot". The
//   verb "resolve(s) from", negative after "do not" or "does not". The count
//   comes BEFORE these, so the figure read is the nearest one before the word,
//   within twelve words. When that figure closes an "N of the M" phrase, N is
//   read. With no figure before, the first figure AFTER the word is read, when
//   it is within six words and a "factory" or "factories" stands between.
//
//   ACTIVE verbs "can import", "cannot import", "can resolve" and "cannot
//   resolve". The count comes AFTER these, so the figure read is the first one
//   between the verb and "factory" or "factories", with the nearest one before
//   the verb as a fallback.
//
// Every form except the bare "importable" family counts only in a clause that
// also says "factory" or "factories", because a sentence such as "this package
// cannot import the outbox's one runner" is about something else.
//
// QUOTATION MARKS EXEMPT A FIGURE, and that is the one convention this
// imposes. Withdrawn wordings are worth keeping as history, so a figure inside
// "double quotes" is read as quoted and skipped. Text in `backticks` is code and
// skipped too. Anything else is a claim about now, and must agree with the
// constant.
//
// HONEST LIMITATIONS, each pinned by a planted row in the first case below. A
// count with none of those words, such as "the root composes all nine of them",
// is not read. Neither is a figure across a colon, as in "importable factories:
// eleven". A figure within twelve words before the word is read as its count
// even when it counts something else nearby, which over-reports rather than
// under-reports. The partition case above is still the authority on the figure.
// This block only stops the prose from contradicting it.
// ---------------------------------------------------------------------------

/** The claim a figure makes, and the figure the partition says it must be. */
interface CountClaim {
  readonly file: string;
  readonly claim: "importable" | "unimportable";
  readonly figure: number;
  readonly expected: number;
  readonly word: string;
  readonly clause: string;
}

interface Figure {
  readonly value: number;
  readonly index: number;
  readonly end: number;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
});
const FIGURE = new RegExp(
  [
    `(?<![\\w\\-.:§/#])(\\d{1,2})(?![\\w\\-.:/])`,
    `(?<!\\b(?:the|every|each|any|this|that|which|is|a|no)\\s+)\\b(one)\\b`,
    `\\b(${Object.keys(NUMBER_WORDS).filter((word) => word !== "one").join("|")})\\b`,
  ].join("|"),
  "giu",
);

const ADJECTIVE = "importable|reachable|resolvable|nameable";
const CLAIM = new RegExp(
  [
    `(?<![\\w-])(?:un|not |no longer |never )?(?:${ADJECTIVE})\\b`,
    `(?<![\\w-])(?:cannot|can't|can not|can)(?: (?:no longer|not|only|still|now))? be (?:imported|reached|resolved|named)\\b`,
    `(?<![\\w-])(?:cannot|can't|can not|can)(?: (?:no longer|not|only|still|now))? (?:import|resolve)\\b`,
    `(?<![\\w-])(?:(?:do|does|did) not |don't |doesn't |no longer |now |still |only )?resolves? from\\b`,
  ].join("|"),
  "giu",
);
const ACTIVE = /^(?:cannot|can't|can not|can)(?: \w+(?: \w+)?)? (?:import|resolve)$/u;
const NEGATIVE_FORM = /^(?:un|not |no longer |never |cannot|can't|can not|do not|does not|did not|don't|doesn't)/u;
const NEGATOR_BEFORE = /(?:\bnot|n't|\bno longer|\bnever)\s+(?:\w+\s+)?$/iu;
const BARE_IMPORTABLE = /^(?:un|not |no longer |never )?importable$/u;
const FACTORY_WORD = /\bfactor(?:y|ies)\b/iu;
/** Cheap test for a file or block that could hold a claim at all. */
const MAY_CLAIM = /importable|reachable|resolvable|nameable|be (?:imported|reached|resolved|named)|can(?:not|'t| not)? (?:import|resolve)|resolves? from/iu;

/** The figures in a stretch of text, in order, with where each sits. */
const figuresIn = (text: string, offset: number): Figure[] =>
  [...text.matchAll(FIGURE)].map((match) => {
    const word = (match[2] ?? match[3] ?? "").toLowerCase();
    return {
      value: match[1] !== undefined ? Number(match[1]) : (NUMBER_WORDS[word] ?? Number.NaN),
      index: offset + (match.index ?? 0),
      end: offset + (match.index ?? 0) + match[0].length,
    };
  });

const wordCount = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

/** Words after which a `/` opens a regular-expression literal rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/**
 * Every comment in a JavaScript or TypeScript source, with where it starts and
 * ends.
 *
 * A scanner rather than a line match, so that the two things a line match gets
 * wrong are right: a `//` inside a string, template or regular expression is
 * not a comment, and a `//` after code on the same line is. A `/` is read as a
 * regular expression after punctuation that cannot end a value, or after a
 * keyword such as `return`, and as division otherwise.
 */
function commentsIn(source: string): { text: string; start: number; end: number }[] {
  const comments: { text: string; start: number; end: number }[] = [];
  const substitutions: number[] = [];
  let braces = 0;
  let previous = "";
  let at = 0;
  const length = source.length;
  const template = (): void => {
    while (at < length) {
      const character = source[at];
      if (character === "\\") {
        at += 2;
      } else if (character === "`") {
        at += 1;
        previous = "value";
        return;
      } else if (character === "$" && source[at + 1] === "{") {
        at += 2;
        substitutions.push(braces);
        braces += 1;
        previous = "{";
        return;
      } else {
        at += 1;
      }
    }
  };
  while (at < length) {
    const character = source[at] ?? "";
    const next = source[at + 1];
    if (character === "/" && next === "/") {
      const newline = source.indexOf("\n", at);
      const end = newline === -1 ? length : newline;
      comments.push({ text: source.slice(at + 2, end).replace(/^\/+/u, ""), start: at, end });
      at = end;
    } else if (character === "/" && next === "*") {
      const close = source.indexOf("*/", at + 2);
      const end = close === -1 ? length : close + 2;
      const body = source.slice(at + 2, close === -1 ? length : close);
      comments.push({ text: body.split("\n").map((line) => line.replace(/^\s*\*+ ?/u, "")).join("\n"), start: at, end });
      at = end;
    } else if (character === '"' || character === "'") {
      at += 1;
      while (at < length && source[at] !== character && source[at] !== "\n") at += source[at] === "\\" ? 2 : 1;
      at += 1;
      previous = "value";
    } else if (character === "`") {
      at += 1;
      template();
    } else if (character === "{") {
      braces += 1;
      previous = "{";
      at += 1;
    } else if (character === "}") {
      braces -= 1;
      at += 1;
      if (substitutions.length > 0 && substitutions[substitutions.length - 1] === braces) {
        substitutions.pop();
        template();
      } else {
        previous = "}";
      }
    } else if (character === "/") {
      const regex = previous === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/u.test(previous) || REGEX_AFTER_WORD.has(previous);
      at += 1;
      if (regex) {
        let inClass = false;
        while (at < length && source[at] !== "\n") {
          const inner = source[at];
          if (inner === "\\") {
            at += 2;
            continue;
          }
          if (inner === "[") inClass = true;
          else if (inner === "]") inClass = false;
          else if (inner === "/" && !inClass) break;
          at += 1;
        }
        at += 1;
        while (at < length && /[a-z]/u.test(source[at] ?? "")) at += 1;
        previous = "value";
      } else {
        previous = "/";
      }
    } else if (/\s/u.test(character)) {
      at += 1;
    } else if (/[\w$]/u.test(character)) {
      let end = at;
      while (end < length && /[\w$]/u.test(source[end] ?? "")) end += 1;
      const word = source.slice(at, end);
      previous = REGEX_AFTER_WORD.has(word) ? word : "value";
      at = end;
    } else {
      previous = character;
      at += 1;
    }
  }
  return comments;
}

/** The stretches of prose in one file: comment blocks and titles, or Markdown paragraphs. */
function proseBlocks(file: string, source: string): string[] {
  if (file.endsWith(".md")) {
    const outsideFences = source.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, " ");
    return outsideFences.split(/\n\s*\n/u).map((paragraph) => paragraph.replace(/\s+/gu, " "));
  }
  const blocks: string[] = [];
  let current: string[] = [];
  let lastEnd = 0;
  for (const comment of commentsIn(source)) {
    if (current.length > 0 && !/^\s*$/u.test(source.slice(lastEnd, comment.start))) {
      blocks.push(current.join(" "));
      current = [];
    }
    current.push(comment.text);
    lastEnd = comment.end;
  }
  if (current.length > 0) blocks.push(current.join(" "));
  for (const title of source.matchAll(/\b(?:it|test|describe)(?:\.[a-z]+)*\(\s*"([^"\\]*)"/gu)) {
    blocks.push(title[1] ?? "");
  }
  return blocks.map((block) => block.replace(/\s+/gu, " "));
}

/**
 * Every importability count stated in one file's prose.
 *
 * The negative controls below call it on planted text, so the readback is shown
 * to SEE a stale figure before it is trusted to report none.
 */
function countClaims(
  file: string,
  source: string,
  counts: { readonly importable: number; readonly unimportable: number },
): { claims: CountClaim[]; unbalanced: string[] } {
  const claims: CountClaim[] = [];
  const unbalanced: string[] = [];
  for (const block of proseBlocks(file, source)) {
    if (!MAY_CLAIM.test(block)) continue;
    const unquoted = block.replace(/`[^`]*`/gu, " CODE ");
    if ((unquoted.match(/"/gu) ?? []).length % 2 !== 0) {
      unbalanced.push(`${file}: ${block.slice(0, 160)}`);
      continue;
    }
    const prose = unquoted.replace(/"[^"]*"/gu, " QUOTE ").replace(/\s+/gu, " ");
    for (const clause of prose.split(/[.;:?!](?=\s|$)|\s[—–]\s|\s--\s/u)) {
      const keywords = [...clause.matchAll(CLAIM)];
      keywords.forEach((keyword, position) => {
        const word = keyword[0].toLowerCase();
        const at = keyword.index ?? 0;
        const end = at + keyword[0].length;
        const earlierKeyword = keywords[position - 1];
        const laterKeyword = keywords[position + 1];
        const segmentStart = earlierKeyword === undefined ? 0 : (earlierKeyword.index ?? 0) + earlierKeyword[0].length;
        const segmentEnd = laterKeyword === undefined ? clause.length : (laterKeyword.index ?? clause.length);
        if (!BARE_IMPORTABLE.test(word) && !FACTORY_WORD.test(clause)) return;

        const active = ACTIVE.test(word);
        const negative =
          NEGATIVE_FORM.test(word) ||
          / not /u.test(word) ||
          NEGATOR_BEFORE.test(clause.slice(Math.max(segmentStart, at - 30), at));

        let figure: Figure | undefined;
        if (active) {
          const tail = clause.slice(end, segmentEnd);
          const factory = tail.search(FACTORY_WORD);
          if (factory >= 0) figure = figuresIn(tail.slice(0, factory), end)[0];
        }
        if (figure === undefined) {
          const before = figuresIn(clause.slice(segmentStart, at), segmentStart);
          let nearest = before[before.length - 1];
          if (nearest !== undefined && wordCount(clause.slice(nearest.index, at)) > 12) nearest = undefined;
          const earlier = before[before.length - 2];
          if (
            nearest !== undefined &&
            earlier !== undefined &&
            /^\s+of(?:\s+(?:the|these|those|its|all))?\s+$/iu.test(clause.slice(earlier.end, nearest.index))
          ) {
            nearest = earlier;
          }
          figure = nearest;
        }
        if (figure === undefined && !active) {
          const after = figuresIn(clause.slice(end, segmentEnd), end)[0];
          const between = after === undefined ? "" : clause.slice(end, after.index);
          if (after !== undefined && wordCount(between) <= 6 && FACTORY_WORD.test(between)) figure = after;
        }
        if (figure === undefined) return;

        const claim = negative ? "unimportable" : "importable";
        claims.push({
          file,
          claim,
          figure: figure.value,
          expected: claim === "unimportable" ? counts.unimportable : counts.importable,
          word,
          clause: clause.trim().slice(0, 200),
        });
      });
    }
  }
  return { claims, unbalanced };
}

/** Directory names the walk never enters: dependencies, build output, generated code, tool caches. */
const NOT_PROSE = new Set(["node_modules", "dist", "generated", ".git", ".turbo", ".next", ".cache", ".output", ".vercel", "coverage"]);

/**
 * Every file under the repository root that can hold prose this block reads.
 *
 * The whole tree rather than a list of projects. A list is a statement about
 * where somebody expected the claim to be, and the claim has already turned up
 * in a generator script outside every V1 project.
 */
function proseFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (NOT_PROSE.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts|js|mjs|cjs|md)$/u.test(entry.name)) files.push(full);
    }
  };
  walk(ROOT);
  return files;
}

describe("prose that counts importable context factories", () => {
  it("SEES a stale figure, and skips one in quotation marks, before it is trusted", () => {
    const now = { importable: 17, unimportable: 0 };
    const stale = (source: string, file = "planted.ts", counts = now) =>
      countClaims(file, source, counts)
        .claims.filter((claim) => claim.figure !== claim.expected)
        .map((claim) => ({ claim: claim.claim, figure: claim.figure }));

    // Each planted text is a string LITERAL, so this file's own scan reads none
    // of them as a comment. A title is split across two literals for the same
    // reason. `[source, file, expected]`, one row per wording.
    const seen: readonly (readonly [string, string, { claim: string; figure: number }])[] = [
      // THE FOUR WORDINGS THAT WENT STALE IN THIS TREE, verbatim.
      ["// SEVENTEEN publish one; NINE are importable.", "planted.ts", { claim: "importable", figure: 9 }],
      [["/**", " * The eight contexts whose contract factory this root cannot IMPORT.", " */"].join("\n"), "planted.ts", { claim: "unimportable", figure: 8 }],
      ["//   SIX not importable  channels, eventing, files, jobs, observability,", "planted.ts", { claim: "unimportable", figure: 6 }],
      [["it", '("cannot import SIX context factories, and partitions all seventeen", () => {});'].join(""), "planted.ts", { claim: "unimportable", figure: 6 }],
      // THE FOUR THAT EVADED THIS BLOCK'S FIRST VERSION (the round-1 verifier's probes).
      ["// Only 11 context factories can be imported from this root.", "planted.ts", { claim: "importable", figure: 11 }],
      ["// Six context factories are unreachable from apps/core-api.", "planted.ts", { claim: "unimportable", figure: 6 }],
      ["// The importable factories number eleven.", "planted.ts", { claim: "importable", figure: 11 }],
      ["const probe = 1; // NINE are importable.", "planted.ts", { claim: "importable", figure: 9 }],
      // AND THE OTHER SHAPES THE RULES ABOVE NAME.
      ["// Nine factories are reachable from here.", "planted.ts", { claim: "importable", figure: 9 }],
      ["// Eleven of the seventeen factories are importable.", "planted.ts", { claim: "importable", figure: 11 }],
      ["// Six context factories aren't importable.", "planted.ts", { claim: "unimportable", figure: 6 }],
      ["// Only eleven context factories resolve from apps/core-api.", "planted.ts", { claim: "importable", figure: 11 }],
      ["// Six factories do not resolve from this package.", "planted.ts", { claim: "unimportable", figure: 6 }],
      ["// This root can resolve 11 of the factories.", "planted.ts", { claim: "importable", figure: 11 }],
      ["// Six factories cannot be reached from here.", "planted.ts", { claim: "unimportable", figure: 6 }],
      ["// Eleven factories are nameable from the composition root.", "planted.ts", { claim: "importable", figure: 11 }],
      ['matcher(/"/gu); // SIX are unimportable', "planted.ts", { claim: "unimportable", figure: 6 }],
      ["Six context factories are not importable from apps/core-api.\n", "planted.md", { claim: "unimportable", figure: 6 }],
    ];
    for (const [source, file, expected] of seen) {
      expect(stale(source, file), `must be SEEN: ${source}`).toEqual([expected]);
    }

    const passed: readonly (readonly [string, string])[] = [
      // QUOTED, it is history and passes. Unquoted and true, it passes.
      ['// It read "SEVENTEEN publish one; NINE are importable".', "planted.ts"],
      ["// SEVENTEEN are importable, and NONE is unimportable.", "planted.ts"],
      // A sentence about some other import is not a count of factories.
      ["// so this package cannot import the outbox's one runner", "planted.ts"],
      ["// One store-unreachable refusal, raised from each command of the same factory.", "planted.ts"],
      ["// the 2 handlers resolve the promise their factory returns", "planted.ts"],
      ["// every one of the seventeen factories now resolves from this package", "planted.ts"],
      // Not a comment at all: a string, a template, a regular expression, a fence.
      ['const url = "https://example.test // NINE are importable";', "planted.ts"],
      ["const text = `// NINE are importable ${value}`; const after = 2;", "planted.ts"],
      ["const pattern = /\\/\\/ NINE are importable/u;", "planted.ts"],
      ["```\nSix context factories are not importable.\n```\n", "planted.md"],
    ];
    for (const [source, file] of passed) {
      expect(stale(source, file), `must NOT be read as a stale count: ${source}`).toEqual([]);
    }

    // THE DOCUMENTED LIMITS, pinned so the paragraph above cannot overstate what
    // this block sees. Each is stale and each passes. Whoever teaches the
    // readback to see one moves its row up to `seen` and edits that paragraph.
    const unseen: readonly string[] = [
      "// The root composes all nine of them.",
      "// Importable factories: eleven.",
    ];
    for (const source of unseen) {
      expect(stale(source), `a documented limit, not seen: ${source}`).toEqual([]);
    }

    // AND THE SAME TRUE SENTENCE GOES RED WHEN THE CONSTANT MOVES. Both of its
    // figures now disagree, which is what the tree-wide case below catches.
    expect(
      stale("// SEVENTEEN are importable, and NONE is unimportable.", "planted.ts", { importable: 16, unimportable: 1 }),
    ).toEqual([
      { claim: "importable", figure: 17 },
      { claim: "unimportable", figure: 0 },
    ]);

    // An unbalanced quotation is reported, not guessed at.
    expect(countClaims("planted.ts", '// It read "NINE are importable.', now).unbalanced).toHaveLength(1);
  });

  it("states no count of importable factories that UNIMPORTABLE_CONTEXT_FACTORIES does not measure", async () => {
    const { UNIMPORTABLE_CONTEXT_FACTORIES } = await import("./context-ports.js");
    const counts = {
      importable: CONTEXTS.length - UNIMPORTABLE_CONTEXT_FACTORIES.length,
      unimportable: UNIMPORTABLE_CONTEXT_FACTORIES.length,
    };

    const claims: CountClaim[] = [];
    const unbalanced: string[] = [];
    for (const file of proseFiles()) {
      const source = readFileSync(file, "utf8");
      if (!MAY_CLAIM.test(source)) continue;
      const found = countClaims(file.slice(ROOT.length), source, counts);
      claims.push(...found.claims);
      unbalanced.push(...found.unbalanced);
    }

    expect(unbalanced, "a quotation that does not close cannot be told apart from a claim").toEqual([]);
    expect(
      claims.filter((claim) => claim.figure !== claim.expected),
      "correct the figure, or put a withdrawn wording in double quotation marks",
    ).toEqual([]);

    // NOT VACUOUS. The two files this readback exists for are the ones whose
    // prose went stale, and each must still state the count so the comparison
    // above reads a figure. An extractor that saw nothing would pass on nothing.
    const where = new Set(claims.map((claim) => claim.file));
    expect(where).toContain("apps/core-api/src/composition/context-ports.ts");
    expect(where).toContain("scripts/arch/gen-v1-skeleton.mjs");
  }, 60_000);
});
