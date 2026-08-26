import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import manifest from "./deployment-boundary-manifest.json";

function hasTriggerDeclaration(sourceFile: ts.SourceFile): boolean {
  let discovered = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "task") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "schedules" &&
            node.expression.name.text === "task") ||
            (ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === "chat" &&
              node.expression.name.text === "customAgent"))))
    ) {
      discovered = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return discovered;
}

function runtimeImport(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return true;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function resolveRelativeImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function scanRuntimeGraph(entryPoints: readonly string[]): string[] {
  const taskRoot = resolve(__dirname);
  const queue = entryPoints.map((entryPoint) => resolve(taskRoot, entryPoint));
  const visited = new Set<string>();
  const violations: string[] = [];

  while (queue.length > 0) {
    const sourcePath = queue.shift()!;
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);

    const sourceFile = ts.createSourceFile(
      sourcePath,
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const displayPath = relative(resolve(__dirname, "../../../.."), sourcePath);

    const inspectSpecifier = (specifier: string): void => {
      if (
        manifest.forbiddenRuntimeImports.some(
          (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`)
        )
      ) {
        violations.push(`${displayPath}: forbidden runtime import ${specifier}`);
      }
      if (
        specifier.startsWith(".") &&
        manifest.forbiddenRelativeImports.some((forbidden) => specifier.includes(forbidden))
      ) {
        violations.push(`${displayPath}: forbidden relative import ${specifier}`);
      }
      const dependency = resolveRelativeImport(sourcePath, specifier);
      if (dependency) queue.push(dependency);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && manifest.forbiddenRuntimeIdentifiers.includes(node.text)) {
        violations.push(`${displayPath}: forbidden runtime identifier ${node.text}`);
      }
      if (
        ts.isStringLiteralLike(node) &&
        manifest.forbiddenRuntimeIdentifiers.includes(node.text)
      ) {
        violations.push(`${displayPath}: forbidden runtime string ${node.text}`);
      }
      if (
        ts.isImportDeclaration(node) &&
        runtimeImport(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        inspectSpecifier(node.moduleSpecifier.text);
      }
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        inspectSpecifier(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        inspectSpecifier(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return [...new Set(violations)].sort();
}

function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function localScheduleOwnershipViolations(source: string, filename: string): string[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@internal/schedule-engine"
    ) {
      violations.push("schedule engine runtime import");
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "@internal/schedule-engine" &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      violations.push("schedule engine runtime import");
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "ScheduleEngine"
    ) {
      violations.push("ScheduleEngine construction");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "singleton" &&
      node.arguments.some(
        (argument) => ts.isStringLiteralLike(argument) && argument.text === "ScheduleEngine"
      )
    ) {
      violations.push("ScheduleEngine singleton");
    }
    if (ts.isIdentifier(node) && node.text === "scheduleEngine") {
      violations.push("local scheduleEngine use");
    }
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      /^(?:SCHEDULE_WORKER_|SCHEDULE_ENGINE_)/.test(node.text)
    ) {
      violations.push(`local schedule worker configuration ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(violations)].sort();
}

function localBatchMutationViolations(source: string, filename: string): string[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const forbiddenImports = [
    "~/db.server",
    "~/utils/requestIdempotency.server",
    "~/v3/objectStore.server",
    "~/runEngine/services/batchTrigger.server",
    "~/runEngine/services/createBatch.server",
    "~/runEngine/services/streamBatchItems.server",
    "~/v3/runEngine.server",
  ];
  const forbiddenIdentifiers = new Set([
    "prisma",
    "handleRequestIdempotency",
    "saveRequestIdempotency",
    "downloadPacketFromObjectStore",
    "uploadPacketToObjectStore",
    "RunEngineBatchTriggerService",
    "CreateBatchService",
    "StreamBatchItemsService",
    "createNdjsonParserStream",
    "streamToAsyncIterable",
    "engine",
  ]);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      forbiddenImports.includes(node.moduleSpecifier.text)
    ) {
      violations.push(`mutable import ${node.moduleSpecifier.text}`);
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      violations.push(`mutable identifier ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(violations)].sort();
}

describe("external Trigger deployment boundary", () => {
  it("manifests every emitted Trigger registration source exactly once", () => {
    const discovered = readdirSync(__dirname, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      )
      .filter((entry) => {
        const sourcePath = resolve(__dirname, entry.name);
        const sourceFile = ts.createSourceFile(
          entry.name,
          readFileSync(sourcePath, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS
        );
        return hasTriggerDeclaration(sourceFile);
      })
      .map((entry) => entry.name)
      .sort();

    expect([...new Set(manifest.entryPoints)].sort()).toEqual(discovered);
    expect(manifest.entryPoints).toHaveLength(discovered.length);
  });

  it("proves the emitted runtime graph has no database client or database URL access", () => {
    expect(scanRuntimeGraph(manifest.entryPoints)).toEqual([]);
  });

  it("keeps authentication and executable source outside the custom-task payload contract", () => {
    expect(manifest.callbackAuthentication.transport).toContain("header");
    expect(manifest.callbackAuthentication.payloadFields).toEqual([
      "taskRowId",
      "payload",
      "scope",
      "invokedBy",
      "agentId",
    ]);
    expect(manifest.callbackAuthentication.forbiddenPayloadFields).toEqual(
      expect.arrayContaining(["authorization", "token", "secret", "handler", "compiledHandler"])
    );
  });

  it("deploys an immutable version and only promotes its pinned output explicitly", () => {
    const workflow = readFileSync(
      resolve(__dirname, "../../../../.github/workflows/trigger-deploy.yml"),
      "utf8"
    );
    const validateStart = workflow.indexOf("  validate-contract:\n");
    const deployStart = workflow.indexOf("  deploy:\n");
    const promoteStart = workflow.indexOf("  promote:\n");
    const validateJob = workflow.slice(validateStart, deployStart);
    const deployJob = workflow.slice(deployStart, promoteStart);
    const promoteJob = workflow.slice(promoteStart);

    expect(validateStart).toBeGreaterThan(-1);
    expect(deployStart).toBeGreaterThan(validateStart);
    expect(promoteStart).toBeGreaterThan(deployStart);
    expect(validateJob).not.toContain("trigger.dev@4.5.4 deploy");
    expect(validateJob).not.toContain("TRIGGER_ACCESS_TOKEN");
    expect(deployJob).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(deployJob).toContain("environment: trigger-deployment");
    expect(workflow).toContain("deploy --skip-promotion");
    expect(workflow).toContain(
      "deployment_version: ${{ steps.deploy-trigger.outputs.deploymentVersion }}"
    );
    expect(promoteJob).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.promote_target == true"
    );
    expect(promoteJob).toContain("environment: trigger-promotion");
    expect(promoteJob).toContain('promote "$TARGET_DEPLOYMENT_VERSION"');
    expect(workflow).toContain("trigger_api_url:");
    expect(workflow).toContain("required: true");
    expect(workflow.match(/test -n \"\$TRIGGER_API_URL\"/g)).toHaveLength(2);
    expect(workflow.match(/TRIGGER_API_URL: \$\{\{ inputs\.trigger_api_url \}\}/g)).toHaveLength(3);
    expect(workflow).not.toContain("https://api.trigger.dev");
    expect(
      workflow
        .split("\n")
        .filter((line) => line.includes("trigger.dev@4.5.4 deploy"))
        .every((line) => line.includes("--skip-promotion"))
    ).toBe(true);
  });

  it("has no local Trigger worker, bootstrap, or webapp engine routes", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const routeRoot = resolve(repoRoot, "apps/webapp/app/routes");
    const engineRoutes = readdirSync(routeRoot)
      .filter((entry) => entry.startsWith("engine."))
      .sort();

    expect(existsSync(resolve(repoRoot, "apps/agent/src/trigger-worker.ts"))).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "apps/agent/src/trigger-tasks/agent-batch-op.task.ts"))
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "apps/agent/src/trigger-tasks/price-verify.task.ts"))).toBe(
      false
    );
    expect(existsSync(resolve(repoRoot, "apps/webapp/app/bootstrap.ts"))).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts"))
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "apps/webapp/app/v3/services/triggerTask.server.ts"))).toBe(
      false
    );
    expect(
      existsSync(resolve(repoRoot, "apps/webapp/app/runEngine/services/triggerTask.server.ts"))
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "apps/webapp/app/services/engineRateLimit.server.ts"))
    ).toBe(false);
    expect(existsSync(resolve(repoRoot, "apps/webapp/app/v3/handleSocketIo.server.ts"))).toBe(
      false
    );
    expect(existsSync(resolve(repoRoot, "apps/webapp/app/v3/runEngineHandlers.server.ts"))).toBe(
      false
    );
    expect(engineRoutes).toEqual([]);

    const localModeSources = [
      "apps/agent/entrypoint.sh",
      "apps/agent/src/shared/env.ts",
      "apps/webapp/app/entry.server.tsx",
      "apps/webapp/app/env.server.ts",
      "apps/webapp/app/v3/runEngine.server.ts",
      "apps/webapp/app/services/routeBuilders/apiBuilder.server.ts",
      "apps/webapp/server.ts",
      "docker-compose.platos.yml",
    ]
      .map((path) => resolve(repoRoot, path))
      .filter(existsSync)
      .map((path) => readFileSync(path, "utf8"));
    const localModeSource = localModeSources.join("\n");

    expect(localModeSource).not.toMatch(/\bWORKER_MODE\b/);
    expect(localModeSource).not.toMatch(/\bTRIGGER_WORKER_TOKEN\b/);
    expect(localModeSource).not.toMatch(/\bTRIGGER_BOOTSTRAP_/);
    expect(localModeSource).not.toContain("createActionWorkerApiRoute");
    expect(localModeSource).not.toContain("createLoaderWorkerApiRoute");
    expect(localModeSource).not.toMatch(/^\s{2}worker:/m);
    expect(localModeSource).not.toContain('TRIGGER_API_URL: "http://webapp');
    expect(localModeSource).not.toMatch(/\bRUN_ENGINE_WORKER_ENABLED\b/);
    expect(localModeSource).not.toContain('singleton("RunEngine"');
    expect(localModeSource).not.toContain("new RunEngine(");
    expect(localModeSource).not.toContain("Worker.init()");
  });

  it("has no import, construction, singleton, or worker configuration for a local ScheduleEngine", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const scheduleModule = resolve(repoRoot, "apps/webapp/app/v3/scheduleEngine.server.ts");
    expect(existsSync(scheduleModule)).toBe(false);

    const violations = sourceFilesUnder(resolve(repoRoot, "apps/webapp/app")).flatMap(
      (sourcePath) =>
        localScheduleOwnershipViolations(readFileSync(sourcePath, "utf8"), sourcePath).map(
          (violation) => `${relative(repoRoot, sourcePath)}: ${violation}`
        )
    );
    expect(violations).toEqual([]);

    const deploymentConfiguration = [
      ".env.example",
      "docker-compose.platos.yml",
      "apps/webapp/app/env.server.ts",
    ]
      .map((path) => readFileSync(resolve(repoRoot, path), "utf8"))
      .join("\n");
    expect(deploymentConfiguration).not.toMatch(/\b(?:SCHEDULE_WORKER_|SCHEDULE_ENGINE_)/);
  });

  it("detects a mutation that restores local ScheduleEngine construction", () => {
    const mutatedSource = `
      import { ScheduleEngine } from "@internal/schedule-engine";
      const scheduleEngine = singleton("ScheduleEngine", () => new ScheduleEngine({
        enabled: env.SCHEDULE_WORKER_ENABLED,
      }));
    `;

    expect(localScheduleOwnershipViolations(mutatedSource, "scheduleEngine.server.ts")).toEqual([
      "ScheduleEngine construction",
      "ScheduleEngine singleton",
      "local schedule worker configuration SCHEDULE_WORKER_ENABLED",
      "local scheduleEngine use",
      "schedule engine runtime import",
    ]);
  });

  it("keeps batch rejection routes free of database, object-store, and idempotency dependencies", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const routes = [
      "apps/webapp/app/routes/api.v2.tasks.batch.ts",
      "apps/webapp/app/routes/api.v3.batches.ts",
      "apps/webapp/app/routes/api.v3.batches.$batchId.items.ts",
    ];

    const violations = routes.flatMap((route) => {
      const sourcePath = resolve(repoRoot, route);
      if (!existsSync(sourcePath)) return [];
      return localBatchMutationViolations(readFileSync(sourcePath, "utf8"), route).map(
        (violation) => `${route}: ${violation}`
      );
    });
    expect(violations).toEqual([]);
  });

  it("keeps active local schedule routes and services free of schedule persistence mutations", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const sources = [
      "apps/webapp/app/routes/admin.api.v1.environments.$environmentId.schedules.recover.ts",
      "apps/webapp/app/routes/api.v1.schedules.ts",
      "apps/webapp/app/routes/api.v1.schedules.$scheduleId.ts",
      "apps/webapp/app/routes/api.v1.schedules.$scheduleId.activate.ts",
      "apps/webapp/app/routes/api.v1.schedules.$scheduleId.deactivate.ts",
      "apps/webapp/app/v3/services/createBackgroundWorker.server.ts",
      "apps/webapp/app/v3/services/deleteTaskSchedule.server.ts",
      "apps/webapp/app/v3/services/setActiveOnTaskSchedule.server.ts",
      "apps/webapp/app/v3/services/upsertTaskSchedule.server.ts",
    ];

    for (const source of sources) {
      const sourcePath = resolve(repoRoot, source);
      if (!existsSync(sourcePath)) continue;
      expect(readFileSync(sourcePath, "utf8"), source).not.toMatch(
        /taskSchedule(?:Instance)?\s*\.\s*(?:create|update|upsert|delete|deleteMany)\s*\(/
      );
    }
  });
});
