#!/usr/bin/env node
// Executable implementation of the single WIN-251-owned ADR M0.3 §6 slice:
// max lines per file. This does not claim the other six §6 budget rows.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// WIN-256 widens this from `packages/contexts/**` to every V1-OWNED package
// root. The rule was written for the layer ADR M0.3 §6 is about, and it read as
// if it covered `packages/**`; it did not, and the gap was the two roots that
// had held nothing but declaration placeholders. The first real adapter arrived
// at 645 effective lines in one test file — under no threshold at all, because
// no threshold applied — which is the same shape one layer down as the
// 7,121-line service this programme is extracting.
//
// `packages/**` itself is deliberately NOT the selector. The other eleven
// directories under it are legacy packages this programme does not own and has
// not budgeted, and pointing the rule at them would make it a wall of findings
// nobody can act on, which is how a gate stops being read.
export const SELECTORS = [
  "packages/kernel/**",
  "packages/contexts/**",
  "packages/adapters/**",
  "apps/core-api/src/transports/**",
];
export const WARNING_THRESHOLD = 400;
export const ERROR_THRESHOLD = 500;
const SOURCE_EXTENSION = /\.(?:cts|mts|tsx?|jsx?)$/u;

export function effectiveLineCount(source) {
  let blockComment = false;
  let quote = null;
  let escaped = false;
  let count = 0;

  for (const line of source.split("\n")) {
    let code = "";
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const next = line[index + 1];

      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }

      if (quote !== null) {
        code += character;
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }

      if (character === "/" && next === "/") break;
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") quote = character;
      code += character;
    }
    if (code.trim() !== "") count += 1;
    if (quote === "'" || quote === '"') {
      quote = null;
      escaped = false;
    }
  }
  return count;
}

function listSourceFiles(root, selector) {
  if (!selector.endsWith("/**")) throw new Error(`selector must end in /**: ${selector}`);
  const selectorRoot = selector.slice(0, -3);
  const absoluteRoot = join(root, selectorRoot);
  const files = [];
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ["dist", "node_modules"].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (SOURCE_EXTENSION.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(absolute);
    }
  };
  walk(absoluteRoot);
  return files;
}

export function auditMaxFileLines(root = repositoryRoot, options = {}) {
  const selectors = options.selectors ?? SELECTORS;
  const warningThreshold = options.warningThreshold ?? WARNING_THRESHOLD;
  const errorThreshold = options.errorThreshold ?? ERROR_THRESHOLD;
  const selected = new Set();
  const findings = [];
  const errors = [];

  if (!(warningThreshold < errorThreshold)) {
    errors.push(`warning threshold ${warningThreshold} must be lower than error threshold ${errorThreshold}`);
  }

  for (const selector of selectors) {
    let files;
    try {
      files = listSourceFiles(root, selector);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (files.length === 0) errors.push(`selector matched zero source files: ${selector}`);
    for (const file of files) selected.add(file);
  }

  for (const absolute of [...selected].sort()) {
    const path = relative(root, absolute).split("\\").join("/");
    const effectiveLines = effectiveLineCount(readFileSync(absolute, "utf8"));
    if (effectiveLines > errorThreshold) findings.push({ path, effectiveLines, severity: "error" });
    else if (effectiveLines > warningThreshold) findings.push({ path, effectiveLines, severity: "warning" });
  }

  return {
    selectors: [...selectors],
    warningThreshold,
    errorThreshold,
    fileCount: selected.size,
    findings,
    errors,
  };
}

function main() {
  const result = auditMaxFileLines(repositoryRoot);
  process.stdout.write(
    `max-file-lines: scanned ${result.fileCount} source file(s) under ${result.selectors.join(", ")} ` +
      `(warn >${result.warningThreshold}, fail >${result.errorThreshold}; comments/blanks excluded)\n`
  );
  for (const finding of result.findings) {
    process.stdout.write(`${finding.severity.toUpperCase()} ${finding.path}: ${finding.effectiveLines} effective lines\n`);
  }
  for (const error of result.errors) process.stdout.write(`FAIL ${error}\n`);
  const hardFindings = result.findings.filter((finding) => finding.severity === "error");
  if (result.errors.length || hardFindings.length) process.exitCode = 1;
  else process.stdout.write(`ok: ${result.fileCount} real file(s) satisfy the enforced ADR M0.3 §6 max-file-lines slice\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
