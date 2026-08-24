import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDocsExamples } from "./docs-examples.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function copyContractFile(root, sourcePath) {
  const target = join(root, sourcePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repositoryRoot, sourcePath), target);
}

function contractFixture() {
  const root = mkdtempSync(join("/var/tmp", "platos-docs-examples-"));
  const sourcePaths = [
    "package.json",
    "docker-compose.platos.yml",
    "apps/agent/src/openapi/openapi.generated.json",
    "apps/agent/src/agent-runtime/agent.service.ts",
    "apps/agent/src/agent-runtime/jobs.controller.ts",
    "apps/agent/src/mcp-platform/tools/jobs.ts",
    "internal-packages/tenancy-database/prisma/schema.prisma",
    "packages/platos-client/package.json",
    "packages/platos-client/src/index.ts",
    "packages/platos-client/src/client.ts",
    "packages/platos-client/src/types.ts",
    "packages/platools-js/package.json",
    "packages/platools-js/src/index.ts",
    "packages/platools-js/src/platools.ts",
    "packages/platools-py/pyproject.toml",
    "packages/platools-py/platools/__init__.py",
  ];
  for (const name of readdirSync(join(repositoryRoot, "packages/platos-client/src/apis"))) {
    if (name.endsWith(".ts")) sourcePaths.push(`packages/platos-client/src/apis/${name}`);
  }
  for (const sourcePath of sourcePaths) copyContractFile(root, sourcePath);
  mkdirSync(join(root, "content/docs"), { recursive: true });
  mkdirSync(join(root, "content/guides"), { recursive: true });
  return root;
}

function writeExample(root, body) {
  writeFileSync(
    join(root, "content/docs/example.md"),
    `---\nslug: example\ntitle: Example\ndescription: Example.\n---\n\n${body}\n`,
  );
}

test("authored examples match generated contracts without a local server", () => {
  const result = validateDocsExamples(repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.ok(result.stats.docs >= 53);
  assert.ok(result.stats.guides >= 28);
  assert.ok(result.stats.examples >= 20);
  assert.ok(result.stats.requests >= 10);
});

test("the harness rejects an HTTP example absent from generated OpenAPI", () => {
  const root = contractFixture();
  try {
    writeExample(root, "`POST /api/v1/agent/not-a-real-resource`");
    const result = validateDocsExamples(root);
    assert.ok(result.errors.some((error) => error.includes("POST /api/v1/agent/not-a-real-resource")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the harness rejects an SDK method absent from the public client", () => {
  const root = contractFixture();
  try {
    writeExample(root, "```ts\nawait platos.threads.stream({ threadId, message: \"Hi\" });\n```");
    const result = validateDocsExamples(root);
    assert.ok(result.errors.some((error) => error.includes("PlatosClient.threads.stream is not public")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the harness rejects unavailable package exports, installs, and root scripts", () => {
  const root = contractFixture();
  try {
    writeExample(
      root,
      "```ts\nimport { PlatosArtifact } from \"@platosdev/client/react\";\n```\n\n```bash\nnpm install @platosdev/not-a-package\npnpm run not-a-script\n```",
    );
    const result = validateDocsExamples(root);
    assert.ok(result.errors.some((error) => error.includes("package subpath @platosdev/client/react is absent")));
    assert.ok(result.errors.some((error) => error.includes("npm package @platosdev/not-a-package is absent")));
    assert.ok(result.errors.some((error) => error.includes("root package.json has no script not-a-script")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the harness rejects an unknown Compose service", () => {
  const root = contractFixture();
  try {
    writeExample(root, "```bash\ndocker compose -f docker-compose.platos.yml restart webapp start-worker\n```");
    const result = validateDocsExamples(root);
    assert.ok(result.errors.some((error) => error.includes("unknown Compose service start-worker")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the harness rejects an incorrect spawn_job payload", () => {
  const root = contractFixture();
  try {
    writeExample(root, "The `spawn_job` payload is:\n\n```json\n{\"jobId\":\"report\",\"input\":{}}\n```");
    const result = validateDocsExamples(root);
    assert.ok(result.errors.some((error) => error.includes("spawn_job payload contains unsupported key jobId")));
    assert.ok(result.errors.some((error) => error.includes("spawn_job payload is missing required key instruction")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
