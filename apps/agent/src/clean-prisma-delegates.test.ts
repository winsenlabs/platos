import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Prisma, PrismaClient } from "@platos/tenancy-database";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const sourceRoot = __dirname;
const generatedClient = new PrismaClient();

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    if (/\.(?:test|spec)\.ts$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [path];
  });
}

function lowerFirst(value: string): string {
  return `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
}

const generatedDelegates = new Set(
  Prisma.dmmf.datamodel.models.map((model) => lowerFirst(model.name)),
);
const generatedOperationsByDelegate = new Map<string, Set<string>>(
  [...generatedDelegates].map((delegate) => {
    const value = (generatedClient as unknown as Record<string, Record<string, unknown>>)[delegate];
    return [
      delegate,
      new Set(Object.keys(value).filter((key) => typeof value[key] === "function" && !key.startsWith("$"))),
    ];
  }),
);
const generatedOperations = new Set(
  [...generatedOperationsByDelegate.values()].flatMap((operations) => [...operations]),
);

type DelegateCall = {
  delegate: string;
  operation: string;
  file: string;
  line: number;
};

type Analysis = {
  calls: DelegateCall[];
  unresolvedDynamicAccesses: string[];
};

function staticMemberName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ? argument.text
      : null;
  }
  return null;
}

function memberBase(expression: ts.Expression): ts.Expression | null {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expression.expression;
  }
  return null;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(node) ?? undefined;
}

function declarationsFor(checker: ts.TypeChecker, identifier: ts.Identifier): readonly ts.Declaration[] {
  return symbolAt(checker, identifier)?.declarations ?? [];
}

function hasInjectedPrismaToken(parameter: ts.ParameterDeclaration): boolean {
  const decorators = ts.canHaveDecorators(parameter) ? ts.getDecorators(parameter) : undefined;
  return decorators?.some((decorator) => decorator.getText().includes("Inject(PRISMA_TOKEN)")) ?? false;
}

function createAnalyzer(program: ts.Program, files: readonly ts.SourceFile[]) {
  const checker = program.getTypeChecker();
  const clientSymbols = new Set<ts.Symbol>();

  const markTypedClient = (node: ts.Node, name: ts.Node) => {
    const rendered = checker.typeToString(checker.getTypeAtLocation(node));
    if (/\b(?:ControlDatabaseClient|PrismaClient)\b/.test(rendered)) {
      const symbol = symbolAt(checker, name);
      if (symbol) clientSymbols.add(symbol);
    }
  };

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        markTypedClient(node, node.name);
        if (hasInjectedPrismaToken(node)) {
          const symbol = symbolAt(checker, node.name);
          if (symbol) clientSymbols.add(symbol);
        }
      } else if (
        (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
        && ts.isIdentifier(node.name)
      ) {
        markTypedClient(node, node.name);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  const isClientExpression = (expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const rendered = checker.typeToString(checker.getTypeAtLocation(expression));
    if (/\b(?:ControlDatabaseClient|PrismaClient)\b/.test(rendered)) return true;

    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      return isClientExpression(expression.expression, seen);
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(checker, expression);
      if (!symbol || seen.has(symbol)) return false;
      if (clientSymbols.has(symbol)) return true;
      seen.add(symbol);
      return (symbol.declarations ?? []).some((declaration) => {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          return isClientExpression(declaration.initializer, seen);
        }
        if (ts.isParameter(declaration) && hasInjectedPrismaToken(declaration)) return true;
        return false;
      });
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const nameNode = ts.isPropertyAccessExpression(expression)
        ? expression.name
        : expression.argumentExpression;
      const symbol = nameNode ? symbolAt(checker, nameNode) : undefined;
      if (symbol && clientSymbols.has(symbol)) return true;
    }
    return false;
  };

  // Resolve constructor assignments (`this.prisma = prisma`) and transaction
  // callback parameters. Repeat because either side may itself be an alias.
  for (let pass = 0; pass < 3; pass++) {
    for (const file of files) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && isClientExpression(node.right)
        ) {
          const target = ts.isPropertyAccessExpression(node.left)
            ? node.left.name
            : ts.isIdentifier(node.left)
              ? node.left
              : null;
          const symbol = target ? symbolAt(checker, target) : undefined;
          if (symbol) clientSymbols.add(symbol);
        }
        if (ts.isCallExpression(node) && staticMemberName(node.expression) === "$transaction") {
          const base = memberBase(node.expression);
          const callback = node.arguments[0];
          if (
            base
            && isClientExpression(base)
            && callback
            && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ) {
            const parameter = callback.parameters[0];
            if (parameter && ts.isIdentifier(parameter.name)) {
              const symbol = symbolAt(checker, parameter.name);
              if (symbol) clientSymbols.add(symbol);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }

  const delegateFromType = (expression: ts.Expression): string | null => {
    const expressionType = checker.getTypeAtLocation(expression);
    const types = expressionType.isUnion() ? expressionType.types : [expressionType];
    for (const type of types) {
      const name = (type.aliasSymbol ?? type.getSymbol())?.getName() ?? "";
      const match = /^\$?(.+)Delegate$/.exec(name);
      if (match?.[1]) return lowerFirst(match[1]);
    }
    return null;
  };

  const delegateFor = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string | null => {
    const typed = delegateFromType(expression);
    if (typed) return typed;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      return delegateFor(expression.expression, seen);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = memberBase(expression);
      const name = staticMemberName(expression);
      if (base && isClientExpression(base)) return name ?? "<dynamic>";
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(checker, expression);
      if (!symbol || seen.has(symbol)) return null;
      seen.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const delegated = delegateFor(declaration.initializer, seen);
          if (delegated) return delegated;
        }
        if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
          const variable = declaration.parent.parent;
          if (ts.isVariableDeclaration(variable) && variable.initializer && isClientExpression(variable.initializer)) {
            return declaration.propertyName && ts.isIdentifier(declaration.propertyName)
              ? declaration.propertyName.text
              : ts.isIdentifier(declaration.name)
                ? declaration.name.text
                : null;
          }
        }
      }
    }
    return null;
  };

  const callable = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): { delegate: string; operation: string } | null => {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const operation = staticMemberName(expression);
      const base = memberBase(expression);
      if (operation && generatedOperations.has(operation) && base) {
        const delegate = delegateFor(base);
        return delegate ? { delegate, operation } : null;
      }
      return null;
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(checker, expression);
      if (!symbol || seen.has(symbol)) return null;
      seen.add(symbol);
      for (const declaration of declarationsFor(checker, expression)) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const resolved = callable(declaration.initializer, seen);
          if (resolved) return resolved;
        }
        if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
          const operation = declaration.propertyName && ts.isIdentifier(declaration.propertyName)
            ? declaration.propertyName.text
            : ts.isIdentifier(declaration.name)
              ? declaration.name.text
              : null;
          const variable = declaration.parent.parent;
          if (
            operation
            && generatedOperations.has(operation)
            && ts.isVariableDeclaration(variable)
            && variable.initializer
          ) {
            const delegate = delegateFor(variable.initializer);
            if (delegate) return { delegate, operation };
          }
        }
      }
    }
    return null;
  };

  return (): Analysis => {
    const calls: DelegateCall[] = [];
    const unresolvedDynamicAccesses: string[] = [];
    for (const file of files) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const resolvedCall = callable(node.expression);
          if (resolvedCall) {
            const position = file.getLineAndCharacterOfPosition(node.getStart(file));
            const location = `${relative(sourceRoot, file.fileName)}:${position.line + 1}`;
            if (resolvedCall.delegate === "<dynamic>") {
              unresolvedDynamicAccesses.push(location);
            } else {
              calls.push({
                ...resolvedCall,
                file: relative(sourceRoot, file.fileName),
                line: position.line + 1,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return { calls, unresolvedDynamicAccesses };
  };
}

function productionProgram(files: string[]): ts.Program {
  const configPath = ts.findConfigFile(resolve(sourceRoot, ".."), ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("apps/agent tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."));
  return ts.createProgram({ rootNames: files, options: parsed.options });
}

afterAll(async () => {
  await generatedClient.$disconnect();
});

describe("clean tenancy Prisma boundary", () => {
  it("uses the type checker to inventory every production delegate operation", () => {
    const paths = productionTypeScriptFiles(sourceRoot);
    const program = productionProgram(paths);
    const files = paths.map((path) => program.getSourceFile(path)).filter((file): file is ts.SourceFile => !!file);
    const analysis = createAnalyzer(program, files)();
    const violations = analysis.calls.filter(({ delegate, operation }) =>
      !generatedDelegates.has(delegate)
      || !generatedOperationsByDelegate.get(delegate)?.has(operation),
    );
    const inventory = [...new Set(
      analysis.calls.map(({ delegate, operation }) => `${delegate}.${operation}`),
    )].sort();
    const inventoryDigest = createHash("sha256").update(inventory.join("\n")).digest("hex");

    expect(files.length).toBeGreaterThan(100);
    expect(analysis.unresolvedDynamicAccesses).toEqual([]);
    expect(violations).toEqual([]);
    // Independently pin both call-site count and unique operation inventory so
    // the audit cannot pass because its discovery silently stopped working.
    //
    // WIN-267 A4, 2026-09-08. RE-PINNED 751 -> 815, 304 -> 329, digest
    // 0b36ea83 -> 0c4fd159, and the suite was added to the agent job in
    // .github/workflows/ci.yml at the same time.
    //
    // WHY THE RE-PIN IS NOT A LAUNDERED REGRESSION. This file was RED on `v1`
    // for 1,064 commits because no CI job ran it: the agent job executes eight
    // individually-named Vitest files and this was not one of them. The pin
    // last moved in PR #120 (f5793473, 2026-08-24, 747 -> 751), so 64 net
    // production call sites accumulated unobserved. They were read before the
    // ratchet was raised. Layer split, measured with the SAME analyzer over
    // both trees: service 590 -> 641, controller 94 -> 108, MCP tool 54 -> 53,
    // other 13 -> 13. `agent-runtime/platos-tasks.controller.ts` (8),
    // `mcp-platform/tools/platos_tasks.ts` (12) and
    // `agent-runtime/platos-task-execution.service.ts` (2) were renamed to
    // `jobs.controller.ts` (9), `tools/jobs.ts` (11) and
    // `job-execution.service.ts` (2) — 22 sites out, 22 in. The rest is
    // list-endpoint totals (18 new `.count` sites), memory import/export,
    // attachments, the access-key bootstrap grant and postman executions.
    //
    // BUILD STATE. This census is TYPE-CHECKER driven, so the answer depends
    // on which workspace packages have been built, and both failure modes were
    // measured rather than assumed. Delete
    // `internal-packages/tenancy-database/dist` and this suite does not
    // under-count, it does not run: Vitest reports `Failed to resolve entry for
    // package "@platos/tenancy-database"` and collects nothing. Keep `dist` but
    // delete its fifteen `.d.ts` files — runtime import fine, types gone — and
    // the count silently reads 812 instead of 815. That quiet three-call-site
    // drift is why `scripts/ci-policy.test.mjs` asserts this suite runs AFTER
    // ci.yml's "Generate and build compiled Agent dependencies" step rather
    // than trusting a reader to notice. Measured under exactly the state the
    // agent job reaches before its Vitest steps — `pnpm install
    // --frozen-lockfile --ignore-scripts`, then `pnpm --filter
    // @platos/tenancy-database build && pnpm --filter
    // @internal/workload-identity build` (ci.yml "Generate and build compiled
    // Agent dependencies"). Re-measured after `pnpm build:v1` as well: 815 in
    // both states, so the pin does not depend on where in the job it runs.
    //
    // THE PIN IS JOINED TO THE ORACLE, NOT TO ITSELF. Running this same
    // analyzer against `apps/agent/src` as it stood at f5793473 reproduces
    // that commit's pinned triple exactly — 751 / 304 /
    // 0b36ea83f83a49ed4795881e9c9ccc00a6214c5e30ef654091d36dc13c2cc5a4 — which
    // is what establishes that 815 is real growth rather than a measurement
    // artifact of a different build state.
    //
    // RE-PINNED 815 -> 817, 2026-09-10, and the inventory and digest do NOT move.
    //
    // WHY THIS WAS FOUND LATE, WHICH IS THE FINDING. This suite is a CI gate --
    // ci.yml runs it by name in "Tenancy Prisma delegate boundary and census" --
    // and it went red on this integration branch some commits before this one.
    // Nothing surfaced it, because the branch had not yet had the full gate list
    // run against it: two tranches added a production delegate call site each and
    // neither moved this pin. The gate was right and the tranches were not.
    //
    // THE TWO SITES, EACH NAMED. `mcp-platform/permission-gateway.service.ts`
    // 8 -> 9: `this.prisma.environment.findUnique` in the environment resolution
    // the forged-scope refusal needed. `tool-gateway/mcp-transport/
    // entity-mcp-discovery.service.ts` 6 -> 7: `this.prisma.entityMcpClient` with
    // `.update(...)` on a SEPARATE LINE from the delegate -- which is why a grep
    // for `prisma.<model>.update(` finds only the first of the two and the
    // TYPE-CHECKER-driven analyzer finds both. `mcp-platform/tools/macros.ts` is
    // 10 in both trees: its `prisma.macro.create` predates this branch.
    //
    // MEASURED THE WAY THE COMMENT ABOVE DEMANDS -- against the oracle, not
    // against itself. With those three files swapped back to their 7e1243fc
    // contents and nothing else changed, THIS analyzer in THIS build state reads
    // exactly 815 (per-file: 8 / 10 / 6); swapped forward it reads 817
    // (9 / 10 / 7). So the delta is those two call sites and nothing else, and
    // 817 is real growth rather than drift in the measurement.
    //
    // THE INVENTORY AND THE DIGEST ARE DELIBERATELY UNMOVED. Both new sites use
    // `delegate.operation` pairs the inventory already contained
    // (`environment.findUnique`, `entityMcpClient.update`), so the count of
    // UNIQUE operations stays 329 and its digest stays `0c4fd159`. Two pins that
    // move together say less than two pins that move independently: a re-pin that
    // had to touch all three would be a re-pin that added a new KIND of store
    // reach, which is a different review.
    expect(analysis.calls.length).toBe(817);
    expect(inventory).toHaveLength(329);
    expect(inventoryDigest).toBe(
      "0c4fd159179dbf051d093ac039b87771c53d407adbf06e7aa79df0a3cc6f85ac",
    );
    // 120s, not 20s. Building the program and walking it three times takes
    // ~10-16s on an M-series laptop; a hosted runner is slower, and a gate that
    // goes red on wall-clock is a gate someone deletes. The budget bounds
    // nothing this suite asserts, so widening it removes a false red without
    // weakening any claim.
  }, 120_000);

  it("follows delegate aliases, object destructuring, method aliases, and bracket access", () => {
    const fileName = "/virtual/clean-prisma-inventory-fixture.ts";
    const source = `
      interface JobDelegate { findMany(): void; count(): void }
      interface PrismaClient { job: JobDelegate; $transaction(): void }
      declare const prisma: PrismaClient;
      const direct = prisma["job"];
      const { job: destructured } = prisma;
      const aliased = destructured;
      aliased["findMany"]();
      const { count: countJobs } = direct;
      countJobs();
    `;
    const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022 };
    const baseHost = ts.createCompilerHost(options);
    const sourceFile = ts.createSourceFile(fileName, source, options.target!, true);
    const host: ts.CompilerHost = {
      ...baseHost,
      fileExists: (path) => path === fileName || baseHost.fileExists(path),
      readFile: (path) => path === fileName ? source : baseHost.readFile(path),
      getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) =>
        path === fileName
          ? sourceFile
          : baseHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile),
    };
    const program = ts.createProgram([fileName], options, host);
    const analysis = createAnalyzer(program, [sourceFile])();

    expect(analysis.calls.map(({ delegate, operation }) => `${delegate}.${operation}`).sort()).toEqual([
      "job.count",
      "job.findMany",
    ]);
  });
});
