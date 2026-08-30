#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = /\.(?:[cm]?[jt]sx?|css)$/;
const codeExtensions = /\.[cm]?[jt]sx?$/;
const testPath = /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/;
const configFile = /^(?:remix|tailwind|postcss|vitest|vite|prettier)\.config\.[cm]?[jt]s$/;
const runtimeScript = /^(?:entrypoint|wait-for-it|memory-policy|ws-)/;
const productionSystemCommands = new Set([
  "/usr/local/bin/goose",
  "cd",
  "dumb-init",
  "echo",
  "else",
  "exec",
  "env",
  "export",
  "fi",
  "grep",
  "node",
  "set",
  "then",
]);

function packageName(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("~") ||
    specifier.startsWith("#") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    isBuiltin(specifier)
  ) {
    return null;
  }
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function walk(root, relativePath, { includeBuildOutput = false } = {}) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (!statSync(absolutePath).isDirectory()) return [relativePath];
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".cache") return [];
    if (!includeBuildOutput && entry.name === "build") return [];
    return walk(root, path.join(relativePath, entry.name), { includeBuildOutput });
  });
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function importIsTypeOnly(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  return Boolean(
    clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

function codeSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const references = [];
  const add = (node, kind, typeOnly = false) => {
    if (node && ts.isStringLiteralLike(node)) {
      references.push({ specifier: node.text, kind, typeOnly });
    }
  };
  const isProvablyLocalPath = (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (!["join", "resolve"].includes(node.expression.name.text)) return false;
    const [base, ...segments] = node.arguments;
    const cwd =
      base &&
      ts.isCallExpression(base) &&
      ts.isPropertyAccessExpression(base.expression) &&
      ts.isIdentifier(base.expression.expression) &&
      base.expression.expression.text === "process" &&
      base.expression.name.text === "cwd";
    const directory = base && ts.isIdentifier(base) && base.text === "__dirname";
    return Boolean((cwd || directory) && segments.every((segment) => ts.isStringLiteralLike(segment)));
  };
  const addModuleLoad = (argument, kind) => {
    if (argument && ts.isStringLiteralLike(argument)) {
      add(argument, kind);
    } else if (!argument || !isProvablyLocalPath(argument)) {
      references.push({ kind, unresolved: true, typeOnly: false });
    }
  };

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, "static import", importIsTypeOnly(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, "export surface", node.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, "import equals", node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) add(argument.literal, "type import", true);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addModuleLoad(argument, "dynamic import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addModuleLoad(argument, "require");
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve"
      ) {
        addModuleLoad(argument, "require.resolve");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (path.basename(file).startsWith("postcss.config.")) {
    function visitPostcss(node) {
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === "plugins") ||
          (ts.isStringLiteralLike(node.name) && node.name.text === "plugins")) &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
            references.push({
              specifier: property.name.text,
              kind: "PostCSS plugin metadata",
              typeOnly: false,
            });
          }
        }
      }
      ts.forEachChild(node, visitPostcss);
    }
    visitPostcss(sourceFile);
  }

  if (path.basename(file).startsWith("remix.config.")) {
    function visitRemix(node) {
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === "serverDependenciesToBundle") ||
          (ts.isStringLiteralLike(node.name) && node.name.text === "serverDependenciesToBundle")) &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const element of node.initializer.elements) {
          if (ts.isStringLiteralLike(element)) {
            references.push({
              specifier: element.text,
              kind: "Remix bundling metadata",
              metadataOnly: true,
              typeOnly: false,
            });
          }
        }
      }
      ts.forEachChild(node, visitRemix);
    }
    visitRemix(sourceFile);
  }

  return references;
}

function cssSpecifiers(source) {
  const references = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (!source.startsWith("@import", index)) {
      index += 1;
      continue;
    }
    index += "@import".length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source.startsWith("url(", index)) {
      index += 4;
      while (/\s/.test(source[index] ?? "")) index += 1;
    }
    const quote = source[index];
    if (quote !== '"' && quote !== "'") continue;
    const end = source.indexOf(quote, index + 1);
    if (end === -1) break;
    references.push({ specifier: source.slice(index + 1, end), kind: "CSS import" });
    index = end + 1;
  }
  return references;
}

function exportTargets(manifest) {
  const targets = [];
  const visit = (value) => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(manifest.main);
  visit(manifest.module);
  visit(manifest.browser);
  visit(manifest.exports);
  visit(manifest.bin);
  return targets;
}

function resolvePackageManifest(root, dependency) {
  let current = root;
  while (true) {
    const candidate = path.join(current, "node_modules", dependency, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageBins(root, manifest) {
  const bins = new Map();
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  for (const dependency of Object.keys(declared)) {
    const packagePath = resolvePackageManifest(root, dependency);
    if (!packagePath) continue;
    const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
    if (typeof metadata.bin === "string") {
      bins.set(metadata.name ?? dependency, dependency);
    } else if (metadata.bin && typeof metadata.bin === "object") {
      for (const binary of Object.keys(metadata.bin)) bins.set(binary, dependency);
    }
  }
  return bins;
}

function shellCommands(source) {
  const commands = [];
  const normalized = source
    .replace(/\\\r?\n/g, " ")
    .replace(/^#!.*$/gm, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(/\s+#.*$/gm, "");
  for (const rawSegment of normalized.split(/\r?\n|&&|\|\||[;|]/)) {
    let segment = rawSegment.trim();
    if (!segment) continue;
    let previous;
    do {
      previous = segment;
      segment = segment.replace(/^(?:(?:if|elif|then|else|while|until|do|exec|!)\s+)+/, "");
      segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
    } while (segment !== previous);
    segment = segment.replace(/^(?:(?:env|cross-env|dumb-init)\s+)+/, (prefix) => {
      commands.push(...prefix.trim().split(/\s+/));
      return "";
    });
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
    const command = segment.match(/^(?:command\s+)?([A-Za-z0-9_@./:-]+)/)?.[1];
    if (command) commands.push(command);
  }
  return commands;
}

function dockerCommands(source) {
  const commands = [];
  const logicalLines = source.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const rawLine of logicalLines) {
    const line = rawLine.trim();
    const instruction = line.match(/^(RUN|CMD|ENTRYPOINT)\s+(.+)$/i);
    if (!instruction) continue;
    const [, operation, body] = instruction;
    if (operation.toUpperCase() === "RUN") {
      for (const command of shellCommands(body)) commands.push({ command, scope: "build" });
      continue;
    }
    if (body.startsWith("[")) {
      try {
        const [command] = JSON.parse(body);
        if (command) commands.push({ command, scope: "production" });
      } catch {
        // An invalid Docker JSON command is Docker's responsibility; it cannot establish evidence.
      }
    } else {
      for (const command of shellCommands(body)) commands.push({ command, scope: "production" });
    }
  }
  return commands;
}

function packageScriptScope(name) {
  return name === "start" || name.startsWith("start:") || name === "dev:worker"
    ? "production"
    : "build";
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function localCommandExists(root, command) {
  if (!command.includes("/") || command.startsWith("/usr/")) return false;
  const candidate = command.startsWith("/platos/")
    ? command.slice("/platos/".length)
    : command.replace(/^\.\//, "");
  const absolute = path.resolve(root, candidate);
  return absolute.startsWith(`${path.resolve(root)}${path.sep}`) && existsSync(absolute);
}

function projectFiles(root, manifest, includeBuildOutput) {
  const files = new Map();
  const add = (file, scope) => {
    if (!existsSync(path.join(root, file))) return;
    const current = files.get(file);
    if (current === "production" || current === scope) return;
    files.set(file, scope);
  };

  for (const file of walk(root, "app")) {
    if (sourceExtensions.test(file) && !testPath.test(file)) {
      add(file, file.endsWith(".d.ts") ? "build" : "production");
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (configFile.test(entry.name)) add(entry.name, "build");
    else if (sourceExtensions.test(entry.name) && !testPath.test(entry.name)) {
      add(entry.name, entry.name.endsWith(".d.ts") ? "build" : "production");
    }
  }
  for (const file of walk(root, "scripts")) {
    if (!/\.(?:[cm]?[jt]sx?|sh)$/.test(file)) continue;
    add(file, runtimeScript.test(path.basename(file)) ? "production" : "build");
  }
  add("upload-sourcemaps.sh", "build");

  for (const target of exportTargets(manifest)) {
    if (target.startsWith(".")) add(target.replace(/^\.\//, ""), "production");
  }
  if (includeBuildOutput) {
    for (const file of walk(root, "build", { includeBuildOutput: true })) {
      if (codeExtensions.test(file)) add(file, "production");
    }
  }
  return files;
}

function addEvidence(evidence, dependency, item) {
  const entries = evidence.get(dependency) ?? [];
  if (!entries.some((entry) => JSON.stringify(entry) === JSON.stringify(item))) entries.push(item);
  evidence.set(dependency, entries);
}

function firstEvidence(evidence, dependency) {
  const entry = evidence.get(dependency)?.[0];
  return entry ? `${entry.kind} in ${entry.file}` : "unknown source";
}

export function auditProductionDependencies({
  root = defaultRoot,
  manifest,
  includeBuildOutput = false,
} = {}) {
  const manifestPath = path.join(root, "package.json");
  const packageJson = manifest ?? JSON.parse(readFileSync(manifestPath, "utf8"));
  const evidence = new Map();
  const errors = [];
  const bins = packageBins(root, packageJson);
  const auditCommand = ({ command, scope, kind, file, strictProduction = false }) => {
    const dependency = bins.get(command);
    if (dependency) {
      addEvidence(evidence, dependency, { scope, kind, file });
      return;
    }
    if (
      strictProduction &&
      scope === "production" &&
      !productionSystemCommands.has(command) &&
      !localCommandExists(root, command)
    ) {
      errors.push(`unknown production command cannot be audited: ${command} (${kind} in ${file})`);
    }
  };

  for (const [file, fileScope] of projectFiles(root, packageJson, includeBuildOutput)) {
    const source = readFileSync(path.join(root, file), "utf8");
    const references = file.endsWith(".css")
      ? cssSpecifiers(source)
      : codeExtensions.test(file)
        ? codeSpecifiers(file, source)
        : [];
    for (const reference of references) {
      if (reference.unresolved) {
        errors.push(`non-literal module load cannot be audited: ${reference.kind} in ${file}`);
        continue;
      }
      const dependency = packageName(reference.specifier);
      if (!dependency) continue;
      const scope = reference.metadataOnly ? "metadata" : reference.typeOnly ? "build" : fileScope;
      addEvidence(evidence, dependency, { scope, kind: reference.kind, file });
    }
    if (file.endsWith(".sh")) {
      for (const command of shellCommands(source)) {
        auditCommand({
          command,
          scope: fileScope,
          kind: fileScope === "production" ? "operational command" : "build command",
          file,
          strictProduction: path.basename(file).startsWith("entrypoint"),
        });
      }
    }
  }

  for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
    const scope = packageScriptScope(name);
    for (const command of shellCommands(script)) {
      auditCommand({
        command,
        scope,
        kind: `package script command (${name})`,
        file: "package.json",
        strictProduction: scope === "production",
      });
    }
  }

  for (const file of ["Dockerfile", "Dockerfile.platos"]) {
    const absolutePath = path.join(root, file);
    if (!existsSync(absolutePath)) continue;
    const source = readFileSync(absolutePath, "utf8");
    for (const { command, scope } of dockerCommands(source)) {
      auditCommand({
        command,
        scope,
        kind: scope === "production" ? "Docker entrypoint command" : "Docker build command",
        file,
        strictProduction: scope === "production",
      });
    }
  }

  for (const target of exportTargets(packageJson)) {
    const dependency = packageName(target);
    if (dependency) {
      addEvidence(evidence, dependency, {
        scope: "production",
        kind: "package export surface",
        file: "package.json",
      });
    }
  }

  const dependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
  const optionalDependencies = new Set(Object.keys(packageJson.optionalDependencies ?? {}));
  const productionDeclared = new Set([...dependencies, ...optionalDependencies]);
  const devDeclared = new Set(Object.keys(packageJson.devDependencies ?? {}));
  const runtimeUsed = new Set(
    [...evidence].filter(([, entries]) => entries.some((entry) => entry.scope === "production")).map(([name]) => name),
  );
  const buildUsed = new Set(
    [...evidence].filter(([, entries]) => entries.some((entry) => entry.scope === "build")).map(([name]) => name),
  );

  for (const dependency of [...runtimeUsed].sort()) {
    if (!productionDeclared.has(dependency)) {
      errors.push(`runtime dependency is undeclared: ${dependency} (${firstEvidence(evidence, dependency)})`);
    }
  }
  for (const dependency of [...productionDeclared].sort()) {
    if (!runtimeUsed.has(dependency)) {
      errors.push(`production dependency has no reachable use: ${dependency}`);
    }
  }
  for (const dependency of [...buildUsed].sort()) {
    if (!productionDeclared.has(dependency) && !devDeclared.has(dependency)) {
      errors.push(`build dependency is undeclared: ${dependency} (${firstEvidence(evidence, dependency)})`);
    }
  }
  for (const dependency of [...productionDeclared].sort()) {
    if (buildUsed.has(dependency) && !runtimeUsed.has(dependency)) {
      errors.push(`build-only dependency is declared for production: ${dependency}`);
    }
  }
  for (const dependency of [...dependencies].sort()) {
    if (optionalDependencies.has(dependency)) {
      errors.push(`dependency is declared as both required and optional: ${dependency}`);
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
  return {
    productionDependencies: [...productionDeclared].sort(),
    runtimeReachable: [...runtimeUsed].sort(),
    buildReachable: [...buildUsed].sort(),
    metadataReferences: [...evidence]
      .filter(([, entries]) => entries.some((entry) => entry.scope === "metadata"))
      .map(([name]) => name)
      .sort(),
    evidence: Object.fromEntries([...evidence].sort(([a], [b]) => a.localeCompare(b))),
    inferenceExceptions: [
      "Remix serverDependenciesToBundle literals and regular expressions are recorded as bundling metadata, not package-load evidence; regular expressions cannot be reduced to package names.",
      "Production package-script, entrypoint, Docker CMD, and Docker ENTRYPOINT commands must resolve through declared npm bin metadata, a checked local executable, or the explicit production system-command allowlist.",
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = auditProductionDependencies({
      includeBuildOutput: process.argv.slice(2).includes("--build-output"),
    });
    console.log(
      `webapp-production-dependency-audit: ${result.productionDependencies.length} direct production dependencies derived and verified`,
    );
  } catch (error) {
    console.error(`webapp-production-dependency-audit failed:\n${error.message}`);
    process.exit(1);
  }
}
