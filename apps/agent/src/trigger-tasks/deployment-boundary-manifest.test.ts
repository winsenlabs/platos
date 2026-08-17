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
  if (!clause || clause.isTypeOnly) return false;
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
      sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const displayPath = relative(resolve(__dirname, "../../../.."), sourcePath);

    const inspectSpecifier = (specifier: string): void => {
      if (
        manifest.forbiddenRuntimeImports.some(
          (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
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
      if (
        ts.isIdentifier(node) &&
        manifest.forbiddenRuntimeIdentifiers.includes(node.text)
      ) {
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

describe("external Trigger deployment boundary", () => {
  it("manifests every emitted Trigger registration source exactly once", () => {
    const discovered = readdirSync(__dirname, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .filter((entry) => {
        const sourcePath = resolve(__dirname, entry.name);
        const sourceFile = ts.createSourceFile(
          entry.name,
          readFileSync(sourcePath, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
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
      expect.arrayContaining(["authorization", "token", "secret", "handler", "compiledHandler"]),
    );
  });

  it("deploys an immutable version and only promotes its pinned output explicitly", () => {
    const workflow = readFileSync(
      resolve(__dirname, "../../../../.github/workflows/trigger-deploy.yml"),
      "utf8",
    );

    expect(workflow).toContain("deploy --skip-promotion");
    expect(workflow).toContain("deployment_version: ${{ steps.deploy-trigger.outputs.deploymentVersion }}");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch' && inputs.promote_target");
    expect(workflow).toContain('promote "$TARGET_DEPLOYMENT_VERSION"');
    expect(
      workflow
        .split("\n")
        .filter((line) => line.includes("trigger.dev@4.5.4 deploy"))
        .every((line) => line.includes("--skip-promotion")),
    ).toBe(true);
  });
});
