// WHAT THE COMPOSE SERVICE COMPOSES, READ BACK FROM THE DOCUMENT THAT CLAIMS IT.
//
// `content/docs/self-hosting.md` tells an operator which `.env` settings compose
// which contexts, and `.env.example` repeats it. Both used to say the five contexts
// need "the security pair" of three variables; measured through the image, the
// session secret composes nothing and the credential root and its version compose
// all four extra contexts. A table of counts nobody re-reads drifts exactly like
// that, so this suite re-reads it.
//
// EVERY SIDE IS SOMETHING THIS FILE DOES NOT WRITE:
//
//   * the environment is the `core-api` service's own block in
//     docker-compose.platos.yml, interpolated the way Compose interpolates it with
//     the committed `.env.example` values;
//   * each table row adds the variables its first column names, cumulatively;
//   * the readback is `evaluateReadiness` over the REAL construction path
//     `main.ts` runs (`loadPlatformConfiguration` -> `constructAdapters` ->
//     `assembleContextPorts` -> `composeApplication`), with no server listening,
//     because the question is what the composition root BUILDS;
//   * the expected counts and contexts are the table's own cells.
//
// A row naming a variable this suite has no valid value for fails by name rather
// than being skipped, so the table cannot grow a row nothing checks.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { composeApplication, DECLARED_BINDING_COUNT } from "../app.module.js";
import { loadPlatformConfiguration } from "../config/platform.js";
import { evaluateReadiness } from "../health/readiness.js";
import { createProcessDefaults } from "../runtime/lifecycle.js";
import { constructAdapters, type AdapterConstruction } from "./adapter-bindings.js";
import { assembleContextPorts } from "./context-ports.js";

const repositoryFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

const COMPOSE_FILE = "docker-compose.platos.yml";
const ENV_EXAMPLE = ".env.example";
const SELF_HOSTING = "content/docs/self-hosting.md";

/** The `core-api` service's `environment:` block, as `KEY: "value"` lines. */
function composeEnvironment(): Readonly<Record<string, string>> {
  const compose = repositoryFile(COMPOSE_FILE);
  const service = /^ {2}core-api:\n([\s\S]*?)(?=^ {2}\S)/mu.exec(compose)?.[1] ?? "";
  const block = /^ {4}environment:\n((?: {6}.*\n| *\n)+)/mu.exec(service)?.[1] ?? "";
  const entries = [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*): "(.*)"$/gmu)].map((match) => [match[1] ?? "", match[2] ?? ""]);
  return Object.fromEntries(entries);
}

/** Uncommented `KEY=value` lines of the committed example environment. */
function exampleEnvironment(): Readonly<Record<string, string>> {
  const entries = repositoryFile(ENV_EXAMPLE)
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1] ?? "", (match[2] ?? "").replace(/^'(.*)'$/u, "$1")]);
  return Object.fromEntries(entries);
}

/** Compose's `${NAME}`, `${NAME:-default}` and `${NAME-default}` over a variable set. */
function interpolate(value: string, variables: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)(?:(:?-)([^}]*))?\}/gu, (_whole, name: string, operator?: string, fallback?: string) => {
    const present = variables[name];
    if (operator === ":-") return present === undefined || present === "" ? (fallback ?? "") : present;
    if (operator === "-") return present === undefined ? (fallback ?? "") : present;
    return present ?? "";
  });
}

/** A valid value for each variable a table row may add. Unknown names fail the suite. */
const ROW_VALUES: Readonly<Record<string, string>> = Object.freeze({
  PLATOS_SECURITY_ENCRYPTION_KEY: "d".repeat(64),
  PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
  PLATOS_SECURITY_SESSION_SECRET: "s".repeat(32),
  PLATOS_CHANNELS_SLACK_SIGNING_SECRET: "c".repeat(64),
  // The rows below arrived on the INTEGRATED tree, not on the lane this suite was
  // written on: the second channel runtime (D10) and the email notifier that D20
  // also made identity-access's magic-link delivery. Each value is the shape
  // `apps/core-api/src/config/channels.ts` demands of that field and nothing
  // weaker — a 64-hex raw Ed25519 key, an `smtp:`/`smtps:` relay, an address with
  // one `@` and a dot in the domain, and an `https:` login page — so a row whose
  // adapter stops composing fails here rather than being papered over by a value
  // the loader would have refused at the door anyway.
  PLATOS_CHANNELS_DISCORD_PUBLIC_KEY: "a".repeat(64),
  PLATOS_CHANNELS_EMAIL_SMTP_URL: "smtp://relay.invalid:25",
  PLATOS_CHANNELS_EMAIL_FROM: "platos@relay.invalid",
  PLATOS_CHANNELS_EMAIL_LOGIN_URL: "https://console.invalid/sign-in",
});

interface TableRow {
  readonly adds: readonly string[];
  readonly satisfied: number;
  readonly declared: number;
  readonly contexts: readonly string[] | "same";
}

/** The `/readyz` table in the self-hosting page, parsed row by row. */
function readinessTable(): readonly TableRow[] {
  const page = repositoryFile(SELF_HOSTING);
  const table = /\| Set in `\.env` \| `\/readyz` bindings \| `composedContexts` \|\n\|[-|]+\|\n((?:\|.*\|\n)+)/u.exec(page)?.[1] ?? "";
  return table
    .trim()
    .split("\n")
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .map(([setting = "", bindings = "", contexts = ""]) => {
      const counts = /^(\d+) of (\d+)$/u.exec(bindings);
      const names = [...setting.matchAll(/`([A-Z][A-Z0-9_]*)`/gu)].map((match) => match[1] ?? "");
      return {
        adds: setting.startsWith("plus ") ? names : [],
        satisfied: Number(counts?.[1] ?? Number.NaN),
        declared: Number(counts?.[2] ?? Number.NaN),
        contexts: contexts === "the same five" ? "same" : [...contexts.matchAll(/`([A-Za-z]+)`/gu)].map((match) => match[1] ?? ""),
      };
    });
}

const opened: AdapterConstruction[] = [];

afterEach(async () => {
  for (const construction of opened.splice(0)) await construction.release();
});

function readinessOf(env: Readonly<Record<string, string>>) {
  const outcome = loadPlatformConfiguration(env);
  if (!outcome.ok) throw new Error(`compose environment is invalid: ${outcome.diagnostics.map((d) => d.field).join(", ")}`);
  const platform = outcome.value;
  const defaults = createProcessDefaults(platform.core);
  const construction = constructAdapters({
    stores: platform.stores,
    security: platform.security,
    providers: platform.providers,
    channels: platform.channels,
    clock: defaults.clock,
    correlation: null,
  });
  opened.push(construction);
  const assembly = assembleContextPorts(construction.adapters, defaults);
  const app = composeApplication({
    configuration: platform.core,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
  });
  return evaluateReadiness(app, { phase: "serving" });
}

/**
 * The `<satisfied> of <declared>` pairs `.env.example` states in prose, in order.
 *
 * THE SECOND COPY OF THE SAME TABLE, AND IT WAS WRONG. This file's header says
 * "`.env.example` repeats it", and the suite read only the page — so when the
 * email notifier's two bindings landed, the page moved to 63 and the example file
 * kept saying "of 62" and "the remaining five" with nothing to catch it. Prose
 * nobody re-reads drifts exactly like that, which is the sentence this whole
 * suite was written under. The pairs are read out of the file rather than
 * restated here, and joined to the page's own rows below.
 */
function exampleReadinessPairs(): readonly { readonly satisfied: number; readonly declared: number }[] {
  return [...repositoryFile(ENV_EXAMPLE).matchAll(/(\d+) of (\d+)\b/gu)].map((match) => ({
    satisfied: Number(match[1]),
    declared: Number(match[2]),
  }));
}

describe("the self-hosting readiness table, against the compose service it describes", () => {
  const rows = readinessTable();

  it("finds the same satisfied/declared pairs in .env.example that the page's table states", () => {
    const pairs = exampleReadinessPairs();
    // NON-VACUITY: the file really does state them, so an empty match set is a
    // failure rather than a silent pass.
    expect(pairs.length).toBeGreaterThanOrEqual(rows.length);
    for (const pair of pairs) {
      expect(pair.declared, `.env.example says "of ${String(pair.declared)}"`).toBe(DECLARED_BINDING_COUNT);
    }
    // Every count the page states must appear in the file, and every count the
    // file states must be one the page states: neither may invent a row.
    const fromPage = new Set(rows.map((row) => row.satisfied));
    const fromFile = new Set(pairs.map((pair) => pair.satisfied));
    expect([...fromFile].sort((a, b) => a - b)).toEqual([...fromPage].sort((a, b) => a - b));
  });

  it("states the right number of bindings no `.env` can reach, in both documents", () => {
    // THE OTHER HALF OF THE SAME DRIFT. `.env.example` said "the remaining five"
    // while the page said four, and the true number is whatever the fullest row
    // leaves unsatisfied. It is a WORD in both files, so it is read as a word.
    const fullest = Math.max(...rows.map((row) => row.satisfied));
    const remaining = DECLARED_BINDING_COUNT - fullest;
    const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const word = NUMBER_WORDS[remaining];
    expect(word, `no word for ${String(remaining)} unreachable bindings`).toBeDefined();
    for (const file of [ENV_EXAMPLE, SELF_HOSTING]) {
      const text = repositoryFile(file);
      const stated = [...text.matchAll(/remaining (\w+) are|(\w+) that\s+remain unsatisfied|The (\w+) that/gu)]
        .map((match) => match[1] ?? match[2] ?? match[3])
        .filter((candidate): candidate is string => candidate !== undefined && NUMBER_WORDS.includes(candidate));
      expect(stated.length, `${file} states no count of unreachable bindings`).toBeGreaterThan(0);
      for (const candidate of stated) {
        expect(candidate, `${file} says "${candidate}" where the readback leaves ${String(remaining)}`).toBe(word);
      }
    }
  });

  it("finds the table, every row with counts and contexts, and a first row that adds nothing", () => {
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]?.adds).toEqual([]);
    for (const row of rows) {
      expect(Number.isInteger(row.satisfied) && Number.isInteger(row.declared)).toBe(true);
      expect(row.declared).toBe(DECLARED_BINDING_COUNT);
    }
    for (const name of rows.flatMap((row) => row.adds)) {
      expect(Object.keys(ROW_VALUES), `${SELF_HOSTING} names ${name}, which this suite has no value for`).toContain(name);
    }
  });

  it("reads back each row's bindings and contexts from the compose environment plus that row's settings", () => {
    const example = exampleEnvironment();
    const service = composeEnvironment();
    expect(Object.keys(service)).toContain("PLATOS_ENVIRONMENT");
    const added: Record<string, string> = {};
    let previous: readonly string[] = [];
    for (const row of rows) {
      for (const name of row.adds) {
        expect(Object.keys(service), `${COMPOSE_FILE} core-api must pass ${name} through`).toContain(name);
        added[name] = ROW_VALUES[name] ?? "";
      }
      const variables = { ...example, ...added };
      const env = Object.fromEntries(Object.entries(service).map(([name, value]) => [name, interpolate(value, variables)]));
      const verdict = readinessOf(env);
      const expectedContexts = row.contexts === "same" ? previous : row.contexts;
      expect(verdict.detail.satisfiedBindings.length, `row adding [${row.adds.join(", ")}]`).toBe(row.satisfied);
      expect([...verdict.detail.composedContexts].sort(), `row adding [${row.adds.join(", ")}]`).toEqual([...expectedContexts].sort());
      previous = expectedContexts;
    }
  });

  it("composes nothing more from the session secret alone, as the page says", () => {
    const example = exampleEnvironment();
    const service = composeEnvironment();
    const env = (added: Record<string, string>) =>
      Object.fromEntries(Object.entries(service).map(([name, value]) => [name, interpolate(value, { ...example, ...added })]));
    const baseline = readinessOf(env({}));
    const withSession = readinessOf(env({ PLATOS_SECURITY_SESSION_SECRET: ROW_VALUES["PLATOS_SECURITY_SESSION_SECRET"] ?? "" }));
    expect(withSession.detail.satisfiedBindings.length).toBe(baseline.detail.satisfiedBindings.length);
    expect(withSession.detail.composedContexts).toEqual(baseline.detail.composedContexts);
  });
});
