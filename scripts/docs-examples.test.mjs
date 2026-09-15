import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QUICK_START_PATHS, quickStartEnvironmentErrors, validateDocsExamples } from "./docs-examples.mjs";

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

test("every Compose quick-start creates and explains .env before model evaluation", () => {
  assert.deepEqual(quickStartEnvironmentErrors(repositoryRoot), []);
  assert.ok(QUICK_START_PATHS.length >= 8, "quick-start selector must remain non-vacuous");

  const rootReadme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  const missingCopy = new Map([["README.md", rootReadme.replace("cp .env.example .env", "# omitted environment setup")]]);
  assert.ok(quickStartEnvironmentErrors(repositoryRoot, missingCopy).some((error) => error.includes("must create .env")));

  const lateCopy = new Map([["README.md", rootReadme.replace("cp .env.example .env", "").replace(
    "docker compose -f docker-compose.platos.yml up -d",
    "docker compose -f docker-compose.platos.yml up -d\ncp .env.example .env",
  )]]);
  assert.ok(quickStartEnvironmentErrors(repositoryRoot, lateCopy).some((error) => error.includes("must create .env")));
});

// A fresh fixture is fresh only if the shell running the suite cannot supply what
// .env.example omits. Compose reads an interpolated variable from the process
// environment BEFORE .env, so a developer or runner that happens to export one
// would turn a missing example value into a pass. Strip every name the Compose
// file interpolates, and every COMPOSE_* setting that could change which file or
// profile is evaluated, and keep the rest (PATH, DOCKER_HOST, ...) so the CLI runs.
function composeInterpolatedNames(composeSource) {
  return [...new Set([...composeSource.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]))];
}

function freshComposeEnvironment(composeSource, parent = process.env) {
  const interpolated = new Set(composeInterpolatedNames(composeSource));
  return Object.fromEntries(
    Object.entries(parent).filter(([name]) => !interpolated.has(name) && !name.startsWith("COMPOSE_")),
  );
}

function composeRequiredNames(composeSource) {
  return [...new Set([...composeSource.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/gu)].map((match) => match[1]))];
}

function composeQuickStartFixture() {
  const root = mkdtempSync(join("/var/tmp", "platos-compose-quick-start-"));
  copyFileSync(join(repositoryRoot, ".env.example"), join(root, ".env.example"));
  copyFileSync(join(repositoryRoot, "docker-compose.platos.yml"), join(root, "docker-compose.platos.yml"));
  execFileSync("cp", [".env.example", ".env"], { cwd: root });
  return root;
}

test("the documented environment setup permits Compose model evaluation in a fresh fixture", () => {
  const composeSource = readFileSync(join(repositoryRoot, "docker-compose.platos.yml"), "utf8");
  assert.ok(composeRequiredNames(composeSource).length >= 13, "the required-variable selector must remain non-vacuous");
  const root = composeQuickStartFixture();
  try {
    execFileSync("docker", ["compose", "-f", "docker-compose.platos.yml", "config", "--quiet"], {
      cwd: root,
      env: freshComposeEnvironment(composeSource),
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a required Compose variable the example omits fails evaluation even when the parent shell exports it", () => {
  const composeSource = readFileSync(join(repositoryRoot, "docker-compose.platos.yml"), "utf8");
  const envExample = readFileSync(join(repositoryRoot, ".env.example"), "utf8");
  const required = composeRequiredNames(composeSource).find((name) => new RegExp(`^${name}=`, "mu").test(envExample));
  assert.ok(required, "at least one Compose-required variable must be assigned in .env.example");
  const root = composeQuickStartFixture();
  try {
    writeFileSync(join(root, ".env"), envExample.replace(new RegExp(`^${required}=.*$\\n?`, "mu"), ""));
    const exported = { ...process.env, [required]: "exported-by-the-parent-shell-0123456789abcdef" };
    assert.throws(
      () =>
        execFileSync("docker", ["compose", "-f", "docker-compose.platos.yml", "config", "--quiet"], {
          cwd: root,
          env: freshComposeEnvironment(composeSource, exported),
          stdio: "pipe",
        }),
      (error) => String(error.stderr ?? error.message).includes(required),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// What Compose RESOLVED for every required variable, read back from its own model.
// An unquoted `.env` value followed by `   # a comment` is not a blank value in
// Compose: the comment becomes the value, so `:?required` is satisfied by the text
// of a comment and the service starts with it as its secret. Evaluating is not
// enough; the resolved value has to be one somebody wrote as a value.
function resolvedRequiredValues(root, composeSource) {
  const model = JSON.parse(
    execFileSync("docker", ["compose", "-f", "docker-compose.platos.yml", "config", "--format", "json"], {
      cwd: root,
      env: freshComposeEnvironment(composeSource),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }),
  );
  const required = new Set(composeRequiredNames(composeSource));
  const resolved = [];
  for (const [service, definition] of Object.entries(model.services ?? {})) {
    for (const [name, value] of Object.entries(definition.environment ?? {})) {
      if (required.has(name)) resolved.push({ service, name, value: String(value ?? "") });
    }
  }
  return resolved;
}

const COMMENT_AS_VALUE = /(?:^|\s)#/u;

test("no Compose-required variable resolves to an inline comment from .env.example", () => {
  const composeSource = readFileSync(join(repositoryRoot, "docker-compose.platos.yml"), "utf8");
  const root = composeQuickStartFixture();
  try {
    const resolved = resolvedRequiredValues(root, composeSource);
    // NON-VACUITY: the model really carries the required secrets, by name.
    for (const name of ["PLATOS_COMPONENT_AUTH_SECRET", "MANAGED_WORKER_SECRET", "PLATOS_INTERNAL_AUTH_TOKEN"]) {
      assert.ok(resolved.some((entry) => entry.name === name), `the resolved model no longer carries ${name}`);
    }
    assert.deepEqual(
      resolved.filter((entry) => COMMENT_AS_VALUE.test(entry.value)),
      [],
      "put the comment on its own line: Compose reads an unquoted inline comment as the value",
    );

    // NEGATIVE CONTROL: the shape this case exists for is SEEN when planted.
    const envExample = readFileSync(join(root, ".env"), "utf8");
    writeFileSync(
      join(root, ".env"),
      envExample.replace(/^MANAGED_WORKER_SECRET=.*$/mu, "MANAGED_WORKER_SECRET=   # generate with openssl rand -hex 32"),
    );
    assert.deepEqual(
      resolvedRequiredValues(root, composeSource)
        .filter((entry) => entry.name === "MANAGED_WORKER_SECRET")
        .map((entry) => COMMENT_AS_VALUE.test(entry.value)),
      [true],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
