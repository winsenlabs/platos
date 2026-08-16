import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  DORMANT_TRIGGER_TASK_MANIFEST,
  EXTERNAL_PLATOS_SESSION_MANIFEST,
  EXTERNAL_PLATOS_TASK_MANIFEST,
  INTERNAL_TRIGGER_TASK_MANIFEST,
} from "./registration-manifest";

type DeclarationKind = "task" | "schedule" | "chat.customAgent";

interface DiscoveredRegistration {
  id: string;
  declaration: DeclarationKind;
  source: string;
}

function declarationKind(expression: ts.LeftHandSideExpression): DeclarationKind | undefined {
  if (ts.isIdentifier(expression) && expression.text === "task") return "task";
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  if (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "schedules" &&
    expression.name.text === "task"
  ) {
    return "schedule";
  }

  if (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "chat" &&
    expression.name.text === "customAgent"
  ) {
    return "chat.customAgent";
  }

  return undefined;
}

function registrationId(config: ts.ObjectLiteralExpression, source: string): string {
  const idProperty = config.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === "id") ||
        (ts.isStringLiteral(property.name) && property.name.text === "id"))
  );

  if (
    !idProperty ||
    (!ts.isStringLiteral(idProperty.initializer) &&
      !ts.isNoSubstitutionTemplateLiteral(idProperty.initializer))
  ) {
    throw new Error(`Trigger registration in ${source} must declare a literal id`);
  }

  return idProperty.initializer.text;
}

function discoverRegistrations(): DiscoveredRegistration[] {
  const registrations: DiscoveredRegistration[] = [];
  const sourceFiles = readdirSync(__dirname, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
    )
    .map((entry) => resolve(__dirname, entry.name));

  for (const sourcePath of sourceFiles) {
    const source = basename(sourcePath);
    const sourceFile = ts.createSourceFile(
      source,
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = declarationKind(node.expression);
        const config = node.arguments[0];
        if (declaration && config && ts.isObjectLiteralExpression(config)) {
          registrations.push({
            id: registrationId(config, source),
            declaration,
            source,
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return registrations;
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

describe("Trigger registration manifest", () => {
  it("discovers all 21 task/schedule declarations and the chat customAgent", () => {
    const registrations = discoverRegistrations();
    const taskRegistrations = registrations.filter(
      (registration) =>
        registration.declaration === "task" || registration.declaration === "schedule"
    );
    const sessionRegistrations = registrations.filter(
      (registration) => registration.declaration === "chat.customAgent"
    );

    expect(taskRegistrations).toHaveLength(21);
    expect(sessionRegistrations).toEqual([
      {
        id: "platos.chat.session",
        declaration: "chat.customAgent",
        source: "chat-session.task.ts",
      },
    ]);
    expect(duplicates(registrations.map(({ id }) => id))).toEqual([]);
  });

  it("classifies every discovered registration exactly once", () => {
    const registrations = discoverRegistrations();
    const taskManifest = [
      ...EXTERNAL_PLATOS_TASK_MANIFEST,
      ...INTERNAL_TRIGGER_TASK_MANIFEST,
      ...DORMANT_TRIGGER_TASK_MANIFEST,
    ];
    const completeManifest = [...taskManifest, ...EXTERNAL_PLATOS_SESSION_MANIFEST];

    expect(EXTERNAL_PLATOS_TASK_MANIFEST).toHaveLength(18);
    expect(EXTERNAL_PLATOS_SESSION_MANIFEST).toEqual(["platos.chat.session"]);
    expect(INTERNAL_TRIGGER_TASK_MANIFEST).toEqual(["platos-agent-batch-op", "price-verify"]);
    expect(DORMANT_TRIGGER_TASK_MANIFEST).toEqual(["platos.agent.durable-turn"]);
    expect(duplicates(completeManifest)).toEqual([]);
    expect([...completeManifest].sort()).toEqual(registrations.map(({ id }) => id).sort());
  });
});

describe("Trigger deployment config", () => {
  function evaluateConfig(env: Record<string, string | undefined>): { project: string } {
    const configPath = resolve(__dirname, "../../trigger.config.ts");
    const transpiled = ts.transpileModule(readFileSync(configPath, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: configPath,
    });
    const module = { exports: {} as Record<string, unknown> };

    runInNewContext(transpiled.outputText, {
      exports: module.exports,
      module,
      process: { env },
      require: (specifier: string) => {
        if (specifier === "@trigger.dev/sdk") {
          return { defineConfig: (config: unknown) => config };
        }
        if (specifier === "./scripts/trigger-worker-externals") {
          return { generatedWorkerExternalsMustResolve: () => ({ name: "test-extension" }) };
        }
        throw new Error(`Unexpected config import: ${specifier}`);
      },
    });

    return (module.exports as { default: { project: string } }).default;
  }

  it("requires an explicit project ref only when deployment config is loaded", () => {
    expect(() => evaluateConfig({})).toThrow(/TRIGGER_PROJECT_REF is required/);
    expect(evaluateConfig({ TRIGGER_PROJECT_REF: "  proj_explicit  " }).project).toBe(
      "proj_explicit"
    );
  });
});
