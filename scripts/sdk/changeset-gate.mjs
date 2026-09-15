#!/usr/bin/env node

// THE CHANGESET GATE: A PUBLISHABLE PACKAGE THAT CHANGED CARRIES VERSION INTENT.
//
// WIN-270 (M4.4), "semver automation exists". Founder decision D15 (2026-09-15):
// publication from this repository stays forbidden (RELEASE.md, CHANGESETS.md),
// so the clause is met by VERSION automation — this gate plus a release-plan dry
// run — and by nothing that publishes. There is no publish step here and none may
// be added to it.
//
// -----------------------------------------------------------------------------
// WHY A SCRIPT AND NOT `changeset status --since`
//
// `changeset status --since <ref>` asks one question: did the diff add ANY
// changeset? MEASURED on a throwaway worktree of this repository: a commit that
// changes `packages/platos-embed/src/embed.ts` and adds nothing exits 1, but the
// same commit plus a changeset naming `@platosdev/token-mint` exits 0 — the
// package that changed is still unnamed, and the package named did not change.
// And the root `changeset:status` script, which passes no `--since`, ran in no CI
// job at all:
// commit 77864609 changed `packages/platos-client/src/client.ts` (+85 lines, the
// retry guard) with no changeset, and nothing noticed.
//
// -----------------------------------------------------------------------------
// WHAT IS CHECKED, IN BOTH DIRECTIONS, OVER `merge-base(base, head)..head`
//
//   CHANGED -> NAMED. Every non-private `packages/*` package with a SHIPPED path in
//   the diff, and the owner of every generated SDK artifact in the diff, must be
//   named by a changeset the diff adds or edits.
//
//   NAMED -> CHANGED. Every package a changeset in the diff names must be a
//   current non-private `packages/*` package, and must either have a shipped path
//   in the diff or be cited: the changeset's body names a commit, reachable from
//   head, that changed a shipped path of that package. That is how an entry that
//   records intent for an EARLIER change (the retry guard) stays honest — it has
//   to say which change it is for, and the gate checks that the commit did it.
//
// A SHIPPED PATH is any path inside the package directory that is not test-only:
// see `NON_SHIPPING`. The package set is read from the COMMITTED head tree, from
// the `packages/*` glob `pnpm-workspace.yaml` declares, and the changesets are
// parsed by Changesets' own parser, so neither is a second opinion.
//
// THE GENERATED SDK ARTIFACTS are the three paths `scripts/sdk/v1-contract.mjs`
// writes, imported rather than restated. The TypeScript client is the npm identity
// of that generation pass, so all three are owned by the package that contains
// `TYPESCRIPT_OUTPUT`: a change to the emitted Python client or to the shared
// fixture is a change to the generated surface `@platosdev/client` ships, and the
// Python client has no npm identity of its own to name.
//
// ONE EXCEPTION, AND IT IS PROVENANCE: the fixture records `sourceDigests` of its
// inputs, so ANY edit to the OpenAPI document, the manifest, the policy, core-api's
// SSE lane or the kernel's stream module moves that one field even when no client
// changes. A fixture diff confined to `sourceDigests` is not a surface change and
// asks for no intent; every other byte of it does.
//
//   node scripts/sdk/changeset-gate.mjs --base <rev> [--head <rev>] [--release-plan] [--root <checkout>]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_OUTPUT, PYTHON_OUTPUT, TYPESCRIPT_OUTPUT } from "./v1-contract.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..", "..");

/** The workspace glob this gate covers. `pnpm-workspace.yaml` must still declare it. */
export const PACKAGE_GLOB = "packages/*";

export const CHANGESET_DIRECTORY = ".changeset";

/** The generated SDK artifacts, as repository-relative paths. */
export const GENERATED_SDK_ARTIFACTS = Object.freeze(
  [TYPESCRIPT_OUTPUT, PYTHON_OUTPUT, FIXTURE_OUTPUT].map((path) => relative(repositoryRoot, path)),
);

/**
 * Paths inside a package that never reach its published tarball or its build.
 *
 * TEST-ONLY, AND NOTHING ELSE. `CHANGELOG.md` is here because the version step
 * writes it; every other file — source, README, LICENSE, package.json, a build
 * config — is shipped or shapes what is shipped, and requires intent.
 */
export const NON_SHIPPING = Object.freeze([
  { reason: "test directory", test: (segments) => segments.slice(0, -1).some((s) => s === "test" || s === "tests" || s === "__tests__") },
  { reason: "test file", test: (segments) => /\.(?:test|spec)\.[^/]+$/u.test(segments.at(-1)) },
  { reason: "test config", test: (segments) => segments.length === 1 && /^(?:vitest\.config\.[^/]+|tsconfig\.test\.json)$/u.test(segments[0]) },
  { reason: "written by the version step", test: (segments) => segments.length === 1 && segments[0] === "CHANGELOG.md" },
]);

class GateError extends Error {}

function git(args, root) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrNull(args, root) {
  try {
    return git(args, root);
  } catch {
    return null;
  }
}

/** Resolve a revision to a commit, or refuse. A gate with no base must not pass. */
export function resolveCommit(revision, root) {
  if (typeof revision !== "string" || revision.trim() === "" || /^0+$/u.test(revision.trim())) {
    throw new GateError(`no usable base revision (${JSON.stringify(revision ?? null)}); the gate refuses to compare against nothing`);
  }
  const sha = gitOrNull(["rev-parse", "--verify", "--quiet", `${revision.trim()}^{commit}`], root);
  if (sha === null || sha.trim() === "") throw new GateError(`revision ${revision} does not resolve to a commit in this clone`);
  return sha.trim();
}

/** The non-private `packages/*` packages in the committed `head` tree. */
export function readPackages(head, root) {
  const workspace = git(["show", `${head}:pnpm-workspace.yaml`], root);
  if (!new RegExp(`^\\s*-\\s*["']?${PACKAGE_GLOB.replace("*", "\\*")}["']?\\s*$`, "mu").test(workspace)) {
    throw new GateError(`pnpm-workspace.yaml no longer declares ${PACKAGE_GLOB}; the gate's package set is gone`);
  }
  const directories = git(["ls-tree", "--name-only", "-d", `${head}`, "packages/"], root)
    .split("\n")
    .filter(Boolean);
  const packages = [];
  for (const directory of directories) {
    const manifest = gitOrNull(["show", `${head}:${directory}/package.json`], root);
    if (manifest === null) continue;
    const parsed = JSON.parse(manifest);
    packages.push({ name: parsed.name, directory, private: parsed.private === true });
  }
  return packages;
}

/** Which package a path belongs to, and whether it is a shipped path of it. */
export function classifyPath(path, packages) {
  const owner = packages.find((entry) => path.startsWith(`${entry.directory}/`));
  if (owner === undefined) return null;
  const segments = path.slice(owner.directory.length + 1).split("/");
  const excluded = NON_SHIPPING.find((rule) => rule.test(segments));
  return { package: owner, shipping: excluded === undefined, reason: excluded?.reason ?? null };
}

/**
 * The packages a set of paths moves: `Map<name, paths[]>`.
 *
 * Generated SDK artifacts are attributed to the package that contains
 * `TYPESCRIPT_OUTPUT`, whichever of the three moved.
 */
export function movedPackages(paths, packages) {
  const generatedOwner = classifyPath(GENERATED_SDK_ARTIFACTS[0], packages)?.package ?? null;
  const moved = new Map();
  const add = (entry, path) => {
    if (entry.private) return;
    moved.set(entry.name, [...(moved.get(entry.name) ?? []), path]);
  };
  for (const path of paths) {
    if (GENERATED_SDK_ARTIFACTS.includes(path)) {
      if (generatedOwner === null) throw new GateError(`${GENERATED_SDK_ARTIFACTS[0]} is in no workspace package`);
      add(generatedOwner, path);
      continue;
    }
    const classified = classifyPath(path, packages);
    if (classified !== null && classified.shipping) add(classified.package, path);
  }
  return moved;
}

function parseChangeset(source) {
  const cliRequire = createRequire(createRequire(import.meta.url).resolve("@changesets/cli/package.json"));
  const parsed = cliRequire("@changesets/parse");
  return (parsed.default ?? parsed)(source);
}

/** The fixture's surface: everything but the provenance digests. */
export function fixtureSurface(text) {
  const parsed = JSON.parse(text);
  delete parsed.sourceDigests;
  return JSON.stringify(parsed);
}

/**
 * Generated artifacts in the diff whose change is provenance only (see the header).
 * An artifact absent on either side is a surface change by definition.
 */
export function provenanceOnlyChanges(changedPaths, mergeBase, head, root) {
  const fixture = GENERATED_SDK_ARTIFACTS[2];
  if (!changedPaths.includes(fixture)) return new Set();
  const before = gitOrNull(["show", `${mergeBase}:${fixture}`], root);
  const after = gitOrNull(["show", `${head}:${fixture}`], root);
  if (before === null || after === null) return new Set();
  return fixtureSurface(before) === fixtureSurface(after) ? new Set([fixture]) : new Set();
}

/** Changesets the diff adds or edits, parsed at head. Deleted ones are the version step's business. */
export function readChangesets(changedWithStatus, head, root) {
  const found = [];
  for (const { status, path } of changedWithStatus) {
    if (status === "D") continue;
    if (!path.startsWith(`${CHANGESET_DIRECTORY}/`) || !path.endsWith(".md")) continue;
    if (path.slice(CHANGESET_DIRECTORY.length + 1).includes("/") || path.endsWith("/README.md")) continue;
    const source = git(["show", `${head}:${path}`], root);
    let parsed;
    try {
      parsed = parseChangeset(source);
    } catch (error) {
      throw new GateError(`${path} is not a changeset Changesets can parse: ${error.message}`);
    }
    found.push({ path, releases: parsed.releases, summary: parsed.summary });
  }
  return found;
}

/** Commits a changeset body cites, keeping only those that resolve and are reachable from head. */
export function citedCommits(summary, head, root) {
  const cited = [];
  for (const [candidate] of summary.matchAll(/\b[0-9a-f]{7,40}\b/gu)) {
    const sha = gitOrNull(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], root)?.trim();
    if (!sha) continue;
    if (gitOrNull(["merge-base", "--is-ancestor", sha, head], root) === null) continue;
    const touched = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", sha], root)
      .split("\0")
      .filter(Boolean);
    cited.push({ sha, touched });
  }
  return cited;
}

/**
 * The verdict, as data. Pure over its inputs so the rule can be tested on its own.
 *
 * `changesets[].cited` is `[{ sha, touched }]`.
 */
export function evaluate({ changedPaths, packages, changesets }) {
  const violations = [];
  const moved = movedPackages(changedPaths, packages);
  const byName = new Map(packages.map((entry) => [entry.name, entry]));

  const named = new Map();
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      named.set(release.name, [...(named.get(release.name) ?? []), changeset.path]);
    }
  }

  for (const [name, paths] of moved) {
    if (named.has(name)) continue;
    violations.push({
      kind: "changed-without-changeset",
      package: name,
      message:
        `${name} changed without a changeset naming it: ${paths.slice(0, 5).join(", ")}` +
        (paths.length > 5 ? ` and ${paths.length - 5} more` : ""),
    });
  }

  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      const entry = byName.get(release.name);
      if (entry === undefined || entry.private) {
        violations.push({
          kind: "names-non-publishable",
          package: release.name,
          message: `${changeset.path} names ${release.name}, which is not a current non-private ${PACKAGE_GLOB} package`,
        });
        continue;
      }
      if (moved.has(release.name)) continue;
      const cites = (changeset.cited ?? []).filter(({ touched }) =>
        movedPackages(touched, packages).has(release.name),
      );
      if (cites.length > 0) continue;
      violations.push({
        kind: "names-unchanged",
        package: release.name,
        message:
          `${changeset.path} names ${release.name}, but nothing ${release.name} ships changed in this diff ` +
          "and the changeset cites no commit that changed it",
      });
    }
  }
  return { moved, named, violations };
}

/** `changeset status --since <sha> --output <file>`: the release plan, computed and not written. */
export function releasePlan(mergeBase, root) {
  const cli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");
  const directory = mkdtempSync(join(tmpdir(), "platos-changeset-plan-"));
  const output = join(directory, "plan.json");
  try {
    // RELATIVE, because `changeset status` joins `--output` onto its working
    // directory even when it is absolute.
    execFileSync(process.execPath, [cli, "status", `--since=${mergeBase}`, `--output=${relative(root, output)}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(readFileSync(output, "utf8"));
  } catch (error) {
    throw new GateError(`the release-plan dry run failed:\n${error.stderr ?? error.message}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { base: null, head: "HEAD", releasePlan: false, root: repositoryRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release-plan") options.releasePlan = true;
    else if (argument === "--base" || argument === "--head" || argument === "--root") {
      options[argument.slice(2)] = argv[++index] ?? "";
    } else throw new GateError(`unknown argument ${argument}`);
  }
  return options;
}

export function runGate({ base, head = "HEAD", withReleasePlan = false, root = repositoryRoot }) {
  const baseCommit = resolveCommit(base, root);
  const headCommit = resolveCommit(head, root);
  const mergeBase = gitOrNull(["merge-base", baseCommit, headCommit], root)?.trim();
  if (!mergeBase) throw new GateError(`${base} and ${head} share no history in this clone`);

  const changedWithStatus = git(["diff", "--name-status", "--no-renames", "-z", mergeBase, headCommit], root)
    .split("\0")
    .filter(Boolean)
    .reduce((rows, value, index, all) => (index % 2 === 0 ? [...rows, { status: value, path: all[index + 1] }] : rows), []);
  const provenanceOnly = provenanceOnlyChanges(
    changedWithStatus.map((row) => row.path),
    mergeBase,
    headCommit,
    root,
  );
  const changedPaths = changedWithStatus.map((row) => row.path).filter((path) => !provenanceOnly.has(path));
  const packages = readPackages(headCommit, root);
  const changesets = readChangesets(changedWithStatus, headCommit, root).map((changeset) => ({
    ...changeset,
    cited: citedCommits(changeset.summary, headCommit, root),
  }));
  const verdict = evaluate({ changedPaths, packages, changesets });

  let plan = null;
  if (withReleasePlan && verdict.violations.length === 0 && changesets.length > 0) {
    plan = releasePlan(mergeBase, root);
    for (const name of verdict.named.keys()) {
      const release = plan.releases?.find((entry) => entry.name === name);
      if (release === undefined || release.type === "none" || release.newVersion === release.oldVersion) {
        verdict.violations.push({
          kind: "plan-without-release",
          package: name,
          message: `the release plan computes no version change for ${name}, which a changeset in this diff names`,
        });
      }
    }
  }
  return { mergeBase, changedPaths, provenanceOnly, packages, changesets, plan, ...verdict };
}

function runCli(argv = process.argv.slice(2)) {
  let result;
  try {
    const options = parseArguments(argv);
    result = runGate({
      base: options.base,
      head: options.head,
      withReleasePlan: options.releasePlan,
      root: resolve(options.root),
    });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    process.stderr.write(`[changeset-gate] ${error.message}\n`);
    process.exit(2);
    return;
  }
  const publishable = result.packages.filter((entry) => !entry.private).map((entry) => entry.name);
  process.stderr.write(
    `[changeset-gate] merge base ${result.mergeBase.slice(0, 12)}; ${result.changedPaths.length} changed path(s); ` +
      `${publishable.length} non-private ${PACKAGE_GLOB} package(s); ${result.changesets.length} changeset(s) in the diff\n`,
  );
  for (const path of result.provenanceOnly) {
    process.stderr.write(`  ${path}: only its sourceDigests moved (provenance, not surface)\n`);
  }
  for (const [name, paths] of result.moved) {
    process.stderr.write(`  moved ${name} (${paths.length} shipped path(s)) named by ${(result.named.get(name) ?? ["nothing"]).join(", ")}\n`);
  }
  if (result.plan !== null) {
    for (const name of result.named.keys()) {
      const release = result.plan.releases.find((entry) => entry.name === name);
      if (release) {
        process.stderr.write(
          `  plan ${name} ${release.oldVersion} -> ${release.newVersion} (${release.type}), from this diff's changesets\n`,
        );
      }
    }
  }
  if (result.violations.length > 0) {
    process.stderr.write(
      `[changeset-gate] FAILED:\n${result.violations.map((entry) => `  ${entry.message}`).join("\n")}\n` +
        "Record version intent with `pnpm changeset:add` (see CHANGESETS.md); publication stays forbidden.\n",
    );
    process.exit(1);
  }
  process.stderr.write("[changeset-gate] ok: every changed publishable package carries version intent, and every intent names a change\n");
}

export { GateError, runCli };

/**
 * Whether this module is the entry point, compared by REAL path.
 *
 * `/tmp` is a symlink on macOS, so `node /tmp/.../changeset-gate.mjs` hands
 * `process.argv[1]` a path that differs from `import.meta.url`'s. A plain string
 * comparison then skips `runCli()` and the process exits 0 having checked
 * nothing — a gate that passes by not running.
 */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) runCli();
