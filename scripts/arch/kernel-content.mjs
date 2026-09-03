#!/usr/bin/env node
// ADR M0.3 §5.3 — the kernel-content assertion.
//
// §5.1 already stops the kernel IMPORTING a context, an adapter or an
// infrastructure client (`kernel-is-leaf`). That is not enough. A leaf can still
// rot into a junk drawer while importing nothing at all: a stateful service, a
// hand-rolled clock, a business rule. §5.3 asks for the other half —
//
//   "A tiny AST test over packages/kernel/src/**: fail if any file declares a
//    class with a non-empty constructor, imports anything outside
//    packages/kernel, or exports a value that is not an interface / type alias /
//    const enum / frozen object / pure function. This is what keeps the shared
//    kernel from becoming a junk drawer while it hosts DurableRuntime /
//    SafetyEventSink / ErasureTarget."
//
// — and until now it did not exist. This is it.
//
// It is a real AST walk over the TypeScript compiler's own parse, not a regex:
// a regex cannot tell a `class` in a string from a `class` in code, and the
// whole point is that this gate must not be foolable.
//
//   node scripts/arch/kernel-content.mjs          # check, exit 1 on violation
//   node scripts/arch/kernel-content.mjs --json   # machine-readable
//
// Test files are held to K1 only, in a widened form: they legitimately construct
// stateful fakes (that is what a fake IS) and they legitimately import the test
// runner. Everything else in the kernel is held to all five.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const KERNEL_ROOT = "packages/kernel/src";

/** The only bare specifier any kernel file may name, and only from a test. */
export const TEST_ONLY_IMPORTS = ["vitest"];

/**
 * Identifiers that make a file impure. Reading the wall clock, drawing a random
 * number, touching the process or the network are all things the kernel exposes
 * as PORTS — `Clock`, `IdGenerator`. A kernel file doing any of them directly
 * has bypassed the seam it exists to define.
 */
export const FORBIDDEN_GLOBALS = [
  "process",
  "fetch",
  "require",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "globalThis",
  "crypto",
  "Buffer",
  "__dirname",
  "__filename",
];

/** Property accesses that are impure even though their object is allowed. */
export const FORBIDDEN_MEMBERS = [
  ["Math", "random"],
  ["Date", "now"],
];

export const RULES = [
  { id: "K1", description: "imports only relative paths inside packages/kernel" },
  { id: "K2", description: "declares no stateful class (no constructor parameters, no property declarations)" },
  { id: "K3", description: "declares no mutable module-level state (no top-level let or var)" },
  { id: "K4", description: "reads no clock, no randomness, no process and no network" },
  { id: "K5", description: "exports only interfaces, type aliases, enums, functions and immutable consts" },
];

function listKernelFiles(root) {
  const absoluteRoot = join(root, KERNEL_ROOT);
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["dist", "node_modules", ".turbo"].includes(entry.name)) continue;
        walk(join(directory, entry.name));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        found.push(join(directory, entry.name));
      }
    }
  };
  if (!statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) return found;
  walk(absoluteRoot);
  return found.sort();
}

function positionOf(sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return line + 1;
}

/** An initializer that cannot introduce mutable shared state. */
function isImmutableInitializer(node) {
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isLiteralExpression(node) || ts.isBigIntLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(node)) return isImmutableInitializer(node.operand);
  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  // `x as const` freezes the literal at type level, so the value it names is
  // immutable however deep it is. `x as Y` and `x satisfies Y` assert nothing
  // about mutability, so they are judged by what they wrap.
  if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type)) {
    if (ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const") return true;
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return isImmutableInitializer(node.expression);
  // Object.freeze(...)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    node.expression.name.text === "freeze"
  ) {
    return true;
  }
  return false;
}

export function analyzeSource(virtualPath, text) {
  const isTest = virtualPath.endsWith(".test.ts");
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations = [];
  const report = (rule, node, message) =>
    violations.push({ rule, path: virtualPath, line: positionOf(sourceFile, node), message });

  const checkSpecifier = (node, specifier) => {
    if (specifier.startsWith(".")) return;
    if (isTest && TEST_ONLY_IMPORTS.includes(specifier)) return;
    report(
      "K1",
      node,
      isTest
        ? `test imports "${specifier}"; a kernel test may import only relative paths and ${TEST_ONLY_IMPORTS.join(", ")}`
        : `imports "${specifier}"; packages/kernel has zero runtime dependencies and may import only its own relative modules`,
    );
  };

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node, node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      checkSpecifier(node, node.argument.literal.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first)) checkSpecifier(node, first.text);
    }

    if (!isTest) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member) && member.parameters.length > 0) {
            report("K2", member, "declares a class with a non-empty constructor; the kernel holds no stateful class");
          }
          if (ts.isPropertyDeclaration(member) && !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
            report("K2", member, "declares a class with instance state; the kernel holds no stateful class");
          }
        }
      }

      if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.includes(node.text)) {
        const parent = node.parent;
        const isDeclarationName =
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertySignature(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isParameter(parent) && parent.name === node) ||
            (ts.isBindingElement(parent) && parent.name === node) ||
            (ts.isVariableDeclaration(parent) && parent.name === node) ||
            (ts.isImportSpecifier(parent) && parent.name === node));
        if (!isDeclarationName) {
          report("K4", node, `references "${node.text}"; the kernel reaches infrastructure only through its ports`);
        }
      }

      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        for (const [object, member] of FORBIDDEN_MEMBERS) {
          if (node.expression.text === object && node.name.text === member) {
            report("K4", node, `calls ${object}.${member}(); the kernel takes time and identity from the Clock and IdGenerator ports`);
          }
        }
      }

      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
        report("K4", node, "constructs a Date; the kernel takes the current instant from the Clock port");
      }
    }

    ts.forEachChild(node, visit);
  };

  for (const statement of sourceFile.statements) {
    if (isTest) continue;
    if (ts.isVariableStatement(statement)) {
      const isDeclared = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
      const flags = statement.declarationList.flags;
      if (!isDeclared && !(flags & ts.NodeFlags.Const)) {
        report("K3", statement, "declares mutable module-level state with let or var");
      }
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported && !isDeclared) {
        for (const declaration of statement.declarationList.declarations) {
          if (!isImmutableInitializer(declaration.initializer)) {
            report(
              "K5",
              declaration,
              "exports a const that is not a literal, an `as const`, an Object.freeze(...) or a function",
            );
          }
        }
      }
    }
    if (ts.isClassDeclaration(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      report("K5", statement, "exports a class; the kernel exports interfaces, types, enums and pure functions");
    }
  }

  visit(sourceFile);
  return violations;
}

export function checkKernel(root = repositoryRoot) {
  const files = listKernelFiles(root);
  const violations = [];
  for (const absolute of files) {
    const virtualPath = relative(root, absolute).split("\\").join("/");
    violations.push(...analyzeSource(virtualPath, readFileSync(absolute, "utf8")));
  }
  return { fileCount: files.length, violations };
}

function main() {
  const result = checkKernel();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.fileCount === 0) {
    process.stdout.write(`FAIL: kernel-content scan is vacuous; ${KERNEL_ROOT} holds no source file\n`);
    process.exitCode = 1;
    return;
  } else if (result.violations.length === 0) {
    process.stdout.write(
      `kernel-content: scanned ${result.fileCount} file(s) under ${KERNEL_ROOT}\n` +
        `ok: ${result.fileCount} file(s) satisfy all ${RULES.length} ADR M0.3 §5.3 kernel-content rules.\n`,
    );
  } else {
    for (const violation of result.violations) {
      process.stdout.write(`${violation.rule} ${violation.path}:${violation.line} — ${violation.message}\n`);
    }
    process.stdout.write(`\n${result.violations.length} kernel-content violation(s).\n`);
  }
  process.exitCode = result.violations.length > 0 || result.fileCount === 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("kernel-content.mjs")) main();
