#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { CORE_API_CONFIG_DIRECTORY, loadCoreApiConfigFields } from "./lib/core-api-config-schema.mjs";

const root = new URL("..", import.meta.url).pathname;
const failures = [];
const checks = [];

function check(description, condition) {
  checks.push(description);
  if (!condition) failures.push(description);
}

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

const packageJson = JSON.parse(read("package.json"));
const agentPackage = JSON.parse(read("apps/agent/package.json"));
const agentBuildTsconfig = JSON.parse(read("apps/agent/tsconfig.build.json"));
const tenancyDatabasePackage = JSON.parse(read("internal-packages/tenancy-database/package.json"));
const webappPackage = JSON.parse(read("apps/webapp/package.json"));
const agentDockerfile = read("apps/agent/Dockerfile");
const coreApiDockerfile = read("apps/core-api/Dockerfile");
const webappDockerfile = read("apps/webapp/Dockerfile.platos");
const agentEntrypoint = read("apps/agent/entrypoint.sh");
const compose = read("docker-compose.platos.yml");

function sourceFiles(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute).flatMap((entry) => sourceFiles(join(path, entry)));
}

check("root exposes build:platos", Boolean(packageJson.scripts?.["build:platos"]));
check("root exposes build:platos:agent", Boolean(packageJson.scripts?.["build:platos:agent"]));
check("root exposes build:platos:webapp", Boolean(packageJson.scripts?.["build:platos:webapp"]));
check("root exposes build:platos:core-api", Boolean(packageJson.scripts?.["build:platos:core-api"]));
check(
  "build:platos includes the core-api graph",
  /(?:^|&&\s*)pnpm run build:platos:core-api(?:\s*&&|$)/.test(packageJson.scripts?.["build:platos"] ?? "")
);
check(
  "agent build compiles the clean tenancy database dependency",
  /--filter @platos\/tenancy-database build/.test(packageJson.scripts?.["build:platos:agent"] ?? "")
);
check(
  "agent build does not generate the legacy database client",
  !/--filter @platos\/database generate/.test(packageJson.scripts?.["build:platos:agent"] ?? "")
);
check(
  "agent package does not depend on the legacy database graph",
  !agentPackage.dependencies?.["@platos/database"] &&
    !agentPackage.dependencies?.["@prisma/client"] &&
    !agentPackage.dependencies?.["@platos/sdk"]
);
check(
  "agent build audits emitted production dependencies",
  /audit:production-dependencies/.test(packageJson.scripts?.["build:platos:agent"] ?? "") &&
    Boolean(agentPackage.scripts?.["audit:production-dependencies"])
);
check(
  "tenancy database deploy includes compiled and generated runtime entries",
  ["dist", "generated"].every((path) => tenancyDatabasePackage.files?.includes(path))
);
check(
  "agent exposes a production-only strict declaration build",
  /--project tsconfig\.build\.json/.test(agentPackage.scripts?.["build:strict"] ?? "") &&
    ["src/**/*.test.ts", "src/**/*.spec.ts"].every((pattern) => agentBuildTsconfig.exclude?.includes(pattern))
);
check("webapp build is guarded by memory policy", /memory-policy\.mjs build/.test(webappPackage.scripts?.build ?? ""));
check("agent has no legacy pricing package dependency", !agentPackage.dependencies?.["@internal/cost-rates"]);
check(
  "webapp has no legacy pricing package dependency",
  !webappPackage.dependencies?.["@internal/cost-rates"] &&
    !webappPackage.dependencies?.["@internal/llm-model-catalog"]
);
check("agent image uses explicit Platos build graph", /build:platos:agent/.test(agentDockerfile));
check("agent image does not copy the legacy database schema", !agentDockerfile.includes("internal-packages/database/prisma"));
check("agent entrypoint does not generate the legacy database client", !agentEntrypoint.includes("@platos/database"));
check("webapp image uses explicit Platos build graph", /build:platos:webapp/.test(webappDockerfile));
check("core-api image uses explicit Platos build graph", /^RUN pnpm run build:platos:core-api$/m.test(coreApiDockerfile));
// The image-production milestone asks for non-root images. Read the LAST `USER`
// in the LAST stage: an earlier stage's account, or a `USER` that a later one
// resets, is not what the container runs as.
const coreApiRuntimeStage = coreApiDockerfile.slice(
  [...coreApiDockerfile.matchAll(/^FROM\s/gm)].at(-1)?.index ?? coreApiDockerfile.length
);
const coreApiRuntimeUser = [...coreApiRuntimeStage.matchAll(/^USER\s+(\S+)\s*$/gm)].at(-1)?.[1] ?? "";
check(
  "core-api image runs its final stage as a non-root account",
  coreApiRuntimeUser !== "" && !/^(?:root|0)(?::|$)/.test(coreApiRuntimeUser)
);

// ─── Deployability invariants the core-api image and its compose service state ───
// Each of these was a sentence in a comment that no gate read until an
// independent verifier mutated it with every check still green. Two verifier
// rounds found them: the first found the port, profile, edge and build-step
// sentences; the second found the runtime ENV and CMD, the warm-context exclusion,
// the migration ordering, the store addresses and the deploy override's build
// blocks. They join to things this file does not write: the config schema, the
// package's start script and tsc project, the Prisma schemas, the health
// controller's routes, the build-images candidate matrix, scripts/deploy-platos.sh,
// and a route table pinned from origin/v1.

/** Dockerfile instructions with continuation lines joined and comments dropped. */
function dockerInstructions(text) {
  const instructions = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line) || (current === "" && line.trim() === "")) continue;
    const continued = /\\\s*$/.test(line);
    current += `${current === "" ? "" : " "}${line.replace(/\\\s*$/, "").trim()}`;
    if (!continued) {
      instructions.push(current);
      current = "";
    }
  }
  if (current !== "") instructions.push(current);
  return instructions.map((instruction) => {
    const match = /^(\S+)\s*(.*)$/.exec(instruction);
    return { keyword: match[1].toUpperCase(), args: match[2], text: instruction };
  });
}

/** Variable names an ENV or ARG instruction declares. */
function declaredBuildVariables({ keyword, args }) {
  if (keyword === "ARG") return [args.split("=")[0].trim()];
  if (keyword !== "ENV") return [];
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) return [args.split(/\s+/)[0]];
  return [...args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1]);
}

// ─── No secret reaches an image layer ───
// A value baked under ENV or ARG is in a layer for anyone who pulls the image;
// credentials arrive at run time or through a secret mount. The set of names this
// refuses is JOINED TO THE CORE-API CONFIG SCHEMA: every field its six sections
// mark `secret: true`, read by importing the field tables themselves
// (scripts/lib/core-api-config-schema.mjs), not by guessing from a name. The
// verifier that found the gap baked a PostgreSQL password into the runtime stage
// as PLATOS_STORE_POSTGRES_URL and every gate stayed green, because a store URL,
// an object-store access key id and an SMTP URL are secrets whose names say none
// of SECRET, PASSWORD or TOKEN. The loader's count must also equal an independent
// count of `secret: true` in the source text, so a loader that lost a section
// cannot make this check pass by finding nothing.
const coreApiConfig = await loadCoreApiConfigFields(root);
const CORE_API_SECRET_FIELDS = new Set(coreApiConfig.fields.filter((field) => field.secret).map((field) => field.name));
check(
  `the core-api config schema yields its secret fields to this audit (${CORE_API_SECRET_FIELDS.size} imported from ${CORE_API_CONFIG_DIRECTORY}, ${coreApiConfig.sourceSecretCount} marked in its source)`,
  CORE_API_SECRET_FIELDS.size > 0 && CORE_API_SECRET_FIELDS.size === coreApiConfig.sourceSecretCount
);

// The SECOND net, kept for names no schema owns: a credential for some other
// process (a registry token, an npm token) is still refused by shape.
const CREDENTIAL_SHAPED_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ENCRYPTION_KEY|SIGNING_KEY|ROOT_KEY/i;

const buildImagesWorkflow = parseYaml(read(".github/workflows/build-images.yml"));
const candidateDockerfiles = (buildImagesWorkflow.jobs?.["build-candidates"]?.strategy?.matrix?.include ?? [])
  .map((row) => row.dockerfile)
  .filter((path) => typeof path === "string");
check(
  "the build-images candidate matrix builds the core-api Dockerfile",
  candidateDockerfiles.includes("apps/core-api/Dockerfile")
);
for (const dockerfile of candidateDockerfiles) {
  const instructions = dockerInstructions(read(dockerfile));
  const stages = new Set();
  const unpinned = [];
  for (const { keyword, args } of instructions) {
    if (keyword !== "FROM") continue;
    const match = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args);
    const image = match?.[1] ?? args;
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image) && !stages.has(image.toLowerCase())) unpinned.push(image);
    if (match?.[2]) stages.add(match[2].toLowerCase());
  }
  check(`${dockerfile}: every FROM is digest-pinned or names an earlier stage`, unpinned.length === 0);
  const declaredNames = instructions.flatMap(declaredBuildVariables);
  const schemaSecrets = declaredNames.filter((name) => CORE_API_SECRET_FIELDS.has(name));
  check(
    `${dockerfile}: no ENV or ARG, in any stage, declares a field the core-api config schema marks secret${schemaSecrets.length > 0 ? ` (found: ${[...new Set(schemaSecrets)].join(", ")})` : ""}`,
    CORE_API_SECRET_FIELDS.size > 0 && schemaSecrets.length === 0
  );
  const credentialNames = declaredNames.filter((name) => CREDENTIAL_SHAPED_NAME.test(name));
  check(`${dockerfile}: no ENV or ARG declares a credential-shaped name`, credentialNames.length === 0);
}

// ─── The node base the Debian images share ───
// apps/webapp/Dockerfile.platos and apps/core-api/Dockerfile each state that every
// node stage they build FROM reuses the digest apps/agent/Dockerfile pins, so
// neither adds a supply-chain input of its own. The webapp moved onto that digest
// on 2026-09-15, when the Debian 11 security archive had withdrawn packages its
// three apt-get steps install. The digest is read out of the agent's file rather
// than written here, so the join is between the three Dockerfiles and not to a
// literal this audit also controls; and each file must still be a build-images
// candidate, so the check cannot keep passing on a file CI no longer builds.
// migrations is a candidate too and is NOT held to this: it builds on node:22-alpine
// and states no such reuse.
//
// WHICH STAGES ARE NODE STAGES, WHATEVER REGISTRY THEY NAME. The first version of
// this check counted a FROM as a node base only when it read `node:` or
// `docker.io/library/node:`, and a verifier moved the webapp runner to
// `public.ecr.aws/docker/library/node:22-slim@sha256:3333…` with the audit green.
// Two nets now. A FROM whose repository's last path segment is `node` is a node
// stage on any registry (Docker Hub, public.ecr.aws/docker/library, quay.io, a
// mirror). And in the two files that claim the reuse, EVERY external FROM must be
// the agent's exact reference unless it is listed below as a reviewed non-node
// base, so a node image published under another repository name cannot pass as
// "not node" either.
const REVIEWED_NON_NODE_BASES = Object.freeze({
  // goose, the ClickHouse migration binary, compiled in its own stage and copied out.
  "apps/webapp/Dockerfile.platos": Object.freeze([
    "golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f",
  ]),
  "apps/core-api/Dockerfile": Object.freeze([]),
});
/** The repository path of an image reference: registry host kept, tag and digest dropped. */
function imageRepository(image) {
  const withoutDigest = image.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const tagColon = withoutDigest.indexOf(":", lastSlash + 1);
  return tagColon === -1 ? withoutDigest : withoutDigest.slice(0, tagColon);
}
/** Every FROM that is not an earlier stage, in order. */
function externalBases(dockerfile) {
  const stages = new Set();
  const bases = [];
  for (const { keyword, args } of dockerInstructions(read(dockerfile))) {
    if (keyword !== "FROM") continue;
    const match = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args);
    const image = match?.[1] ?? args;
    if (!stages.has(image.toLowerCase())) bases.push(image);
    if (match?.[2]) stages.add(match[2].toLowerCase());
  }
  return bases;
}
function isNodeImage(image) {
  return imageRepository(image).split("/").at(-1)?.toLowerCase() === "node";
}
const AGENT_DOCKERFILE = "apps/agent/Dockerfile";
const AGENT_NODE_BASE_REUSERS = Object.keys(REVIEWED_NON_NODE_BASES);
const agentNodeBases = [...new Set(externalBases(AGENT_DOCKERFILE).filter(isNodeImage))];
check(
  `${AGENT_DOCKERFILE} builds on exactly one digest-pinned node base, and on nothing else`,
  candidateDockerfiles.includes(AGENT_DOCKERFILE) &&
    agentNodeBases.length === 1 &&
    /^[^\s@]+@sha256:[0-9a-f]{64}$/.test(agentNodeBases[0]) &&
    externalBases(AGENT_DOCKERFILE).every((image) => image === agentNodeBases[0])
);
const agentNodeDigest = agentNodeBases.length === 1 ? agentNodeBases[0].split("@")[1] : null;
for (const dockerfile of AGENT_NODE_BASE_REUSERS) {
  const bases = externalBases(dockerfile);
  const nodeBases = bases.filter(isNodeImage);
  const unreviewedOthers = bases.filter(
    (image) => !isNodeImage(image) && !REVIEWED_NON_NODE_BASES[dockerfile].includes(image)
  );
  check(
    `${dockerfile}: is a build-images candidate, every node stage on any registry is exactly the ${AGENT_DOCKERFILE} reference (digest ${agentNodeDigest ?? "unresolved"}), and every other base is a reviewed non-node base${nodeBases.some((image) => image !== agentNodeBases[0]) ? ` (differs: ${nodeBases.filter((image) => image !== agentNodeBases[0]).join(", ")})` : ""}${unreviewedOthers.length > 0 ? ` (unreviewed: ${unreviewedOthers.join(", ")})` : ""}`,
    candidateDockerfiles.includes(dockerfile) &&
      agentNodeBases.length === 1 &&
      nodeBases.length > 0 &&
      nodeBases.every((image) => image === agentNodeBases[0]) &&
      unreviewedOthers.length === 0
  );
}
for (const dockerfile of candidateDockerfiles) {
  const bullseye = dockerInstructions(read(dockerfile)).filter(
    ({ keyword, args }) => keyword === "FROM" && /bullseye/i.test(args)
  );
  check(`${dockerfile}: no stage builds FROM a Debian 11 (bullseye) image`, bullseye.length === 0);
}

// ─── The MinIO images both compose files pull ───
// Docker Hub stopped serving minio/minio and minio/mc (both repositories answered
// 404 on 2026-09-15, and build-images run 35008577255 failed at "pull access
// denied"). The persisted-state gate's compose file says it now pulls both from
// quay.io at the digests pinned before, and that docker-compose.platos.yml carries
// the same two references. Hold both halves: every MinIO image either file names
// is a digest-pinned quay.io/minio reference, each file names a server and a
// client image, and the two files name exactly the same set.
const MINIO_COMPOSE_FILES = ["docker-compose.platos.yml", ".github/compose/persisted-state-gate.yml"];
const minioImagesByFile = MINIO_COMPOSE_FILES.map((file) => {
  const services = parseYaml(read(file), { merge: true })?.services ?? {};
  return Object.values(services)
    .map((service) => String(service?.image ?? ""))
    .filter((image) => /(?:^|\/)minio\/(?:minio|mc)[:@]/.test(image));
});
MINIO_COMPOSE_FILES.forEach((file, index) => {
  const images = minioImagesByFile[index];
  check(
    `${file}: every MinIO image is a digest-pinned quay.io/minio reference, with a server and a client image`,
    images.some((image) => image.startsWith("quay.io/minio/minio:")) &&
      images.some((image) => image.startsWith("quay.io/minio/mc:")) &&
      images.every((image) => /^quay\.io\/minio\/(?:minio|mc):RELEASE\.[^\s@]+@sha256:[0-9a-f]{64}$/.test(image))
  );
});
check(
  `${MINIO_COMPOSE_FILES.join(" and ")} name the same MinIO image references`,
  JSON.stringify([...new Set(minioImagesByFile[0])].sort()) ===
    JSON.stringify([...new Set(minioImagesByFile[1])].sort())
);

// The webapp Dockerfile's base comment says the move to OpenSSL 3 needs no
// schema change because the Prisma client it generates lists `native`, which
// resolves to the build stage's own OpenSSL engine. Hold that to every
// `prisma generate --schema` the Dockerfile runs and the schema file it names.
const webappPrismaGenerates = dockerInstructions(webappDockerfile)
  .filter(({ keyword }) => keyword === "RUN")
  .map(({ args }) => /cd\s+\/platos\/(\S+)\s+&&\s+pnpx\s+prisma@\S+\s+generate\s+--schema\s+(\S+)/.exec(args))
  .filter(Boolean)
  .map((match) => `${match[1]}/${match[2]}`);
check("apps/webapp/Dockerfile.platos generates at least one Prisma client", webappPrismaGenerates.length > 0);
for (const schemaPath of webappPrismaGenerates) {
  const generator = /generator\s+\w+\s*\{([\s\S]*?)\}/.exec(existsSync(join(root, schemaPath)) ? read(schemaPath) : "")?.[1] ?? "";
  const targets = /binaryTargets\s*=\s*\[([^\]]*)\]/.exec(generator)?.[1] ?? "";
  check(
    `${schemaPath} (generated by apps/webapp/Dockerfile.platos) lists the native engine target`,
    /"native"/.test(targets)
  );
}

const coreApiInstructions = dockerInstructions(coreApiDockerfile);
const coreApiDeployIndex = coreApiInstructions.findIndex(
  ({ text }) => text === "RUN node scripts/deploy-bundle-closure.mjs deploy --importer apps/core-api --bundle /deploy"
);
const coreApiClosureIndex = coreApiInstructions.findIndex(
  ({ text }) => text === "RUN node scripts/deploy-bundle-closure.mjs check --bundle /deploy --importer apps/core-api"
);
const coreApiRuntimeFromIndex = coreApiInstructions.findLastIndex(({ keyword }) => keyword === "FROM");
check(
  "core-api image deploys its production bundle from the shared lockfile, then proves the bundle against the lockfile before the runtime stage",
  coreApiDeployIndex >= 0 && coreApiClosureIndex > coreApiDeployIndex && coreApiRuntimeFromIndex > coreApiClosureIndex
);
// D-ZOD. SHIPPED MUST EQUAL TESTED, so the image may neither fall back to the
// legacy deploy that re-resolved the Slack adapter's peers against zod 3, nor
// record a closure package as reviewed-absent: an absence is exactly a package
// the workspace tests use and the image does not ship.
const { REVIEWED_ABSENT: DEPLOY_REVIEWED_ABSENT } = await import("./deploy-bundle-closure.mjs");
check(
  "core-api image never uses a legacy deploy, and its bundle is allowed no reviewed absence from the lockfile closure",
  !coreApiInstructions.some(({ keyword, args }) => keyword === "RUN" && /(?:^|\s)--legacy(?:\s|$)|force-legacy-deploy/.test(args)) &&
    Array.isArray(DEPLOY_REVIEWED_ABSENT["apps/core-api"]) &&
    DEPLOY_REVIEWED_ABSENT["apps/core-api"].length === 0
);

const coreApiSchema = read("apps/core-api/src/config/schema.ts");
const coreApiPortDefault = /name:\s*"PLATOS_CORE_API_PORT",[\s\S]*?defaultValue:\s*"(\d+)"/.exec(coreApiSchema)?.[1] ?? null;
check(
  "core-api image exposes the config module's default port",
  coreApiPortDefault !== null &&
    coreApiInstructions.filter(({ keyword }) => keyword === "EXPOSE").map(({ args }) => args).join(" ") === coreApiPortDefault
);

// ─── What the runtime stage runs, and on which interface ───
// Two runtime-stage lines decide whether the image can serve at all, and an
// independent verifier mutated both with every gate still green: without the
// HOST line the container logs, passes a loopback healthcheck and is unreachable
// through every published port; with CMD pointed elsewhere it never starts.
// Each is joined to the file that makes it true: the config schema's field and
// its loopback default, the package's own `start` script, and the TypeScript
// project whose output directory that script names.
const coreApiRuntimeInstructions = coreApiInstructions.slice(coreApiRuntimeFromIndex + 1);

/** ENV assignments in instruction order, both `ENV K=V ...` and legacy `ENV K V`. Later wins. */
function envAssignments(instructions) {
  const assignments = new Map();
  for (const { keyword, args } of instructions) {
    if (keyword !== "ENV") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) {
      const [name, ...value] = args.split(/\s+/);
      assignments.set(name, value.join(" "));
      continue;
    }
    for (const match of args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
      assignments.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
    }
  }
  return assignments;
}

const coreApiHostDefault = /name:\s*"PLATOS_CORE_API_HOST",[\s\S]*?defaultValue:\s*"([^"]*)"/.exec(coreApiSchema)?.[1] ?? null;
check(
  "core-api image's runtime stage binds every interface: PLATOS_CORE_API_HOST=0.0.0.0 overrides the config module's loopback default",
  coreApiHostDefault === "127.0.0.1" && envAssignments(coreApiRuntimeInstructions).get("PLATOS_CORE_API_HOST") === "0.0.0.0"
);

const coreApiPackage = JSON.parse(read("apps/core-api/package.json"));
const coreApiTsconfig = JSON.parse(read("apps/core-api/tsconfig.json"));
const coreApiStartArgv = (coreApiPackage.scripts?.start ?? "").trim().split(/\s+/).filter(Boolean);
const coreApiCmd = coreApiRuntimeInstructions.filter(({ keyword }) => keyword === "CMD").at(-1)?.args ?? "";
let coreApiCmdArgv = null;
try {
  const parsed = JSON.parse(coreApiCmd);
  if (Array.isArray(parsed) && parsed.every((word) => typeof word === "string")) coreApiCmdArgv = parsed;
} catch {
  coreApiCmdArgv = null;
}
check(
  "core-api image's CMD is exec form and exactly apps/core-api/package.json's `start` script",
  coreApiCmdArgv !== null && coreApiStartArgv.length > 0 && JSON.stringify(coreApiCmdArgv) === JSON.stringify(coreApiStartArgv)
);
// V3-4. `dev` SERVES. It used to be `tsc -b --watch`, which recompiled and never
// started a listener, while the sibling deployables' dev scripts serve
// (apps/agent: `nest start --watch`). The runner joins the package's own `build`
// and `start` scripts rather than restating them; this holds the script to that
// runner and the runner to both joins, so neither can be dropped with CI green.
const CORE_API_DEV_RUNNER = "apps/core-api/scripts/dev.mjs";
const coreApiDevRunner = existsSync(join(root, CORE_API_DEV_RUNNER)) ? read(CORE_API_DEV_RUNNER) : "";
check(
  `core-api's dev script serves: it runs ${CORE_API_DEV_RUNNER}, which watches the package's tsc build script and restarts its start script after each clean compilation`,
  coreApiPackage.scripts?.dev === `node ${CORE_API_DEV_RUNNER.slice("apps/core-api/".length)}` &&
    /^tsc -b(?:\s|$)/.test(coreApiPackage.scripts?.build ?? "") &&
    coreApiDevRunner.includes("scripts.build") &&
    coreApiDevRunner.includes("scripts.start") &&
    coreApiDevRunner.includes('"--watch"') &&
    /Found \(\\d\+\) errors\?/.test(coreApiDevRunner)
);
check(
  "core-api image's runtime stage declares no ENTRYPOINT of its own that would change what CMD runs",
  !coreApiRuntimeInstructions.some(({ keyword }) => keyword === "ENTRYPOINT")
);
const coreApiOutDir = String(coreApiTsconfig.compilerOptions?.outDir ?? "").replace(/^\.\//, "").replace(/\/$/, "");
const coreApiRootDir = String(coreApiTsconfig.compilerOptions?.rootDir ?? "").replace(/^\.\//, "").replace(/\/$/, "");
const coreApiEntry = coreApiStartArgv.at(-1) ?? "";
const coreApiRuntimeWorkdir = coreApiRuntimeInstructions.filter(({ keyword }) => keyword === "WORKDIR").at(-1)?.args ?? "";
const coreApiBuilderWorkdir =
  coreApiInstructions
    .slice(0, coreApiRuntimeFromIndex)
    .filter(({ keyword }) => keyword === "WORKDIR")
    .at(-1)?.args ?? "";
check(
  "core-api's start entry is the tsc output of src/main.ts, and the runtime stage copies that output directory to where CMD resolves it",
  coreApiOutDir !== "" &&
    coreApiRootDir !== "" &&
    coreApiEntry === `${coreApiOutDir}/main.js` &&
    existsSync(join(root, "apps/core-api", coreApiRootDir, "main.ts")) &&
    coreApiPackage.main === `./${coreApiEntry}` &&
    coreApiRuntimeWorkdir.startsWith("/") &&
    coreApiBuilderWorkdir.startsWith("/") &&
    coreApiRuntimeInstructions.some(
      ({ keyword, args }) =>
        keyword === "COPY" &&
        [
          `--from=builder ${coreApiBuilderWorkdir}/apps/core-api/${coreApiOutDir} ./${coreApiOutDir}`,
          `--from=builder ${coreApiBuilderWorkdir}/apps/core-api/${coreApiOutDir} ${coreApiRuntimeWorkdir}/${coreApiOutDir}`,
        ].includes(args)
    )
);

// ─── The build context a WARM tree sends ───
// The tenancy client is generated into directories the Prisma schemas name. They
// are gitignored, so a cold checkout never has them and a warm one does, and a
// host-generated client (another platform's query engine) reaches an image only
// if the context carries it. The output directories are read from the schemas,
// not restated, and .dockerignore must exclude each one without re-including it.
const dockerignoreLines = read(".dockerignore")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
const tenancyPrismaDirectory = "internal-packages/tenancy-database/prisma";
const tenancyClientOutputs = readdirSync(join(root, tenancyPrismaDirectory))
  .filter((entry) => entry.endsWith(".prisma"))
  .flatMap((entry) =>
    [...read(`${tenancyPrismaDirectory}/${entry}`).matchAll(/^\s*output\s*=\s*"([^"]+)"/gm)].map((match) =>
      join(tenancyPrismaDirectory, match[1]).split("\\").join("/")
    )
  );
/** A literal (glob-free) exclusion covering `path`, with no later `!` line re-including any of it. */
function dockerignoreExcludes(path) {
  const normalize = (pattern) => pattern.replace(/^\//, "").replace(/\/$/, "");
  const index = dockerignoreLines.findIndex((line) => {
    const pattern = normalize(line);
    return !line.startsWith("!") && !/[*?[]/.test(pattern) && (path === pattern || path.startsWith(`${pattern}/`));
  });
  if (index === -1) return false;
  const excluded = normalize(dockerignoreLines[index]);
  return !dockerignoreLines.slice(index + 1).some((line) => line.startsWith("!") && normalize(line.slice(1)).startsWith(excluded));
}
check(
  "every generated tenancy client directory the Prisma schemas name is excluded from the image build context",
  tenancyClientOutputs.length > 0 && tenancyClientOutputs.every(dockerignoreExcludes)
);

const composeDocument = parseYaml(compose, { merge: true });
const coreApiService = composeDocument.services?.["core-api"] ?? {};
check(
  "core-api compose service leaves the image's listener interface alone",
  coreApiService.environment?.PLATOS_CORE_API_HOST === undefined
);
check("core-api compose service is opt-in behind exactly the core-api profile", JSON.stringify(coreApiService.profiles) === '["core-api"]');
const coreApiPorts = (coreApiService.ports ?? []).map(String);
const coreApiLoopback =
  coreApiPortDefault === null ? null : new RegExp(`^127\\.0\\.0\\.1:(\\d+):${coreApiPortDefault}$`).exec(coreApiPorts[0] ?? "");
check(
  "core-api publishes exactly one port, bound to host loopback, onto the config default port",
  coreApiPorts.length === 1 && coreApiLoopback !== null
);
const coreApiHostPort = coreApiLoopback?.[1] ?? null;
const healthController = read("apps/core-api/src/http/health.controller.ts");
const coreApiHealthcheck = [coreApiService.healthcheck?.test ?? []].flat().map(String).join(" ");
// THROUGH THE CONTAINER'S NETWORK ADDRESS, NOT LOOPBACK. A listener bound to
// 127.0.0.1 inside the container answers a loopback probe and nothing else, so a
// loopback healthcheck reports that container healthy while every published port
// and every other service on the network gets a refused connection.
check(
  "core-api healthcheck probes liveness on the container port through the container's own network address, never loopback, never readiness",
  /@Get\("livez"\)/.test(healthController) &&
    coreApiPortDefault !== null &&
    coreApiHealthcheck.includes("host: require('os').hostname()") &&
    coreApiHealthcheck.includes("family: 4") &&
    coreApiHealthcheck.includes(`port: ${coreApiPortDefault}`) &&
    coreApiHealthcheck.includes("path: '/livez'") &&
    !/127\.0\.0\.1|localhost|::1|readyz/.test(coreApiHealthcheck)
);

// ─── Ordering against the migrations, and the addresses of the stores ───
// Both are properties no image test sees: an image started by hand is given its
// addresses and started after the migrations by whoever starts it. In compose
// they are decided here. The one-shot database jobs are derived, not listed:
// every service built from the migrations Dockerfile whose DATABASE_URL names
// the same PostgreSQL host core-api's store URL names.
/** A compose URL with its interpolations neutralized, parsed; null when it is not a URL. */
function composeUrl(value) {
  try {
    return new URL(String(value ?? "").replace(/\$\{[^}]*\}/g, "x"));
  } catch {
    return null;
  }
}
/** The container-side port of a service's first published mapping, as a string. */
function containerPort(service) {
  return String((service?.ports ?? [])[0] ?? "").split(":").at(-1) || null;
}
const composeServices = composeDocument.services ?? {};
const coreApiDependsOn = coreApiService.depends_on ?? {};
const coreApiEnvironment = coreApiService.environment ?? {};
const coreApiPostgresUrl = composeUrl(coreApiEnvironment.PLATOS_STORE_POSTGRES_URL);
const coreApiRedisUrl = composeUrl(coreApiEnvironment.PLATOS_STORE_REDIS_URL);
const coreApiPostgresService = composeServices[coreApiPostgresUrl?.hostname ?? ""];
const coreApiRedisService = composeServices[coreApiRedisUrl?.hostname ?? ""];
check(
  "core-api's PostgreSQL URL names the compose PostgreSQL service, on its container port and database, and core-api waits for it to be healthy",
  coreApiPostgresUrl?.protocol === "postgresql:" &&
    /^(?:pgvector\/pgvector|postgres):/.test(String(coreApiPostgresService?.image ?? "")) &&
    coreApiPostgresUrl.port === containerPort(coreApiPostgresService) &&
    String(coreApiEnvironment.PLATOS_STORE_POSTGRES_URL).endsWith(`/${coreApiPostgresService?.environment?.POSTGRES_DB}`) &&
    coreApiDependsOn[coreApiPostgresUrl.hostname]?.condition === "service_healthy"
);
check(
  "core-api's Redis URL names the compose Redis service on its container port, and core-api waits for it to be healthy",
  coreApiRedisUrl?.protocol === "redis:" &&
    /^redis:/.test(String(coreApiRedisService?.image ?? "")) &&
    coreApiRedisUrl.port === containerPort(coreApiRedisService) &&
    coreApiDependsOn[coreApiRedisUrl.hostname]?.condition === "service_healthy"
);
const tenancyMigrationJobs = Object.entries(composeServices)
  .filter(
    ([, service]) =>
      service?.build?.dockerfile === "internal-packages/tenancy-database/Dockerfile.migrations" &&
      coreApiPostgresUrl !== null &&
      composeUrl(service.environment?.DATABASE_URL)?.hostname === coreApiPostgresUrl.hostname
  )
  .map(([name]) => name)
  .sort();
check(
  `core-api starts only after every one-shot job that migrates its PostgreSQL database completes (${tenancyMigrationJobs.join(", ") || "none found"})`,
  tenancyMigrationJobs.length > 0 &&
    tenancyMigrationJobs.every((name) => coreApiDependsOn[name]?.condition === "service_completed_successfully")
);

// ─── What the pull-only deploy override leaves able to compile on the box ───
// `docker compose up` builds any service that has a `build:` block and no local
// image, whether or not `build` is passed (measured on compose 5.1.3 with
// `up --dry-run`). docker-compose.deploy.yml's header used to say it "removes
// every application build block"; under it, core-api and docs-mcp-bridge keep
// theirs (docs-mcp-bridge already did on origin/v1). The header now says so: its
// owner-authorization byte pin in scripts/clickhouse-split-audit.mjs was
// re-baselined to the corrected bytes under D-DEPLOY-HEADER
// (docs/adr/M2-M4-delegated-decisions-2026-09-15.md). The exact set is pinned
// here, computed from the two files as compose merges them, the header must name
// that set, and every service scripts/deploy-platos.sh pulls or starts must be
// reset to a required digest reference.
const SERVICES_KEEPING_A_BUILD_BLOCK_UNDER_DEPLOY = Object.freeze(["core-api", "docs-mcp-bridge"]);
const COMPOSE_RESET = Symbol("compose !reset");
const deployOverride = parseYaml(read("docker-compose.deploy.yml"), {
  customTags: [{ tag: "!reset", resolve: () => COMPOSE_RESET }],
});
const deployOverrideServices = deployOverride?.services ?? {};
const keepsBuildUnderDeploy = Object.entries(composeServices)
  .filter(([name, service]) => service?.build !== undefined && deployOverrideServices[name]?.build !== COMPOSE_RESET)
  .map(([name]) => name)
  .sort();
check(
  `exactly the reviewed services keep a build block under the deploy override (now: ${keepsBuildUnderDeploy.join(", ") || "none"})`,
  JSON.stringify(keepsBuildUnderDeploy) === JSON.stringify([...SERVICES_KEEPING_A_BUILD_BLOCK_UNDER_DEPLOY].sort())
);
const deployOverrideHeader = read("docker-compose.deploy.yml").split("\nservices:")[0];
check(
  "docker-compose.deploy.yml's header names every service that keeps a build block under it, and no longer claims to remove every build block",
  keepsBuildUnderDeploy.length > 0 &&
    keepsBuildUnderDeploy.every((name) => deployOverrideHeader.includes(`\`${name}\``)) &&
    !/removes every application build block/.test(deployOverrideHeader) &&
    !/ignores `build:` when you don't pass `build`/.test(deployOverrideHeader)
);
check(
  "of the services keeping a build block under the deploy override, only the reviewed pre-existing docs-mcp-bridge starts without a profile",
  keepsBuildUnderDeploy
    .filter((name) => !(Array.isArray(composeServices[name]?.profiles) && composeServices[name].profiles.length > 0))
    .every((name) => name === "docs-mcp-bridge")
);
const deployScript = read("scripts/deploy-platos.sh");
const deployAppServices = (/^APP_SERVICES="([^"]+)"$/m.exec(deployScript)?.[1] ?? "").split(/\s+/).filter(Boolean);
const deployPulledServices = (/^docker compose \$COMPOSE_FILES pull \$APP_SERVICES (.+)$/m.exec(deployScript)?.[1] ?? "")
  .split(/\s+/)
  .filter(Boolean);
const deployPathServices = [...new Set([...deployAppServices, ...deployPulledServices])].sort();
check(
  `every service scripts/deploy-platos.sh pulls or starts is reset to a required digest reference by the deploy override (${deployPathServices.join(", ")})`,
  deployAppServices.length > 0 &&
    deployPulledServices.length > 0 &&
    deployPathServices.every(
      (name) =>
        deployOverrideServices[name]?.build === COMPOSE_RESET &&
        /^\$\{PLATOS_[A-Z_]+_IMAGE:\?[^}]+\}$/.test(String(deployOverrideServices[name]?.image ?? ""))
    )
);
/** Every service `names` start, following depends_on. */
function dependencyClosure(names) {
  const seen = new Set();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...Object.keys(composeServices[name]?.depends_on ?? {}));
  }
  return seen;
}
const deployPathClosure = dependencyClosure(deployPathServices);
check(
  "no service the deploy path starts, directly or through depends_on, keeps a build block under the deploy override",
  keepsBuildUnderDeploy.every((name) => !deployPathClosure.has(name))
);
check(
  "core-api passes PLATOS_ENVIRONMENT through blank when unset: the process refuses it, the parse does not",
  coreApiService.environment?.PLATOS_ENVIRONMENT === "${PLATOS_ENVIRONMENT:-}"
);
check(
  "core-api, an opt-in profile service, makes no variable mandatory at parse time",
  !/\$\{[A-Za-z_][A-Za-z0-9_]*:?\?/.test(JSON.stringify(coreApiService))
);
check(
  "agent publishes its port on host loopback only",
  JSON.stringify((composeDocument.services?.agent?.ports ?? []).map(String)) === '["127.0.0.1:3100:3100"]'
);

/** Every reverse_proxy in a Caddyfile, with the host and handle block it sits in. */
function caddyRoutes(text) {
  const routes = [];
  const stack = [];
  for (const line of text.split("\n").map((raw) => raw.replace(/#.*$/, "").trim()).filter(Boolean)) {
    if (line === "}") {
      stack.pop();
      continue;
    }
    const opens = line.endsWith("{");
    const body = opens ? line.slice(0, -1).trim() : line;
    const [word, ...rest] = body.split(/\s+/);
    const top = stack.at(-1);
    if (top === undefined) {
      stack.push({ kind: "host", host: body });
      continue;
    }
    if (top.kind === "proxy") {
      top.route.options.push(body);
      if (opens) stack.push({ kind: "other" });
      continue;
    }
    const host = stack.find((frame) => frame.kind === "host")?.host ?? null;
    const handle = [...stack].reverse().find((frame) => frame.kind === "handle");
    if (word === "reverse_proxy") {
      const route = {
        host,
        directive: handle?.directive ?? null,
        matcher: handle?.matcher ?? null,
        upstream: rest.join(" "),
        options: [],
      };
      routes.push(route);
      if (opens) stack.push({ kind: "proxy", route });
    } else if (opens) {
      stack.push(word === "handle" || word === "handle_path" ? { kind: "handle", directive: word, matcher: rest.join(" ") || null } : { kind: "other" });
    }
  }
  return routes;
}

// The edge as origin/v1 (7fd2e4fb) routes it: eight reverse_proxy routes on the two
// host blocks that existed there, fingerprinted as the parsed table below rather
// than as bytes, so a comment can change and a retarget cannot. Pointing any of
// them at core-api IS the cutover, and that is a decision this file must not let
// through as an edit.
const V1_EDGE_HOSTS = Object.freeze(["test.platos.dev", "agent.test.platos.dev"]);
const V1_EDGE_ROUTE_COUNT = 8;
const V1_EDGE_ROUTES_SHA256 = "4e9b0c5fe5be7f0ffff4f1b1f4960a5060023e669d01796395e62d3fc4c0797f";
const CORE_API_EDGE_HOST = "core.test.platos.dev";
const edgeRoutes = caddyRoutes(read("deploy/Caddyfile"));
const v1EdgeRoutes = edgeRoutes.filter((route) => V1_EDGE_HOSTS.includes(route.host));
const v1EdgeFingerprint = createHash("sha256")
  .update(JSON.stringify(v1EdgeRoutes.map(({ host, directive, matcher, upstream, options }) => [host, directive, matcher, upstream, options])))
  .digest("hex");
check(
  `no existing edge route changes target (${V1_EDGE_ROUTE_COUNT} routes on ${V1_EDGE_HOSTS.join(", ")}, pinned from origin/v1)`,
  v1EdgeRoutes.length === V1_EDGE_ROUTE_COUNT && v1EdgeFingerprint === V1_EDGE_ROUTES_SHA256
);
if (v1EdgeFingerprint !== V1_EDGE_ROUTES_SHA256) {
  for (const route of v1EdgeRoutes) console.error(`  edge route now: ${JSON.stringify(route)}`);
}
check(
  "the edge has exactly the v1 host blocks plus core-api's own",
  JSON.stringify([...new Set(edgeRoutes.map((route) => route.host))].sort()) ===
    JSON.stringify([...V1_EDGE_HOSTS, CORE_API_EDGE_HOST].sort())
);
const coreApiEdgeRoutes = edgeRoutes.filter((route) => route.host === CORE_API_EDGE_HOST);
check(
  "core-api's edge host has one unmatched route to core-api's loopback host port",
  coreApiHostPort !== null &&
    coreApiEdgeRoutes.length === 1 &&
    coreApiEdgeRoutes[0].matcher === null &&
    coreApiEdgeRoutes[0].upstream === `localhost:${coreApiHostPort}`
);
// D-COOKIE. The interim `header_down -Set-Cookie` on core-api's host is gone, and
// that is safe only while two schema facts hold, so the check joins the edge to
// the config field tables rather than to a sentence in operator.ts: core-api
// believes no forwarded header unless PLATOS_CORE_API_TRUSTED_PROXY is set (its
// default is null), and it issues the session cookie only as a Secure __Host-
// cookie over TLS unless an operator says otherwise
// (PLATOS_SECURITY_SESSION_COOKIE_SECURE defaults to true). Flip either default
// and a cookie could leave this host without Secure, so either flip fails here.
const coreApiFieldDefault = (name) => coreApiConfig.fields.find((field) => field.name === name)?.defaultValue;
check(
  "core-api's edge host passes responses through unmodified, and only because core-api trusts no proxy and issues only a Secure session cookie by default",
  JSON.stringify(coreApiEdgeRoutes[0]?.options ?? null) === "[]" &&
    coreApiFieldDefault("PLATOS_CORE_API_TRUSTED_PROXY") === null &&
    coreApiFieldDefault("PLATOS_SECURITY_SESSION_COOKIE_SECURE") === "true"
);
check(
  "core-api's compose service passes the trusted proxy and the three session cookie settings through blank",
  ["PLATOS_CORE_API_TRUSTED_PROXY", "PLATOS_SECURITY_SESSION_COOKIE_SECURE", "PLATOS_SECURITY_SESSION_COOKIE_NAME", "PLATOS_SECURITY_SESSION_SAME_SITE"].every(
    (name) => coreApiService.environment?.[name] === `\${${name}:-}` && coreApiConfig.fields.some((field) => field.name === name)
  )
);
check(
  "no other edge route reaches core-api's host port",
  coreApiHostPort !== null &&
    edgeRoutes.filter((route) => route.host !== CORE_API_EDGE_HOST).every((route) => !route.upstream.endsWith(`:${coreApiHostPort}`))
);

const webappCompose = compose.split(/^  (?=\S)/m).find((service) => service.startsWith("webapp:")) ?? "";
check("webapp service receives the documented runtime heap variable", /WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB/.test(webappCompose));

for (const path of [
  "apps/agent/src/agent-runtime/turn-dispatch.service.ts",
  "apps/agent/src/trigger-bridge/runs-bridge.service.ts",
  "apps/agent/src/agent-runtime/agent.service.ts",
]) {
  const source = read(path);
  check(`${path} has no implicit Trigger Cloud endpoint`, !source.includes("https://api.trigger.dev"));
  check(`${path} has no implicit localhost/webapp Trigger endpoint`, !/http:\/\/(?:localhost|webapp):\d+/.test(source));
}
for (const path of [
  "apps/agent/src/agent-runtime/agent-task.service.ts",
  "apps/agent/src/agent-runtime/jobs.controller.ts",
  "apps/agent/src/mcp-platform/tools/jobs.ts",
  "apps/agent/src/skills/official/skill-handlers.ts",
]) {
  const source = read(path);
  check(`${path} does not gate SDK calls on the secret alone`, !source.includes("!!process.env.TRIGGER_SECRET_KEY"));
  check(`${path} uses the explicit external Trigger gate`, source.includes("configureExternalTriggerSdk"));
}

// WIN-132 removes Platos-hosted Trigger execution while deliberately leaving
// the broader run-engine package in place for still-deferred dashboard
// consumers. Keep those two facts distinct so this audit catches either a
// reintroduced Mode-C surface or an accidental package deletion.
check("deferred run-engine package remains present", existsSync(join(root, "internal-packages/run-engine/package.json")));
check("local Trigger worker is absent", !existsSync(join(root, "apps/agent/src/trigger-worker.ts")));
check("local Trigger worker compose service is absent", !/^  worker:/m.test(compose));
check(
  "local Trigger engine routes are absent",
  !existsSync(join(root, "apps/webapp/app/routes/engine.v1.worker-actions.connect.ts"))
);

for (const path of [
  ...sourceFiles("apps/agent/src"),
  ...sourceFiles("apps/webapp/app"),
]) {
  if (!/\.(?:ts|tsx|mts)$/.test(path) || /\.(?:test|spec)\./.test(path)) continue;
  const source = read(path);
  check(`${path} has no legacy pricing package import`, !/@internal\/(?:cost-rates|llm-model-catalog)/.test(source));
  check(`${path} has no Redis model catalogue authority`, !source.includes("cost:model_catalog"));
  check(`${path} has no inherited pricing delegate`, !/\.(?:llmModel|llmPrice|llmPricingTier)\b/.test(source));
  check(`${path} has no agent-local verified prices`, !source.includes("verified-prices"));
}

console.log(`platos-build-audit: ${checks.length} checks`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
for (const description of checks) console.log(`  ok: ${description}`);
