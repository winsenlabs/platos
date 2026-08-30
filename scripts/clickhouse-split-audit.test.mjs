import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  INTEGRATION_BASE,
  OWNER_AUTHORIZATION_BASE,
  REPORT_PATH,
  auditRepository,
  reportText,
  scanReachability,
  validateCurrentTreeTombstones,
  validateDeletionSet,
} from "./clickhouse-split-audit.mjs";

const root = resolve(import.meta.dirname, "..");
const candidateNames = ["@internal/clickhouse", "@internal/replication", "@internal/tsql"];

function scan(path, content) {
  return scanReachability([{ path, content }], candidateNames);
}

function withDetachedWorktree(prefix, revision, run) {
  const scratch = mkdtempSync(`/var/tmp/${prefix}-`);
  const worktree = resolve(scratch, "worktree");
  let worktreeAdded = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, revision], { cwd: root, stdio: "ignore" });
    worktreeAdded = true;
    return run(worktree);
  } finally {
    if (worktreeAdded) {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const mutationFixtures = [
  {
    channel: "package-dependencies",
    path: "packages/consumer/package.json",
    content: JSON.stringify({ dependencies: { "@internal/clickhouse": "workspace:*" } }),
  },
  {
    channel: "static-imports",
    path: "packages/consumer/src/index.ts",
    content: 'import { client } from "@internal/clickhouse";\n',
  },
  {
    channel: "side-effect-imports",
    path: "packages/consumer/src/register.ts",
    content: 'import "@internal/replication";\n',
  },
  {
    channel: "dynamic-imports",
    path: "packages/consumer/src/lazy.ts",
    content: 'export const load = () => import("@internal/tsql");\n',
  },
  {
    channel: "filesystem-loaders",
    label: "filesystem-loader path",
    expectedKind: "filesystem-loader",
    path: "packages/consumer/src/package-loader.ts",
    content: 'const manifest = JSON.parse(readFileSync(resolve(root, "internal-packages/tsql/package.json"), "utf8"));\n',
  },
  {
    channel: "filesystem-loaders",
    label: "createRequire package-name loader",
    expectedKind: "create-require",
    path: "packages/consumer/src/create-require-loader.ts",
    content: 'const parser = createRequire(import.meta.url)("@internal/tsql");\n',
  },
  {
    channel: "filesystem-loaders",
    label: "createRequire assigned alias",
    expectedKind: "create-require-alias",
    path: "packages/consumer/src/required-alias.ts",
    content: 'const required = createRequire(import.meta.url);\nconst parser = required("@internal/clickhouse/parser");\n',
  },
  {
    channel: "filesystem-loaders",
    label: "createRequire direct resolver",
    expectedKind: "create-require-resolve",
    path: "packages/consumer/src/create-require-resolve.ts",
    content: 'const parserPath = createRequire(import.meta.url).resolve("@internal/tsql");\n',
  },
  {
    channel: "filesystem-loaders",
    label: "createRequire aliased resolver",
    expectedKind: "create-require-alias-resolve",
    path: "packages/consumer/src/create-require-alias-resolve.ts",
    content: 'const req = createRequire(import.meta.url);\nconst parserPath = req.resolve("@internal/clickhouse/parser");\n',
  },
  {
    channel: "filesystem-loaders",
    label: "import.meta.resolve package-name loader",
    expectedKind: "import-meta-resolve",
    path: "packages/consumer/src/import-meta-resolve.ts",
    content: 'const packageUrl = import.meta.resolve("@internal/replication");\n',
  },
  {
    channel: "ts-references",
    path: "packages/consumer/tsconfig.json",
    content: JSON.stringify({ references: [{ path: "../../internal-packages/tsql" }] }),
  },
  {
    channel: "ci",
    path: ".github/workflows/ci.yml",
    content: "run: pnpm --filter @internal/replication test\n",
  },
  {
    channel: "scripts",
    path: "scripts/build-retired.sh",
    content: "pnpm --filter @internal/clickhouse build\n",
  },
  {
    channel: "docker",
    path: "Dockerfile",
    content: "COPY internal-packages/clickhouse/Dockerfile /tmp/Dockerfile\n",
  },
  {
    channel: "test-config",
    path: "vitest.config.ts",
    content: 'const retired = "internal-packages/tsql";\n',
  },
  {
    channel: "docs",
    path: "docs/operator.md",
    content: "Run internal-packages/replication before startup.\n",
  },
  {
    channel: "licenses",
    path: "NOTICE",
    content: "Bundled component: @internal/tsql\n",
  },
  {
    channel: "generated",
    path: "packages/consumer/generated/client.generated.ts",
    content: 'export { parse } from "@internal/tsql";\n',
  },
];

const cleanAudit = auditRepository(root);

for (const fixture of mutationFixtures) {
  test(`mutation fixture flips ${fixture.label ?? fixture.channel}`, () => {
    const pristine = scan(fixture.path, fixture.content.replaceAll("@internal/", "@fixture/")
      .replaceAll("internal-packages/", "fixture-packages/"));
    assert.equal(pristine[fixture.channel].length, 0, "negative control must start clean");
    const mutated = scan(fixture.path, fixture.content);
    assert.ok(mutated[fixture.channel].length > 0, `${fixture.channel} detector did not fire`);
    if (fixture.expectedKind) {
      assert.ok(
        mutated[fixture.channel].some(({ kind }) => kind === fixture.expectedKind),
        `${fixture.expectedKind} detector did not fire`
      );
    }
  });
}

test("deletion-set validation rejects an unrecorded deletion", () => {
  const predecessor = [
    "internal-packages/clickhouse/schema/001.sql",
    "internal-packages/clickhouse/src/index.ts",
    "internal-packages/replication/package.json",
    "internal-packages/tsql/package.json",
    "patches/antlr4ts@0.5.0-alpha.4.patch",
    "README.md",
  ];
  const actual = [
    "internal-packages/clickhouse/src/index.ts",
    "internal-packages/replication/package.json",
    "internal-packages/tsql/package.json",
    "patches/antlr4ts@0.5.0-alpha.4.patch",
    "README.md",
  ];
  assert.deepEqual(validateDeletionSet(predecessor, actual).unrecorded, ["README.md"]);
});

test("deletion-set validation rejects a restored owner-authorized path", () => {
  const ownerAuthorized = [
    "internal-packages/replication/package.json",
    "internal-packages/replication/src/index.ts",
  ];
  assert.deepEqual(
    validateDeletionSet(ownerAuthorized, ["internal-packages/replication/package.json"]).missing,
    ["internal-packages/replication/src/index.ts"]
  );
});

test("current-tree tombstones reject newly introduced retired-cluster paths", () => {
  const pristine = [
    "internal-packages/clickhouse/schema",
    "internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql",
  ];
  assert.deepEqual(validateCurrentTreeTombstones(pristine), [], "schema exception must remain allowed");
  assert.deepEqual(
    validateCurrentTreeTombstones([
      ...pristine,
      "internal-packages/clickhouse/src/reintroduced.ts",
      "internal-packages/replication/package.json",
      "internal-packages/tsql/generated/parser.ts",
    ]),
    [
      "internal-packages/clickhouse/src/reintroduced.ts",
      "internal-packages/replication/package.json",
      "internal-packages/tsql/generated/parser.ts",
    ]
  );
});

test("live audit turns red for a current-tree tombstone mutation", () => {
  withDetachedWorktree("platos-win253-tombstone", "HEAD", (worktree) => {
    const mutation = resolve(worktree, "internal-packages/tsql/reintroduced-package.json");
    mkdirSync(resolve(mutation, ".."), { recursive: true });
    writeFileSync(mutation, "{}\n");
    const { violations } = auditRepository(worktree);
    assert.ok(
      violations.includes("current-tree tombstone violated: internal-packages/tsql/reintroduced-package.json"),
      "live audit must reject an untracked path beneath a removed package root"
    );
  });
});

test("live audit turns red for an ignored retired-root file", () => {
  withDetachedWorktree("platos-win253-ignored-tombstone", "HEAD", (worktree) => {
    const repositoryPath = "internal-packages/tsql/node_modules/ignored-remnant.js";
    const mutation = resolve(worktree, repositoryPath);
    mkdirSync(resolve(mutation, ".."), { recursive: true });
    writeFileSync(mutation, "module.exports = {};\n");
    execFileSync("git", ["check-ignore", "--quiet", "--", repositoryPath], { cwd: worktree });
    const { violations } = auditRepository(worktree);
    assert.ok(
      violations.includes(`current-tree tombstone violated: ${repositoryPath}`),
      "live audit must reject ignored files beneath a removed package root"
    );
  });
});

test("live audit derives every deletion and integration-base identity from Git", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  const actual = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", INTEGRATION_BASE, "--"],
    { cwd: root, encoding: "utf8" }
  ).split("\0").filter(Boolean).sort();
  assert.deepEqual(report.deletion.files.map(({ path }) => path), actual);
  assert.deepEqual(report.restore.pathspec, actual);
  assert.deepEqual(report.restore.argv.slice(0, 4), ["git", "restore", `--source=${INTEGRATION_BASE}`, "--"]);

  for (const file of report.deletion.files) {
    const integrationBaseBlob = execFileSync("git", ["show", `${INTEGRATION_BASE}:${file.path}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(file.bytes, integrationBaseBlob.length, file.path);
    assert.equal(file.integrationBaseSha256, createHash("sha256").update(integrationBaseBlob).digest("hex"), file.path);
    assert.equal(
      file.integrationBaseBlobOid,
      execFileSync("git", ["rev-parse", `${INTEGRATION_BASE}:${file.path}`], { cwd: root, encoding: "utf8" }).trim(),
      file.path
    );
  }

  const ownerPackage = execFileSync("git", ["show", `${OWNER_AUTHORIZATION_BASE}:internal-packages/clickhouse/package.json`], {
    cwd: root,
    encoding: "buffer",
  });
  const integrationPackage = execFileSync("git", ["show", `${INTEGRATION_BASE}:internal-packages/clickhouse/package.json`], {
    cwd: root,
    encoding: "buffer",
  });
  assert.notDeepEqual(integrationPackage, ownerPackage, "control requires the ClickHouse manifest to differ across baselines");
  const packageRecord = report.deletion.files.find(({ path }) => path === "internal-packages/clickhouse/package.json");
  assert.equal(packageRecord.integrationBaseSha256, createHash("sha256").update(integrationPackage).digest("hex"));
});

test("reported restore command recreates all deletion paths byte-for-byte from the integration base", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  assert.equal(report.deletion.files.length, 91);
  withDetachedWorktree("platos-win253-restore", INTEGRATION_BASE, (worktree) => {
    for (const { path } of report.deletion.files) rmSync(resolve(worktree, path), { force: true });
    const [command, ...args] = report.restore.argv;
    execFileSync(command, args, { cwd: worktree, stdio: "ignore" });
    for (const file of report.deletion.files) {
      const restored = readFileSync(resolve(worktree, file.path));
      const integrationBaseBlob = execFileSync("git", ["show", `${INTEGRATION_BASE}:${file.path}`], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.deepEqual(restored, integrationBaseBlob, file.path);
    }
  });
});

test("committed report is the exact executable audit output", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  assert.equal(readFileSync(resolve(root, REPORT_PATH), "utf8"), reportText(report));

  const tampered = structuredClone(report);
  tampered.deletion.files.pop();
  assert.notEqual(reportText(tampered), reportText(report), "deletion-record mutation must be visible");
});
