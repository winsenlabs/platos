/**
 * Real temp-directory scenarios for the vocabulary boundary manifest.
 *
 * Every scenario is an actual git repository on disk with actual commits and
 * actual `git mv`, not a mock. Move detection reads real git plumbing, so a
 * mocked tree would prove nothing about the thing under test.
 *
 * NOTE ON SPELLING: this file is itself scanned by the boundary gate, so it
 * must not contain any forbidden token as a literal. The tokens the fixtures
 * need are assembled at runtime from fragments below. Do not "tidy" these into
 * plain strings -- doing so makes the repository fail its own gate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { collectFindings } from "../../scripts/vocabulary-boundary.mjs";
import { regenerate } from "../../scripts/vocabulary/generate.mjs";
import { serializeManifest } from "../../scripts/vocabulary/manifest-io.mjs";

const assemble = (...parts) => parts.join("");

/** Forbidden tokens, assembled so this source file stays clean. */
export const TOKEN = Object.freeze({
  vendor: assemble("Tri", "gger"),
  vendorLower: assemble("tri", "gger"),
  retry: assemble("att", "empt"),
  rollout: assemble("deploy", "ment"),
  retiredTool: assemble("spawn", "_bgo"),
  secret: assemble("TRI", "GGER_INTERNAL_SECRET"),
});

export const VENDOR_LIFECYCLE = Object.freeze({
  classification: "vendor",
  owner: "Runtime Integrations",
  rationale: "Names an external vendor contract rather than a Platos concept.",
  removalPolicy: "Remove when the vendor contract is removed.",
  removalEvent: "External vendor support is removed.",
});

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function writeFileAt(root, path, source) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
}

/**
 * Create a committed git repository containing `files`.
 * @returns a handle with mutation helpers and a regeneration runner.
 */
export function createScenario(files) {
  const root = mkdtempSync(join(tmpdir(), "platos-vocab-fixture-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Boundary Fixture"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  for (const [path, source] of Object.entries(files)) writeFileAt(root, path, source);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-q", "-m", "seed"]);

  // Deliberately outside the scanned repository: the manifest records the very
  // tokens the gate forbids, so keeping it inside would make every scenario
  // scan its own manifest and report the records as fresh violations.
  const manifestPath = join(mkdtempSync(join(tmpdir(), "platos-vocab-manifest-")), "manifest.json");

  const handle = {
    root,
    manifestPath,

    write(path, source) {
      writeFileAt(root, path, source);
      git(root, ["add", "--all"]);
    },

    /** A real rename that git records as such. */
    move(from, to) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      git(root, ["mv", from, to]);
    },

    remove(path) {
      git(root, ["rm", "-q", path]);
    },

    /**
     * Place content at `to` WITHOUT telling git it is a rename, leaving the
     * destination untracked. Git rename detection reports nothing here, so only
     * the content digest can pair the two -- which is exactly what this
     * exercises. Pass `body` to synthesize content instead of copying `from`.
     */
    copyOutsideGit(from, to, body) {
      const content = body ?? readFileSync(join(root, from), "utf8");
      if (from) git(root, ["rm", "-q", from]);
      writeFileAt(root, to, content);
    },

    /**
     * Approve every current finding, producing a manifest that is exactly in
     * sync with the tree. The starting point for every scenario.
     */
    seedManifest(lifecycle = VENDOR_LIFECYCLE) {
      const scan = collectFindings(root, new Set());
      const exceptions = scan.findings.map((finding) => {
        const exception = {
          path: finding.path,
          rule: finding.rule,
          matchedText: finding.matchedText,
          line: finding.line,
          column: finding.column,
          localContextSha256: finding.localContextSha256,
          semanticContextKind: finding.semanticContextKind,
          semanticContextSha256: finding.semanticContextSha256,
          ...lifecycle,
        };
        if (finding.collisionContextSha256) {
          exception.collisionContextSha256 = finding.collisionContextSha256;
        }
        return exception;
      });
      const manifest = { version: 1, exclusions: [], exceptions };
      writeFileSync(manifestPath, serializeManifest(manifest));
      return manifest;
    },

    run(options = {}) {
      return regenerate(root, { manifestPath, manifestLabel: "manifest.json", ...options });
    },

    /** Disposition counts keyed by name, for compact assertions. */
    counts(options = {}) {
      return handle.run(options).classification.counts;
    },

    exists(path) {
      return existsSync(join(root, path));
    },

    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(manifestPath), { recursive: true, force: true });
    },
  };
  return handle;
}

/** Source text helpers that keep forbidden tokens out of this file's bytes. */
export const source = {
  vendorModule(extra = "") {
    return [
      "export class VendorRuntime {",
      "  connect() {",
      `    return "External ${TOKEN.vendor}";`,
      "  }",
      "}",
      extra,
      "",
    ].join("\n");
  },
  markdownSection(body) {
    return ["# Vendor runtime", "", "## Setup", "", body, ""].join("\n");
  },
};
