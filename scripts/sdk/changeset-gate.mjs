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
//   to say which change it is for, and the gate checks that the commit did it. A
//   release an EDITED changeset already declared, with the same bump, at the merge
//   base is carried intent rather than a new claim, and needs neither.
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
// THE TWO PYTHON SDKS ARE PACKAGES TOO. `packages/platos-client-py` and
// `packages/platools-py` publish to PyPI and have no `package.json`, so a gate that
// read only npm manifests let every hand-written change to them through with no
// intent at all. Changesets cannot bump a `pyproject.toml` (`docs/sdk-v1-migration.md`,
// "Version policy"), and this repository already records a Python SDK's intent
// beside its TypeScript twin's (`.changeset/platools-sdk-tenancy-id-docs.md`). So
// each is mapped to that twin in `PYTHON_SDK_TWINS`: a shipped change to the Python
// tree needs a changeset naming the npm twin. The map is checked against the tree
// on every run — each Python directory must carry a `pyproject.toml` project name
// and each twin a non-private `package.json` — and a `packages/*` directory with
// no `package.json` that the map does not name is a REFUSAL, so a third Python SDK
// cannot be added outside the gate.
//
// TWO EXCEPTIONS, BOTH NAMED BY THIS REPOSITORY'S OWN RULES, AND NEITHER A SURFACE:
//
//   PROVENANCE. The fixture records `sourceDigests` of its inputs, so ANY edit to
//   the OpenAPI document, the manifest, the policy, core-api's SSE lane or the
//   kernel's stream module moves that one field even when no client changes. A
//   fixture diff confined to `sourceDigests` is not a surface change and asks for
//   no intent; every other byte of it does.
//
//   LEGAL METADATA RECONCILED TO THE GOVERNING LICENCE. CHANGESETS.md: the
//   reconciliation of every non-private package to the repository's governing
//   Apache-2.0 metadata "does not itself create package-version intent". Measured
//   before this rule: the gate run against `origin/main` failed on
//   `@platos/react-hooks`, whose ONLY changes were that reconciliation (its MIT
//   `license` field and a new LICENSE file) — so the pull request from v1 to main
//   would have been red on the repository's own policy. Exempt, path by path, and
//   nothing wider: a package `LICENSE` whose head bytes equal the repository root
//   `LICENSE`, and a `package.json` whose parsed content differs from the merge base
//   in `license` ALONE, set to `GOVERNING_LICENSE`. A licence moved anywhere else,
//   a LICENSE with any other text, or a manifest with any other change still
//   requires intent.
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

/**
 * Where CHANGESETS.md says the entries naming retired package identities were
 * "preserved byte-for-byte". A deleted entry whose bytes are here at head was moved
 * into history rather than dropped, which is the only deletion the gate excuses
 * besides a version step that spends the intent.
 */
export const ARCHIVED_CHANGESETS = "docs/audits/history/win-252/stale-changesets";

/**
 * The SPDX id CHANGESETS.md calls the repository's governing licence metadata, and
 * the one `scripts/license-distribution.test.mjs` requires of every non-private
 * package manifest. `changeset-gate.test.mjs` reads that test to keep the two equal.
 */
export const GOVERNING_LICENSE = "Apache-2.0";

/**
 * Python SDK directories under `packages/*`, each with the npm package whose
 * changesets record its version intent. See the header. The TypeScript client's
 * twin is the directory the generator writes the Python client into, so that pair
 * is derived from `scripts/sdk/v1-contract.mjs` rather than restated; the platools
 * pair is stated, and the test suite joins it to the SDK pairing
 * `scripts/capability-matrix.mjs` records.
 */
export const PYTHON_SDK_TWINS = Object.freeze([
  {
    directory: relative(repositoryRoot, PYTHON_OUTPUT).split("/").slice(0, 2).join("/"),
    twin: relative(repositoryRoot, TYPESCRIPT_OUTPUT).split("/").slice(0, 2).join("/"),
  },
  { directory: "packages/platools-py", twin: "packages/platools-js" },
]);

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
  // The Python SDK suites' CI install: the pins and hashed lock `.github/workflows/ci.yml`
  // installs pytest from. Neither reaches a wheel, and neither is a runtime dependency.
  { reason: "test requirements", test: (segments) => segments.length === 1 && /^requirements-ci\.(?:in|txt)$/u.test(segments[0]) },
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

/** The `[project]` name a committed `pyproject.toml` declares, or null. */
export function pyprojectName(source) {
  const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/mu.exec(source);
  const name = project === null ? null : /^name\s*=\s*"([^"]+)"\s*$/mu.exec(project[1]);
  return name === null ? null : name[1];
}

/**
 * The `packages/*` packages in the committed `head` tree: every npm manifest, and
 * every Python SDK directory under the npm name of its twin (`python` names the
 * PyPI distribution). A directory that is neither is a refusal.
 */
export function readPackages(head, root, twins = PYTHON_SDK_TWINS) {
  const workspace = git(["show", `${head}:pnpm-workspace.yaml`], root);
  if (!new RegExp(`^\\s*-\\s*["']?${PACKAGE_GLOB.replace("*", "\\*")}["']?\\s*$`, "mu").test(workspace)) {
    throw new GateError(`pnpm-workspace.yaml no longer declares ${PACKAGE_GLOB}; the gate's package set is gone`);
  }
  const directories = git(["ls-tree", "--name-only", "-d", `${head}`, "packages/"], root)
    .split("\n")
    .filter(Boolean);
  // Directories the workspace declares as CONTAINERS (`packages/contexts/*`): each
  // holds packages of its own under another glob, and has no manifest itself.
  const containers = new Set(
    [...workspace.matchAll(/^\s*-\s*["']?([^"'\s#]+)\/\*["']?\s*$/gmu)].map((match) => match[1]),
  );
  const packages = [];
  const unmanifested = [];
  for (const directory of directories) {
    const manifest = gitOrNull(["show", `${head}:${directory}/package.json`], root);
    if (manifest === null && containers.has(directory)) {
      // Outside this gate's glob, and CHANGESETS.md scopes intent to `packages/*`:
      // so every package in the container must be private, or the gate refuses.
      const children = git(["ls-tree", "--name-only", "-d", `${head}`, `${directory}/`], root).split("\n").filter(Boolean);
      for (const child of children) {
        const childManifest = gitOrNull(["show", `${head}:${child}/package.json`], root);
        if (childManifest !== null && JSON.parse(childManifest).private !== true) {
          throw new GateError(
            `${child} is a non-private package outside ${PACKAGE_GLOB}; CHANGESETS.md scopes version intent to ${PACKAGE_GLOB}, ` +
              "so the gate cannot tell whether its changes need a changeset",
          );
        }
      }
      continue;
    }
    if (manifest === null) {
      unmanifested.push(directory);
      continue;
    }
    const parsed = JSON.parse(manifest);
    packages.push({ name: parsed.name, directory, private: parsed.private === true, python: null });
  }
  for (const directory of unmanifested) {
    const pairing = twins.find((entry) => entry.directory === directory);
    if (pairing === undefined) {
      throw new GateError(
        `${directory} has no package.json and is not a Python SDK in PYTHON_SDK_TWINS; ` +
          "the gate cannot tell whether it publishes, so it refuses rather than let its changes through",
      );
    }
    const pyproject = gitOrNull(["show", `${head}:${directory}/pyproject.toml`], root);
    const distribution = pyproject === null ? null : pyprojectName(pyproject);
    if (distribution === null) {
      throw new GateError(`${directory} is mapped as a Python SDK but carries no pyproject.toml [project] name`);
    }
    const twin = packages.find((entry) => entry.directory === pairing.twin);
    if (twin === undefined || twin.private) {
      throw new GateError(`${directory}'s twin ${pairing.twin} is not a non-private npm package; its intent has nowhere to be recorded`);
    }
    packages.push({ name: twin.name, directory, private: false, python: distribution });
  }
  for (const pairing of twins) {
    if (!directories.includes(pairing.directory)) {
      throw new GateError(`PYTHON_SDK_TWINS names ${pairing.directory}, which is not in the ${PACKAGE_GLOB} tree; the map is stale`);
    }
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

/**
 * Whether one changed path is legal metadata reconciled to the governing licence
 * (see the header). `before`/`after` are the path's content at the merge base and
 * head (null when absent); `rootLicense` is the repository root `LICENSE` at head.
 */
export function isLicenseReconciliation({ path, before, after, rootLicense, packages }) {
  const owner = packages.find((entry) => path.startsWith(`${entry.directory}/`));
  if (owner === undefined || owner.python !== null || after === null) return false;
  const inside = path.slice(owner.directory.length + 1);
  if (inside === "LICENSE") return rootLicense !== null && Buffer.compare(after, rootLicense) === 0;
  if (inside !== "package.json" || before === null) return false;
  let previous;
  let next;
  try {
    previous = JSON.parse(before.toString("utf8"));
    next = JSON.parse(after.toString("utf8"));
  } catch {
    return false;
  }
  if (next?.license !== GOVERNING_LICENSE || previous?.license === GOVERNING_LICENSE) return false;
  const { license: _before, ...restBefore } = previous;
  const { license: _after, ...restAfter } = next;
  return JSON.stringify(restBefore) === JSON.stringify(restAfter);
}

function gitBlob(revision, path, root) {
  try {
    return execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Changed paths that are licence reconciliation only. */
export function licenseReconciliations(changedPaths, mergeBase, head, packages, root) {
  const rootLicense = gitBlob(head, "LICENSE", root);
  const exempt = new Set();
  for (const path of changedPaths) {
    if (!/\/(?:LICENSE|package\.json)$/u.test(path)) continue;
    const verdict = isLicenseReconciliation({
      path,
      before: gitBlob(mergeBase, path, root),
      after: gitBlob(head, path, root),
      rootLicense,
      packages,
    });
    if (verdict) exempt.add(path);
  }
  return exempt;
}

/** Is this path a changeset entry (and not the directory's README or a nested file)? */
function isChangesetEntry(path) {
  if (!path.startsWith(`${CHANGESET_DIRECTORY}/`) || !path.endsWith(".md")) return false;
  if (path.slice(CHANGESET_DIRECTORY.length + 1).includes("/")) return false;
  return !path.endsWith("/README.md");
}

/**
 * Changesets the diff adds or edits, parsed at head.
 *
 * `carried` holds the `name:type` releases an EDITED changeset already declared at
 * the merge base. Those are pending intent recorded for an earlier change, not intent
 * this diff creates: when WIN-253 deleted the retired package names from
 * `.changeset/eobd-83-followup-package-repo-urls.md`, the two names it kept did not
 * become claims about this diff. A release that is new, or whose bump changed, is.
 *
 * DELETED entries are NOT skipped any more; `readDeletedChangesets` reads them at the
 * merge base and `evaluate` refuses a deletion that drops still-pending intent.
 */
export function readChangesets(changedWithStatus, head, root, mergeBase = null) {
  const found = [];
  const parseAt = (revision, path) => {
    const source = git(["show", `${revision}:${path}`], root);
    try {
      return parseChangeset(source);
    } catch (error) {
      throw new GateError(`${path} at ${revision.slice(0, 12)} is not a changeset Changesets can parse: ${error.message}`);
    }
  };
  for (const { status, path } of changedWithStatus) {
    if (status === "D") continue;
    if (!isChangesetEntry(path)) continue;
    const parsed = parseAt(head, path);
    const carried = new Set();
    if (status === "M" && mergeBase !== null) {
      for (const release of parseAt(mergeBase, path).releases) carried.add(`${release.name}:${release.type}`);
    }
    found.push({ path, releases: parsed.releases, summary: parsed.summary, carried });
  }
  return found;
}

/**
 * Changesets the diff DELETES, parsed at the merge base.
 *
 * THE LENIENCY THIS CLOSES. The gate read the diff in both directions and ignored
 * deletions entirely, so a diff could REMOVE pending version intent — the retry-guard
 * entry, say — and pass with nothing said. That is the one direction where silence is
 * a loss of a maintainer's recorded decision rather than an absence of one.
 *
 * In a repository that RAN `changeset version` this would be ordinary: the version step
 * consumes entries as it applies them. This repository does not have that step —
 * CHANGESETS.md says so in as many words ("no Changesets release workflow, npm
 * publication workflow, prerelease helper, or automatic npm authority") — so a deleted
 * entry here is intent dropped, not intent spent. `evaluate` still allows the spent
 * case, keyed on the only evidence that distinguishes it: the named package's own
 * version moving in the same diff.
 */
export function readDeletedChangesets(changedWithStatus, mergeBase, head, root) {
  if (mergeBase === null) return [];
  const found = [];
  for (const { status, path } of changedWithStatus) {
    if (status !== "D" || !isChangesetEntry(path)) continue;
    const source = gitOrNull(["show", `${mergeBase}:${path}`], root);
    if (source === null) continue;
    let parsed;
    try {
      parsed = parseChangeset(source);
    } catch {
      // Unparseable at the base: it recorded no machine-readable intent, so its
      // removal drops none.
      continue;
    }
    // PRESERVED, NOT DROPPED. CHANGESETS.md records that the entries naming retired
    // package identities were kept under ARCHIVED_CHANGESETS. The evidence is the
    // archived file's own front matter, not this gate's opinion — and it is compared
    // by DECLARED RELEASE and not by bytes, because `generate:evidence-lifecycle`
    // stamps a `title`/`lifecycle` pair and a banner onto everything under `docs/`,
    // so "byte-for-byte" stopped being literally true the moment that gate ran.
    const archivedSource = gitOrNull(
      ["show", `${head}:${ARCHIVED_CHANGESETS}/${path.slice(CHANGESET_DIRECTORY.length + 1)}`],
      root,
    );
    const preserved = new Set();
    if (archivedSource !== null) {
      try {
        for (const release of parseChangeset(archivedSource).releases) preserved.add(`${release.name}:${release.type}`);
      } catch {
        // An archived copy that no longer parses preserves nothing the gate can read.
      }
    }
    found.push({ path, releases: parsed.releases, preserved });
  }
  return found;
}

/**
 * Packages whose own manifest version moved between the merge base and head.
 *
 * This is the ONLY signal that tells a `changeset version` run (which consumes entries
 * as it applies them) apart from a plain deletion of pending intent.
 */
export function versionBumps(packages, mergeBase, head, root) {
  const bumped = new Set();
  if (mergeBase === null) return bumped;
  for (const entry of packages) {
    if (entry.private || entry.python !== null) continue;
    const manifest = `${entry.directory}/package.json`;
    const before = gitOrNull(["show", `${mergeBase}:${manifest}`], root);
    const after = gitOrNull(["show", `${head}:${manifest}`], root);
    if (before === null || after === null) continue;
    try {
      if (JSON.parse(before).version !== JSON.parse(after).version) bumped.add(entry.name);
    } catch {
      continue;
    }
  }
  return bumped;
}

/**
 * The commit that set a package's CURRENT version, or null if nothing in history did.
 *
 * Walks that package's manifest history newest-first and stops at the first commit
 * where the `version` field differs from its first parent's. A commit that ADDED the
 * manifest counts: the version it introduced is the one that commit set.
 */
export function versionSetAt(entry, head, root, limit = 200) {
  const manifest = `${entry.directory}/package.json`;
  const versionAt = (revision) => {
    const source = gitOrNull(["show", `${revision}:${manifest}`], root);
    if (source === null) return null;
    try {
      return JSON.parse(source).version ?? null;
    } catch {
      return null;
    }
  };
  const history = (gitOrNull(["log", `--max-count=${limit}`, "--format=%H", head, "--", manifest], root) ?? "")
    .split("\n")
    .filter(Boolean);
  for (const sha of history) {
    const parent = gitOrNull(["rev-parse", "--verify", "--quiet", `${sha}^1`], root)?.trim() ?? null;
    if (parent === null) return sha;
    if (versionAt(sha) !== versionAt(parent)) return sha;
  }
  return null;
}

/**
 * Commits a changeset body cites, keeping only those that resolve and are reachable from head.
 *
 * `staleFor` names the packages for which this commit is ALREADY RELEASED: it is the
 * package's own version-setting commit or an ancestor of it, so the change it carries
 * shipped under the version the manifest currently declares.
 *
 * THE LENIENCY THIS CLOSES. Reachability alone let a changeset name an unchanged
 * package and clear the gate by quoting ANY commit hash that ever touched that
 * package's shipped paths — including one released long ago. "Reachable and it touched
 * the package" is not "this diff has a reason to move the version".
 */
export function citedCommits(summary, head, root, packages = [], limit = 200) {
  const releasedAt = new Map();
  const setAt = (name) => {
    if (releasedAt.has(name)) return releasedAt.get(name);
    const entry = packages.find((candidate) => candidate.name === name && candidate.python === null);
    const sha = entry === undefined ? null : versionSetAt(entry, head, root, limit);
    releasedAt.set(name, sha);
    return sha;
  };
  const cited = [];
  for (const [candidate] of summary.matchAll(/\b[0-9a-f]{7,40}\b/gu)) {
    const sha = gitOrNull(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], root)?.trim();
    if (!sha) continue;
    if (gitOrNull(["merge-base", "--is-ancestor", sha, head], root) === null) continue;
    const touched = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", sha], root)
      .split("\0")
      .filter(Boolean);
    const staleFor = [];
    for (const name of movedPackages(touched, packages).keys()) {
      const bump = setAt(name);
      if (bump === null) continue;
      if (gitOrNull(["merge-base", "--is-ancestor", sha, bump], root) !== null) staleFor.push(name);
    }
    cited.push({ sha, touched, staleFor });
  }
  return cited;
}

/**
 * The verdict, as data. Pure over its inputs so the rule can be tested on its own.
 *
 * `changesets[].cited` is `[{ sha, touched }]`.
 */
export function evaluate({
  changedPaths,
  packages,
  changesets,
  deletedChangesets = [],
  versionBumped = new Set(),
}) {
  const violations = [];
  const moved = movedPackages(changedPaths, packages);
  // Resolved against npm manifests only: a Python SDK carries its twin's name.
  const byName = new Map(packages.filter((entry) => entry.python === null).map((entry) => [entry.name, entry]));

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
      if (changeset.carried?.has(`${release.name}:${release.type}`)) continue;
      const touching = (changeset.cited ?? []).filter(({ touched }) =>
        movedPackages(touched, packages).has(release.name),
      );
      const live = touching.filter(({ staleFor }) => !(staleFor ?? []).includes(release.name));
      if (live.length > 0) continue;
      if (touching.length > 0) {
        violations.push({
          kind: "names-released-change",
          package: release.name,
          message:
            `${changeset.path} names ${release.name}, and the only commit(s) it cites that changed ${release.name} ` +
            `(${touching.map(({ sha }) => sha.slice(0, 12)).join(", ")}) already shipped under the version its ` +
            "manifest declares; a citation must be newer than the package's last version bump",
        });
        continue;
      }
      violations.push({
        kind: "names-unchanged",
        package: release.name,
        message:
          `${changeset.path} names ${release.name}, but nothing ${release.name} ships changed in this diff ` +
          "and the changeset cites no commit that changed it",
      });
    }
  }

  // DELETED -> STILL PENDING. A deletion that drops recorded intent is refused unless
  // the named package's own version moved in the same diff, which is what a
  // `changeset version` run looks like.
  for (const changeset of deletedChangesets) {
    for (const release of changeset.releases) {
      if (versionBumped.has(release.name)) continue;
      if (changeset.preserved?.has(`${release.name}:${release.type}`)) continue;
      violations.push({
        kind: "deletes-pending-intent",
        package: release.name,
        message:
          `${changeset.path} is deleted, and it declared pending ${release.type} intent for ${release.name} ` +
          `whose version did not move in this diff; removing a recorded release needs the version step that spends it, ` +
          `or the entry kept under ${ARCHIVED_CHANGESETS}/`,
      });
    }
  }
  return { moved, named, violations, deletedChangesets, versionBumped };
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
  const packages = readPackages(headCommit, root);
  const licenseOnly = licenseReconciliations(
    changedWithStatus.map((row) => row.path),
    mergeBase,
    headCommit,
    packages,
    root,
  );
  const changedPaths = changedWithStatus
    .map((row) => row.path)
    .filter((path) => !provenanceOnly.has(path) && !licenseOnly.has(path));
  const changesets = readChangesets(changedWithStatus, headCommit, root, mergeBase).map((changeset) => ({
    ...changeset,
    cited: citedCommits(changeset.summary, headCommit, root, packages),
  }));
  const deletedChangesets = readDeletedChangesets(changedWithStatus, mergeBase, headCommit, root);
  const versionBumped = versionBumps(packages, mergeBase, headCommit, root);
  const verdict = evaluate({ changedPaths, packages, changesets, deletedChangesets, versionBumped });

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
  return { mergeBase, changedPaths, provenanceOnly, licenseOnly, packages, changesets, plan, ...verdict };
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
  const publishable = result.packages.filter((entry) => !entry.private && entry.python === null).map((entry) => entry.name);
  const python = result.packages.filter((entry) => entry.python !== null);
  process.stderr.write(
    `[changeset-gate] merge base ${result.mergeBase.slice(0, 12)}; ${result.changedPaths.length} changed path(s); ` +
      `${publishable.length} non-private npm ${PACKAGE_GLOB} package(s) and ${python.length} Python SDK(s) ` +
      `(${python.map((entry) => `${entry.python} -> ${entry.name}`).join(", ")}); ` +
      `${result.changesets.length} changeset(s) in the diff\n`,
  );
  for (const path of result.provenanceOnly) {
    process.stderr.write(`  ${path}: only its sourceDigests moved (provenance, not surface)\n`);
  }
  for (const path of result.licenseOnly) {
    process.stderr.write(`  ${path}: reconciled to the governing ${GOVERNING_LICENSE} licence metadata (CHANGESETS.md: not version intent)\n`);
  }
  for (const [name, paths] of result.moved) {
    process.stderr.write(`  moved ${name} (${paths.length} shipped path(s)) named by ${(result.named.get(name) ?? ["nothing"]).join(", ")}\n`);
  }
  for (const changeset of result.deletedChangesets) {
    process.stderr.write(
      `  deleted ${changeset.path}, which declared ${changeset.releases.map((release) => `${release.name}:${release.type}`).join(", ") || "nothing"}\n`,
    );
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
