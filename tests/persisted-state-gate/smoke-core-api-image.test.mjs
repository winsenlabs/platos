import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { adapterBindings } from "../../scripts/arch/gen-v1-skeleton.mjs";
import {
  COMPOSE_FILE,
  CONTEXTS_COMPOSED_WHEN_FULLY_CONFIGURED,
  OPERATION_MANIFEST,
  composeEnvironmentDefault,
  composeHealthcheckProgram,
  composeServiceCommand,
  composeServiceEnvironmentNames,
  composeServiceImage,
  coreApiEnvironment,
  identitySessionPath,
  readinessViolations,
} from "./smoke-core-api-image.mjs";

// The smoke itself runs in build-images.yml against a loaded candidate. These
// cases pin what it READS and what it REFUSES, without Docker: its line readers
// are joined to an independent YAML parse of the same compose file, and every
// refusal of the readiness readback has a negative control that must trip it.

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const source = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const composeText = source(COMPOSE_FILE);
const compose = parseYaml(composeText, { merge: true });

test("the smoke's store images, migration commands, model default and healthcheck are the compose file's", () => {
  assert.equal(composeServiceImage(composeText, "postgres"), compose.services.postgres.image);
  assert.equal(composeServiceImage(composeText, "redis"), compose.services.redis.image);
  assert.deepEqual([composeServiceCommand(composeText, "migrations-init")], compose.services["migrations-init"].command);
  assert.deepEqual(
    [composeServiceCommand(composeText, "memory-profile-migrate")],
    compose.services["memory-profile-migrate"].command
  );
  assert.equal(
    `\${PLATOS_DEFAULT_MODEL:-${composeEnvironmentDefault(composeText, "core-api", "PLATOS_PROVIDERS_DEFAULT_MODEL")}}`,
    compose.services["core-api"].environment.PLATOS_PROVIDERS_DEFAULT_MODEL
  );
  const healthcheck = compose.services["core-api"].healthcheck.test;
  assert.deepEqual(healthcheck.slice(0, 3), ["CMD", "node", "-e"]);
  assert.equal(composeHealthcheckProgram(composeText, "core-api"), healthcheck[3]);

  // NEGATIVE CONTROLS: a tag-only store image and a missing service are refused.
  const tagOnly = composeText.replace(compose.services.redis.image, "redis:7");
  assert.notEqual(tagOnly, composeText);
  assert.throws(() => composeServiceImage(tagOnly, "redis"), /no digest-pinned image/);
  assert.throws(() => composeServiceImage(composeText, "no-such-service"), /has no service named/);
});

test("the smoke starts core-api with exactly the variable names its compose service passes", () => {
  const passed = Object.keys(compose.services["core-api"].environment).sort();
  assert.deepEqual(composeServiceEnvironmentNames(composeText, "core-api").sort(), passed);
  const started = Object.keys(
    coreApiEnvironment({
      postgresUrl: "postgresql://u:p@postgres:5432/db",
      redisUrl: "redis://redis:6379",
      defaultModel: "a:b",
      secrets: { sessionSecret: "s", encryptionKey: "k", slackSigningSecret: "x", adminHealthToken: "t" },
    })
  ).sort();
  assert.deepEqual(started, passed);
  assert.ok(!started.includes("PLATOS_CORE_API_HOST"), "the image's own ENV must decide the listener interface");
});

test("the operator session path comes from the generated operation manifest", () => {
  const manifest = JSON.parse(source(OPERATION_MANIFEST));
  const sessionPath = identitySessionPath(manifest);
  assert.match(sessionPath, /^\/.+\/identity\/session$/);

  // NEGATIVE CONTROL: without the operation, the smoke refuses rather than guessing.
  const without = structuredClone(manifest);
  without.inventories.restOperations = without.inventories.restOperations.filter(
    (operation) => operation.path !== sessionPath
  );
  assert.throws(() => identitySessionPath(without), /must name exactly one GET operation/);
});

/** A detailed readiness body as a fully configured install reports it. */
function fullyConfiguredBody(bindings, unimplemented) {
  const names = bindings.map(({ adapter, port }) => `${adapter}:${port}`);
  return {
    status: "not-ready",
    phase: "serving",
    detail: {
      satisfiedBindings: names.filter((name) => !unimplemented.includes(name.split(":")[0])),
      unsatisfiedBindings: names.filter((name) => unimplemented.includes(name.split(":")[0])),
      declaredBindings: names.length,
      unwiredAdapters: unimplemented.map((adapter) => ({ adapter, cause: "implementation", reason: "generated interface" })),
      composedContexts: [...CONTEXTS_COMPOSED_WHEN_FULLY_CONFIGURED],
      inFlight: 1,
    },
  };
}

test("the readiness readback passes a fully configured body and refuses each way it can be wrong", () => {
  const bindings = adapterBindings();
  assert.ok(bindings.length > 0);
  const unimplemented = ["durable-runtime", "clickhouse-observability", "objectstore-minio", "notifier-email", "notifier-webhook"];
  assert.deepEqual(readinessViolations(fullyConfiguredBody(bindings, unimplemented), bindings), []);

  const controls = [
    ["draining", (body) => (body.phase = "draining"), /phase is "draining"/],
    ["declared count", (body) => (body.detail.declaredBindings += 1), /declaredBindings is/],
    ["missing binding", (body) => body.detail.satisfiedBindings.shift(), /differ from the ADR adapter table/],
    ["duplicate binding", (body) => body.detail.satisfiedBindings.push(body.detail.satisfiedBindings[0]), /more than once/],
    [
      "store binding unsatisfied",
      (body) => body.detail.unsatisfiedBindings.push(body.detail.satisfiedBindings.shift()),
      /not report unimplemented/,
    ],
    ["configuration cause", (body) => (body.detail.unwiredAdapters[0].cause = "configuration"), /configuration could fix/],
    [
      "satisfied on unimplemented",
      (body) => body.detail.satisfiedBindings.push(body.detail.unsatisfiedBindings.shift()),
      /reported unimplemented: /,
    ],
    ["context absent", (body) => body.detail.composedContexts.pop(), /contexts not composed/],
    ["no detail", (body) => delete body.detail, /carries no detail/],
  ];
  for (const [name, mutate, expected] of controls) {
    const body = fullyConfiguredBody(bindings, unimplemented);
    mutate(body);
    const violations = readinessViolations(body, bindings);
    assert.ok(
      violations.some((violation) => expected.test(violation)),
      `${name}: expected a refusal matching ${expected}, got ${JSON.stringify(violations)}`
    );
  }
});
