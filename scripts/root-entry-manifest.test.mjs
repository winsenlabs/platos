import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ARCHIVED_MOVES,
  CORPUS_EXCLUSIONS,
  JSON_PATH,
  archivedPayloadBytes,
  collectSemanticConsumers,
  findSemanticPathReferences,
  listRepositoryFiles,
  listRootEntries,
  run,
  validateManifest,
  validateRootCoverage,
} from "./root-entry-manifest.mjs";

const repositoryRoot = join(import.meta.dirname, "..");
const temporaryRoots = [];
test.after(() => temporaryRoots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function copy(value) {
  return structuredClone(value);
}

function committedDocument() {
  return JSON.parse(readFileSync(join(repositoryRoot, JSON_PATH), "utf8"));
}

test("committed JSON and Markdown exactly describe the final root", () => {
  assert.deepEqual(run(repositoryRoot, "check"), []);
  const document = committedDocument();
  assert.equal(document.rootEntryCount, 49);
  assert.equal(Object.hasOwn(document, "semanticConsumerCount"), false);
  assert.ok(document.entries.every((row) => !Object.hasOwn(row, "semanticConsumers")));
  assert.equal(document.entries.find((row) => row.entry === ".gstack")?.disposition, "regenerate");
  assert.equal(document.entries.find((row) => row.entry === ".prettierignore")?.fixedName, true);
});

test("Git enumeration is NUL-safe for root names containing newlines", () => {
  const root = mkdtempSync(join("/var/tmp", "platos-root-manifest-nul-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "normal"), "ok\n");
  writeFileSync(join(root, "line\nbreak"), "ok\n");
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "dir", "child"), "ok\n");
  execFileSync("git", ["add", "--", "normal", "line\nbreak", "dir/child"], { cwd: root });
  assert.deepEqual(listRootEntries(root), ["dir", "line\nbreak", "normal"]);
});

test("Git enumeration rejects invalid UTF-8 path bytes and retains dangling symlinks", () => {
  const invalidRoot = mkdtempSync(join("/var/tmp", "platos-root-manifest-invalid-utf8-"));
  temporaryRoots.push(invalidRoot);
  execFileSync("git", ["init", "-q"], { cwd: invalidRoot });
  const invalidPath = Buffer.concat([Buffer.from(`${invalidRoot}/invalid-`), Buffer.from([0xff])]);
  writeFileSync(invalidPath, "invalid pathname bytes\n");
  execFileSync("git", ["add", "--all"], { cwd: invalidRoot });
  assert.throws(() => listRepositoryFiles(invalidRoot), /pathname with invalid UTF-8 bytes/u);

  const symlinkRoot = mkdtempSync(join("/var/tmp", "platos-root-manifest-symlink-"));
  temporaryRoots.push(symlinkRoot);
  execFileSync("git", ["init", "-q"], { cwd: symlinkRoot });
  symlinkSync("missing-target", join(symlinkRoot, "dangling-link"));
  execFileSync("git", ["add", "--", "dangling-link"], { cwd: symlinkRoot });
  assert.deepEqual(listRepositoryFiles(symlinkRoot), ["dangling-link"]);
});

test("coverage rejects duplicate, malformed order, new, missing, and absent entries", () => {
  const entries = [{ entry: "a" }, { entry: "b" }];
  assert.deepEqual(validateRootCoverage(["a", "b"], entries), []);
  assert.ok(validateRootCoverage(["a", "b"], [{ entry: "a" }, { entry: "a" }]).some((error) => error.includes("duplicates")));
  assert.ok(validateRootCoverage(["a", "b"], [{ entry: "b" }, { entry: "a" }]).some((error) => error.includes("sorted")));
  assert.ok(validateRootCoverage(["a", "b", "new-root"], entries).some((error) => error.includes("coverage differs")));
  assert.ok(validateRootCoverage(["a", "b"], [{ entry: "a" }]).some((error) => error.includes("coverage differs")));
  assert.ok(validateRootCoverage(["a"], entries).some((error) => error.includes("coverage differs")));
});

test("manifest schema rejects malformed rows, self-exclusion expansion, and stale archive records", () => {
  const malformed = committedDocument();
  malformed.entries[0].kind = "maybe";
  assert.ok(validateManifest(repositoryRoot, malformed).some((error) => error.includes("kind is malformed")));

  const excluded = committedDocument();
  excluded.corpusExclusions = [...CORPUS_EXCLUSIONS, "README.md"];
  assert.ok(validateManifest(repositoryRoot, excluded).some((error) => error.includes("self-limited")));

  const stale = committedDocument();
  stale.archivedMoves[0].sha256 = "0".repeat(64);
  assert.ok(validateManifest(repositoryRoot, stale).some((error) => error.includes("archived move records must be exact")));

  const duplicate = committedDocument();
  duplicate.entries.splice(1, 0, copy(duplicate.entries[0]));
  assert.ok(validateManifest(repositoryRoot, duplicate).some((error) => error.includes("duplicates")));
  assert.equal(ARCHIVED_MOVES.length, 13);
});

test("visible lifecycle envelopes preserve exact archived payload hashes and fail closed when malformed", () => {
  for (const move of ARCHIVED_MOVES) {
    const source = readFileSync(join(repositoryRoot, move.destination), "utf8");
    const payloadHash = createHash("sha256").update(archivedPayloadBytes(source)).digest("hex");
    assert.equal(payloadHash, move.sha256, move.destination);
    assert.throws(
      () => archivedPayloadBytes(source.replace('lifecycle: "POINT-IN-TIME"', 'lifecycle: "ACCEPTED"')),
      /exact reviewed POINT-IN-TIME lifecycle envelope/u,
    );
    assert.notEqual(
      createHash("sha256").update(archivedPayloadBytes(`${source}payload drift\n`)).digest("hex"),
      move.sha256,
    );
  }
});

test("semantic consumers come from parsed JSON and YAML, not removed scripts or inert comments", () => {
  const found = collectSemanticConsumers(
    JSON.stringify({ scripts: { active: "pnpm audit:root-manifest" } }),
    {
      ".github/workflows/ci.yml": `jobs:\n  gate:\n    steps:\n      - run: pnpm test:root-manifest\n      - run: echo skipped # pnpm test:hook-policy\n`,
    },
  );
  assert.ok(found.some((item) => item.type === "package-script" && item.command === "pnpm audit:root-manifest"));
  assert.ok(found.some((item) => item.type === "workflow-command" && item.command === "pnpm test:root-manifest"));
  assert.ok(!found.some((item) => item.command === "pnpm test:hook-policy"));
  assert.ok(!found.some((item) => item.id.includes("scripts.docker")));
});

test("removed-path reachability covers semantic references but excludes inert Python, JSONC, Dockerfile, and archived comments", () => {
  const target = "scripts/removed.ts";
  const references = findSemanticPathReferences([target], new Map([
    ["docs/page.mdx", "[runner](../scripts/removed.ts)\n"],
    ["config.json", '{"runner":"scripts/removed.ts"}\n'],
    ["config.yml", "runner: scripts/removed.ts\n"],
    ["src/use.ts", 'import "../scripts/removed";\n'],
    ["README.md", "Run `node scripts/removed.ts` before release.\n"],
    ["src/inert.ts", '// import "../scripts/removed";\n/* scripts/removed.ts */\n'],
    ["tools/inert.py", "runner = None# scripts/removed.ts\n"],
    ["config/inert.jsonc", '// "runner": "scripts/removed.ts"\n/* scripts/removed.ts */\n'],
    ["tsconfig.inert.json", '// "runner": "scripts/removed.ts"\n'],
    [".vscode/settings.json", '// "runner": "scripts/removed.ts"\n'],
    ["inert.yml", "# runner: scripts/removed.ts\n"],
    ["apps/webapp/Dockerfile.platos", "# COPY scripts/removed.ts /app/removed.ts\n"],
    ["internal-packages/tenancy-database/Dockerfile.migrations", "# COPY scripts/removed.ts /app/removed.ts\n"],
    ["docs/inert.mdx", "<!-- [old](../scripts/removed.ts) -->\n"],
    ["docs/audits/history/win-252/old.md", "scripts/removed.ts\n"],
  ]));
  assert.deepEqual(references, [{
    path: target,
    referencedBy: ["README.md", "config.json", "config.yml", "docs/page.mdx", "src/use.ts"],
  }]);
});
