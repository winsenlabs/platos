#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRepositoryPath } from "./vocabulary/identity.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultManifestPath = "docs/vocabulary-boundary-exceptions.json";

export const RULES = [
  {
    id: "spawn-bgo",
    pattern: /spawn_bgo/giu,
    replacement: "Use the Platos-owned spawn_job runtime tool.",
  },
  {
    id: "trigger-internal-secret",
    pattern: /TRIGGER_INTERNAL_SECRET/gu,
    replacement: "Use a Platos-owned worker/authentication secret name.",
  },
  {
    id: "task-run",
    pattern: /task[\s_-]?runs?/giu,
    replacement: "Use Turn for agent work or Job for asynchronous Platos work.",
  },
  {
    id: "waitpoint",
    pattern: /wait[\s_-]?points?/giu,
    replacement: "Model waiting as Turn or Job state; keep waitpoint only at the Trigger boundary.",
  },
  {
    id: "background-worker",
    pattern: /background[\s_-]?workers?/giu,
    replacement: "Use Job/runtime infrastructure vocabulary for Platos-owned work.",
  },
  {
    id: "deployment",
    pattern: /deployments?/giu,
    replacement: "Use Agent Version for product rollout; reserve deployment for infrastructure or Trigger.",
  },
  {
    id: "attempt",
    pattern: /attempts?/giu,
    replacement: "Use retry metadata on Step, Tool Call, or Job; reserve attempt for Trigger metadata.",
  },
  {
    id: "trigger",
    pattern: /trigger/giu,
    replacement: "Use Platos vocabulary unless this names the external Trigger Cloud/self-hosted integration.",
  },
];

const specificRuleIds = new Set(RULES.filter((rule) => rule.id !== "trigger").map((rule) => rule.id));

export function listRepositoryFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function decodeTextFile(path) {
  const source = readFileSync(path);
  if (source.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return null;
  }
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest.version !== 1) errors.push("manifest.version must be 1");
  if (!Array.isArray(manifest.exceptions)) errors.push("manifest.exceptions must be an array");
  if (!Array.isArray(manifest.exclusions)) errors.push("manifest.exclusions must be an array");

  const ruleIds = new Set(RULES.map((rule) => rule.id));
  for (const [index, exception] of (manifest.exceptions ?? []).entries()) {
    const label = `exceptions[${index}]`;
    for (const field of [
      "path",
      "rule",
      "matchedText",
      "localContextSha256",
      "semanticContextKind",
      "semanticContextSha256",
      "classification",
      "owner",
      "rationale",
      "removalPolicy",
    ]) {
      if (typeof exception[field] !== "string" || exception[field].trim() === "") {
        errors.push(`${label}.${field} must be a non-empty string`);
      }
    }
    if (!Number.isInteger(exception.line) || exception.line < 1) errors.push(`${label}.line must be positive`);
    if (!Number.isInteger(exception.column) || exception.column < 1) errors.push(`${label}.column must be positive`);
    if (!/^[a-f0-9]{64}$/u.test(exception.localContextSha256 ?? "")) {
      errors.push(`${label}.localContextSha256 must be a lowercase SHA-256 digest`);
    }
    if (!/^[a-f0-9]{64}$/u.test(exception.semanticContextSha256 ?? "")) {
      errors.push(`${label}.semanticContextSha256 must be a lowercase SHA-256 digest`);
    }
    if (
      exception.collisionContextSha256 !== undefined &&
      !/^[a-f0-9]{64}$/u.test(exception.collisionContextSha256)
    ) {
      errors.push(`${label}.collisionContextSha256 must be a lowercase SHA-256 digest when present`);
    }
    if (
      !["vendor", "migration-debt", "migration-archaeology", "technical", "boundary-spec"].includes(
        exception.classification
      )
    ) {
      errors.push(
        `${label}.classification must identify vendor, migration-debt, migration-archaeology, technical, or boundary-spec`
      );
    }
    if (/[*?\[\]]/u.test(exception.path ?? "")) {
      errors.push(`${label}.path must be exact; wildcard directory/file suppression is forbidden`);
    }
    if ((exception.path ?? "").startsWith("/") || (exception.path ?? "").split("/").includes("..")) {
      errors.push(`${label}.path must be repository-relative`);
    }
    if (typeof exception.path === "string" && normalizeRepositoryPath(exception.path) !== exception.path) {
      errors.push(
        `${label}.path must be canonical: write ${normalizeRepositoryPath(exception.path)} (forward slashes, no "./", no repeated "/")`
      );
    }
    if (!ruleIds.has(exception.rule)) errors.push(`${label}.rule is unknown: ${exception.rule}`);
    validateLifecycle(exception, label, errors);
  }

  const exclusionPaths = new Set();
  for (const [index, exclusion] of (manifest.exclusions ?? []).entries()) {
    const label = `exclusions[${index}]`;
    for (const field of ["path", "classification", "owner", "rationale", "removalPolicy", "removalEvent"]) {
      if (typeof exclusion[field] !== "string" || exclusion[field].trim() === "") {
        errors.push(`${label}.${field} must be a non-empty string`);
      }
    }
    if (!["binary", "generated", "vendor"].includes(exclusion.classification)) {
      errors.push(`${label}.classification must be binary, generated, or vendor`);
    }
    if (/[*?\[\]]/u.test(exclusion.path ?? "")) {
      errors.push(`${label}.path must be exact; wildcard exclusion is forbidden`);
    }
    if ((exclusion.path ?? "").startsWith("/") || (exclusion.path ?? "").split("/").includes("..")) {
      errors.push(`${label}.path must be repository-relative`);
    }
    if (typeof exclusion.path === "string" && normalizeRepositoryPath(exclusion.path) !== exclusion.path) {
      errors.push(
        `${label}.path must be canonical: write ${normalizeRepositoryPath(exclusion.path)} (forward slashes, no "./", no repeated "/")`
      );
    }
    if (exclusionPaths.has(exclusion.path)) errors.push(`${label}.path duplicates an existing exclusion`);
    exclusionPaths.add(exclusion.path);
  }
  return errors;
}

function validateLifecycle(exception, label, errors) {
  if (
    exception.classification === "migration-archaeology" &&
    !/(?:^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/u.test(exception.path ?? "")
  ) {
    errors.push(`${label}.migration-archaeology is restricted to immutable Prisma migration.sql files`);
  }
  if (exception.classification === "migration-debt") {
    if (typeof exception.trackingIssue !== "string" || !/^WIN-\d+$/u.test(exception.trackingIssue)) {
      errors.push(`${label}.trackingIssue must be a WIN issue for migration-debt`);
    }
    if (!isCalendarDate(exception.expiresOn)) {
      errors.push(`${label}.expiresOn must be a real YYYY-MM-DD date for migration-debt`);
    }
    if (exception.removalEvent !== undefined) errors.push(`${label}.removalEvent is not a debt expiry`);
  } else {
    if (typeof exception.removalEvent !== "string" || exception.removalEvent.trim() === "") {
      errors.push(`${label}.removalEvent must bind non-debt exceptions to a concrete event`);
    }
    if (exception.trackingIssue !== undefined || exception.expiresOn !== undefined) {
      errors.push(`${label} non-debt lifecycle must be event-bound, not date-bound`);
    }
  }
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const localContextRadius = 64;

function localContextSha256(line, start, end) {
  const before = line.slice(Math.max(0, start - localContextRadius), start);
  const after = line.slice(end, end + localContextRadius);
  return sha256(`${before}\0<MATCH>\0${after}`);
}

function createSemanticContextResolver(source, lines, path, kind) {
  if (kind === "path") {
    const context = semanticContext("repository-path", path, path, 0, lines, 0);
    return () => context;
  }

  if (/\.(?:md|mdx)$/iu.test(path)) {
    const contexts = markdownContexts(lines);
    return (lineIndex) => contexts[lineIndex] ?? fallbackContext(lines, lineIndex);
  }

  if (/\.json$/iu.test(path)) {
    const json = parseJsonAst(source);
    if (json) {
      const lineStarts = sourceLineStarts(source);
      return (lineIndex, column) => {
        const offset = lineStarts[lineIndex] + column;
        const resolved = jsonContextAt(json, offset, []);
        if (!resolved) return fallbackContext(lines, lineIndex);
        return semanticContext(
          "json-path",
          `/${resolved.path.map(escapePointerSegment).join("/")}`,
          resolved.instance,
          lineIndex,
          lines,
          resolved.scopeStartLine ?? lineIndex
        );
      };
    }
  }

  if (/\.ya?ml$/iu.test(path)) {
    const contexts = yamlContexts(lines);
    return (lineIndex) => contexts[lineIndex] ?? fallbackContext(lines, lineIndex);
  }

  const contexts = sourceScopeContexts(lines);
  return (lineIndex) => contexts[lineIndex] ?? fallbackContext(lines, lineIndex);
}

function semanticContext(kind, identity, instance, lineIndex, lines, scopeStartLine) {
  return {
    kind,
    identity,
    instance,
    sha256: sha256(identity),
    collisionCandidateSha256: collisionCandidateSha256(lines, lineIndex, scopeStartLine),
  };
}

function fallbackContext(lines, lineIndex) {
  const previous = nearestContextLine(lines, lineIndex, -1);
  const next = nearestContextLine(lines, lineIndex, 1);
  const identity = `previous:${previous ?? "<START>"}\nnext:${next ?? "<END>"}`;
  return semanticContext("neighbor-lines", identity, `neighbors:${identity}`, lineIndex, lines, lineIndex);
}

function markdownContexts(lines) {
  const contexts = [];
  const headings = [];
  for (const [lineIndex, line] of lines.entries()) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = { text: heading[2].trim(), line: lineIndex, level };
    }
    const breadcrumb = headings.filter(Boolean);
    if (!breadcrumb.length) continue;
    const identity = breadcrumb.map((entry) => `h${entry.level}:${entry.text}`).join("/");
    const instance = breadcrumb.map((entry) => `${entry.level}@${entry.line}`).join("/");
    contexts[lineIndex] = semanticContext(
      "markdown-breadcrumb",
      identity,
      instance,
      lineIndex,
      lines,
      breadcrumb.at(-1).line
    );
  }
  return contexts;
}

function yamlContexts(lines) {
  const contexts = [];
  const stack = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const indent = indentation(line);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();

    const list = line.match(/^\s*-\s*(?:["']?([^"':]+)["']?\s*:\s*(.*))?$/u);
    let item;
    let key;
    let value;
    if (list) {
      item = yamlListIdentity(lines, lineIndex, indent);
      key = list[1]?.trim();
      value = list[2]?.trim();
    } else {
      const mapping = line.match(/^\s*["']?([^"':]+?)["']?\s*:\s*(.*)$/u);
      key = mapping?.[1]?.trim();
      value = mapping?.[2]?.trim();
    }

    const segments = stack.map((entry) => entry.segment);
    if (item) segments.push(item.segment);
    if (key) segments.push(key);
    if (!segments.length) continue;
    const identity = `/${segments.map(escapePointerSegment).join("/")}`;
    const instance = [...stack.map((entry) => entry.instance), item?.instance, `${lineIndex}`]
      .filter(Boolean)
      .join("/");
    contexts[lineIndex] = semanticContext(
      "yaml-path",
      identity,
      instance,
      lineIndex,
      lines,
      item?.line ?? stack.at(-1)?.line ?? lineIndex
    );

    if (item) stack.push({ indent, segment: item.segment, instance: item.instance, line: item.line });
    if (key && (value === "" || /^[|>][+-]?$/u.test(value ?? ""))) {
      stack.push({ indent: list ? indent + 1 : indent, segment: key, instance: `${key}@${lineIndex}`, line: lineIndex });
    }
  }
  return contexts;
}

function escapePointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function yamlListIdentity(lines, lineIndex, indent) {
  const candidateKeys = "id|name|key|slug|title|type|provider";
  const sameLine = lines[lineIndex].match(
    new RegExp(`^\\s*-\\s*["']?(${candidateKeys})["']?\\s*:\\s*([^#]+?)\\s*$`, "iu")
  );
  if (sameLine) {
    const value = unquoteScalar(sameLine[2]);
    return { segment: `[${sameLine[1]}=${value}]`, instance: `item@${lineIndex}`, line: lineIndex };
  }
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const candidateIndent = indentation(lines[index]);
    if (candidateIndent <= indent) break;
    const identity = lines[index].match(
      new RegExp(`^\\s*["']?(${candidateKeys})["']?\\s*:\\s*([^#]+?)\\s*$`, "iu")
    );
    if (identity) {
      return {
        segment: `[${identity[1]}=${unquoteScalar(identity[2])}]`,
        instance: `item@${lineIndex}`,
        line: lineIndex,
      };
    }
  }
  return { segment: "[anonymous]", instance: `item@${lineIndex}`, line: lineIndex };
}

function unquoteScalar(value) {
  return value.trim().replace(/^(["'])(.*)\1[,]?$/u, "$2").replace(/,$/u, "");
}

function indentation(line) {
  return line.match(/^\s*/u)[0].replaceAll("\t", "  ").length;
}

function sourceScopeContexts(lines) {
  const contexts = [];
  const structuralLines = sanitizeStructuralLines(lines);
  const stack = [];
  let depth = 0;
  for (const [lineIndex, line] of structuralLines.entries()) {
    while (stack.length && stack.at(-1).bodyDepth > depth) stack.pop();
    const declarations = scopeDeclarations(line, depth, lineIndex);
    const chain = [...stack, ...declarations];
    if (chain.length) {
      const identity = chain.map((entry) => entry.identity).join("/");
      const instance = chain.map((entry) => `${entry.identity}@${entry.line}`).join("/");
      contexts[lineIndex] = semanticContext(
        "source-scope-chain",
        identity,
        instance,
        lineIndex,
        lines,
        chain.at(-1).line
      );
    }
    stack.push(...declarations);
    depth += braceDelta(line);
  }
  return contexts;
}

function scopeDeclarations(line, depth, lineIndex) {
  const declarations = [];
  const patterns = [
    { pattern: /\b(module|namespace|class|function)\s+([A-Za-z_$][\w$]*)[^\n{]*\{/gu, identity: (match) => `${match[1]}:${match[2]}` },
    { pattern: /\b(const|let|var)\s+([A-Za-z_$][\w$]*)[^\n=]*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gu, identity: (match) => `function:${match[2]}` },
    { pattern: /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(constructor|[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{;]*\{/gu, identity: (match) => `method:${match[1]}` },
  ];
  for (const { pattern, identity } of patterns) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      const opening = line.indexOf("{", match.index);
      const bodyDepth = depth + braceDelta(line.slice(0, opening + 1));
      declarations.push({ identity: identity(match), line: lineIndex, opening, bodyDepth });
    }
  }
  return declarations.sort((left, right) => left.opening - right.opening);
}

function sanitizeStructuralLines(lines) {
  let blockComment = false;
  return lines.map((line) => {
    let quote = null;
    let escaped = false;
    let result = "";
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const next = line[index + 1];
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          result += "  ";
          index += 1;
        } else result += " ";
        continue;
      }
      if (quote) {
        result += " ";
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        result += "  ";
        index += 1;
      } else if (character === "/" && next === "/") {
        result += " ".repeat(line.length - index);
        break;
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
        result += " ";
      } else result += character;
    }
    return result;
  });
}

function braceDelta(value) {
  let delta = 0;
  for (const character of value) {
    if (character === "{") delta += 1;
    else if (character === "}") delta -= 1;
  }
  return delta;
}

function collisionCandidateSha256(lines, lineIndex, scopeStartLine) {
  const start = Math.max(0, Math.min(scopeStartLine, lineIndex));
  return sha256(lines.slice(start).map((line) => line.trimEnd()).join("\n"));
}

function nearestContextLine(lines, lineIndex, direction) {
  for (let index = lineIndex + direction; index >= 0 && index < lines.length; index += direction) {
    const line = lines[index].trim();
    if (!line) return null;
    if (/^#{1,6}\s/u.test(line) || declarationLineIdentity(line) || /^\s*["']?[^"':]+["']?\s*:/u.test(line)) {
      return null;
    }
    return line;
  }
  return null;
}

function declarationLineIdentity(line) {
  return /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var|namespace|module)\s+[A-Za-z_$][\w$]*/u.test(
    line
  );
}

function sourceLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function parseJsonAst(source) {
  let offset = 0;
  const whitespace = () => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const string = () => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset++] === '"') break;
    }
    const raw = source.slice(start, offset);
    return { type: "string", start, end: offset, value: JSON.parse(raw) };
  };
  const value = () => {
    whitespace();
    const start = offset;
    if (source[offset] === '"') return string();
    if (source[offset] === "{") {
      offset += 1;
      const properties = [];
      whitespace();
      while (offset < source.length && source[offset] !== "}") {
        const key = string();
        whitespace();
        if (source[offset++] !== ":") throw new Error("invalid JSON object");
        const child = value();
        properties.push({ key, value: child });
        whitespace();
        if (source[offset] === ",") {
          offset += 1;
          whitespace();
        } else break;
      }
      if (source[offset++] !== "}") throw new Error("invalid JSON object");
      return { type: "object", start, end: offset, properties };
    }
    if (source[offset] === "[") {
      offset += 1;
      const items = [];
      whitespace();
      while (offset < source.length && source[offset] !== "]") {
        items.push(value());
        whitespace();
        if (source[offset] === ",") {
          offset += 1;
          whitespace();
        } else break;
      }
      if (source[offset++] !== "]") throw new Error("invalid JSON array");
      return { type: "array", start, end: offset, items };
    }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) offset += 1;
    const raw = source.slice(start, offset);
    return { type: "primitive", start, end: offset, value: JSON.parse(raw) };
  };
  try {
    const root = value();
    whitespace();
    return offset === source.length ? root : null;
  } catch {
    return null;
  }
}

function jsonContextAt(node, offset, path) {
  if (offset < node.start || offset >= node.end) return null;
  if (node.type === "object") {
    for (const property of node.properties) {
      const nextPath = [...path, property.key.value];
      if (offset >= property.key.start && offset < property.key.end) {
        return { path: nextPath, instance: `${nextPath.join("/")}@${node.start}` };
      }
      const child = jsonContextAt(property.value, offset, nextPath);
      if (child) return child;
    }
  } else if (node.type === "array") {
    for (const [index, item] of node.items.entries()) {
      const segment = jsonArrayItemIdentity(item, index);
      const child = jsonContextAt(item, offset, [...path, segment]);
      if (child) return child;
    }
  }
  return { path, instance: `${path.join("/")}@${node.start}` };
}

function jsonArrayItemIdentity(node, index) {
  if (node.type === "object") {
    const candidates = ["id", "name", "key", "slug", "title", "type", "provider"];
    for (const candidate of candidates) {
      const property = node.properties.find((entry) => entry.key.value === candidate);
      if (property && ["string", "primitive"].includes(property.value.type)) {
        return `[${candidate}=${String(property.value.value)}]`;
      }
    }
  }
  return `[#${index}]`;
}

export function findForbiddenVocabulary(source, path, kind = "content") {
  const findings = [];
  const lines = source.split(/\r?\n/u);
  const resolveSemanticContext = createSemanticContextResolver(source, lines, path, kind);
  for (const [lineIndex, line] of lines.entries()) {
    const lineFindings = [];
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        const context = resolveSemanticContext(lineIndex, match.index);
        lineFindings.push({
          path,
          line: lineIndex + 1,
          column: match.index + 1,
          end: match.index + match[0].length,
          rule: rule.id,
          match: match[0],
          matchedText: match[0],
          sourceLine: line,
          localContextSha256: localContextSha256(line, match.index, match.index + match[0].length),
          semanticContextKind: context.kind,
          semanticContextSha256: context.sha256,
          semanticScopeIdentity: context.identity,
          semanticScopeInstance: context.instance,
          collisionCandidateSha256: context.collisionCandidateSha256,
          replacement: rule.replacement,
          kind,
        });
      }
    }

    // The dedicated secret rule is more actionable than also reporting the
    // embedded "TRIGGER" substring as a second violation.
    for (const finding of lineFindings) {
      if (
        finding.rule === "trigger" &&
        lineFindings.some(
          (other) =>
            specificRuleIds.has(other.rule) &&
            other.column <= finding.column &&
            other.end >= finding.end
        )
      ) {
        continue;
      }
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * Walk the tracked tree and collect every finding, with collision anchors
 * already applied. Deliberately free of manifest coupling so the manifest
 * generator can scan a tree whose manifest is mid-regeneration (and therefore
 * temporarily inconsistent) without tripping the manifest's own validators.
 *
 * `scanRepository` delegates here so both paths observe one implementation.
 */
export function collectFindings(root, excludedPaths = new Set(), knownTrackedFiles) {
  const trackedFiles =
    knownTrackedFiles ?? listRepositoryFiles(root).filter((path) => existsSync(join(root, path)));
  const excludedFiles = trackedFiles.filter((path) => excludedPaths.has(path));
  const textByPath = new Map();
  const binaryFiles = [];
  for (const path of trackedFiles) {
    if (excludedPaths.has(path)) continue;
    const source = decodeTextFile(join(root, path));
    if (source === null) binaryFiles.push(path);
    else textByPath.set(path, source);
  }
  const files = [...textByPath.keys()];
  const findings = files.flatMap((path) => [
    ...findForbiddenVocabulary(path, path, "path"),
    ...findForbiddenVocabulary(textByPath.get(path), path),
  ]);
  const collisionErrors = applyCollisionAnchors(findings);
  return { trackedFiles, excludedFiles, binaryFiles, files, findings, collisionErrors, textByPath };
}

export function scanRepository(root, manifest, options = {}) {
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) return { files: [], findings: [], violations: [], manifestErrors, exceptionDrift: [] };

  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  for (const [index, exception] of manifest.exceptions.entries()) {
    if (exception.classification === "migration-debt" && exception.expiresOn < today) {
      manifestErrors.push(
        `exceptions[${index}] expired on ${exception.expiresOn} (${exception.path}:${exception.line}:${exception.column}, ${exception.trackingIssue})`
      );
    }
  }
  if (manifestErrors.length) return { files: [], findings: [], violations: [], manifestErrors, exceptionDrift: [] };

  const trackedFiles = listRepositoryFiles(root).filter((path) => existsSync(join(root, path)));
  const trackedPathSet = new Set(trackedFiles);
  for (const exclusion of manifest.exclusions) {
    if (!trackedPathSet.has(exclusion.path)) {
      manifestErrors.push(`stale exact exclusion: ${exclusion.path}`);
    }
  }
  if (manifestErrors.length) {
    return { trackedFiles, files: [], findings: [], violations: [], manifestErrors, exceptionDrift: [] };
  }
  const excludedPaths = new Set(manifest.exclusions.map((exclusion) => exclusion.path));
  const scan = collectFindings(root, excludedPaths, trackedFiles);
  const { excludedFiles, binaryFiles, files, findings } = scan;
  manifestErrors.push(...scan.collisionErrors);
  manifestErrors.push(...validateCollisionAnchors(findings, manifest.exceptions));
  if (manifestErrors.length) {
    return {
      trackedFiles,
      files,
      binaryFiles,
      excludedFiles,
      findings,
      violations: [],
      manifestErrors,
      exceptionDrift: [],
    };
  }
  const exceptions = manifest.exceptions.map((exception, index) => ({ ...exception, index, used: false }));
  const exceptionsByAnchor = new Map();
  for (const exception of exceptions) {
    const key = anchorKey(exception);
    const bucket = exceptionsByAnchor.get(key) ?? [];
    bucket.push(exception);
    exceptionsByAnchor.set(key, bucket);
  }
  const violations = [];

  for (const finding of findings) {
    const exception = (exceptionsByAnchor.get(anchorKey(finding)) ?? []).find((candidate) => !candidate.used);
    if (exception) exception.used = true;
    else violations.push(finding);
  }

  const exceptionDrift = exceptions
    .filter((exception) => !exception.used)
    .map((exception) => ({ ...exception }))
    .sort((left, right) => left.index - right.index);
  return {
    trackedFiles,
    files,
    binaryFiles,
    excludedFiles,
    findings,
    // Carried so the regeneration pass can reuse this walk instead of
    // repeating it; the receipt fingerprints the scanned text from here.
    textByPath: scan.textByPath,
    violations,
    manifestErrors,
    exceptionDrift,
  };
}

export function anchorKey(entry) {
  return `${baseAnchorKey(entry)}\0${entry.collisionContextSha256 ?? ""}`;
}

export function baseAnchorKey(entry) {
  // Normalized here, not just in identity.mjs. Without this the two spellings
  // of one path disagree, and the failure mode is a deadlock: the gate rejects
  // the entry, --write reports success and changes nothing, and the gate
  // rejects it again with no actionable message.
  const path = normalizeRepositoryPath(entry.path ?? "");
  return `${path}\0${entry.rule}\0${entry.matchedText}\0${entry.localContextSha256}\0${entry.semanticContextKind}\0${entry.semanticContextSha256}`;
}

export function applyCollisionAnchors(findings) {
  const errors = [];
  const findingsByFingerprint = new Map();
  for (const finding of findings) {
    const key = baseAnchorKey(finding);
    const bucket = findingsByFingerprint.get(key) ?? [];
    bucket.push(finding);
    findingsByFingerprint.set(key, bucket);
  }
  for (const bucket of findingsByFingerprint.values()) {
    const instances = new Set(bucket.map((finding) => finding.semanticScopeInstance));
    if (instances.size < 2) continue;

    const instancesByCandidate = new Map();
    for (const finding of bucket) {
      const candidateInstances = instancesByCandidate.get(finding.collisionCandidateSha256) ?? new Set();
      candidateInstances.add(finding.semanticScopeInstance);
      instancesByCandidate.set(finding.collisionCandidateSha256, candidateInstances);
    }
    if ([...instancesByCandidate.values()].some((candidateInstances) => candidateInstances.size > 1)) {
      const finding = bucket[0];
      errors.push(
        `unresolved fingerprint collision across distinct semantic scopes at ${finding.path} [${finding.rule}] "${finding.matchedText}"; add a stable named scope/object identity or a stronger anchor`
      );
      continue;
    }
    for (const finding of bucket) finding.collisionContextSha256 = finding.collisionCandidateSha256;
  }
  return errors;
}

function validateCollisionAnchors(findings, exceptions) {
  const errors = [];
  const candidatesByBaseAnchor = new Map();
  for (const finding of findings) {
    if (!finding.collisionContextSha256) continue;
    const candidates = candidatesByBaseAnchor.get(baseAnchorKey(finding)) ?? new Set();
    candidates.add(finding.collisionContextSha256);
    candidatesByBaseAnchor.set(baseAnchorKey(finding), candidates);
  }
  for (const [index, exception] of exceptions.entries()) {
    const candidates = candidatesByBaseAnchor.get(baseAnchorKey(exception));
    if (!candidates) continue;
    if (!exception.collisionContextSha256) {
      errors.push(`exceptions[${index}].collisionContextSha256 is required for a cross-scope fingerprint collision`);
    } else if (!candidates.has(exception.collisionContextSha256)) {
      errors.push(`exceptions[${index}].collisionContextSha256 does not match a current semantic scope`);
    }
  }
  return errors;
}

export function formatReport(result, manifestPath = defaultManifestPath) {
  const lines = [
    `vocabulary-boundary: scanned ${result.files.length} textual files (${result.binaryFiles?.length ?? 0} binary, ${result.excludedFiles?.length ?? 0} exact exclusions)`,
  ];
  for (const error of result.manifestErrors) lines.push(`MANIFEST: ${error}`);
  for (const finding of result.violations) {
    lines.push(
      `${finding.path}:${finding.line}:${finding.column} [${finding.rule}] forbidden "${finding.match}"`,
      `  ${finding.kind === "path" ? "path: " : ""}${finding.sourceLine.trim()}`,
      `  Fix: ${finding.kind === "path" ? "Rename the product-owned path. " : ""}${finding.replacement}`,
      `  If this is vendor-owned, add one exact path + rule + matchedText + local/semantic context exception to ${manifestPath}; include lifecycle metadata.`
    );
  }
  for (const exception of result.exceptionDrift) {
    lines.push(
      `${manifestPath}: exception drift for ${exception.path}:${exception.line}:${exception.column} [${exception.rule}] match "${exception.matchedText}"`,
      "  Fix: remove a stale exception or review the changed local/semantic context; line and column are diagnostics only."
    );
  }
  if (!result.manifestErrors.length && !result.violations.length && !result.exceptionDrift.length) {
    lines.push(`ok: ${result.findings.length} reviewed findings match exact manifest exceptions`);
  }
  return lines.join("\n");
}

const VALUE_FLAGS = ["manifest", "since", "ledger", "receipt"];
const BOOLEAN_FLAGS = ["write", "check", "help"];

/**
 * Parse argv accepting both `--flag=value` and `--flag value`, and reject
 * anything unrecognised. Silently ignoring `--since <rev>` meant the committed
 * move workflow appeared to run and quietly did nothing.
 */
export function parseCliOptions(argv) {
  const values = new Map();
  const flags = new Set();
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      errors.push(`unexpected argument: ${entry}`);
      continue;
    }
    const separator = entry.indexOf("=");
    const name = (separator === -1 ? entry.slice(2) : entry.slice(2, separator)).trim();
    if (VALUE_FLAGS.includes(name)) {
      const inline = separator === -1 ? undefined : entry.slice(separator + 1);
      const value = inline ?? argv[++index];
      if (value === undefined || value.startsWith("--")) errors.push(`--${name} requires a value`);
      else values.set(name, value);
    } else if (BOOLEAN_FLAGS.includes(name)) {
      if (separator !== -1) errors.push(`--${name} does not take a value`);
      flags.add(name);
    } else {
      errors.push(`unknown option: --${name}`);
    }
  }
  return {
    manifestPath: values.get("manifest") ?? defaultManifestPath,
    revision: values.get("since") ?? "HEAD",
    ledgerPath: values.get("ledger"),
    receiptPath: values.get("receipt"),
    write: flags.has("write"),
    check: flags.has("check"),
    help: flags.has("help"),
    errors,
  };
}

const USAGE = [
  "usage: node scripts/vocabulary-boundary.mjs [--check | --write] [options]",
  "",
  "  --check              read-only; classify the regeneration diff and print the receipt",
  "  --write              apply relocations and resolved exceptions; refuses anything needing review",
  "  --since <revision>   revision to detect file moves against (default: HEAD plus upstream merge bases)",
  "  --manifest <path>    manifest to read (default: docs/vocabulary-boundary-exceptions.json)",
  "  --ledger <path>      verify repository ledger dispositions against the boundary evidence",
  "  --receipt <path>     also write the receipt as JSON to this path",
  "",
  "With no mode flag the gate runs read-only and still fails on an out-of-date manifest.",
].join("\n");

const REFUSAL_EXPLANATION = [
  "  --write may remove a resolved exception, relocate one whose reviewed context is",
  "  unchanged, and rebind a path anchor only when the destination carries exactly the",
  "  same forbidden words in the same path segments. It never approves an occurrence",
  "  nobody has reviewed, and it never relocates an exclusion, because an exclusion",
  "  suppresses an entire file.",
].join("\n");

async function loadLedger(options, result) {
  const { existsSync } = await import("node:fs");
  const absolute = resolve(repositoryRoot, options.ledgerPath);
  if (!existsSync(absolute)) {
    console.log(`LEDGER: no such file: ${options.ledgerPath}`);
    process.exitCode = 1;
    return;
  }
  const { readLedger, verifyLedger, formatLedgerReport } = await import("./vocabulary/ledger.mjs");
  let parsed;
  try {
    parsed = readLedger(absolute);
  } catch (error) {
    console.log(`LEDGER: cannot read ${options.ledgerPath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  for (const error of parsed.errors) console.log(`LEDGER: ${error}`);
  const verdict = verifyLedger({
    ledger: parsed.ledger,
    entries: result.entries,
    moves: result.moves,
    trackedPaths: result.trackedSet,
  });
  console.log(formatLedgerReport(verdict));
  if (parsed.errors.length || verdict.blocked.length) process.exitCode = 1;
}

async function runWrite(options) {
  const { regenerate, formatClassification } = await import("./vocabulary/generate.mjs");
  const { formatReceipt } = await import("./vocabulary/receipt.mjs");
  const { writeFileSync } = await import("node:fs");
  const absoluteManifestPath = resolve(repositoryRoot, options.manifestPath);
  const result = regenerate(repositoryRoot, {
    manifestPath: absoluteManifestPath,
    manifestLabel: options.manifestPath,
    revision: options.revision,
  });
  console.log(formatClassification(result, options.manifestPath));

  if (result.reviewRequired.length) {
    console.log(
      result.reviewRequired.length === 1
        ? "refusing to write: 1 entry needs human review."
        : `refusing to write: ${result.reviewRequired.length} entries need human review.`
    );
    console.log(REFUSAL_EXPLANATION);
    process.exitCode = 1;
    return result;
  }

  // Never hand back a manifest this tool's own gate would reject. Without this
  // the tool can tell you to commit something that fails CI on a rule the
  // author never touched.
  const { validateRegeneratedManifest } = await import("./vocabulary/generate.mjs");
  const gate = validateRegeneratedManifest(repositoryRoot, result.nextManifest);
  if (!gate.ok) {
    console.log("refusing to write: the regenerated manifest does not pass the gate.");
    for (const error of gate.errors.slice(0, 20)) console.log(`  ${error}`);
    if (gate.errors.length > 20) console.log(`  ...and ${gate.errors.length - 20} more`);
    console.log("  A relocation rewrote a path that a lifecycle rule constrains. Resolve by hand.");
    process.exitCode = 1;
    return result;
  }

  writeFileSync(absoluteManifestPath, result.manifestText);
  console.log(`wrote ${options.manifestPath}`);
  console.log(formatReceipt(result.receipt));
  if (options.receiptPath) {
    writeFileSync(resolve(repositoryRoot, options.receiptPath), `${JSON.stringify(result.receipt, null, 2)}\n`);
  }
  if (options.ledgerPath) await loadLedger(options, result);
  return result;
}

async function runCli() {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.errors.length) {
    for (const error of options.errors) console.log(`argument error: ${error}`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.write) {
    await runWrite(options);
    return;
  }

  const { regenerate, formatClassification } = await import("./vocabulary/generate.mjs");
  const { formatReceipt } = await import("./vocabulary/receipt.mjs");
  const absoluteManifestPath = resolve(repositoryRoot, options.manifestPath);
  const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
  const result = scanRepository(repositoryRoot, manifest);
  console.log(formatReport(result, options.manifestPath));
  const failed =
    result.manifestErrors.length || result.violations.length || result.exceptionDrift.length;
  if (failed) process.exitCode = 1;

  // The default invocation is check-only: an out-of-date manifest and anything
  // awaiting review fail the gate too, so CI does not need a separate command.
  // Reuse the walk the gate just did so a check costs one tree scan, not two.
  const regeneration = regenerate(repositoryRoot, {
    manifestPath: absoluteManifestPath,
    manifestLabel: options.manifestPath,
    revision: options.revision,
    scan: result.manifestErrors.length ? undefined : result,
  });
  const classification = formatClassification(regeneration, options.manifestPath);
  const quiet =
    !options.check &&
    !failed &&
    regeneration.reviewRequired.length === 0 &&
    regeneration.manifestText === readFileSync(absoluteManifestPath, "utf8");
  if (!quiet) console.log(classification);
  if (options.check) console.log(formatReceipt(regeneration.receipt));

  if (regeneration.reviewRequired.length) process.exitCode = 1;
  // An up-to-date manifest is part of the gate: relocations and resolved
  // exceptions must be committed, not left for the next person to rediscover.
  if (regeneration.manifestText !== readFileSync(absoluteManifestPath, "utf8")) {
    console.log(`${options.manifestPath} is out of date; run with --write and commit the result.`);
    process.exitCode = 1;
  }
  if (options.ledgerPath) await loadLedger(options, regeneration);
}

// Not a top-level await: `./vocabulary/generate.mjs` imports this module back,
// and an unfinished top-level await here would deadlock that cycle.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
