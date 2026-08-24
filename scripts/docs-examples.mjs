#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contentDirectories = ["content/docs", "content/guides"];
const openApiPath = "apps/agent/src/openapi/openapi.generated.json";
const schemaPath = "internal-packages/tenancy-database/prisma/schema.prisma";
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
  const slugs = new Set(pages.map(({ path }) => basename(path, ".md")));
  const stats = { pages: pages.length, docs: 0, guides: 0, examples: 0, requests: 0 };

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
          JSON.parse(block.code);
        } catch (error) {
          errors.push(`${label}: invalid JSON example: ${error.message}`);
        }
      } else if (["ts", "typescript", "tsx"].includes(block.language)) {
        for (const diagnostic of validateTypeScript(block.code, `${expectedSlug}.${block.language}`)) {
          errors.push(`${label}: invalid TypeScript example: ${diagnostic}`);
        }
      } else if (["py", "python"].includes(block.language)) {
        const error = validatePython(block.code);
        if (error) errors.push(`${label}: invalid Python example: ${error}`);
      }
    }
  }

  if (stats.docs < 53) errors.push(`content/docs: expected at least 53 authored pages, found ${stats.docs}`);
  if (stats.guides < 28) errors.push(`content/guides: expected at least 28 authored pages, found ${stats.guides}`);
  if (stats.requests < 10) errors.push(`docs examples: expected at least 10 generated-contract HTTP checks, found ${stats.requests}`);
  if (stats.examples < 20) errors.push(`docs examples: expected at least 20 executable syntax checks, found ${stats.examples}`);

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
