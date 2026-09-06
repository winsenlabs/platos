#!/usr/bin/env node
// WIN-258 T7 mutation sweep. Runs ON THE MINI, inside /tmp/pl-t7json.
//
// Each entry names a file, the EXACT text that implements the guard, and the
// edit that removes it. The named suites are run before and after; a mutation
// that leaves every named suite green is a SURVIVOR and is reported as one.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = "/tmp/pl-t7json";
const pkg = resolve(root, "packages/adapters/postgres-tenancy");

const MUTATIONS = [
  {
    name: "M-J01 macro step params must be an object",
    file: "src/agents-rows.ts",
    from: `    if (typeof params !== "object" || Array.isArray(params)) {`,
    to: `    if (false) {`,
    suites: ["unit:agents-rows", "integration:json-columns"],
  },
  {
    name: "M-J02 a macro step must name a tool",
    file: "src/agents-rows.ts",
    from: `    if (step === null || typeof tool !== "string" || tool === "") {`,
    to: `    if (step === null) {`,
    suites: ["unit:agents-rows", "integration:json-columns"],
  },
  {
    name: "M-J03 the steps column must be a JSON array",
    file: "src/agents-rows.ts",
    from: `  if (!Array.isArray(value)) {\n    throw new UnreadableAgentsRowError(\n      MACRO_STEPS_NOT_AN_ARRAY,`,
    to: `  if (false) {\n    throw new UnreadableAgentsRowError(\n      MACRO_STEPS_NOT_AN_ARRAY,`,
    suites: ["unit:agents-rows"],
  },
  {
    name: "M-J04 an object column must hold an object",
    file: "src/agents-rows.ts",
    from: `  if (typeof value !== "object" || Array.isArray(value)) {\n    throw new UnreadableAgentsRowError(\n      AGENTS_COLUMN_NOT_AN_OBJECT,`,
    to: `  if (false) {\n    throw new UnreadableAgentsRowError(\n      AGENTS_COLUMN_NOT_AN_OBJECT,`,
    suites: ["unit:agents-rows"],
  },
  {
    name: "M-J05 the four agents refusals carry four codes",
    file: "src/agents-rows.ts",
    from: `export const MACRO_STEP_PARAMS_NOT_AN_OBJECT = "agents.adapter.macro_step_params_not_an_object";`,
    to: `export const MACRO_STEP_PARAMS_NOT_AN_OBJECT = "agents.adapter.macro_steps_not_an_array";`,
    suites: ["unit:agents-rows"],
  },
  {
    name: "M-J06 Event.payload must hold an object root",
    file: "src/outbox-store.ts",
    from: `  if (typeof value !== "object" || value === null || Array.isArray(value)) {`,
    to: `  if (false) {`,
    suites: ["unit:outbox-store"],
  },
  {
    name: "M-J07 the census root matches the migration and the catalog",
    file: "src/json-columns.ts",
    from: `    model: "Macro", column: "steps", root: "array", nullable: false,`,
    to: `    model: "Macro", column: "steps", root: "object", nullable: false,`,
    suites: ["unit:json-columns", "integration:json-columns"],
  },
  {
    name: "M-J08 the census names a decoder that exists",
    file: "src/json-columns.ts",
    from: `    owner: "privacy", decoder: "privacy-rows.readTenantScope", disposition: "refuse",`,
    to: `    owner: "privacy", decoder: "privacy-rows.readTenantScopeGone", disposition: "refuse",`,
    suites: ["unit:json-columns"],
  },
  {
    name: "M-J09 an unowned column names no decoder and no owner",
    file: "src/json-columns.ts",
    from: `    owner: "-", decoder: "", disposition: "unowned",\n    note: "No store here names endUserIdentity`,
    to: `    owner: "-", decoder: "", disposition: "refuse",\n    note: "No store here names endUserIdentity`,
    suites: ["unit:json-columns"],
  },
  {
    name: "M-J10 the census covers every Json column in the schema",
    file: "src/json-columns.ts",
    from: `  {\n    model: "Turn", column: "output", root: "object", nullable: true,`,
    to: `  {\n    model: "Turn", column: "outputGone", root: "object", nullable: true,`,
    suites: ["unit:json-columns"],
  },
  {
    name: "M-J11 the column map is the row interface's own column list",
    file: "src/agents-rows.ts",
    from: `export const MACRO_COLUMNS = {\n  id: true,\n  environmentId: true,`,
    to: `export const MACRO_COLUMNS = {\n  id: true,`,
    suites: ["integration:json-columns"],
  },
  {
    name: "M-J12 a macro read PROJECTS its columns",
    file: "src/agents-scaffolding.ts",
    from: `          where: { id: macroId, environmentId: scope.environmentId },\n          select: MACRO_COLUMNS,`,
    to: `          where: { id: macroId, environmentId: scope.environmentId },`,
    suites: ["integration:json-columns"],
  },
  {
    name: "M-J13 the bound read PROJECTS every relation",
    file: "src/agents-catalog.ts",
    from: `  activeAgentVersion: { select: VERSION_COLUMNS },`,
    to: `  activeAgentVersion: true,`,
    suites: ["integration:json-columns"],
  },
];

function run(suite) {
  const [kind, name] = suite.split(":");
  const args =
    kind === "unit"
      ? ["--filter", "@platos/adapter-postgres-tenancy", "exec", "vitest", "run", `${name}.test`]
      : [
          "--filter",
          "@platos/adapter-postgres-tenancy",
          "exec",
          "vitest",
          "run",
          `${name}.integration`,
          "--no-file-parallelism",
          "--testTimeout=120000",
          "--hookTimeout=300000",
        ];
  try {
    execFileSync("pnpm", args, { cwd: root, stdio: "pipe" });
    return "green";
  } catch {
    return "RED";
  }
}

function build() {
  try {
    execFileSync("pnpm", ["build:v1"], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const only = process.argv[2] ?? null;
const results = [];
for (const mutation of MUTATIONS) {
  if (only !== null && !mutation.name.startsWith(only)) continue;
  const path = resolve(pkg, mutation.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, verdict: "TEXT-NOT-FOUND" });
    continue;
  }
  writeFileSync(path, original.replace(mutation.from, mutation.to), "utf8");
  const compiled = build();
  const outcome = compiled
    ? Object.fromEntries(mutation.suites.map((suite) => [suite, run(suite)]))
    : { build: "RED" };
  writeFileSync(path, original, "utf8");
  build();
  const killed = Object.values(outcome).includes("RED");
  results.push({ name: mutation.name, verdict: killed ? "KILLED" : "SURVIVED", outcome });
  console.log(`${killed ? "KILLED  " : "SURVIVED"} ${mutation.name} ${JSON.stringify(outcome)}`);
}
console.log(
  `\nTOTAL ${results.length}  KILLED ${results.filter((r) => r.verdict === "KILLED").length}  SURVIVED ${results.filter((r) => r.verdict === "SURVIVED").length}  NOT-FOUND ${results.filter((r) => r.verdict === "TEXT-NOT-FOUND").length}`,
);
