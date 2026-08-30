import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  MANIFEST_PATH,
  buildManifest,
  checkManifest,
  listProspectiveEntries,
  pathSetSha256,
} from "./protected-paths.mjs";

function fixture(files) {
  const root = mkdtempSync("/var/tmp/platos-protected-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["add", "--all"], { cwd: root });
  return root;
}

function controls(root) {
  for (const path of [MANIFEST_PATH, "docs/audits/win-254-evidence-lifecycle.json"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "{}\n");
  }
}

test("the committed protected-path artifact exactly matches the prospective tree", () => {
  const root = new URL("..", import.meta.url).pathname;
  const manifest = JSON.parse(readFileSync(new URL(`../${MANIFEST_PATH}`, import.meta.url), "utf8"));
  assert.ok(manifest.pathCount > 500, "protected selector is non-vacuous");
  assert.deepEqual(checkManifest(manifest, root), []);
});

test("deletion cannot disappear from both tree and generated inventory because the path-set anchor is independent", () => {
  const root = fixture({ "content/docs/a.md": "a\n", "design/README.md": "design\n", "docs/page.mdx": "# Page\n" });
  try {
    controls(root);
    const before = buildManifest(root);
    rmSync(join(root, "content/docs/a.md"));
    const after = buildManifest(root);
    assert.equal(after.entries.some((entry) => entry.path === "content/docs/a.md"), false);
    const errors = checkManifest(after, root, { expectedPathSetSha256: before.pathSetSha256 });
    assert.ok(errors.some((error) => error.includes("committed anchor")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale hash, missing path, extra path, and duplicate path mutations fail", () => {
  const root = new URL("..", import.meta.url).pathname;
  const manifest = buildManifest(root);
  const mutations = [
    (copy) => { copy.entries[0].sha256 = "0".repeat(64); },
    (copy) => { copy.entries.pop(); copy.pathCount -= 1; copy.pathSetSha256 = pathSetSha256(copy.entries); },
    (copy) => { copy.entries.push({ path: "docs/extra.md", mode: "100644", sha256: "0".repeat(64) }); copy.pathCount += 1; copy.pathSetSha256 = pathSetSha256(copy.entries); },
    (copy) => { copy.entries.splice(1, 0, { ...copy.entries[0] }); copy.pathCount += 1; copy.pathSetSha256 = pathSetSha256(copy.entries); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.ok(checkManifest(copy, root).length > 0);
  }
});

test("NUL-safe inventory rejects newline and invalid-UTF8 pathname bypasses", () => {
  const newlineRoot = fixture({ "docs/good.md": "ok\n" });
  try {
    writeFileSync(join(newlineRoot, "docs/bad\nname.md"), "bad\n");
    execFileSync("git", ["add", "--all"], { cwd: newlineRoot });
    assert.throws(() => listProspectiveEntries(newlineRoot), /canonical newline-free repository path/u);
  } finally {
    rmSync(newlineRoot, { recursive: true, force: true });
  }

  const invalidRoot = fixture({ "docs/good.md": "ok\n" });
  try {
    const invalid = Buffer.concat([Buffer.from(`${invalidRoot}/docs/invalid-`), Buffer.from([0xff])]);
    writeFileSync(invalid, "bad\n");
    execFileSync("git", ["add", "--all"], { cwd: invalidRoot });
    assert.throws(() => listProspectiveEntries(invalidRoot), /invalid UTF-8 bytes/u);
  } finally {
    rmSync(invalidRoot, { recursive: true, force: true });
  }
});

test("protected symlinks, dangling links, and outside-root targets fail closed", () => {
  for (const target of ["../outside", "missing"] ) {
    const root = fixture({ "outside": "outside\n" });
    try {
      mkdirSync(join(root, "content/docs"), { recursive: true });
      symlinkSync(target, join(root, "content/docs/link.md"));
      execFileSync("git", ["add", "--all"], { cwd: root });
      assert.throws(() => buildManifest(root), /protected Git mode 120000|symbolic link/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("staged deletion and whole protected-root deletion cannot be hidden by removing artifact rows", () => {
  const root = fixture({
    "content/docs/a.md": "a\n",
    "content/docs/b.md": "b\n",
    "design/README.md": "design\n",
  });
  try {
    controls(root);
    const before = buildManifest(root);
    execFileSync("git", ["rm", "-q", "-f", "content/docs/a.md"], { cwd: root });
    const staged = buildManifest(root);
    assert.ok(checkManifest(staged, root, { expectedPathSetSha256: before.pathSetSha256 }).some((error) => error.includes("committed anchor")));

    rmSync(join(root, "content"), { recursive: true, force: true });
    const withoutRoot = buildManifest(root);
    assert.ok(checkManifest(withoutRoot, root, { expectedPathSetSha256: before.pathSetSha256 }).some((error) => error.includes("committed anchor")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unresolved Git index stages fail before a protected inventory can be built", () => {
  const root = fixture({ "docs/good.md": "ok\n" });
  try {
    const hashes = ["base\n", "ours\n", "theirs\n"].map((input) =>
      execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input, encoding: "utf8" }).trim()
    );
    const indexInfo = hashes.map((hash, index) => `100644 ${hash} ${index + 1}\tdocs/conflict.md`).join("\n") + "\n";
    execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: indexInfo });
    assert.throws(() => listProspectiveEntries(root), /unresolved Git index stage/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
