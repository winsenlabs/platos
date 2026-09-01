#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const JSON_PATH = "docs/audits/win-252-root-entry-manifest.json";
export const MARKDOWN_PATH = "docs/audits/win-252-root-entry-manifest.md";
export const CORPUS_EXCLUSIONS = [
  JSON_PATH,
  MARKDOWN_PATH,
  "docs/v1-ledger-rules.json",
  "scripts/root-entry-manifest.mjs",
  "scripts/root-entry-manifest.test.mjs",
];

const d = (entry, kind, disposition, owner, consumer, evidence, fixedName = false, externalBoundary = null, expectedSemanticConsumers = []) => ({
  entry,
  kind,
  disposition,
  owner,
  consumer,
  evidence,
  fixedName,
  externalBoundary,
  expectedSemanticConsumers,
});
const pkg = (name, command) => ({ type: "package-script", id: `package.json#scripts.${name}`, command });
const ci = (command) => ({ type: "workflow-command", id: ".github/workflows/ci.yml", command });

export const ROOT_DECISIONS = [
  d(".changeset", "directory", "retain", "Release Governance", "Changesets CLI", "Manual package-version intent for current non-private packages.", true, "npm"),
  d(".configs", "directory", "retain", "Build Platform", "TypeScript project graph", "Shared compiler configuration extended by tracked projects."),
  d(".cursor", "directory", "retain", "Developer Experience", "Cursor", "Repository guidance discovered by its fixed directory name.", true, "Cursor"),
  d(".cursorignore", "file", "retain", "Developer Experience", "Cursor", "Repository indexing boundary discovered by fixed filename.", true, "Cursor"),
  d(".dependency-cruiser.js", "file", "regenerate", "Architecture", "dependency-cruiser", "Generated from scripts/arch/boundary-rules.mjs and byte-checked.", true, "dependency-cruiser"),
  d(".dockerignore", "file", "retain", "Infrastructure", "Docker builders", "Build-context and legal-distribution boundary.", true, "Docker"),
  d(".env.example", "file", "retain", "Infrastructure", "Contributors and Compose", "Safe configuration template with non-secret sentinels.", true),
  d(".github", "directory", "retain", "Repository Governance", "GitHub", "Workflows and repository metadata discovered by GitHub.", true, "GitHub"),
  d(".gitignore", "file", "retain", "Repository Governance", "Git", "Local artifact and secret exclusion boundary.", true, "Git"),
  d(".gitmodules", "file", "retain", "Observability", "Git submodule plumbing", "Pins the OpenTelemetry protocol source boundary.", true, "Git/OpenTelemetry"),
  d(".gstack", "directory", "regenerate", "Test Platform", "Browser evidence tooling", "Generated browser evidence retained as requested.", true, "gstack"),
  d(".nvmrc", "file", "retain", "Build Platform", "Node version managers and CI", "Exact Node 22.14.0 runtime pin.", true, "Node.js"),
  d(".platos", "directory", "retain", "Infrastructure", "docker-compose.platos.yml", "Tracked ClickHouse configuration mounted by Compose."),
  d(".prettierignore", "file", "retain", "Developer Experience", "Prettier", "Intentional root editor/formatter boundary discovered by fixed filename.", true, "Prettier"),
  d(".vscode", "directory", "retain", "Developer Experience", "Visual Studio Code", "Useful launch and workspace settings with verified paths.", true, "VS Code"),
  d(".zed", "directory", "retain", "Developer Experience", "Zed", "Useful project task discovered by fixed directory name.", true, "Zed"),
  d("CHANGESETS.md", "file", "retain", "Release Governance", "Contributors", "Defines manual package-version intent and the npm non-authorization boundary."),
  d("CODE_OF_CONDUCT.md", "file", "retain", "Repository Governance", "Community participants", "Official Contributor Covenant 2.1 with monitored enforcement contact.", true, "Contributor Covenant"),
  d("CONTRIBUTING.md", "file", "retain", "Repository Governance", "Contributors", "Truthful source, Compose, package, candidate, and hook guidance.", true),
  d("LICENSE", "file", "retain", "Legal", "Repository and distributed images", "Apache-2.0 licence text required for distribution.", true, "Apache-2.0"),
  d("NOTICE", "file", "retain", "Legal", "Repository and distributed images", "Attribution and checked SBOM closure references.", true, "Apache-2.0"),
  d("README.md", "file", "retain", "Documentation", "Repository visitors", "Primary repository entry document.", true),
  d("RELEASE.md", "file", "retain", "Release Governance", "Release operators", "OCI and environment authorization process; explicitly excludes npm authority."),
  d("SECURITY.md", "file", "retain", "Security", "Security reporters", "Fixed public vulnerability-reporting policy.", true),
  d("ai", "directory", "retain", "Developer Experience", "Repository assistants", "Current repository, test, and migration references."),
  d("apps", "directory", "retain", "Application Engineering", "Workspace and image builds", "Shipping applications and V1 composition roots."),
  d("content", "directory", "retain", "Documentation", "Documentation site", "Product documentation source."),
  d("deploy", "directory", "retain", "Infrastructure", "Release operators", "Reverse-proxy and host operation assets."),
  d("design", "directory", "retain", "Design System", "Product development", "Protected V1 design evidence."),
  d("docker-compose.deploy.yml", "file", "retain", "Release Governance", "Docker Compose", "Immutable-image Compose override.", false, "Docker"),
  d("docker-compose.platos.yml", "file", "retain", "Infrastructure", "Docker Compose", "Current local full-stack and supporting-store definition.", false, "Docker"),
  d("docs", "directory", "retain", "Documentation", "Documentation and policy checks", "Documentation plus durable generated and historical audit evidence."),
  d("examples", "directory", "retain", "Documentation", "Contributors", "Runnable examples checked by docs-example policy."),
  d("hosting", "directory", "retain", "Infrastructure", "Host operators", "Hosted environment configuration boundary."),
  d("internal-packages", "directory", "retain", "Application Engineering", "pnpm workspace", "Private application implementation packages."),
  d("lefthook.yml", "file", "retain", "Repository Governance", "Pinned local Lefthook runtime", "Rejects direct commits on exact main and v1 refs; local bypass remains possible.", true, "Lefthook", [ci("pnpm exec lefthook validate")]),
  d("package.json", "file", "retain", "Build Platform", "Corepack and pnpm", "Root scripts, exact package-manager pin, and policy reachability; no duplicate workspace graph.", true, "pnpm"),
  d("packages", "directory", "retain", "SDK and Architecture", "pnpm workspace", "Apache-2.0 publishable SDKs plus the V1 context/adapter graph; metadata is mutation-tested."),
  d("patches", "directory", "retain", "Build Platform", "pnpm", "Tracked dependency patches referenced by package.json."),
  d("pnpm-lock.yaml", "file", "regenerate", "Build Platform", "pnpm", "Frozen dependency graph checked by install and CI.", true, "pnpm"),
  d("pnpm-workspace.yaml", "file", "retain", "Build Platform", "pnpm", "Sole authoritative workspace discovery graph and dependency-age policy.", true, "pnpm"),
  d("prettier.config.js", "file", "retain", "Developer Experience", "Prettier", "Repository formatter configuration.", true, "Prettier"),
  d("references", "directory", "retain", "Developer Experience", "Reference workspaces", "Tracked development integration references."),
  d("renovate.json", "file", "retain", "Supply Chain", "Renovate", "Dependency update governance.", true, "Renovate"),
  d("rules", "directory", "retain", "Repository Governance", "Repository assistants", "Tracked assistant rule assets."),
  d("scripts", "directory", "retain", "Build Platform", "package.json and CI", "Repository-owned checks and operators with exact semantic reachability.", false, null, [
    pkg("generate:root-manifest", "node scripts/root-entry-manifest.mjs --write"),
    pkg("audit:root-manifest", "node scripts/root-entry-manifest.mjs --check"),
    pkg("test:root-manifest", "node --test scripts/root-entry-manifest.test.mjs"),
    pkg("audit:hook-policy", "node scripts/hook-policy.mjs"),
    pkg("test:hook-policy", "node --test scripts/hook-policy.test.mjs"),
    ci("pnpm audit:root-manifest"),
    ci("pnpm test:root-manifest"),
    ci("pnpm audit:hook-policy"),
    ci("pnpm test:hook-policy"),
  ]),
  d("tests", "directory", "retain", "Test Platform", "Package scripts and CI", "Current release and evidence suites; broken legacy root browser suite removed."),
  d("tsconfig.json", "file", "retain", "Architecture", "TypeScript", "Root V1 solution graph.", true, "TypeScript", [pkg("build:v1", "tsc -b tsconfig.json")]),
  d("turbo.json", "file", "retain", "Build Platform", "Turbo", "Workspace task graph.", true, "Turbo"),
].sort((a, b) => Buffer.compare(Buffer.from(a.entry), Buffer.from(b.entry)));

export const ARCHIVED_MOVES = [
  [".changeset/ctx-sdk-context.md", "docs/audits/history/win-252/stale-changesets/ctx-sdk-context.md", "913115a6292dd9434022d1b9f6b37e9d160c2eb5d1117eabc969d696fa267713"],
  [".changeset/eobd-80-platos-client-publish-prep.md", "docs/audits/history/win-252/stale-changesets/eobd-80-platos-client-publish-prep.md", "272ed7d9508b46ca334e6f3df45ab4459532e9e9cf6709efbaff7236ee224d32"],
  [".changeset/eobd-82-platools-sdk-publish-prep.md", "docs/audits/history/win-252/stale-changesets/eobd-82-platools-sdk-publish-prep.md", "d1a2cd19cdc8ba8bc55b8735e04be7f5e70cbf18b6e5d14b5f7e282f4b380fe0"],
  [".changeset/eobd-85-86-94-platos-client-namespaces.md", "docs/audits/history/win-252/stale-changesets/eobd-85-86-94-platos-client-namespaces.md", "1c335b32577e8a757dfdd606336b887ce7fbaef16708bdba4ce2779fbd7ea11c"],
  [".changeset/eobd-89-90-95-97-public-embed.md", "docs/audits/history/win-252/stale-changesets/eobd-89-90-95-97-public-embed.md", "89729b6a8ca134c45f41ccd1d07296fa8a3c815a670ce9770b0d41572e305aae"],
  [".changeset/platos-client-model-routing.md", "docs/audits/history/win-252/stale-changesets/platos-client-model-routing.md", "a8559e79167a2b682b93cab94387c854afcce7a6abc0546eb6e6214303228233"],
  [".changeset/ppr-29-platools-js-strict-context.md", "docs/audits/history/win-252/stale-changesets/ppr-29-platools-js-strict-context.md", "f1ef351b88e41193e4bad3dfbd91820508824561991dd41094e4b95e72d4d6de"],
  [".changeset/ppr-34-platos-client-mvp.md", "docs/audits/history/win-252/stale-changesets/ppr-34-platos-client-mvp.md", "0574b038f222a1ff44dbd37844b95377b834cc62cea975cdb38567a2c0d57662"],
  [".changeset/ppr-71-nonce-replay-guard.md", "docs/audits/history/win-252/stale-changesets/ppr-71-nonce-replay-guard.md", "b6a517c7c9930c1d1479f68dedc68070763957c72af7eedae58b2aa6cf5c0797"],
  [".changeset/sdk-context-pop-bump.md", "docs/audits/history/win-252/stale-changesets/sdk-context-pop-bump.md", "4836a65786edba4aa75b01918b30072f784204962c805919f8ce9462ad258432"],
  [".server-changes/login-passcode-backdoor.md", "docs/audits/history/win-252/server-changes/login-passcode-backdoor.md", "650b8ba16cc3cbf7ecda176e77254464f6a104c6c4ad1ec25a968cee852af08c"],
  [".server-changes/prompt-caching-and-billing.md", "docs/audits/history/win-252/server-changes/prompt-caching-and-billing.md", "126acebf33e52541c347935cf31ec925c2144140c22296be13edcb960bdd6e27"],
  ["PROGRESS.md", "docs/audits/history/win-252/prompt-caching-progress.md", "a6c8392d7644950df02c93eaf881bf640d78740564f273d9caae7eaec13578e9"],
].map(([source, destination, sha256]) => ({ source, destination, sha256 }));

export const DELETED_PATHS = [
  ".eslintignore",
  "DOCKER_INSTALLATION.md",
  "playwright.config.ts",
  "scripts/build-dockerfile.sh",
  "scripts/enhance-release-pr.mjs",
  "scripts/generate-github-release.mjs",
  "scripts/publish-prerelease.sh",
  "tests/e2e/e2e.spec.ts",
  "tests/global.setup.ts",
  "tests/global.teardown.ts",
  "tests/utils.ts",
];
export const REMOVED_PACKAGE_SCRIPTS = [
  "docker", "docker:stop", "dev:docker", "dev:docker:build", "dev:docker:stop",
  "test:e2e", "test:e2e:ui", "test:e2e:dev", "test:e2e:ci",
  "changeset:version", "changeset:release", "changeset:v4", "changeset:normal",
];

export function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function decodeGitPathList(source) {
  if (!Buffer.isBuffer(source)) throw new TypeError("Git pathname output must remain a Buffer until UTF-8 validation");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 0) continue;
    if (index > start) {
      try {
        paths.push(decoder.decode(source.subarray(start, index)));
      } catch {
        throw new Error(`Git returned a pathname with invalid UTF-8 bytes at output offset ${start}`);
      }
    }
    start = index + 1;
  }
  if (start !== source.length) throw new Error("Git pathname output is not NUL-terminated");
  return paths;
}

export function pathExistsByLstat(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

export function listRepositoryFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(decodeGitPathList(output)
    .filter((path) => pathExistsByLstat(join(root, path))))].sort(byteCompare);
}

export function listRootEntries(root) {
  return [...new Set(listRepositoryFiles(root).map((path) => path.split("/")[0]))].sort(byteCompare);
}

export function validateRootCoverage(actual, entries) {
  const errors = [];
  const names = entries.map((row) => row?.entry);
  if (new Set(names).size !== names.length) errors.push("root entries contain duplicates");
  if (JSON.stringify(names) !== JSON.stringify([...names].sort(byteCompare))) errors.push("root entries are not exact UTF-8 byte sorted order");
  if (JSON.stringify(names) !== JSON.stringify(actual)) errors.push(`root coverage differs: expected ${actual.join(", ")}`);
  return errors;
}

function executableLines(run) {
  return run.split("\n").flatMap((line) => line.split("&&")).map((line) => line.replace(/\s+#.*$/u, "").trim()).filter(Boolean);
}

export function collectSemanticConsumers(packageJsonSource, workflowSources) {
  const found = [];
  const manifest = JSON.parse(packageJsonSource);
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    found.push({ type: "package-script", id: `package.json#scripts.${name}`, command });
  }
  for (const [source, yaml] of Object.entries(workflowSources)) {
    const document = parseDocument(yaml, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length) throw new Error(`${source} is malformed YAML`);
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      if (typeof value.run === "string") {
        for (const command of executableLines(value.run)) found.push({ type: "workflow-command", id: source, command });
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(document.toJS());
  }
  return found;
}

function stripSlashComments(source) {
  let output = "";
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += "\n";
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      output += character;
      if (character === "\\" && quote !== "'") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else output += character;
  }
  return output;
}

function stripHashComments(source, requireWhitespace = true) {
  return source.split("\n").map((line) => {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) escaped = false;
      else if (character === "\\" && quote !== "'") escaped = true;
      else if (quote !== null && character === quote) quote = null;
      else if (quote === null && (character === "'" || character === '"')) quote = character;
      else if (quote === null && character === "#" && (!requireWhitespace || index === 0 || /\s/u.test(line[index - 1]))) return line.slice(0, index);
    }
    return line;
  }).join("\n");
}

export function stripInertComments(path, source) {
  const extension = extname(path).toLowerCase();
  const name = basename(path);
  const slashCommentJson = extension === ".jsonc"
    || extension === ".code-workspace"
    || /^(?:ts|js)config(?:\..+)?\.json$/iu.test(name)
    || /(?:^|\/)\.(?:vscode|devcontainer)\//u.test(path);
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".css", ".scss", ".java", ".go", ".rs"].includes(extension) || slashCommentJson) {
    return stripSlashComments(source);
  }
  if ([".md", ".mdx", ".html", ".xml", ".svg"].includes(extension)) {
    return source.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, " "));
  }
  if (extension === ".py") return stripHashComments(source, false);
  if ([".yaml", ".yml", ".sh", ".bash", ".zsh", ".toml", ".ini", ".conf", ".env"].includes(extension) || /^Dockerfile(?:\.|$)/u.test(name)) {
    return stripHashComments(source);
  }
  return source;
}

function referenceForms(target, source, includeBasename) {
  const forms = new Set([target, `/${target}`]);
  if (includeBasename) forms.add(basename(target));
  const relativeTarget = posix.relative(posix.dirname(source), target);
  forms.add(relativeTarget);
  if (!relativeTarget.startsWith(".")) forms.add(`./${relativeTarget}`);
  const extension = extname(target);
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json"].includes(extension)) {
    const extensionless = target.slice(0, -extension.length);
    forms.add(extensionless);
    const relativeExtensionless = posix.relative(posix.dirname(source), extensionless);
    forms.add(relativeExtensionless);
    if (!relativeExtensionless.startsWith(".")) forms.add(`./${relativeExtensionless}`);
  }
  return [...forms].filter(Boolean);
}

function containsReference(source, form, basenameForm = false) {
  let from = 0;
  while (from <= source.length - form.length) {
    const index = source.indexOf(form, from);
    if (index === -1) return false;
    const before = source[index - 1] ?? "";
    const after = source[index + form.length] ?? "";
    const beforePattern = basenameForm ? /[A-Za-z0-9_@.+-]/u : /[A-Za-z0-9_@.+/-]/u;
    if (!beforePattern.test(before) && !/[A-Za-z0-9_@+-]/u.test(after)) return true;
    from = index + 1;
  }
  return false;
}

export function findSemanticPathReferences(targetPaths, corpus, options = {}) {
  const exclusions = new Set(options.exclusions ?? []);
  const archivePrefixes = options.archivePrefixes ?? ["docs/audits/history/"];
  const references = [];
  for (const target of targetPaths) {
    const referencedBy = [];
    for (const [source, rawText] of corpus) {
      if (
        source === target ||
        exclusions.has(source) ||
        archivePrefixes.some((prefix) => source.startsWith(prefix))
      ) continue;
      const text = stripInertComments(source, rawText);
      if (referenceForms(target, source, options.includeBasename === true).some((form) =>
        containsReference(text, form, options.includeBasename === true && form === basename(target)))) referencedBy.push(source);
    }
    if (referencedBy.length) references.push({ path: target, referencedBy: referencedBy.sort(byteCompare) });
  }
  return references.sort((left, right) => byteCompare(left.path, right.path));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ARCHIVED_LIFECYCLE_BANNER =
  "> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.";

export function archivedPayloadBytes(source) {
  const escapedBanner = ARCHIVED_LIFECYCLE_BANNER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^---\\ntitle: "\\[POINT-IN-TIME\\] [^"\\n]+"\\nlifecycle: "POINT-IN-TIME"\\n([\\s\\S]*?)---\\n\\n${escapedBanner}\\n\\n`,
    "u",
  );
  const match = source.match(pattern);
  if (!match) throw new Error("archived destination requires the exact reviewed POINT-IN-TIME lifecycle envelope");
  const body = source.slice(match[0].length);
  return Buffer.from(match[1] ? `---\n${match[1]}---\n\n${body}` : body);
}

function manifestDocument(root) {
  return {
    schemaVersion: 1,
    generatedBy: "scripts/root-entry-manifest.mjs",
    enumeration: "git ls-files -z --cached --others --exclude-standard; pathname bytes validated as UTF-8; absent index paths removed with lstat; UTF-8 byte sort",
    rootEntryCount: ROOT_DECISIONS.length,
    corpusExclusions: CORPUS_EXCLUSIONS,
    entries: ROOT_DECISIONS.map(({ expectedSemanticConsumers: _expectedSemanticConsumers, ...row }) => row),
    archivedMoves: ARCHIVED_MOVES,
    deletedPaths: DELETED_PATHS.map((path) => ({ path, referenceCount: 0 })),
    removedPackageScripts: REMOVED_PACKAGE_SCRIPTS,
  };
}

export function validateManifest(root, document) {
  const errors = [];
  if (document?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (JSON.stringify(document?.corpusExclusions) !== JSON.stringify(CORPUS_EXCLUSIONS)) errors.push("corpus exclusions must be exact and self-limited");
  if (JSON.stringify(document?.archivedMoves) !== JSON.stringify(ARCHIVED_MOVES)) errors.push("archived move records must be exact");
  if (JSON.stringify(document?.deletedPaths) !== JSON.stringify(DELETED_PATHS.map((path) => ({ path, referenceCount: 0 })))) errors.push("deleted path evidence must be exact");
  if (JSON.stringify(document?.removedPackageScripts) !== JSON.stringify(REMOVED_PACKAGE_SCRIPTS)) errors.push("removed package-script evidence must be exact");
  const actual = listRootEntries(root);
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  errors.push(...validateRootCoverage(actual, entries));
  for (const [index, row] of entries.entries()) {
    for (const field of ["entry", "kind", "disposition", "owner", "consumer", "evidence"]) {
      if (typeof row?.[field] !== "string" || !row[field].trim()) errors.push(`entries[${index}].${field} must be non-empty`);
    }
    if (!["file", "directory"].includes(row?.kind)) errors.push(`entries[${index}].kind is malformed`);
    if (typeof row?.fixedName !== "boolean") errors.push(`entries[${index}].fixedName must be boolean`);
    if (!(row?.externalBoundary === null || typeof row?.externalBoundary === "string")) errors.push(`entries[${index}].externalBoundary is malformed`);
    if (Object.hasOwn(row ?? {}, "semanticConsumers")) errors.push(`entries[${index}].semanticConsumers is derived state and must not be generated`);
    if (row?.entry && pathExistsByLstat(join(root, row.entry))) {
      const actualKind = lstatSync(join(root, row.entry)).isDirectory() ? "directory" : "file";
      if (row.kind !== actualKind) errors.push(`${row.entry} kind differs: ${actualKind}`);
    }
  }
  for (const move of ARCHIVED_MOVES) {
    if (pathExistsByLstat(join(root, move.source))) errors.push(`archived source still exists: ${move.source}`);
    if (!pathExistsByLstat(join(root, move.destination))) errors.push(`archived destination is missing: ${move.destination}`);
    else {
      try {
        const payloadHash = createHash("sha256")
          .update(archivedPayloadBytes(readFileSync(join(root, move.destination), "utf8")))
          .digest("hex");
        if (payloadHash !== move.sha256) errors.push(`archived payload bytes changed: ${move.destination}`);
      } catch (error) {
        errors.push(`${move.destination}: ${error.message}`);
      }
    }
  }
  for (const path of DELETED_PATHS) if (pathExistsByLstat(join(root, path))) errors.push(`deleted candidate still exists: ${path}`);
  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of REMOVED_PACKAGE_SCRIPTS) if (Object.hasOwn(packageManifest.scripts ?? {}, name)) errors.push(`removed package script is still active: ${name}`);

  const workflows = Object.fromEntries(listRepositoryFiles(root).filter((path) => path.startsWith(".github/workflows/") && path.endsWith(".yml"))
    .map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const semantic = collectSemanticConsumers(readFileSync(join(root, "package.json"), "utf8"), workflows);
  for (const consumer of ROOT_DECISIONS.flatMap((row) => row.expectedSemanticConsumers)) {
    const count = semantic.filter((item) => JSON.stringify(item) === JSON.stringify(consumer)).length;
    if (count !== 1) errors.push(`semantic consumer must resolve exactly once: ${consumer.id} -> ${consumer.command}`);
  }

  const corpus = new Map();
  for (const path of listRepositoryFiles(root)) {
    const source = readFileSync(join(root, path));
    if (source.includes(0)) continue;
    try {
      corpus.set(path, new TextDecoder("utf-8", { fatal: true }).decode(source));
    } catch {
      // Non-text file contents cannot carry a semantic text reference.
    }
  }
  const removedPaths = [...ARCHIVED_MOVES.map((move) => move.source), ...DELETED_PATHS];
  for (const reference of findSemanticPathReferences(removedPaths, corpus, { exclusions: CORPUS_EXCLUSIONS })) {
    errors.push(`removed path remains referenced: ${reference.path} in ${reference.referencedBy.join(", ")}`);
  }
  return errors;
}

export function renderMarkdown(document) {
  const lines = [
    "# WIN-252 root-entry manifest",
    "",
    `Exact final root inventory: **${document.rootEntryCount} entries**. Generated by \`${document.generatedBy}\`; do not edit by hand.`,
    "",
    "| Entry | Kind | Disposition | Owner | Consumer | Fixed name | External boundary | Evidence |",
    "|---|---|---|---|---|---:|---|---|",
  ];
  for (const row of document.entries) lines.push(`| \`${row.entry}\` | ${row.kind} | ${row.disposition} | ${row.owner} | ${row.consumer} | ${row.fixedName ? "yes" : "no"} | ${row.externalBoundary ?? "—"} | ${row.evidence} |`);
  lines.push("", "## Archived payload-preserving moves with visible lifecycle envelopes", "");
  for (const move of document.archivedMoves) lines.push(`- \`${move.source}\` → \`${move.destination}\` — original payload SHA-256 \`${move.sha256}\``);
  lines.push("", "## Deletion evidence", "", "Every path below is absent and has zero semantic consumers across Markdown/MDX links, package and workflow commands, source imports, and plain JSON/YAML/config/path references. Inert comments, explicit WIN-252 history, and the five self-declaring control artifacts are excluded:", "");
  for (const row of document.deletedPaths) lines.push(`- \`${row.path}\`: ${row.referenceCount} references`);
  lines.push("", "Local hooks are a contributor guard only; `git commit --no-verify` remains a documented client-side bypass. Remote authorization remains outside this manifest.");
  return `${lines.join("\n")}\n`;
}

export function run(root = repositoryRoot, mode = "check") {
  const expected = manifestDocument(root);
  if (mode === "write") {
    writeFileSync(join(root, JSON_PATH), `${JSON.stringify(expected, null, 2)}\n`);
    writeFileSync(join(root, MARKDOWN_PATH), renderMarkdown(expected));
  }
  if (!existsSync(join(root, JSON_PATH)) || !existsSync(join(root, MARKDOWN_PATH))) return ["generated root-manifest artifacts are missing"];
  let committed;
  try { committed = JSON.parse(readFileSync(join(root, JSON_PATH), "utf8")); }
  catch (error) { return [`root JSON artifact is malformed: ${error.message}`]; }
  const errors = validateManifest(root, committed);
  if (JSON.stringify(committed) !== JSON.stringify(expected)) errors.push("root JSON artifact is stale");
  if (readFileSync(join(root, MARKDOWN_PATH), "utf8") !== renderMarkdown(expected)) errors.push("root Markdown artifact is stale");
  return errors;
}

function main() {
  const mode = process.argv.includes("--write") ? "write" : "check";
  const errors = run(repositoryRoot, mode);
  if (errors.length) {
    process.stderr.write(`root-entry-manifest: FAIL\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`root-entry-manifest: ${ROOT_DECISIONS.length} exact root entries; artifacts ${mode === "write" ? "written" : "current"}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
