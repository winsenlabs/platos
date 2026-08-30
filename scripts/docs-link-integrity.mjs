#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const DOCS_ROOT = "docs";
const CONTENT_ROOTS = ["content/docs", "content/guides"];
const DESIGN_ROOT = "design/platos-ui-refactor";
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const DESIGN_SOURCE_EXTENSIONS = new Set([".html", ".css", ".js"]);
const PAGE_SUFFIXES = [".mdx", ".md", "/index.mdx", "/index.md"];
const GENERATED_DIRECTORIES = new Set([
  ".mintlify",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const GENERATED_FILES = /(?:^|\/)(?:\.DS_Store|.*(?:\.cache|\.map|\.swp|\.tmp|~))$/u;
const EXTERNAL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export const REQUIRED_MINIMUMS = Object.freeze({
  docsMarkdownFiles: 350,
  contentMarkdownFiles: 80,
  navigationLeaves: 240,
  snippetImports: 150,
  rootAssets: 75,
  relativeLinks: 50,
  anchorReferences: 50,
  contentInternalLinks: 200,
  designSourceFiles: 50,
  designReferences: 450,
  redirects: 30,
});

function toRepoPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/") || ".";
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function addError(errors, message) {
  if (!errors.includes(message)) errors.push(message);
}

function isInside(boundary, candidate) {
  const rel = relative(boundary, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function scanSourceTree(root, relativeRoot, errors) {
  const absoluteRoot = resolve(root, relativeRoot);
  if (!existsSync(absoluteRoot)) {
    addError(errors, `${relativeRoot}: required source corpus is missing`);
    return [];
  }

  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      addError(errors, `${toRepoPath(root, directory)}: cannot enumerate source corpus (${error.message})`);
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name);
      const repoPath = toRepoPath(root, absolutePath);
      let stat;
      try {
        stat = lstatSync(absolutePath);
      } catch (error) {
        addError(errors, `${repoPath}: cannot inspect source entry (${error.message})`);
        continue;
      }

      if (stat.isSymbolicLink()) {
        if (!existsSync(absolutePath)) addError(errors, `${repoPath}: dangling symlink is forbidden in a source corpus`);
        else addError(errors, `${repoPath}: symlinks are forbidden in a source corpus`);
        continue;
      }

      if (stat.isDirectory()) {
        if (GENERATED_DIRECTORIES.has(entry.name)) {
          if (entry.name === "node_modules") continue;
          addError(errors, `${repoPath}: generated artifact directory is forbidden in a source corpus`);
          continue;
        }
        visit(absolutePath);
        continue;
      }

      if (!stat.isFile()) {
        addError(errors, `${repoPath}: unsupported filesystem entry in source corpus`);
        continue;
      }
      if (GENERATED_FILES.test(repoPath)) {
        addError(errors, `${repoPath}: generated artifact is forbidden in a source corpus`);
        continue;
      }
      files.push(absolutePath);
    }
  };

  visit(absoluteRoot);
  return files;
}

function maskFencedCode(source) {
  const lines = source.split(/(?<=\n)/u);
  let fence = null;
  return lines
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
      if (!fence && marker) {
        fence = { character: marker[0], length: marker.length };
        return line.replace(/[^\n]/gu, " ");
      }
      if (fence) {
        if (marker && marker[0] === fence.character && marker.length >= fence.length) fence = null;
        return line.replace(/[^\n]/gu, " ");
      }
      return line;
    })
    .join("");
}

function maskInlineCode(source) {
  return source.replace(/(`+)(?!`)([^\n]*?)\1/gu, (match) => match.replace(/[^\n]/gu, " "));
}

function markdownDestinations(source) {
  const destinations = [];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== "]" || source[cursor + 1] !== "(") continue;
    const start = cursor + 2;
    let index = start;
    let depth = 1;
    let angle = false;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\n" && !angle) break;
      if (character === "<" && index === start) angle = true;
      if (character === ">" && angle) angle = false;
      if (!angle && character === "(") depth += 1;
      if (!angle && character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    let raw = source.slice(start, index).trim();
    if (raw.startsWith("<")) {
      const close = raw.indexOf(">");
      raw = close === -1 ? raw : raw.slice(1, close);
    } else {
      raw = raw.match(/^(?:\\.|[^\s])+/u)?.[0] ?? raw;
    }
    const labelStart = source.lastIndexOf("[", cursor);
    const kind = labelStart > 0 && source[labelStart - 1] === "!" ? "asset" : "route";
    if (raw) destinations.push({ value: raw.replaceAll("\\ ", " "), offset: start, kind });
    cursor = index;
  }

  const definition = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gmu;
  for (const match of source.matchAll(definition)) {
    destinations.push({ value: match[1] ?? match[2], offset: match.index ?? 0, kind: "route" });
  }
  return destinations;
}

function skipQuoted(source, start, end = source.length) {
  const quote = source[start];
  let cursor = start + 1;
  for (; cursor < end; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
  }
  return null;
}

function matchingBrace(source, start, end) {
  let depth = 1;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    if (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === "`") {
      const next = skipQuoted(source, cursor, end);
      if (next === null) return null;
      cursor = next - 1;
      continue;
    }
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return null;
}

function parseMdxAttributes(source, start, end) {
  const attributes = [];
  let cursor = start;
  while (cursor < end) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= end || source[cursor] === "/") break;
    if (source[cursor] === "{") {
      const close = matchingBrace(source, cursor, end);
      if (close === null) break;
      cursor = close + 1;
      continue;
    }
    const nameMatch = source.slice(cursor, end).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/u);
    if (!nameMatch) {
      cursor += 1;
      continue;
    }
    const name = nameMatch[0];
    const offset = cursor;
    cursor += name.length;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") {
      attributes.push({ name, offset, type: "boolean" });
      continue;
    }
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === '"' || source[cursor] === "'") {
      const next = skipQuoted(source, cursor, end);
      if (next === null) {
        attributes.push({ name, offset, type: "unprovable" });
        break;
      }
      attributes.push({ name, offset, type: "quoted", value: source.slice(cursor + 1, next - 1) });
      cursor = next;
      continue;
    }
    if (source[cursor] === "{") {
      const close = matchingBrace(source, cursor, end);
      if (close === null) {
        attributes.push({ name, offset, type: "unprovable" });
        break;
      }
      attributes.push({
        name,
        offset,
        type: "expression",
        expression: source.slice(cursor + 1, close),
        expressionOffset: cursor + 1,
      });
      cursor = close + 1;
      continue;
    }
    attributes.push({ name, offset, type: "unprovable" });
    while (cursor < end && !/\s/u.test(source[cursor])) cursor += 1;
  }
  return attributes;
}

function parseMdxTag(source, start, end = source.length) {
  let cursor = start + 1;
  let closing = false;
  if (source[cursor] === "/") {
    closing = true;
    cursor += 1;
  }
  const nameMatch = source.slice(cursor, end).match(/^[A-Za-z_$][A-Za-z0-9_$.-]*/u);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  cursor += name.length;
  const attributesStart = cursor;
  let expressionDepth = 0;
  for (; cursor < end; cursor += 1) {
    if (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === "`") {
      const next = skipQuoted(source, cursor, end);
      if (next === null) return null;
      cursor = next - 1;
      continue;
    }
    if (source[cursor] === "{") expressionDepth += 1;
    if (source[cursor] === "}") expressionDepth -= 1;
    if (source[cursor] === ">" && expressionDepth === 0) {
      const beforeClose = source.slice(attributesStart, cursor).trimEnd();
      return {
        name,
        start,
        end: cursor + 1,
        closing,
        selfClosing: !closing && beforeClose.endsWith("/"),
        attributes: closing ? [] : parseMdxAttributes(source, attributesStart, cursor),
      };
    }
  }
  return null;
}

function scanMdxTags(
  source,
  start = 0,
  end = source.length,
  initialExpressionDepth = 0,
  failures = [],
) {
  const tags = [];
  let expressionDepth = initialExpressionDepth;
  for (let cursor = start; cursor < end; cursor += 1) {
    if (
      expressionDepth > 0 &&
      (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === "`")
    ) {
      const next = skipQuoted(source, cursor, end);
      if (next === null) break;
      cursor = next - 1;
      continue;
    }
    if (source[cursor] === "{") {
      expressionDepth += 1;
      continue;
    }
    if (source[cursor] === "}" && expressionDepth > 0) {
      expressionDepth -= 1;
      continue;
    }
    if (source[cursor] !== "<") continue;
    const tag = parseMdxTag(source, cursor, end);
    if (!tag) {
      const candidate = source.slice(cursor + 1, end).match(/^\/?([A-Za-z_$][A-Za-z0-9_$.-]*)/u);
      if (candidate) failures.push({ name: candidate[1], offset: cursor });
      continue;
    }
    tag.expressionDepth = expressionDepth;
    tags.push(tag);
    for (const attribute of tag.attributes) {
      if (attribute.type !== "expression") continue;
      tags.push(
        ...scanMdxTags(
          source,
          attribute.expressionOffset,
          attribute.expressionOffset + attribute.expression.length,
          expressionDepth + 1,
          failures,
        )
      );
    }
    cursor = tag.end - 1;
  }
  return tags.sort((left, right) => left.start - right.start);
}

function staticExpressionString(expression) {
  const value = expression.trim();
  if (value.length < 2 || (value[0] !== '"' && value[0] !== "'") || value.at(-1) !== value[0])
    return null;
  let decoded = "";
  for (let cursor = 1; cursor < value.length - 1; cursor += 1) {
    if (value[cursor] !== "\\") {
      decoded += value[cursor];
      continue;
    }
    cursor += 1;
    if (cursor >= value.length - 1) return null;
    const escaped = value[cursor];
    const escapes = { "\\": "\\", '"': '"', "'": "'", n: "\n", r: "\r", t: "\t" };
    if (!(escaped in escapes)) return null;
    decoded += escapes[escaped];
  }
  return decoded;
}

function mdxAttributeDestinations(source, sourcePath, errors) {
  const results = [];
  const failures = [];
  const tags = scanMdxTags(source, 0, source.length, 0, failures);
  for (const failure of failures) {
    const remainder = source.slice(failure.offset, failure.offset + 1000);
    for (const match of remainder.matchAll(/\b(href|src)\s*=/gu)) {
      addError(
        errors,
        `${sourcePath}:${lineAt(source, failure.offset + (match.index ?? 0))}: cannot structurally parse MDX ${match[1]} attribute`,
      );
    }
  }
  for (const tag of tags) {
    if (tag.closing) continue;
    for (const attribute of tag.attributes) {
      if (attribute.name !== "href" && attribute.name !== "src") continue;
      let value = null;
      if (attribute.type === "quoted") value = attribute.value;
      if (attribute.type === "expression") value = staticExpressionString(attribute.expression);
      if (value === null) {
        addError(
          errors,
          `${sourcePath}:${lineAt(source, attribute.offset)}: cannot prove static MDX ${
            attribute.name
          } attribute`
        );
        continue;
      }
      results.push({
        value,
        offset: attribute.offset,
        kind: attribute.name === "src" ? "asset" : "route",
      });
    }
  }
  return results;
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseLocalReference(rawValue, sourcePath, errors) {
  const value = decodeHtmlEntities(rawValue.trim());
  if (!value || value.startsWith("//") || EXTERNAL_SCHEME.test(value)) return null;
  if (value.includes("\\") || value.includes("\0")) {
    addError(errors, `${sourcePath}: unsafe link path ${JSON.stringify(value)}`);
    return { invalid: true };
  }

  const hashIndex = value.indexOf("#");
  const queryIndex = value.indexOf("?");
  const pathEnd = Math.min(
    hashIndex === -1 ? value.length : hashIndex,
    queryIndex === -1 ? value.length : queryIndex,
  );
  const rawPath = value.slice(0, pathEnd);
  const rawQuery = queryIndex === -1
    ? ""
    : value.slice(queryIndex + 1, hashIndex !== -1 && hashIndex > queryIndex ? hashIndex : value.length);
  const rawFragment = hashIndex === -1 ? null : value.slice(hashIndex + 1);

  try {
    const decodedPath = decodeURIComponent(rawPath);
    const query = decodeURIComponent(rawQuery);
    const fragment = rawFragment === null ? null : decodeURIComponent(rawFragment);
    const rootSegments = decodedPath.startsWith("/") ? decodedPath.split("/") : [];
    if (
      decodedPath.includes("\\") ||
      decodedPath.includes("\0") ||
      fragment?.includes("\0") ||
      rootSegments.includes(".") ||
      rootSegments.includes("..")
    ) {
      addError(errors, `${sourcePath}: unsafe encoded or traversing link path ${JSON.stringify(value)}`);
      return { invalid: true };
    }
    return { value, path: decodedPath, query, fragment };
  } catch {
    addError(errors, `${sourcePath}: malformed URL encoding in ${JSON.stringify(value)}`);
    return { invalid: true };
  }
}

function hasSymlinkOnPath(boundary, candidate) {
  if (!isInside(boundary, candidate)) return false;
  const rel = relative(boundary, candidate);
  let cursor = boundary;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) return false;
    if (lstatSync(cursor).isSymbolicLink()) return true;
  }
  return false;
}

function resolveExactTarget(root, boundary, candidate, sourcePath, displayValue, errors, { page = false } = {}) {
  if (!isInside(boundary, candidate)) {
    addError(errors, `${sourcePath}: path traversal escapes ${toRepoPath(root, boundary)} in ${JSON.stringify(displayValue)}`);
    return null;
  }
  if (hasSymlinkOnPath(boundary, candidate)) {
    addError(errors, `${sourcePath}: link traverses a symlink in ${JSON.stringify(displayValue)}`);
    return null;
  }

  const candidates = page
    ? [candidate, ...PAGE_SUFFIXES.map((suffix) => resolve(`${candidate}${suffix}`))]
    : [candidate];
  const matches = candidates.filter((target, index) => {
    if (index === 0 && page && extname(target) === "" && existsSync(target) && lstatSync(target).isDirectory()) return false;
    return existsSync(target) && lstatSync(target).isFile();
  });
  if (matches.length > 1) {
    addError(errors, `${sourcePath}: ambiguous target ${JSON.stringify(displayValue)} resolves to multiple files`);
    return null;
  }
  if (matches.length === 0) {
    addError(errors, `${sourcePath}: missing case-sensitive target ${JSON.stringify(displayValue)}`);
    return null;
  }
  return matches[0];
}

function cleanHeadingText(value) {
  return decodeHtmlEntities(value)
    .replace(/\{#[A-Za-z][A-Za-z0-9_.:-]*\}\s*$/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .trim();
}

function headingSlug(value) {
  return cleanHeadingText(value)
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]/gu, "-");
}

function frontmatterTitle(source) {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u)?.[1];
  const rawTitle = frontmatter?.match(/^title\s*:\s*(.+?)\s*$/mu)?.[1];
  if (!rawTitle) return null;
  if (
    (rawTitle.startsWith('"') && rawTitle.endsWith('"')) ||
    (rawTitle.startsWith("'") && rawTitle.endsWith("'"))
  ) {
    return rawTitle.slice(1, -1);
  }
  return rawTitle;
}

function maskMdxComments(source) {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/gu, (match) => match.replace(/[^\n]/gu, " "));
}

function maskFrontmatter(source) {
  return source.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, (match) => match.replace(/[^\n]/gu, " "));
}

function defaultMdxImports(source) {
  const imports = [];
  const pattern = /^\s*import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+(["'])([^"'\n]+)\2\s*;?\s*$/gmu;
  for (const match of source.matchAll(pattern)) {
    imports.push({ binding: match[1], value: match[3], offset: match.index ?? 0 });
  }
  return imports;
}

function hasProvableJsxClose(tags, index) {
  const opening = tags[index];
  let depth = 1;
  for (let cursor = index + 1; cursor < tags.length; cursor += 1) {
    const candidate = tags[cursor];
    if (candidate.expressionDepth !== opening.expressionDepth || candidate.name !== opening.name)
      continue;
    if (candidate.closing) depth -= 1;
    else if (!candidate.selfClosing) depth += 1;
    if (depth === 0) return true;
  }
  return false;
}

function renderStructureFor(root, docsRoot, filePath, errors, anchorCache) {
  if (anchorCache.structures.has(filePath)) return anchorCache.structures.get(filePath);
  const rawSource = readFileSync(filePath, "utf8");
  const headingSource = maskFrontmatter(maskMdxComments(maskFencedCode(rawSource)));
  const source = maskInlineCode(headingSource);
  const sourcePath = toRepoPath(root, filePath);
  const bindings = new Map();
  const parsedImports = defaultMdxImports(source);
  const parsedOffsets = new Set(parsedImports.map((imported) => imported.offset));

  for (const imported of moduleImports(source)) {
    if (
      (!imported.value.startsWith(".") && !imported.value.startsWith("/")) ||
      !MARKDOWN_EXTENSIONS.has(extname(imported.value).toLowerCase())
    ) continue;
    if (!parsedOffsets.has(imported.offset)) {
      addError(
        errors,
        `${sourcePath}:${lineAt(source, imported.offset)}: cannot prove a render binding for local MDX import ${JSON.stringify(imported.value)}`,
      );
    }
  }

  for (const imported of parsedImports) {
    if (
      (!imported.value.startsWith(".") && !imported.value.startsWith("/")) ||
      !MARKDOWN_EXTENSIONS.has(extname(imported.value).toLowerCase())
    ) continue;
    if (bindings.has(imported.binding)) {
      addError(errors, `${sourcePath}:${lineAt(source, imported.offset)}: duplicate local MDX import binding ${imported.binding}`);
      continue;
    }
    const importedPath = imported.value.startsWith("/")
      ? resolve(docsRoot, `.${imported.value}`)
      : resolve(dirname(filePath), imported.value);
    if (
      !isInside(docsRoot, importedPath) ||
      !existsSync(importedPath) ||
      !lstatSync(importedPath).isFile() ||
      !MARKDOWN_EXTENSIONS.has(extname(importedPath).toLowerCase())
    ) continue;
    bindings.set(imported.binding, importedPath);
  }

  const events = [];
  for (const match of headingSource.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    events.push({ type: "heading", value: match[1], offset: match.index ?? 0 });
  }
  for (const match of source.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gu)) {
    events.push({ type: "anchor", value: match[1], offset: match.index ?? 0 });
  }
  const scanFailures = [];
  const tags = scanMdxTags(source, 0, source.length, 0, scanFailures);
  for (const failure of scanFailures) {
    if (!bindings.has(failure.name)) continue;
    addError(
      errors,
      `${sourcePath}:${lineAt(source, failure.offset)}: cannot structurally parse JSX render for ${failure.name}`,
    );
  }
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.closing) continue;
    const target = bindings.get(tag.name);
    if (!target) continue;
    if (tag.expressionDepth > 0) {
      addError(
        errors,
        `${sourcePath}:${lineAt(source, tag.start)}: cannot prove unconditional JSX render for ${
          tag.name
        } inside an MDX expression`
      );
      continue;
    }
    if (!tag.selfClosing && !hasProvableJsxClose(tags, index)) {
      addError(
        errors,
        `${sourcePath}:${lineAt(source, tag.start)}: cannot prove JSX render boundary for ${
          tag.name
        }`
      );
      continue;
    }
    events.push({ type: "render", target, offset: tag.start });
  }
  events.sort((left, right) => left.offset - right.offset);
  const structure = { events, hasTitle: frontmatterTitle(rawSource) !== null };
  anchorCache.structures.set(filePath, structure);
  return structure;
}

function appendRenderedAnchors(root, docsRoot, filePath, errors, anchorCache, anchors, duplicates, stack) {
  if (stack.includes(filePath)) {
    addError(errors, `${toRepoPath(root, filePath)}: rendered local MDX import cycle includes ${[...stack, filePath].map((item) => toRepoPath(root, item)).join(" -> ")}`);
    return;
  }
  const structure = renderStructureFor(root, docsRoot, filePath, errors, anchorCache);
  const nextStack = [...stack, filePath];
  for (const event of structure.events) {
    if (event.type === "anchor") {
      anchors.add(event.value);
      continue;
    }
    if (event.type === "render") {
      appendRenderedAnchors(root, docsRoot, event.target, errors, anchorCache, anchors, duplicates, nextStack);
      continue;
    }
    const explicit = event.value.match(/\{#([A-Za-z][A-Za-z0-9_.:-]*)\}\s*$/u)?.[1];
    const base = explicit ?? headingSlug(event.value);
    if (!base) continue;
    const count = duplicates.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    duplicates.set(base, count + 1);
  }
}

function anchorsFor(root, docsRoot, filePath, errors, anchorCache) {
  if (anchorCache.anchors.has(filePath)) return anchorCache.anchors.get(filePath);
  const anchors = new Set();
  const duplicates = new Map();
  const structure = renderStructureFor(root, docsRoot, filePath, errors, anchorCache);
  if (structure.hasTitle) {
    anchors.add("page-title");
    duplicates.set("page-title", 1);
  }
  appendRenderedAnchors(root, docsRoot, filePath, errors, anchorCache, anchors, duplicates, []);
  anchorCache.anchors.set(filePath, anchors);
  return anchors;
}

function validateAnchor(root, docsRoot, target, fragment, sourcePath, displayValue, errors, anchorCache) {
  if (fragment === null) return;
  if (!fragment) {
    addError(errors, `${sourcePath}: empty anchor in ${JSON.stringify(displayValue)}`);
    return;
  }
  if (!MARKDOWN_EXTENSIONS.has(extname(target).toLowerCase())) return;
  if (!anchorsFor(root, docsRoot, target, errors, anchorCache).has(fragment)) {
    addError(
      errors,
      `${sourcePath}: missing case-sensitive anchor #${fragment} in ${toRepoPath(root, target)} (${JSON.stringify(displayValue)})`,
    );
  }
}

function canonicalPageRoute(docsRoot, filePath) {
  let route = `/${toRepoPath(docsRoot, filePath).replace(/\.(?:md|mdx)$/u, "")}`;
  if (route === "/index") return "/";
  if (route.endsWith("/index")) route = route.slice(0, -"/index".length);
  return route;
}

function quietPageTarget(docsRoot, candidate) {
  const candidates = [candidate, ...PAGE_SUFFIXES.map((suffix) => resolve(`${candidate}${suffix}`))];
  const matches = candidates.filter((target, index) => {
    if (index === 0 && extname(target) === "" && existsSync(target) && lstatSync(target).isDirectory()) return false;
    return isInside(docsRoot, target) && existsSync(target) && lstatSync(target).isFile();
  });
  return matches.length === 1 ? matches[0] : null;
}

function normalizedRoutePath(path) {
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/u, "") : path;
}

function dynamicRedirectMatch(pattern, path) {
  const patternSegments = normalizedRoutePath(pattern).split("/").slice(1);
  const pathSegments = normalizedRoutePath(path).split("/").slice(1);
  const values = new Map();
  let pathIndex = 0;
  for (let index = 0; index < patternSegments.length; index += 1) {
    const parameter = patternSegments[index].match(/^:([A-Za-z][A-Za-z0-9_]*)(\*)?$/u);
    if (!parameter) {
      if (pathSegments[pathIndex] !== patternSegments[index]) return null;
      pathIndex += 1;
      continue;
    }
    if (parameter[2]) {
      values.set(parameter[1], pathSegments.slice(pathIndex).join("/"));
      pathIndex = pathSegments.length;
      continue;
    }
    if (pathIndex >= pathSegments.length) return null;
    values.set(parameter[1], pathSegments[pathIndex]);
    pathIndex += 1;
  }
  return pathIndex === pathSegments.length ? values : null;
}

function substituteRedirectParameters(path, values) {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)(\*)?/gu, (_match, name) => values.get(name) ?? "");
}

function buildDocsRouteGraph(root, docsRoot, docsMarkdown, config, errors) {
  const pages = new Map();
  for (const filePath of docsMarkdown) {
    const route = canonicalPageRoute(docsRoot, filePath);
    if (pages.has(route)) {
      addError(errors, `${toRepoPath(root, filePath)}: canonical documentation route ${route} collides with ${toRepoPath(root, pages.get(route))}`);
    } else {
      pages.set(route, filePath);
    }
  }

  const aliases = new Map();
  if (config?.navigation && typeof config.navigation === "object") {
    const leaves = [];
    collectNavigationLeaves(config.navigation, "docs/docs.json:navigation", [], leaves);
    for (const leaf of leaves) {
      if (typeof leaf.value !== "string" || !leaf.value || leaf.value.startsWith("/") || extname(leaf.value) || /[?#]/u.test(leaf.value)) continue;
      const target = quietPageTarget(docsRoot, resolve(docsRoot, leaf.value));
      if (target) aliases.set(normalizedRoutePath(`/${leaf.value}`), target);
    }
  }

  const redirects = [];
  if (Array.isArray(config?.redirects)) {
    for (const redirect of config.redirects) {
      if (!redirect || typeof redirect.source !== "string" || typeof redirect.destination !== "string") continue;
      const sourceErrors = [];
      const source = parseLocalReference(redirect.source, "docs/docs.json", sourceErrors);
      if (!source || source.invalid || sourceErrors.length > 0 || !source.path.startsWith("/")) continue;
      if (EXTERNAL_SCHEME.test(redirect.destination)) {
        redirects.push({ source: normalizedRoutePath(source.path), external: true });
        continue;
      }
      const destinationErrors = [];
      const destination = parseLocalReference(redirect.destination, "docs/docs.json", destinationErrors);
      if (!destination || destination.invalid || destinationErrors.length > 0 || !destination.path.startsWith("/")) continue;
      redirects.push({
        source: normalizedRoutePath(source.path),
        destination: normalizedRoutePath(destination.path),
      });
    }
  }
  return { aliases, pages, redirects };
}

function resolveDocsRoute(path, routeGraph, seen = new Set()) {
  const route = normalizedRoutePath(path);
  if (seen.has(route)) return null;
  const nextSeen = new Set(seen).add(route);
  if (routeGraph.pages.has(route)) return { target: routeGraph.pages.get(route) };
  if (routeGraph.aliases.has(route)) return { target: routeGraph.aliases.get(route) };

  for (const redirect of routeGraph.redirects) {
    const values = dynamicRedirectMatch(redirect.source, route);
    if (values === null) continue;
    if (redirect.external) return { external: true };
    return resolveDocsRoute(substituteRedirectParameters(redirect.destination, values), routeGraph, nextSeen);
  }
  return null;
}

function collectNavigationLeaves(value, path, errors, leaves) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    addError(errors, `${path}: navigation node must be an object`);
    return;
  }
  let descended = false;
  for (const key of ["dropdowns", "tabs", "groups"]) {
    if (!(key in value)) continue;
    descended = true;
    if (!Array.isArray(value[key]) || value[key].length === 0) {
      addError(errors, `${path}.${key}: must be a non-empty array`);
      continue;
    }
    value[key].forEach((child, index) => collectNavigationLeaves(child, `${path}.${key}[${index}]`, errors, leaves));
  }
  if ("pages" in value) {
    descended = true;
    if (!Array.isArray(value.pages) || value.pages.length === 0) {
      addError(errors, `${path}.pages: must be a non-empty array`);
    } else {
      value.pages.forEach((page, index) => {
        if (typeof page === "string") leaves.push({ value: page, path: `${path}.pages[${index}]` });
        else collectNavigationLeaves(page, `${path}.pages[${index}]`, errors, leaves);
      });
    }
  }
  if (!descended && !("group" in value) && !("dropdown" in value) && !("tab" in value)) {
    addError(errors, `${path}: unrecognized navigation node`);
  }
}

function validateNavigation(root, docsRoot, config, errors, stats) {
  const leaves = [];
  collectNavigationLeaves(config.navigation, "docs/docs.json:navigation", errors, leaves);
  stats.navigationLeaves = leaves.length;
  stats.navigationUniqueLeaves = new Set(leaves.map((leaf) => leaf.value)).size;
  for (const leaf of leaves) {
    if (!leaf.value || leaf.value.startsWith("/") || extname(leaf.value) || /[?#]/u.test(leaf.value)) {
      addError(errors, `${leaf.path}: navigation leaf must be a canonical extensionless route`);
      continue;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(leaf.value);
    } catch {
      addError(errors, `${leaf.path}: malformed URL encoding in navigation leaf ${JSON.stringify(leaf.value)}`);
      continue;
    }
    if (decoded !== leaf.value || decoded.includes("\\") || decoded.split("/").includes("..")) {
      addError(errors, `${leaf.path}: unsafe encoded or traversing navigation leaf ${JSON.stringify(leaf.value)}`);
      continue;
    }
    resolveExactTarget(root, docsRoot, resolve(docsRoot, leaf.value), leaf.path, leaf.value, errors, { page: true });
  }
}

function dynamicRouteParts(path) {
  const names = [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)(?:\*)?/gu)].map((match) => match[1]);
  return { names, staticPrefix: path.replace(/:[A-Za-z][A-Za-z0-9_]*\*?.*$/u, "").replace(/\/$/u, "") };
}

function validateRedirects(root, docsRoot, config, errors, stats, anchorCache) {
  if (!("redirects" in config)) {
    stats.redirects = 0;
    return;
  }
  if (!Array.isArray(config.redirects)) {
    addError(errors, "docs/docs.json: redirects must be an array when present");
    stats.redirects = 0;
    return;
  }
  stats.redirects = config.redirects.length;
  const sources = new Set();
  const staticMappings = new Map();
  config.redirects.forEach((redirect, index) => {
    const sourcePath = `docs/docs.json:redirects[${index}]`;
    if (!redirect || typeof redirect !== "object" || Array.isArray(redirect)) {
      addError(errors, `${sourcePath}: redirect must be an object`);
      return;
    }
    if (typeof redirect.source !== "string" || typeof redirect.destination !== "string") {
      addError(errors, `${sourcePath}: source and destination must be strings`);
      return;
    }
    const source = parseLocalReference(redirect.source, sourcePath, errors);
    if (!source || source.invalid || !source.path.startsWith("/") || source.query || source.fragment !== null) {
      addError(errors, `${sourcePath}: redirect source must be a local path without query or fragment`);
      return;
    }
    if (sources.has(source.path)) addError(errors, `${sourcePath}: duplicate redirect source ${source.path}`);
    sources.add(source.path);

    const destination = parseLocalReference(redirect.destination, sourcePath, errors);
    if (!destination) return;
    if (destination.invalid || !destination.path.startsWith("/")) {
      addError(errors, `${sourcePath}: redirect destination must be an absolute URL or root documentation path`);
      return;
    }
    const sourceDynamic = dynamicRouteParts(source.path);
    const destinationDynamic = dynamicRouteParts(destination.path);
    if (destinationDynamic.names.length > 0) {
      const available = new Set(sourceDynamic.names);
      for (const name of destinationDynamic.names) {
        if (!available.has(name)) addError(errors, `${sourcePath}: destination uses unbound route parameter :${name}`);
      }
      const prefix = destinationDynamic.staticPrefix;
      const prefixTarget = resolve(docsRoot, `.${prefix || "/"}`);
      if (!isInside(docsRoot, prefixTarget) || !existsSync(prefixTarget) || !lstatSync(prefixTarget).isDirectory()) {
        addError(errors, `${sourcePath}: dynamic destination prefix ${JSON.stringify(prefix || "/")} is missing`);
      }
      return;
    }
    const target = resolveExactTarget(
      root,
      docsRoot,
      resolve(docsRoot, `.${destination.path}`),
      sourcePath,
      redirect.destination,
      errors,
      { page: true },
    );
    if (target) validateAnchor(root, docsRoot, target, destination.fragment, sourcePath, redirect.destination, errors, anchorCache);
    if (sourceDynamic.names.length === 0) staticMappings.set(source.path, destination.path);
  });

  for (const source of staticMappings.keys()) {
    const seen = new Set([source]);
    let cursor = staticMappings.get(source);
    while (staticMappings.has(cursor)) {
      if (seen.has(cursor)) {
        addError(errors, `docs/docs.json: redirect cycle includes ${[...seen, cursor].join(" -> ")}`);
        break;
      }
      seen.add(cursor);
      cursor = staticMappings.get(cursor);
    }
  }
}

function moduleImports(source) {
  const imports = [];
  const pattern = /^\s*(?:import|export)\s+(?:(?:type\s+)?[\s\S]{0,500}?\s+from\s+)?(["'])([^"'\n]+)\1\s*;?\s*$/gmu;
  for (const match of source.matchAll(pattern)) imports.push({ value: match[2], offset: match.index ?? 0 });
  return imports;
}

function validateModuleImports(root, docsRoot, filePath, source, errors, stats) {
  const sourcePath = toRepoPath(root, filePath);
  for (const imported of moduleImports(source)) {
    if (!imported.value.startsWith(".") && !imported.value.startsWith("/")) continue;
    stats.moduleImports += 1;
    if (imported.value.startsWith("/snippets/") || imported.value.startsWith("./snippets/")) stats.snippetImports += 1;
    const reference = parseLocalReference(imported.value, sourcePath, errors);
    if (!reference || reference.invalid) continue;
    const candidate = imported.value.startsWith("/")
      ? resolve(docsRoot, `.${reference.path}`)
      : resolve(dirname(filePath), reference.path);
    resolveExactTarget(root, docsRoot, candidate, sourcePath, imported.value, errors);
  }
}

function validateMarkdownReference(root, docsRoot, contentRoots, routeGraph, filePath, item, errors, stats, anchorCache) {
  const sourcePath = toRepoPath(root, filePath);
  const reference = parseLocalReference(item.value, sourcePath, errors);
  if (!reference || reference.invalid) return;
  const underDocs = isInside(docsRoot, filePath);
  const underContent = contentRoots.some((directory) => isInside(directory, filePath));

  if (reference.path.startsWith("/images/") || reference.path.startsWith("/logo/")) {
    if (underDocs) stats.rootAssets += 1;
    resolveExactTarget(root, docsRoot, resolve(docsRoot, `.${reference.path}`), sourcePath, item.value, errors);
    return;
  }

  if (underContent && (/^\/docs(?:\/|$)/u.test(reference.path) || /^\/guides(?:\/|$)/u.test(reference.path))) {
    stats.contentInternalLinks += 1;
    const target = resolveExactTarget(
      root,
      resolve(root, "content"),
      resolve(root, "content", `.${reference.path}`),
      sourcePath,
      item.value,
      errors,
      { page: true },
    );
    if (reference.fragment !== null) stats.anchorReferences += 1;
    if (target) validateAnchor(root, docsRoot, target, reference.fragment, sourcePath, item.value, errors, anchorCache);
    return;
  }

  if (reference.path === "") {
    if (reference.fragment === null) return;
    stats.anchorReferences += 1;
    validateAnchor(root, docsRoot, filePath, reference.fragment, sourcePath, item.value, errors, anchorCache);
    return;
  }

  if (reference.path.startsWith("/")) {
    if (underContent) {
      addError(
        errors,
        `${sourcePath}: unsupported content root-relative path ${JSON.stringify(reference.path)}; use /docs, /guides, /images, or /logo`,
      );
      return;
    }
    if (!underDocs) return;
    if (item.kind === "asset") {
      resolveExactTarget(root, docsRoot, resolve(docsRoot, `.${reference.path}`), sourcePath, item.value, errors);
      return;
    }
    const resolved = resolveDocsRoute(reference.path, routeGraph);
    if (!resolved) {
      addError(errors, `${sourcePath}: missing canonical documentation route ${JSON.stringify(reference.path)} in ${JSON.stringify(item.value)}`);
      return;
    }
    if (reference.fragment !== null) {
      stats.anchorReferences += 1;
      if (resolved.external) {
        addError(errors, `${sourcePath}: cannot validate fragment through external documentation redirect in ${JSON.stringify(item.value)}`);
      } else {
        validateAnchor(root, docsRoot, resolved.target, reference.fragment, sourcePath, item.value, errors, anchorCache);
      }
    }
    return;
  }

  stats.relativeLinks += 1;
  const target = resolveExactTarget(
    root,
    root,
    resolve(dirname(filePath), reference.path),
    sourcePath,
    item.value,
    errors,
    { page: MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase()) && extname(reference.path) === "" },
  );
  if (reference.fragment !== null) stats.anchorReferences += 1;
  if (target) validateAnchor(root, docsRoot, target, reference.fragment, sourcePath, item.value, errors, anchorCache);
}

function validateConfigAssets(root, docsRoot, config, errors, stats) {
  const values = [config.favicon, config.logo?.light, config.logo?.dark];
  for (const value of values) {
    if (typeof value !== "string" || (!value.startsWith("/images/") && !value.startsWith("/logo/"))) continue;
    stats.rootAssets += 1;
    const reference = parseLocalReference(value, "docs/docs.json", errors);
    if (!reference || reference.invalid) continue;
    resolveExactTarget(root, docsRoot, resolve(docsRoot, `.${reference.path}`), "docs/docs.json", value, errors);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchingDelimiter(source, start, open, close) {
  let depth = 1;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '"' || source[cursor] === "'" || source[cursor] === "`") {
      const next = skipQuoted(source, cursor);
      if (next === null) return null;
      cursor = next - 1;
      continue;
    }
    if (source[cursor] === open) depth += 1;
    if (source[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return null;
}

function dynamicDesignReferences(source, rawValue, sourcePath, offset, errors) {
  const binding = rawValue.trim().match(/^\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}$/u);
  if (!binding) {
    addError(errors, `${sourcePath}:${lineAt(source, offset)}: cannot prove dynamic design reference ${JSON.stringify(rawValue)}`);
    return [];
  }
  const [, alias, property] = binding;
  const loops = new Map();
  for (const match of source.matchAll(/<sc-for\b[^>]*\blist\s*=\s*(["'])\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}\1[^>]*\bas\s*=\s*(["'])([A-Za-z_$][A-Za-z0-9_$]*)\3[^>]*>/gsu)) {
    const bindings = loops.get(match[4]) ?? [];
    bindings.push(match[2]);
    loops.set(match[4], bindings);
  }
  const bindings = loops.get(alias) ?? [];
  if (bindings.length === 0) {
    addError(errors, `${sourcePath}:${lineAt(source, offset)}: cannot resolve design loop binding ${alias}`);
    return [];
  }
  if (bindings.length !== 1) {
    addError(errors, `${sourcePath}:${lineAt(source, offset)}: ambiguous duplicate design loop alias ${alias}`);
    return [];
  }
  const [list] = bindings;
  const declaration = new RegExp(`\\bconst\\s+${escapeRegExp(list)}\\s*=\\s*\\[`, "u").exec(source);
  if (!declaration) {
    addError(errors, `${sourcePath}:${lineAt(source, offset)}: cannot resolve design list ${list}`);
    return [];
  }
  const open = declaration.index + declaration[0].lastIndexOf("[");
  const close = matchingDelimiter(source, open, "[", "]");
  if (close === null) {
    addError(errors, `${sourcePath}:${lineAt(source, offset)}: cannot parse design list ${list}`);
    return [];
  }
  const listSource = source.slice(open + 1, close);
  const propertyToken = new RegExp(`\\b${escapeRegExp(property)}\\s*:`, "gu");
  const propertyValue = new RegExp(`\\b${escapeRegExp(property)}\\s*:\\s*(["'])(.*?)\\1`, "gsu");
  const declarations = [...listSource.matchAll(propertyToken)];
  const values = [...listSource.matchAll(propertyValue)].map((match) => match[2]);
  if (declarations.length === 0 || declarations.length !== values.length) {
    addError(errors, `${sourcePath}:${lineAt(source, offset)}: design binding ${alias}.${property} is not an exact string-literal set`);
    return [];
  }
  return values;
}

function validateDesign(root, designRoot, files, errors, stats) {
  const sourceFiles = files.filter((filePath) => DESIGN_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase()));
  stats.designSourceFiles = sourceFiles.length;
  for (const filePath of sourceFiles) {
    const sourcePath = toRepoPath(root, filePath);
    const source = readFileSync(filePath, "utf8");
    const references = [];
    if (extname(filePath).toLowerCase() === ".html") {
      for (const match of source.matchAll(/\b(?:href|src|poster|data)\s*=\s*(["'])(.*?)\1/gsu)) {
        references.push({ value: match[2], offset: match.index ?? 0 });
      }
      for (const match of source.matchAll(/<dc-import\b[^>]*\bname\s*=\s*(["'])([^"']+)\1[^>]*>/gsu)) {
        references.push({ value: `${match[2]}.dc.html`, offset: match.index ?? 0, designImport: true });
        stats.designImports += 1;
      }
      for (const match of source.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gsu)) {
        for (const css of match[2].matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gu)) {
          references.push({ value: css[2], offset: match.index ?? 0 });
        }
      }
    } else if (extname(filePath).toLowerCase() === ".css") {
      for (const match of source.matchAll(/(?:url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3)/gu)) {
        references.push({ value: match[2] ?? match[4], offset: match.index ?? 0 });
      }
    } else {
      const patterns = [
        /\b(?:import|export)\s+(?:(?:type\s+)?[\s\S]{0,300}?\s+from\s+)?(["'])([^"'\n]+)\1/gu,
        /\bimport\(\s*(["'])([^"']+)\1\s*\)/gu,
        /\bnew\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/gu,
        /\b(?:fetch|Worker)\(\s*(["'])([^"']+)\1/gu,
      ];
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) references.push({ value: match[2], offset: match.index ?? 0 });
      }
    }

    for (const item of references) {
      const values = /\{\{|\}\}|\$\{/u.test(item.value)
        ? dynamicDesignReferences(source, item.value, sourcePath, item.offset, errors)
        : [item.value];
      for (const value of values) {
        const reference = parseLocalReference(value, sourcePath, errors);
        if (!reference || reference.invalid || reference.path === "") continue;
        if (reference.path.startsWith("/")) {
          addError(errors, `${sourcePath}:${lineAt(source, item.offset)}: design source uses root asset ${JSON.stringify(value)}`);
          continue;
        }
        stats.designReferences += 1;
        resolveExactTarget(root, designRoot, resolve(dirname(filePath), reference.path), sourcePath, value, errors);
      }
    }
  }
}

function initialStats() {
  return {
    docsMarkdownFiles: 0,
    contentMarkdownFiles: 0,
    navigationLeaves: 0,
    navigationUniqueLeaves: 0,
    moduleImports: 0,
    snippetImports: 0,
    rootAssets: 0,
    relativeLinks: 0,
    anchorReferences: 0,
    contentInternalLinks: 0,
    designSourceFiles: 0,
    designReferences: 0,
    designImports: 0,
    redirects: 0,
  };
}

export function validateDocsLinkIntegrity(root = repositoryRoot, options = {}) {
  const absoluteRoot = resolve(root);
  const errors = [];
  const stats = initialStats();
  const docsRoot = resolve(absoluteRoot, DOCS_ROOT);
  const contentRoots = CONTENT_ROOTS.map((directory) => resolve(absoluteRoot, directory));
  const designRoot = resolve(absoluteRoot, DESIGN_ROOT);
  const docsFiles = scanSourceTree(absoluteRoot, DOCS_ROOT, errors);
  const contentFiles = CONTENT_ROOTS.flatMap((directory) => scanSourceTree(absoluteRoot, directory, errors));
  const designFiles = scanSourceTree(absoluteRoot, DESIGN_ROOT, errors);
  const docsMarkdown = docsFiles.filter((filePath) => MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase()));
  const contentMarkdown = contentFiles.filter((filePath) => MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase()));
  stats.docsMarkdownFiles = docsMarkdown.length;
  stats.contentMarkdownFiles = contentMarkdown.length;
  const anchorCache = { anchors: new Map(), structures: new Map() };

  const configPath = resolve(docsRoot, "docs.json");
  let config = null;
  if (!existsSync(configPath)) {
    addError(errors, "docs/docs.json: required Mintlify configuration is missing");
  } else {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      addError(errors, `docs/docs.json: malformed JSON (${error.message})`);
    }
  }
  if (config !== null) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      addError(errors, "docs/docs.json: configuration root must be an object");
    } else {
      if (config.$schema !== "https://mintlify.com/docs.json") {
        addError(errors, "docs/docs.json: $schema must be https://mintlify.com/docs.json");
      }
      validateNavigation(absoluteRoot, docsRoot, config, errors, stats);
      validateRedirects(absoluteRoot, docsRoot, config, errors, stats, anchorCache);
      validateConfigAssets(absoluteRoot, docsRoot, config, errors, stats);
    }
  }

  const routeGraph = buildDocsRouteGraph(absoluteRoot, docsRoot, docsMarkdown, config, errors);

  for (const filePath of [...docsMarkdown, ...contentMarkdown]) {
    const source = maskInlineCode(maskFencedCode(readFileSync(filePath, "utf8")));
    if (isInside(docsRoot, filePath)) {
      validateModuleImports(absoluteRoot, docsRoot, filePath, source, errors, stats);
      anchorsFor(absoluteRoot, docsRoot, filePath, errors, anchorCache);
    }
    const sourcePath = toRepoPath(absoluteRoot, filePath);
    const destinations = [
      ...markdownDestinations(source),
      ...mdxAttributeDestinations(source, sourcePath, errors),
    ];
    for (const item of destinations) {
      validateMarkdownReference(
        absoluteRoot,
        docsRoot,
        contentRoots,
        routeGraph,
        filePath,
        item,
        errors,
        stats,
        anchorCache,
      );
    }
  }

  validateDesign(absoluteRoot, designRoot, designFiles, errors, stats);

  const minimums = options.minimums === false ? null : (options.minimums ?? REQUIRED_MINIMUMS);
  if (minimums) {
    for (const [name, minimum] of Object.entries(minimums)) {
      if (!Number.isSafeInteger(minimum) || minimum < 1) {
        addError(errors, `minimum ${name} must be a positive integer`);
      } else if (!(name in stats)) {
        addError(errors, `minimum references unknown statistic ${name}`);
      } else if (stats[name] < minimum) {
        addError(errors, `${name}: expected at least ${minimum}, found ${stats[name]}`);
      }
    }
  }

  if (docsMarkdown.length === 0) addError(errors, "docs: Markdown/MDX corpus is empty");
  if (contentMarkdown.length === 0) addError(errors, "content: Markdown corpus is empty");
  if (stats.navigationLeaves === 0) addError(errors, "docs/docs.json: navigation has no page leaves");
  if (stats.designSourceFiles === 0) addError(errors, `${DESIGN_ROOT}: HTML/CSS/JS source corpus is empty`);

  return { errors: errors.sort(), stats };
}

function main() {
  const result = validateDocsLinkIntegrity(repositoryRoot);
  if (result.errors.length > 0) {
    console.error(`docs-link-integrity: ${result.errors.length} error(s)`);
    for (const error of result.errors) console.error(`- ${error}`);
    console.error(`docs-link-integrity: counts ${JSON.stringify(result.stats)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`docs-link-integrity: validated ${JSON.stringify(result.stats)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
