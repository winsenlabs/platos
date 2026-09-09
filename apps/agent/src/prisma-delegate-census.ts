// The type-checker-driven inventory of every ORM delegate call in `apps/agent`.
//
// WHY THIS IS A MODULE AND NOT A TEST. `clean-prisma-delegates.test.ts` wrote
// this analyzer and then asserted THREE numbers about the whole app: a call-site
// count, a unique-operation inventory and its digest. That is the right gate for
// "did the surface grow", and it is the wrong shape for "WHICH context owns the
// rows a given directory still reaches", because the answer it computes —  one
// `{delegate, operation, file, line}` per call site — is thrown away the moment
// the three assertions are made.
//
// WIN-268 P2 needs the same walk with the results KEPT, so that
// `mcp-platform/orm-ownership-census.test.ts` can split the surface by owning
// context and ratchet the split. Copying three hundred lines of type-checker
// code into a second file would have produced two analyzers that could disagree
// — and a disagreement between them would be invisible, because each would be
// the only witness to its own number. There is ONE analyzer, and both consumers
// import it, so the ownership split and the pinned total are two views of one
// walk by construction rather than by hope.
//
// NOTHING ABOUT THE ANALYSIS CHANGED IN THE EXTRACTION. The three pins in
// `clean-prisma-delegates.test.ts` are unmoved (815 / 329 /
// 0c4fd159...), which is the only evidence that matters for a refactor of a
// gate: a move that altered what is measured would have moved them.
//
// BUILD STATE STILL DECIDES THE ANSWER. This is a `ts.Program` over the app's
// real `tsconfig.json`, so the count depends on which workspace packages have
// been built — see the long note on the pins in `clean-prisma-delegates.test.ts`
// and `scripts/ci-policy.test.mjs`, which asserts the suite runs after ci.yml's
// "Generate and build compiled Agent dependencies" step.

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Prisma, PrismaClient } from "@platos/tenancy-database";
import ts from "typescript";

/** The `apps/agent/src` directory every reported path is relative to. */
export const AGENT_SOURCE_ROOT = __dirname;

export function productionTypeScriptFiles(directory: string): string[] {
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

/**
 * The delegate and operation vocabularies, READ OFF THE GENERATED CLIENT.
 *
 * Both are joins to something this repository does not write by hand: the
 * delegate names come from `Prisma.dmmf.datamodel.models`, which `prisma
 * generate` derives from `schema.prisma`, and the operations come from the
 * runtime shape of the client object. A model renamed in the schema changes
 * both without anybody editing this file, which is the property that makes
 * "every call site resolves to a real delegate operation" a checkable claim
 * rather than a restatement of a list kept here.
 */
export const generatedDelegates = new Set(
  Prisma.dmmf.datamodel.models.map((model) => lowerFirst(model.name)),
);

/** `delegate` (camelCase) → the schema `model` name it was derived from. */
export const modelForDelegate = new Map<string, string>(
  Prisma.dmmf.datamodel.models.map((model) => [lowerFirst(model.name), model.name]),
);

let cachedClient: PrismaClient | null = null;
function generatedClient(): PrismaClient {
  cachedClient ??= new PrismaClient();
  return cachedClient;
}

/** Release the client this module lazily constructed. Safe to call twice. */
export async function disconnectGeneratedClient(): Promise<void> {
  const client = cachedClient;
  cachedClient = null;
  if (client) await client.$disconnect();
}

export const generatedOperationsByDelegate = new Map<string, Set<string>>(
  [...generatedDelegates].map((delegate) => {
    const value = (generatedClient() as unknown as Record<string, Record<string, unknown>>)[delegate];
    return [
      delegate,
      new Set(Object.keys(value).filter((key) => typeof value[key] === "function" && !key.startsWith("$"))),
    ];
  }),
);

export const generatedOperations = new Set(
  [...generatedOperationsByDelegate.values()].flatMap((operations) => [...operations]),
);

export type DelegateCall = {
  delegate: string;
  operation: string;
  file: string;
  line: number;
};

export type Analysis = {
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

export function createAnalyzer(program: ts.Program, files: readonly ts.SourceFile[], sourceRoot = AGENT_SOURCE_ROOT) {
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

export function productionProgram(files: string[], sourceRoot = AGENT_SOURCE_ROOT): ts.Program {
  const configPath = ts.findConfigFile(resolve(sourceRoot, ".."), ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("apps/agent tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."));
  return ts.createProgram({ rootNames: files, options: parsed.options });
}

/** One walk of `apps/agent/src`, results kept. Both gates call exactly this. */
export function analyzeAgentSource(sourceRoot = AGENT_SOURCE_ROOT): {
  analysis: Analysis;
  fileCount: number;
} {
  const paths = productionTypeScriptFiles(sourceRoot);
  const program = productionProgram(paths, sourceRoot);
  const files = paths
    .map((path) => program.getSourceFile(path))
    .filter((file): file is ts.SourceFile => !!file);
  return { analysis: createAnalyzer(program, files, sourceRoot)(), fileCount: files.length };
}
