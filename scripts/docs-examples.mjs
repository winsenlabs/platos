#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contentDirectories = ["content/docs", "content/guides"];
const openApiPath = "apps/agent/src/openapi/openapi.generated.json";
const schemaPath = "internal-packages/tenancy-database/prisma/schema.prisma";
const composePath = "docker-compose.platos.yml";
const agentServicePath = "apps/agent/src/agent-runtime/agent.service.ts";
const jobsToolsPath = "apps/agent/src/mcp-platform/tools/jobs.ts";
const jobsControllerPath = "apps/agent/src/agent-runtime/jobs.controller.ts";
const requiredModels = ["Agent", "AgentVersion", "Thread", "Turn", "Step", "ToolCall", "Job"];
const retiredSlugs = new Set([
  "runs",
  "platos-tasks",
  `deploy${"ments"}`,
  `wait${"points"}`,
  "queues",
  "recover-stuck-run",
  "schedule-recurring-task",
  "spawn-bgo",
  "run-an-eval-suite",
]);
const firstPartyPythonPackages = new Set(["platools", "platos-client"]);
const composeActions = new Set(["up", "restart", "logs", "stop", "start", "rm", "pull"]);
const composeOptionsWithValues = new Set(["--env-file", "--profile", "--project-name", "--scale", "--timeout", "-p", "-t"]);
function isFirstPartyNpmPackage(name) {
  return name.startsWith("@platosdev/") || name.startsWith("@platos/");
}

function authoredPages(root) {
  return contentDirectories.flatMap((directory) =>
    readdirSync(resolve(root, directory))
      .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
      .sort()
      .map((name) => ({
        path: `${directory}/${name}`,
        source: readFileSync(resolve(root, directory, name), "utf8"),
      })),
  );
}

function openApiOperations(spec) {
  const operations = new Set();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (/^(get|post|put|patch|delete|head|options)$/u.test(method)) {
        operations.add(`${method.toUpperCase()} ${normalizePath(path)}`);
      }
    }
  }
  return operations;
}

function normalizePath(value) {
  let path = value.trim();
  if (/^https?:\/\//u.test(path)) path = new URL(path).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Leave malformed examples unchanged so the generated-contract check rejects them.
  }
  return path
    .replace(/[?#].*$/u, "")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "{}")
    .replace(/\{[^}]+\}/gu, "{}")
    .replace(/[.,;]$/u, "");
}

function parseFrontmatter(source) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n/u);
  if (!match) return null;
  const fields = new Map();
  for (const line of match[1].split("\n")) {
    if (/^\s/u.test(line) || !line.includes(":")) continue;
    const separator = line.indexOf(":");
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return fields;
}

function fencedBlocks(source) {
  const blocks = [];
  const pattern = /^```([^\n]*)\n([\s\S]*?)^```\s*$/gmu;
  for (const match of source.matchAll(pattern)) {
    blocks.push({ language: match[1].trim().toLowerCase(), code: match[2], offset: match.index ?? 0 });
  }
  return blocks;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function requestLines(source) {
  const out = [];
  const pattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s`"']+|\/[A-Za-z0-9_{}:./?=&-]+)/gu;
  for (const match of source.matchAll(pattern)) {
    out.push({ method: match[1], path: match[2], offset: match.index ?? 0 });
  }
  const curlPattern = /\bcurl(?:\s+-X\s+(GET|POST|PUT|PATCH|DELETE))?\s+(https?:\/\/[^\s`"']+)/gu;
  for (const match of source.matchAll(curlPattern)) {
    const url = new URL(match[2]);
    if (url.hostname === "platos.example.com" && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/oauth/"))) {
      out.push({ method: match[1] ?? "GET", path: match[2], offset: match.index ?? 0 });
    }
  }
  const fetchPattern = /\bfetch\(\s*["'](https?:\/\/[^"']+|\/api\/[^"']+)["']\s*(?:,\s*\{([\s\S]{0,500}?)\}\s*)?\)/gu;
  for (const match of source.matchAll(fetchPattern)) {
    const method = match[2]?.match(/\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/u)?.[1] ?? "GET";
    out.push({ method, path: match[1], offset: match.index ?? 0 });
  }
  return out;
}

function directChildDirectories(root, parent) {
  const absolute = resolve(root, parent);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

function exportedTypeScriptNames(source, fileName) {
  const names = new Set();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function packageSpecifier(value) {
  if (value.startsWith("@")) {
    const [scope, name, ...rest] = value.split("/");
    return { packageName: `${scope}/${name ?? ""}`, subpath: rest.length ? `./${rest.join("/")}` : "." };
  }
  const [name, ...rest] = value.split("/");
  return { packageName: name, subpath: rest.length ? `./${rest.join("/")}` : "." };
}

function sourceForPackageExport(root, packageInfo, subpath) {
  const relative = subpath === "." ? "index" : subpath.slice(2);
  const candidates = [
    resolve(root, packageInfo.directory, "src", `${relative}.ts`),
    resolve(root, packageInfo.directory, "src", `${relative}.tsx`),
    resolve(root, packageInfo.directory, "src", relative, "index.ts"),
    resolve(root, packageInfo.directory, "src", relative, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function workspaceContracts(root) {
  const packages = new Map();
  for (const directory of [
    ...directChildDirectories(root, "apps"),
    ...directChildDirectories(root, "packages"),
    ...directChildDirectories(root, "integrations"),
  ]) {
    const manifestPath = resolve(root, directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string") continue;
    const exportPaths = new Set(
      manifest.exports && typeof manifest.exports === "object"
        ? Object.keys(manifest.exports)
        : ["."],
    );
    packages.set(manifest.name, { directory, manifest, exportPaths });
  }

  const pythonPackages = new Map();
  for (const directory of [...directChildDirectories(root, "apps"), ...directChildDirectories(root, "packages")]) {
    const projectPath = resolve(root, directory, "pyproject.toml");
    if (!existsSync(projectPath)) continue;
    const project = readFileSync(projectPath, "utf8");
    const name = project.match(/^name\s*=\s*["']([^"']+)["']/mu)?.[1];
    if (!name) continue;
    const initPath = resolve(root, directory, name.replaceAll("-", "_"), "__init__.py");
    const exports = new Set();
    if (existsSync(initPath)) {
      const init = readFileSync(initPath, "utf8");
      const all = init.match(/__all__\s*=\s*\[([\s\S]*?)\]/u)?.[1] ?? "";
      for (const match of all.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/gu)) exports.add(match[1]);
    }
    pythonPackages.set(name, { directory, exports });
  }

  return { packages, pythonPackages };
}

function classMethods(source, className, fileName) {
  const methods = new Set();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    for (const member of statement.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) methods.add(member.name.text);
    }
  }
  return methods;
}

function interfaceProperties(source, interfaceName, fileName) {
  const properties = new Set();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue;
    for (const member of statement.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) properties.add(member.name.text);
    }
  }
  return properties;
}

function platosClientContract(root) {
  const clientPath = resolve(root, "packages/platos-client/src/client.ts");
  const typesPath = resolve(root, "packages/platos-client/src/types.ts");
  const client = readFileSync(clientPath, "utf8");
  const namespaces = new Map();
  for (const match of client.matchAll(/readonly\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_]*)\s*;/gu)) {
    const [, namespace, className] = match;
    const apiPath = resolve(root, "packages/platos-client/src/apis", `${namespace}.ts`);
    if (existsSync(apiPath)) {
      namespaces.set(namespace, classMethods(readFileSync(apiPath, "utf8"), className, apiPath));
    }
  }
  return {
    namespaces,
    clientMethods: classMethods(client, "PlatosClient", clientPath),
    options: interfaceProperties(readFileSync(typesPath, "utf8"), "PlatosClientOptions", typesPath),
  };
}

function platoolsContract(root) {
  const path = resolve(root, "packages/platools-js/src/platools.ts");
  const source = readFileSync(path, "utf8");
  return {
    methods: classMethods(source, "Platools", path),
    options: interfaceProperties(source, "PlatoolsConfig", path),
  };
}

function objectLiteralKeys(node) {
  const keys = new Set();
  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name)
    ) {
      keys.add(property.name.text);
    }
  }
  return keys;
}

function validateTypeScriptContracts(code, label, contracts) {
  const errors = [];
  const sourceFile = ts.createSourceFile(`${label}.ts`, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const platoolsVariables = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const { packageName, subpath } = packageSpecifier(moduleName);
    const packageInfo = contracts.workspace.packages.get(packageName);
    if (!packageInfo) {
      if (isFirstPartyNpmPackage(packageName)) errors.push(`${label}: ${moduleName} is not a workspace package export`);
      continue;
    }
    if (!packageInfo.exportPaths.has(subpath)) {
      errors.push(`${label}: package subpath ${moduleName} is absent from ${packageInfo.directory}/package.json exports`);
      continue;
    }
    const entryPath = sourceForPackageExport(contracts.root, packageInfo, subpath);
    if (!entryPath || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const exported = exportedTypeScriptNames(readFileSync(entryPath, "utf8"), entryPath);
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (!exported.has(importedName)) {
        errors.push(`${label}: ${importedName} is not exported by ${moduleName}`);
      }
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer)) {
      if (ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "Platools") {
        platoolsVariables.add(node.name.text);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments?.[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      const keys = objectLiteralKeys(node.arguments[0]);
      if (node.expression.text === "PlatosClient") {
        for (const key of keys) if (!contracts.platosClient.options.has(key)) errors.push(`${label}: PlatosClient option ${key} is not public`);
        if (!keys.has("baseUrl")) errors.push(`${label}: PlatosClient requires baseUrl`);
        if (!keys.has("sessionToken") && !keys.has("apiKey")) errors.push(`${label}: PlatosClient requires sessionToken or apiKey`);
      } else if (node.expression.text === "Platools") {
        for (const key of keys) if (!contracts.platools.options.has(key)) errors.push(`${label}: Platools option ${key} is not public`);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (ts.isPropertyAccessExpression(receiver)) {
        const namespace = receiver.name.text;
        const methods = contracts.platosClient.namespaces.get(namespace);
        if (methods && !methods.has(method)) errors.push(`${label}: PlatosClient.${namespace}.${method} is not public`);
      } else if (ts.isIdentifier(receiver) && platoolsVariables.has(receiver.text) && !contracts.platools.methods.has(method)) {
        errors.push(`${label}: Platools.${method} is not public`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return errors;
}

function validatePythonContracts(code, label, workspace) {
  const errors = [];
  for (const match of code.matchAll(/^from\s+([A-Za-z_][A-Za-z0-9_-]*)\s+import\s+([^\n#]+)/gmu)) {
    const packageInfo = workspace.pythonPackages.get(match[1]);
    if (!packageInfo) {
      if (firstPartyPythonPackages.has(match[1])) errors.push(`${label}: Python package ${match[1]} is absent from workspace pyproject files`);
      continue;
    }
    for (const imported of match[2].split(",").map((value) => value.trim().split(/\s+as\s+/u)[0])) {
      if (imported && !packageInfo.exports.has(imported)) errors.push(`${label}: ${imported} is not exported by Python package ${match[1]}`);
    }
  }
  return errors;
}

function composeContract(root) {
  const source = readFileSync(resolve(root, composePath), "utf8");
  const services = new Set();
  let inServices = false;
  for (const line of source.split("\n")) {
    if (line === "services:") {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/u.test(line) && line.trim()) break;
    const service = inServices ? line.match(/^  ([A-Za-z0-9_-]+):\s*$/u)?.[1] : undefined;
    if (service) services.add(service);
  }
  const variables = new Set([...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/gu)].map((match) => match[1]));
  const requiredVariables = new Set([...source.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/gu)].map((match) => match[1]));
  return { services, variables, requiredVariables };
}

function shellTokens(value) {
  return value.match(/"[^"]*"|'[^']*'|[^\s]+/gu)?.map((token) => token.replace(/^["']|["']$/gu, "")) ?? [];
}

function validateShellContracts(code, label, contracts) {
  const errors = [];
  const normalized = code.replace(/\\\n/gu, " ");
  for (const line of normalized.split("\n")) {
    const install = line.match(/^\s*(?:npm\s+(?:install|i)|pnpm\s+add)\s+(.+)$/u);
    if (install) {
      for (const token of shellTokens(install[1])) {
        if (token.startsWith("-")) continue;
        const packageName = packageSpecifier(token.replace(/@[^/@]+$/u, "")).packageName;
        if (!isFirstPartyNpmPackage(packageName)) continue;
        if (!contracts.workspace.packages.has(packageName)) errors.push(`${label}: npm package ${packageName} is absent from workspace manifests`);
      }
    }
    const pip = line.match(/^\s*pip(?:3)?\s+install\s+(.+)$/u);
    if (pip) {
      for (const token of shellTokens(pip[1])) {
        const packageName = token.replace(/[<>=!~].*$/u, "");
        if (firstPartyPythonPackages.has(packageName) && !contracts.workspace.pythonPackages.has(packageName)) {
          errors.push(`${label}: Python package ${packageName} is absent from workspace pyproject files`);
        }
      }
    }
    const script = line.match(/^\s*pnpm\s+run\s+([A-Za-z0-9:_-]+)/u)?.[1];
    if (script && !contracts.rootScripts.has(script)) errors.push(`${label}: root package.json has no script ${script}`);
  }

  for (const match of normalized.matchAll(/\bdocker\s+compose\s+([^\n]+)/gu)) {
    const tokens = shellTokens(match[1]);
    for (let index = 0; index < tokens.length; index += 1) {
      if ((tokens[index] === "-f" || tokens[index] === "--file") && tokens[index + 1]) {
        if (!existsSync(resolve(contracts.root, tokens[index + 1]))) errors.push(`${label}: Compose file ${tokens[index + 1]} does not exist`);
      }
    }
    const actionIndex = tokens.findIndex((token) => composeActions.has(token));
    if (actionIndex < 0) continue;
    let skipNext = false;
    for (const token of tokens.slice(actionIndex + 1)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (composeOptionsWithValues.has(token)) {
        skipNext = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (!contracts.compose.services.has(token)) errors.push(`${label}: unknown Compose service ${token}`);
    }
  }
  return errors;
}

function jobContracts(root) {
  const agentService = readFileSync(resolve(root, agentServicePath), "utf8");
  const jobsTools = readFileSync(resolve(root, jobsToolsPath), "utf8");
  const jobsController = readFileSync(resolve(root, jobsControllerPath), "utf8");
  const toolNames = new Set([...jobsTools.matchAll(/name:\s*["'](jobs\.[a-z_]+)["']/gu)].map((match) => match[1]));
  const sourceErrors = [];
  const spawnJobSchema = agentService.match(/const\s+spawnJobParameters\s*=\s*z\.object\(\{([\s\S]*?)\n\s*\}\);/u)?.[1];
  const spawnJobInputKeys = new Set();
  const spawnJobRequiredKeys = new Set();
  if (!spawnJobSchema) {
    sourceErrors.push(`${agentServicePath}: spawn_job input schema could not be parsed`);
  } else {
    for (const match of spawnJobSchema.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(z\.[^\n]+)$/gmu)) {
      spawnJobInputKeys.add(match[1]);
      if (!match[2].includes(".optional()")) spawnJobRequiredKeys.add(match[1]);
    }
  }
  for (const required of ["jobType", "instruction"]) {
    if (!spawnJobRequiredKeys.has(required)) sourceErrors.push(`${agentServicePath}: spawn_job is missing required ${required}`);
  }
  for (const optional of ["tools", "timeout"]) {
    if (!spawnJobInputKeys.has(optional) || spawnJobRequiredKeys.has(optional)) {
      sourceErrors.push(`${agentServicePath}: spawn_job is missing optional ${optional}`);
    }
  }
  if (!/body:\s*\{[\s\S]*?jobId:\s*string;[\s\S]*?displayName:\s*string;[\s\S]*?handler:\s*string;/u.test(jobsController)) {
    sourceErrors.push(`${jobsControllerPath}: persisted Job create contract is missing jobId, displayName, or handler`);
  }
  return { toolNames, sourceErrors, spawnJobInputKeys, spawnJobRequiredKeys };
}

function validateTypeScript(code, fileName) {
  const result = ts.transpileModule(code, {
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
}

function validatePython(code) {
  try {
    execFileSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<docs>', 'exec')"], {
      input: code,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null;
  } catch (error) {
    return error.stderr?.toString().trim() || error.message;
  }
}

export function validateDocsExamples(root = repositoryRoot) {
  const errors = [];
  const pages = authoredPages(root);
  const spec = JSON.parse(readFileSync(resolve(root, openApiPath), "utf8"));
  const operations = openApiOperations(spec);
  const schema = readFileSync(resolve(root, schemaPath), "utf8");
  const workspace = workspaceContracts(root);
  const compose = composeContract(root);
  const jobs = jobContracts(root);
  const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const contracts = {
    root,
    workspace,
    compose,
    rootScripts: new Set(Object.keys(rootPackage.scripts ?? {})),
    platosClient: platosClientContract(root),
    platools: platoolsContract(root),
  };
  const slugs = new Set(pages.map(({ path }) => basename(path, ".md")));
  const stats = { pages: pages.length, docs: 0, guides: 0, examples: 0, requests: 0, jobPayloads: 0 };

  errors.push(...jobs.sourceErrors);

  for (const model of requiredModels) {
    if (!new RegExp(`^model ${model}\\b`, "mu").test(schema)) {
      errors.push(`${schemaPath}: generated control schema is missing model ${model}`);
    }
  }

  for (const page of pages) {
    if (page.path.startsWith("content/docs/")) stats.docs += 1;
    else stats.guides += 1;

    const frontmatter = parseFrontmatter(page.source);
    if (!frontmatter) {
      errors.push(`${page.path}: missing frontmatter`);
      continue;
    }
    const expectedSlug = basename(page.path, ".md");
    const slug = frontmatter.get("slug");
    if (slug !== expectedSlug) errors.push(`${page.path}: slug ${JSON.stringify(slug)} must match ${expectedSlug}`);
    if (!frontmatter.get("title")) errors.push(`${page.path}: missing title`);
    if (!frontmatter.get("description")) errors.push(`${page.path}: missing description`);
    if (retiredSlugs.has(expectedSlug)) errors.push(`${page.path}: retired public slug remains`);
    if (/\/agent\/v1\//u.test(page.source)) errors.push(`${page.path}: use the generated /api/v1/agent URL prefix`);
    if (/github\.com\/platos-labs\/platos/iu.test(page.source)) errors.push(`${page.path}: references a nonexistent repository`);

    for (const match of page.source.matchAll(/\bjobs\.[a-z_]+\b/gu)) {
      if (!jobs.toolNames.has(match[0])) errors.push(`${page.path}:${lineAt(page.source, match.index ?? 0)}: unknown platform Job operation ${match[0]}`);
    }

    for (const match of page.source.matchAll(/\]\(\/(docs|guides)\/([a-z0-9-]+)(?:#[^)]+)?\)/gu)) {
      if (!slugs.has(match[2])) errors.push(`${page.path}: broken internal link to /${match[1]}/${match[2]}`);
    }

    for (const request of requestLines(page.source)) {
      stats.requests += 1;
      const contract = `${request.method} ${normalizePath(request.path)}`;
      if (!operations.has(contract)) {
        errors.push(`${page.path}:${lineAt(page.source, request.offset)}: ${contract} is absent from ${openApiPath}`);
      }
    }

    for (const block of fencedBlocks(page.source)) {
      stats.examples += 1;
      const label = `${page.path}:${lineAt(page.source, block.offset)}`;
      if (block.language === "json") {
        try {
          const value = JSON.parse(block.code);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const keys = Object.keys(value);
            const mentionsSpawnJob = page.source.slice(Math.max(0, block.offset - 500), block.offset).includes("spawn_job");
            const looksLikeOutput = keys.some((key) => ["spawned", "durable", "message"].includes(key));
            if (mentionsSpawnJob && !looksLikeOutput) {
              stats.jobPayloads += 1;
              for (const key of keys) {
                if (!jobs.spawnJobInputKeys.has(key)) errors.push(`${label}: spawn_job payload contains unsupported key ${key}`);
              }
              for (const key of jobs.spawnJobRequiredKeys) {
                if (!(key in value)) errors.push(`${label}: spawn_job payload is missing required key ${key}`);
              }
            }
          }
        } catch (error) {
          errors.push(`${label}: invalid JSON example: ${error.message}`);
        }
      } else if (["ts", "typescript", "tsx"].includes(block.language)) {
        for (const diagnostic of validateTypeScript(block.code, `${expectedSlug}.${block.language}`)) {
          errors.push(`${label}: invalid TypeScript example: ${diagnostic}`);
        }
        errors.push(...validateTypeScriptContracts(block.code, label, contracts));
      } else if (["py", "python"].includes(block.language)) {
        const error = validatePython(block.code);
        if (error) errors.push(`${label}: invalid Python example: ${error}`);
        errors.push(...validatePythonContracts(block.code, label, workspace));
      } else if (["bash", "sh", "shell"].includes(block.language)) {
        errors.push(...validateShellContracts(block.code, label, contracts));
      }
    }
  }

  const selfHosting = pages.find((page) => page.path === "content/docs/self-hosting.md")?.source ?? "";
  for (const variable of compose.requiredVariables) {
    if (!new RegExp(`\\b${variable}\\b`, "u").test(selfHosting)) {
      errors.push(`content/docs/self-hosting.md: missing required Compose variable ${variable}`);
    }
  }
  for (const path of ["content/docs/self-hosting.md", "content/guides/install-self-host.md", "content/guides/quickstart.md"]) {
    const page = pages.find((candidate) => candidate.path === path);
    if (!page) continue;
    for (const block of fencedBlocks(page.source).filter((candidate) => ["bash", "sh", "shell"].includes(candidate.language))) {
      for (const match of block.code.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/gmu)) {
        if (!compose.variables.has(match[1])) errors.push(`${path}:${lineAt(page.source, block.offset)}: ${match[1]} is not referenced by ${composePath}`);
      }
    }
  }

  if (stats.docs < 53) errors.push(`content/docs: expected at least 53 authored pages, found ${stats.docs}`);
  if (stats.guides < 28) errors.push(`content/guides: expected at least 28 authored pages, found ${stats.guides}`);
  if (stats.requests < 10) errors.push(`docs examples: expected at least 10 generated-contract HTTP checks, found ${stats.requests}`);
  if (stats.examples < 20) errors.push(`docs examples: expected at least 20 executable syntax checks, found ${stats.examples}`);
  if (stats.jobPayloads < 1) errors.push("docs examples: expected at least one source-contract spawn_job payload check");

  return { errors, stats };
}

function runCli() {
  const result = validateDocsExamples();
  if (result.errors.length) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `docs-examples: validated ${result.stats.examples} code examples and ${result.stats.requests} HTTP requests across ${result.stats.docs} docs + ${result.stats.guides} guides`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCli();
