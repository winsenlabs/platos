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
// WHY THE SUBPATH IMPORTS GO THROUGH `factory-entries/`, ALSO MEASURED. The
// obvious shape, a literal `await import("@platos/context-channels/application/index.js")`
// inside the case, does not fail the case when the manifest stops publishing the
// subpath. Vite resolves every literal specifier while TRANSFORMING the test file,
// so it fails the whole file. Reproduced at vitest 3.1.4 / vite 5.4.21 before this
// file existed: `Missing "./application/index.js" specifier in
// "@platos/context-channels" package`, `Plugin: vite:import-analysis`,
// `Tests  no tests`. A RELATIVE literal import of a module that re-exports the
// factory resolves at transform time because the module file exists. That
// module's own transform runs only when the case loads it, so the rejection
// lands in the case. Measured the same way, deleting the channels entry turned
// that one case red and left its siblings green. A specifier assembled at run
// time would dodge the transform too, and rule (C4) in
// `scripts/arch/composition-root.mjs` refuses it for being invisible to every
// boundary check. Every import in this file and in `factory-entries/` is a
// literal the checks can read.
//
// THE `.` ROUTE NEEDS NO MODULE. A literal import of a package's `.` entry
// resolves at transform time whenever the package exists, and every consumer
// in this tree already depends on that. So a factory that leaves its barrel
// shows up as `undefined` in its own case, not as a load failure.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/** The subpath route two publishes, spelled once. */
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

const onDotBarrel = (context: string): boolean =>
  exportedFactory(`${ROOT}packages/contexts/${context}/contracts/index.ts`, factoryNames(context)) !== null;

const publishesApplicationEntry = (context: string): boolean =>
  manifestOf(context).exports?.[APPLICATION_ENTRY] !== undefined;

/**
 * The assertion every one of the seventeen cases makes about the module it
 * IMPORTED.
 *
 * The import has already happened by the time this runs. A manifest that does
 * not publish the subpath rejects inside the case, which is the red the issue
 * asks for. This helper then checks that the module holds EXACTLY ONE factory
 * the directory name implies, that the factory takes one bundle like its sixteen
 * siblings, and that the ROUTE the case declares is the route the manifest and
 * barrel actually offer. That last check is the join: a case cannot claim the
 * `.` route for a context whose barrel has no factory, and it cannot use the
 * subpath for a context whose barrel has one.
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
    expectFactoryImport("agents", ".", await import("@platos/context-agents"));
  });
  it("conversations: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("conversations", ".", await import("@platos/context-conversations"));
  });
  it("cost-monitoring: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("cost-monitoring", ".", await import("@platos/context-cost-monitoring"));
  });
  it("memory: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("memory", ".", await import("@platos/context-memory"));
  });
  it("providers: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("providers", ".", await import("@platos/context-providers"));
  });
  it("secrets: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("secrets", ".", await import("@platos/context-secrets"));
  });
  it("tools: its contract factory resolves from apps/core-api, proved by import", async () => {
    expectFactoryImport("tools", ".", await import("@platos/context-tools"));
  });

  // ROUTE TWO, THE `./application/index.js` SUBPATH, one module per context.
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

    // THE JOIN TO THE CASES. Every context has exactly one case, and each case
    // imports through the route the derivation gives it: `.` wherever the barrel
    // carries the factory, and the subpath otherwise.
    const cases = declaredCases();
    expect(cases.map((row) => row.context).sort()).toEqual([...CONTEXTS].sort());
    for (const row of cases) {
      expect(row.title, "a case is named by the context it imports").toBe(
        `${row.context}: its contract factory resolves from apps/core-api, proved by import`,
      );
      if (derivedOnDot.includes(row.context as (typeof CONTEXTS)[number])) {
        expect(row.route).toBe(".");
        expect(row.specifier).toBe(`@platos/context-${row.context}`);
      } else {
        expect(row.route).toBe(APPLICATION_ENTRY);
        expect(row.specifier).toBe(`./factory-entries/${row.context}.js`);
        // The module the case loads imports the subpath and nothing else.
        const entry = readFileSync(join(HERE, "factory-entries", `${row.context}.ts`), "utf8");
        expect([...entry.matchAll(/from "([^"]+)"/gu)].map((match) => match[1])).toEqual([
          `@platos/context-${row.context}/application/index.js`,
        ]);
      }
    }
    // No stray module in `factory-entries/`. One nobody loads is dead surface.
    expect(readdirSync(join(HERE, "factory-entries")).sort()).toEqual(
      cases.filter((row) => row.route === APPLICATION_ENTRY).map((row) => `${row.context}.ts`).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// THE PROSE READBACK.
//
// The count of importable factories has been printed in comments and has gone
// stale four times, twice in files whose constant beside it was right. The
// fifth time should be a red case, not a reader's catch. So this block reads
// every sentence in V1 source that counts importable or unimportable factories
// and compares the figure to `UNIMPORTABLE_CONTEXT_FACTORIES`.
//
// WHAT COUNTS AS SUCH A SENTENCE. The text is comments and the titles of cases
// and groups. A figure is a number word or a one- or two-digit numeral. It
// counts only when it stands next to the words that make the claim:
//
//   the ADJECTIVES "importable", "unimportable" and "not importable", and the
//   PASSIVES "cannot be imported", "cannot be named" and "can be named". The
//   count comes BEFORE these, so the figure read is the nearest one before the
//   word, within twelve words.
//
//   the ACTIVE verbs "cannot import" and "can import". The count comes AFTER
//   these, so the figure read is the nearest one between the verb and the
//   word "factory" or "factories", with the nearest one before the verb as a
//   fallback.
//
// The passives and actives count only in a clause that also says "factory" or
// "factories", because "this package cannot import the outbox's runner" is a
// sentence about something else.
//
// QUOTATION MARKS EXEMPT A FIGURE, and that is the one convention this
// imposes. Withdrawn wordings are worth keeping as history, so a figure inside
// "double quotes" is read as quoted and skipped. Text in `backticks` is code and
// skipped too. Anything else is a claim about now, and must agree with the
// constant.
//
// HONEST LIMITATIONS. A count phrased without any of those words, such as
// "nine factories are reachable from here", is invisible to this readback. So
// is a trailing comment on a line of code, since only whole comment lines are
// read. The partition case above is still the authority on the figure. This
// block only stops the prose from contradicting it.
// ---------------------------------------------------------------------------

/** The claim a figure makes, and the figure the partition says it must be. */
interface CountClaim {
  readonly file: string;
  readonly claim: "importable" | "unimportable";
  readonly figure: number;
  readonly expected: number;
  readonly clause: string;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
});
const FIGURE = new RegExp(
  `(?<![\\w\\-.:§/#])(\\d{1,2})(?![\\w\\-.:/])|\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`,
  "giu",
);
const CLAIM =
  /\b(unimportable|not importable|cannot be imported|cannot be named|cannot import|importable|can be named|can import)\b/giu;
const NEGATIVE = new Set(["unimportable", "not importable", "cannot be imported", "cannot be named", "cannot import"]);
const ACTIVE = new Set(["cannot import", "can import"]);
const NEEDS_FACTORY = new Set(["cannot be imported", "cannot be named", "cannot import", "can be named", "can import"]);
const FACTORY_WORD = /\bfactor(?:y|ies)\b/iu;

/** The figures in a stretch of text, in order, with where each sits. */
const figuresIn = (text: string, offset: number): { value: number; index: number }[] =>
  [...text.matchAll(FIGURE)].map((match) => ({
    value: match[1] !== undefined ? Number(match[1]) : (NUMBER_WORDS[(match[2] ?? "").toLowerCase()] ?? NaN),
    index: offset + (match.index ?? 0),
  }));

const wordsBetween = (text: string, from: number, to: number): number =>
  text.slice(Math.min(from, to), Math.max(from, to)).split(/\s+/u).filter(Boolean).length;

/**
 * Every importability count stated in one file's prose.
 *
 * Exported shape, not exported symbol. The negative controls below call it on
 * planted text, so the readback is shown to SEE a stale figure before it is
 * trusted to report none.
 */
function countClaims(
  file: string,
  source: string,
  counts: { readonly importable: number; readonly unimportable: number },
): { claims: CountClaim[]; unbalanced: string[] } {
  // Contiguous comment lines form one block. Any line of code ends the block,
  // so a quotation cannot run from one comment into the next.
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      current.push(trimmed.replace(/^\/\/+\s?/u, ""));
    } else if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      current.push(trimmed.replace(/^\/?\*+\/?\s?/u, "").replace(/\*\/$/u, ""));
    } else if (current.length > 0) {
      blocks.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join(" "));
  for (const title of source.matchAll(/\b(?:it|test|describe)(?:\.[a-z]+)*\(\s*"([^"\\]*)"/gu)) {
    blocks.push(title[1] ?? "");
  }

  const claims: CountClaim[] = [];
  const unbalanced: string[] = [];
  for (const block of blocks) {
    if (!/importable|cannot be named|can be named|can(?:not)? (?:be )?import/iu.test(block)) continue;
    const unquoted = block.replace(/`[^`]*`/gu, " CODE ");
    if ((unquoted.match(/"/gu) ?? []).length % 2 !== 0) {
      unbalanced.push(`${file}: ${block.slice(0, 160)}`);
      continue;
    }
    const prose = unquoted.replace(/"[^"]*"/gu, " QUOTE ").replace(/\s+/gu, " ");
    for (const clause of prose.split(/[.;:?!](?=\s|$)|\s[—–]\s|\s--\s/u)) {
      let previousEnd = 0;
      for (const keyword of clause.matchAll(CLAIM)) {
        const word = (keyword[1] ?? "").toLowerCase();
        const at = keyword.index ?? 0;
        const end = at + (keyword[0]?.length ?? 0);
        const segmentStart = previousEnd;
        previousEnd = end;
        if (NEEDS_FACTORY.has(word) && !FACTORY_WORD.test(clause)) continue;

        let figure: { value: number; index: number } | undefined;
        if (ACTIVE.has(word)) {
          const tail = clause.slice(end);
          const factory = tail.search(FACTORY_WORD);
          if (factory >= 0) figure = figuresIn(tail.slice(0, factory), end)[0];
        }
        if (figure === undefined) {
          const before = figuresIn(clause.slice(segmentStart, at), segmentStart);
          const nearest = before[before.length - 1];
          if (nearest !== undefined && wordsBetween(clause, nearest.index, at) <= 12) figure = nearest;
        }
        if (figure === undefined) continue;

        const claim = NEGATIVE.has(word) ? "unimportable" : "importable";
        claims.push({
          file,
          claim,
          figure: figure.value,
          expected: claim === "unimportable" ? counts.unimportable : counts.importable,
          clause: clause.trim().slice(0, 200),
        });
      }
    }
  }
  return { claims, unbalanced };
}

/**
 * Where such prose can live: every V1 project the root solution references,
 * plus `scripts/arch`, where the generator keeps its own copy of the clause.
 *
 * Read from `tsconfig.json`, which `gen-v1-skeleton.mjs` writes and `--check`
 * byte-compares, rather than from a list kept here. A project added to the
 * layout is covered the day it lands.
 */
function proseFiles(): string[] {
  const solution = JSON.parse(readFileSync(`${ROOT}tsconfig.json`, "utf8")) as {
    readonly references?: readonly { readonly path: string }[];
  };
  const roots = [...(solution.references ?? []).map((reference) => reference.path.replace(/^\.\//u, "")), "scripts/arch"];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".turbo", "coverage"].includes(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mts|mjs)$/u.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) walk(join(ROOT, root));
  return files;
}

describe("prose that counts importable context factories", () => {
  it("SEES a stale figure, and skips one in quotation marks, before it is trusted", () => {
    const now = { importable: 17, unimportable: 0 };
    const stale = (source: string, counts = now) =>
      countClaims("planted", source, counts).claims.filter((claim) => claim.figure !== claim.expected);

    // THE FOUR WORDINGS THAT WENT STALE IN THIS TREE, verbatim. The planted text
    // is built from string literals so this file's own scan does not read it as
    // a comment or a title.
    expect(stale(["// SEVENTEEN publish one; NINE are importable."].join("\n"))).toMatchObject([
      { claim: "importable", figure: 9 },
    ]);
    expect(stale(["/**", " * The eight contexts whose contract factory this root cannot IMPORT.", " */"].join("\n"))).toMatchObject([
      { claim: "unimportable", figure: 8 },
    ]);
    expect(stale(["//   SIX not importable  channels, eventing, files, jobs, observability,"].join("\n"))).toMatchObject([
      { claim: "unimportable", figure: 6 },
    ]);
    expect(stale(["it", '("cannot import SIX context factories, and partitions all seventeen", () => {});'].join(""))).toMatchObject([
      { claim: "unimportable", figure: 6 },
    ]);

    // QUOTED, it is history and passes. Unquoted and true, it passes.
    expect(stale(['// It read "SEVENTEEN publish one; NINE are importable".'].join("\n"))).toEqual([]);
    expect(stale(["// SEVENTEEN are importable, and NONE is unimportable."].join("\n"))).toEqual([]);
    // A sentence about some other import is not a count of factories.
    expect(stale(["// so this package cannot import the outbox's one runner"].join("\n"))).toEqual([]);

    // AND THE SAME TRUE SENTENCE GOES RED WHEN THE CONSTANT MOVES. Both of its
    // figures now disagree, which is what the tree-wide case below catches.
    expect(
      stale(["// SEVENTEEN are importable, and NONE is unimportable."].join("\n"), { importable: 16, unimportable: 1 }),
    ).toMatchObject([
      { claim: "importable", figure: 17 },
      { claim: "unimportable", figure: 0 },
    ]);

    // An unbalanced quotation is reported, not guessed at.
    expect(countClaims("planted", ['// It read "NINE are importable.'].join("\n"), now).unbalanced).toHaveLength(1);
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
      if (!/importable|cannot be named|can be named|can(?:not)? (?:be )?import/iu.test(source)) continue;
      const found = countClaims(file.slice(ROOT.length), source, counts);
      claims.push(...found.claims);
      unbalanced.push(...found.unbalanced);
    }

    expect(unbalanced, "a quotation that does not close cannot be told apart from a claim").toEqual([]);
    expect(claims.filter((claim) => claim.figure !== claim.expected)).toEqual([]);

    // NOT VACUOUS. The two files this readback exists for are the ones whose
    // prose went stale, and each must still state the count so the comparison
    // above reads a figure. An extractor that saw nothing would pass on nothing.
    const where = new Set(claims.map((claim) => claim.file));
    expect(where).toContain("apps/core-api/src/composition/context-ports.ts");
    expect(where).toContain("scripts/arch/gen-v1-skeleton.mjs");
  });
});
