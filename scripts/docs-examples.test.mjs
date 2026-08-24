import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDocsExamples } from "./docs-examples.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("authored examples match generated contracts without a local server", () => {
  const result = validateDocsExamples(repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.ok(result.stats.docs >= 53);
  assert.ok(result.stats.guides >= 28);
  assert.ok(result.stats.examples >= 20);
  assert.ok(result.stats.requests >= 10);
});

test("the harness rejects an HTTP example absent from generated OpenAPI", () => {
  const root = mkdtempSync(join(tmpdir(), "platos-docs-examples-"));
  try {
    for (const sourcePath of [
      "apps/agent/src/openapi/openapi.generated.json",
      "internal-packages/tenancy-database/prisma/schema.prisma",
    ]) {
      const target = join(root, sourcePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(repositoryRoot, sourcePath)));
    }
    mkdirSync(join(root, "content/docs"), { recursive: true });
    mkdirSync(join(root, "content/guides"), { recursive: true });
    writeFileSync(
      join(root, "content/docs/example.md"),
      `---\nslug: example\ntitle: Example\ndescription: Example.\n---\n\n\`POST /api/v1/agent/not-a-real-resource\`\n`,
    );
    const result = validateDocsExamples(root);
    assert.ok(result.errors.some((error) => error.includes("POST /api/v1/agent/not-a-real-resource")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
