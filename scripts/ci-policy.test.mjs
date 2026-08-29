import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const expectedCandidates = [
  {
    name: "agent",
    image: "platos-agent",
    dockerfile: "apps/agent/Dockerfile",
    env_name: "AGENT",
  },
  {
    name: "webapp",
    image: "platos-webapp",
    dockerfile: "apps/webapp/Dockerfile.platos",
    env_name: "WEBAPP",
  },
  {
    name: "migrations",
    image: "platos-migrations",
    dockerfile: "internal-packages/tenancy-database/Dockerfile.migrations",
    env_name: "MIGRATIONS",
  },
];
const expectedInstallInstructions = new Map([
  [
    "apps/agent/Dockerfile",
    ["RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile"],
  ],
  [
    "apps/webapp/Dockerfile.platos",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --prod --filter webapp... --frozen-lockfile",
    ],
  ],
  ["internal-packages/tenancy-database/Dockerfile.migrations", ["RUN pnpm install --frozen-lockfile --prod"]],
]);
const expectedPnpmRunInstructions = new Map([
  [
    "apps/agent/Dockerfile",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
      "RUN pnpm run build:platos:agent",
      "RUN pnpm --filter platos-agent deploy --prod --legacy /deploy",
    ],
  ],
  [
    "apps/webapp/Dockerfile.platos",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
      "RUN cd /platos/internal-packages/tenancy-database && pnpx prisma@6.14.0 generate --schema prisma/schema.prisma",
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --prod --filter webapp... --frozen-lockfile",
      "RUN --mount=type=secret,id=sentry_auth_token SENTRY_AUTH_TOKEN=$(cat /run/secrets/sentry_auth_token 2>/dev/null || true) pnpm run build:platos:webapp",
    ],
  ],
  ["internal-packages/tenancy-database/Dockerfile.migrations", ["RUN pnpm install --frozen-lockfile --prod"]],
]);
const expectedSetupNodeCounts = new Map([
  ["ci", 3],
  ["buildImages", 1],
]);
const relocatedCommands = [
  "pnpm --filter platos-agent exec vitest run src/auth/rate-limit.guard.test.ts",
  "pnpm --filter platos-agent exec vitest run src/memory/memory-profile-startup-verifier.service.test.ts",
  "pnpm --filter platos-agent exec vitest run src/startup-failure.test.ts",
  "pnpm test:persisted-state:performance-contract",
  "pnpm test:non-browser-completion:contract",
  "pnpm test:browser-evidence:contract",
  "pnpm test:route-parity:completion:evidence",
];
const shippingDockerfiles = [...expectedInstallInstructions.keys()];
const shellInterpreters = new Set(["bash", "sh", "dash", "zsh", "ksh", "ash"]);
const corepackManagementCommands = new Set([
  "cache",
  "disable",
  "enable",
  "hydrate",
  "install",
  "pack",
  "prepare",
  "up",
  "use",
]);

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function fixtures() {
  return {
    nvmrc: source(".nvmrc"),
    packageJson: source("package.json"),
    ci: source(".github/workflows/ci.yml"),
    buildImages: source(".github/workflows/build-images.yml"),
    dockerfiles: Object.fromEntries(shippingDockerfiles.map((file) => [file, source(file)])),
  };
}

function parseWorkflow(workflow, label, violations) {
  let document;
  try {
    document = parseDocument(workflow, { prettyErrors: false, uniqueKeys: true });
  } catch {
    violations.push(`${label} must remain valid, uniquely keyed YAML`);
    return {};
  }
  if (document.errors.length > 0) {
    violations.push(`${label} must remain valid, uniquely keyed YAML`);
    return {};
  }
  let parsed;
  try {
    parsed = document.toJS();
  } catch {
    violations.push(`${label} must remain valid, uniquely keyed YAML`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    violations.push(`${label} must contain a workflow mapping`);
    return {};
  }
  return parsed;
}

function workflowJobs(workflow) {
  const jobs = workflow?.jobs;
  return jobs !== null && typeof jobs === "object" && !Array.isArray(jobs) ? new Map(Object.entries(jobs)) : new Map();
}

function workflowSteps(job) {
  return Array.isArray(job?.steps) ? job.steps.filter((step) => step !== null && typeof step === "object") : [];
}

function executableRunValues(job) {
  return workflowSteps(job).map((step) => step.run).filter((run) => typeof run === "string");
}

function allWorkflowSteps(workflow) {
  return [...workflowJobs(workflow).values()].flatMap(workflowSteps);
}

function permissionDeclarations(workflow) {
  return [workflow?.permissions, ...[...workflowJobs(workflow).values()].map((job) => job?.permissions)].filter(
    (permissions) => permissions !== undefined && permissions !== null
  );
}

function eventBranches(workflow, eventName) {
  const branches = workflow?.on?.[eventName]?.branches;
  return Array.isArray(branches) ? branches : null;
}

function imageCandidates(buildCandidatesJob) {
  const candidates = buildCandidatesJob?.strategy?.matrix?.include;
  return Array.isArray(candidates) ? candidates : [];
}

function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  const flush = () => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        flush();
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (command[index + 1] === "\n") {
        index += 1;
        current += " ";
      } else {
        escaped = true;
        current += character;
      }
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "#" && (current === "" || /\s$/u.test(current))) {
      comment = true;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (character === "\n" || character === ";" || character === "|" || pair === "&&" || pair === "||") {
      flush();
      if (pair === "&&" || pair === "||") index += 1;
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

function shellWords(segment) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const flush = () => {
    if (current !== "") words.push(current);
    current = "";
  };
  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "<" || character === ">") {
      flush();
      words.push(character);
    } else if (/\s/u.test(character)) {
      flush();
    } else {
      current += character;
    }
  }
  flush();
  return words;
}

function executableShellArgv(segment) {
  const words = shellWords(segment.replace(/^[({]+\s*/u, ""));
  let index = 0;
  while (index < words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;
    const wrapper = words[index];
    if (!new Set(["env", "sudo", "command", "builtin", "exec", "time", "nice", "nohup", "then", "if", "while", "until", "!"]).has(wrapper)) break;
    index += 1;
    while (words[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;
  }
  const argv = words.slice(index);
  if (argv.length > 0) argv[0] = argv[0].replace(/^.*\//u, "");
  if (argv.length > 0) argv[argv.length - 1] = argv[argv.length - 1].replace(/[)}]+$/u, "");
  return argv;
}

function executableRunCommands(job) {
  return executableRunValues(job).flatMap(shellSegments);
}

function dockerRunInstructions(dockerfile) {
  const lines = dockerfile.split("\n");
  const instructions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].match(/^\s*(RUN)(?:\s+(.*))?$/iu);
    if (!start) continue;
    const keyword = start[1];
    let instruction = start[2] ?? "";
    while (instruction.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      instruction = `${instruction.trimEnd().slice(0, -1)} ${lines[(index += 1)].trim()}`;
    }
    const heredoc = instruction.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u);
    if (heredoc) {
      const body = [];
      while (index + 1 < lines.length) {
        const line = lines[(index += 1)];
        body.push(line);
        if (line.trim() === heredoc[1]) break;
      }
      instruction = `${instruction}\n${body.join("\n")}`;
    }
    instructions.push(`${keyword} ${instruction.replace(/\s+/gu, " ").trim()}`.trim());
  }
  return instructions;
}

function pnpmExecutableToken(word) {
  const normalized = word.replace(/^[`$({[]+/u, "").replace(/[,\]})]+$/u, "").replace(/^.*\//u, "");
  return normalized === "pnpm" || normalized === "pnpx";
}

function dynamicCommandToken(word) {
  return /(?:\$|`)/u.test(word);
}

function corepackPnpmToken(word) {
  const normalized = word.replace(/^.*\//u, "").toLowerCase();
  return normalized === "pnpm" || normalized === "pnpx" || /^(?:pnpm|pnpx)@/u.test(normalized);
}

function jsonPnpmInvocation(argv) {
  if (!Array.isArray(argv) || !argv.every((argument) => typeof argument === "string") || argv.length === 0) {
    return { ambiguous: true, pnpmIndex: null, argv: [] };
  }
  let command = [...argv];
  let index = 0;
  const executable = () => command[index]?.replace(/^.*\//u, "").toLowerCase();

  if (executable() === "env") {
    index += 1;
    while (index < command.length) {
      const argument = command[index];
      if (argument === "--") {
        index += 1;
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
        index += 1;
        continue;
      }
      if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(argument)) {
        index += 1;
        continue;
      }
      if (/^--(?:unset|chdir)=/u.test(argument)) {
        index += 1;
        continue;
      }
      if (["-u", "--unset", "-C", "--chdir"].includes(argument)) {
        if (index + 1 >= command.length) return { ambiguous: true, pnpmIndex: null, argv: command };
        index += 2;
        continue;
      }
      const splitString =
        argument === "-S" || argument === "--split-string"
          ? command[index + 1]
          : argument.startsWith("--split-string=")
            ? argument.slice("--split-string=".length)
            : argument.startsWith("-S") && argument.length > 2
              ? argument.slice(2)
              : null;
      if (splitString !== null) {
        if (typeof splitString !== "string") return { ambiguous: true, pnpmIndex: null, argv: command };
        const splitArgv = shellWords(splitString);
        if (splitArgv.length === 0) return { ambiguous: true, pnpmIndex: null, argv: command };
        const consumed = argument === "-S" || argument === "--split-string" ? 2 : 1;
        command = [...splitArgv, ...command.slice(index + consumed)];
        index = 0;
        break;
      }
      if (argument.startsWith("-")) return { ambiguous: true, pnpmIndex: null, argv: command };
      break;
    }
    if (index >= command.length || dynamicCommandToken(command[index])) {
      return { ambiguous: true, pnpmIndex: null, argv: command };
    }
  }

  if (executable() === "corepack") {
    index += 1;
    const subcommand = command[index];
    if (subcommand === undefined || dynamicCommandToken(subcommand)) {
      return { ambiguous: true, pnpmIndex: null, argv: command };
    }
    if (corepackManagementCommands.has(subcommand.toLowerCase())) {
      return { ambiguous: false, pnpmIndex: null, argv: command };
    }
    if (corepackPnpmToken(subcommand)) {
      return { ambiguous: false, pnpmIndex: index, argv: command };
    }
    return { ambiguous: true, pnpmIndex: null, argv: command };
  }

  if (pnpmExecutableToken(command[index] ?? "")) {
    return { ambiguous: false, pnpmIndex: index, argv: command };
  }
  if (dynamicCommandToken(command[index] ?? "")) {
    return { ambiguous: true, pnpmIndex: null, argv: command };
  }
  return { ambiguous: false, pnpmIndex: null, argv: command };
}

function pnpmInstallInvocation({ ambiguous, pnpmIndex, argv }) {
  if (ambiguous) return true;
  if (pnpmIndex === null) return false;
  return argv
    .slice(pnpmIndex + 1)
    .some((argument) => argument === "install" || argument === "i" || dynamicCommandToken(argument));
}

function containsExecutablePnpmInstall(instruction) {
  const command = instruction.replace(/^RUN\s+/iu, "");
  if (command.startsWith("[")) {
    try {
      return pnpmInstallInvocation(jsonPnpmInvocation(JSON.parse(command)));
    } catch {
      return /pnpm|pnpx|\$|`/iu.test(command);
    }
  }
  if (/\b(?:pnpm|pnpx)\b[\s\S]*\b(?:install|i)\b/iu.test(command)) return true;
  return shellSegments(command).some((segment) => {
    const words = shellWords(segment);
    const pnpmIndex = words.findIndex(pnpmExecutableToken);
    if (pnpmIndex === -1) return false;
    return words
      .slice(pnpmIndex + 1)
      .some((argument) => argument === "install" || argument === "i" || dynamicCommandToken(argument));
  });
}

function dockerInstallInstructions(dockerfile) {
  return dockerRunInstructions(dockerfile).filter(containsExecutablePnpmInstall);
}

function containsExecutablePnpm(instruction) {
  const command = instruction.replace(/^RUN\s+/iu, "");
  if (command.startsWith("[")) {
    try {
      const invocation = jsonPnpmInvocation(JSON.parse(command));
      return invocation.ambiguous || invocation.pnpmIndex !== null;
    } catch {
      return /pnpm|pnpx|\$|`/iu.test(command);
    }
  }
  return shellSegments(command).some((segment) => shellWords(segment).some(pnpmExecutableToken));
}

function dockerPnpmRunInstructions(dockerfile) {
  return dockerRunInstructions(dockerfile).filter(containsExecutablePnpm);
}

function hasInterpreterCommandPayload(argv) {
  const interpreterIndex = argv.findIndex((word) => shellInterpreters.has(word.replace(/^.*\//u, "").toLowerCase()));
  if (interpreterIndex === -1) return false;
  return argv
    .slice(interpreterIndex + 1)
    .some((argument) => argument === "--command" || /^-[a-z]*c[a-z]*$/iu.test(argument));
}

function containsDockerInterpreterPayload(instruction) {
  const command = instruction.replace(/^RUN\s+/iu, "");
  if (command.startsWith("[")) {
    try {
      const argv = JSON.parse(command);
      return Array.isArray(argv) && argv.every((argument) => typeof argument === "string") && hasInterpreterCommandPayload(argv);
    } catch {
      return true;
    }
  }
  return shellSegments(command).some((segment) => hasInterpreterCommandPayload(shellWords(segment)));
}

function countExact(values, expected) {
  return values.filter((value) => value === expected).length;
}

function countSubstring(values, expected) {
  let count = 0;
  for (const value of values) {
    let cursor = 0;
    while (cursor <= value.length - expected.length) {
      const found = value.indexOf(expected, cursor);
      if (found === -1) break;
      count += 1;
      cursor = found + expected.length;
    }
  }
  return count;
}

function normalizedRunCommands(job) {
  return executableRunCommands(job).map((command) => executableShellArgv(command).join(" "));
}

function relocatedSelector(command) {
  const vitestMarker = " exec vitest run ";
  return command.includes(vitestMarker) ? command.slice(command.indexOf(vitestMarker) + vitestMarker.length) : command;
}

function policyViolations(input) {
  const violations = [];
  const workflows = new Map([
    ["ci", { label: "ci.yml", workflow: parseWorkflow(input.ci, "ci.yml", violations) }],
    ["buildImages", { label: "build-images.yml", workflow: parseWorkflow(input.buildImages, "build-images.yml", violations) }],
  ]);

  for (const { label, workflow } of workflows.values()) {
    for (const eventName of ["push", "pull_request"]) {
      const branches = eventBranches(workflow, eventName);
      if (JSON.stringify(branches) !== JSON.stringify(["main", "v1"])) {
        violations.push(`${label} ${eventName} must select exactly main and v1`);
      }
    }
  }

  const buildWorkflow = workflows.get("buildImages").workflow;
  const buildJobs = workflowJobs(buildWorkflow);
  const buildCandidatesJob = buildJobs.get("build-candidates");
  const candidates = imageCandidates(buildCandidatesJob);
  if (candidates.length === 0) violations.push("build image matrix candidate selector is empty");
  if (JSON.stringify(candidates) !== JSON.stringify(expectedCandidates)) {
    violations.push("build image matrix candidates must be unique and exact");
  }
  for (const key of ["name", "image", "dockerfile", "env_name"]) {
    if (new Set(candidates.map((candidate) => candidate[key])).size !== candidates.length) {
      violations.push(`build image matrix ${key} values must be unique`);
    }
  }

  const buildActionSteps = workflowSteps(buildCandidatesJob).filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("docker/build-push-action@")
  );
  if (buildActionSteps.length !== 1) violations.push("build-candidates must have exactly one build-push action");
  const buildAction = buildActionSteps[0];
  if (buildAction?.with?.file !== "${{ matrix.dockerfile }}") {
    violations.push("build-push action file must correlate to matrix.dockerfile");
  }

  for (const [file, expectedInstructions] of expectedInstallInstructions) {
    const interpreterPayloads = dockerRunInstructions(input.dockerfiles[file] ?? "").filter(containsDockerInterpreterPayload);
    if (interpreterPayloads.length > 0) {
      violations.push(`${file} must not contain shell interpreter command payload RUN instruction(s)`);
    }
    const installs = dockerInstallInstructions(input.dockerfiles[file] ?? "");
    if (installs.length === 0) violations.push(`${file} executable pnpm install selector is empty`);
    if (JSON.stringify(installs) !== JSON.stringify(expectedInstructions)) {
      violations.push(`${file} must contain only its exact frozen pnpm install RUN instruction(s)`);
    }
    const pnpmRuns = dockerPnpmRunInstructions(input.dockerfiles[file] ?? "");
    if (JSON.stringify(pnpmRuns) !== JSON.stringify(expectedPnpmRunInstructions.get(file))) {
      violations.push(`${file} must contain only its exact executable pnpm/pnpx RUN instruction(s)`);
    }
  }

  if (input.nvmrc.trim() !== "v22.14.0") violations.push(".nvmrc must pin exactly v22.14.0");
  for (const [key, expectedCount] of expectedSetupNodeCounts) {
    const { label, workflow } = workflows.get(key);
    const setupNodeSteps = allWorkflowSteps(workflow).filter((step) =>
      typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
    );
    if (setupNodeSteps.length !== expectedCount) {
      violations.push(`${label} must contain exactly ${expectedCount} setup-node step(s)`);
    }
    for (const step of setupNodeSteps) {
      if (step.with?.["node-version-file"] !== ".nvmrc" || Object.hasOwn(step.with ?? {}, "node-version")) {
        violations.push(`${label} setup-node must derive its version from .nvmrc`);
      }
    }
  }

  const ciWorkflow = workflows.get("ci").workflow;
  const ciJobs = workflowJobs(ciWorkflow);
  const typecheckCommands = normalizedRunCommands(ciJobs.get("typecheck"));
  const allCiCommands = [...ciJobs.values()].flatMap((job) => normalizedRunCommands(job));
  const allCiRunValues = [...ciJobs.values()].flatMap(executableRunValues);
  const webappTypecheck = "pnpm --filter webapp typecheck";
  if (countExact(typecheckCommands, webappTypecheck) !== 1 || countExact(allCiCommands, webappTypecheck) !== 1) {
    violations.push("webapp typecheck must be one executable command scoped to the typecheck job");
  }

  let packageManifest = {};
  try {
    packageManifest = JSON.parse(input.packageJson);
  } catch {
    violations.push("package.json must remain valid JSON");
  }
  const packageScripts = packageManifest.scripts ?? {};
  if (packageScripts["test:ci-policy"] !== "node --test scripts/ci-policy.test.mjs") {
    violations.push("package.json must wire the CI policy test executable");
  }
  if (packageManifest.devDependencies?.yaml !== "2.6.1") {
    violations.push("package.json must pin yaml 2.6.1 as an exact root devDependency");
  }
  if (countExact(typecheckCommands, "pnpm test:ci-policy") !== 1) {
    violations.push("typecheck job must execute the wired CI policy test exactly once");
  }

  const persistedStateCommands = normalizedRunCommands(buildJobs.get("persisted-state"));
  for (const command of relocatedCommands) {
    if (countExact(typecheckCommands, command) !== 1) {
      violations.push(`typecheck job must execute relocated command: ${command}`);
    }
    if (countSubstring(allCiRunValues, command) !== 1) {
      violations.push(`CI must execute relocated command exactly once across all jobs: ${command}`);
    }
    if (persistedStateCommands.some((persistedCommand) => persistedCommand.includes(relocatedSelector(command)))) {
      violations.push(`persisted-state job must not execute relocated command: ${command}`);
    }
  }

  const buildSteps = allWorkflowSteps(buildWorkflow);
  const permissions = permissionDeclarations(buildWorkflow);
  if (
    permissions.some((declaration) => declaration !== null && typeof declaration === "object" && declaration.packages === "write")
  ) {
    violations.push("build-images grants package write permission");
  }
  if (permissions.some((declaration) => declaration === "write-all")) {
    violations.push("build-images grants write-all permission");
  }
  if (buildSteps.some((step) => typeof step.uses === "string" && step.uses.startsWith("docker/login-action@"))) {
    violations.push("build-images contains a registry login action");
  }
  if (buildAction?.with?.push !== false) violations.push("build-push action must keep push false");
  const outputs = buildAction?.with?.outputs;
  if (typeof outputs !== "string" || /\btype\s*=\s*(?:registry|image)\b/iu.test(outputs)) {
    violations.push("build-push action contains a registry-capable exporter");
  }
  const shellArgv = [...buildJobs.values()].flatMap(executableRunCommands).map(executableShellArgv).filter((argv) => argv.length > 0);
  if (
    shellArgv.some((argv) => {
      const [tool, ...arguments_] = argv.map((word) => word.toLowerCase());
      if (tool === "eval") return true;
      if (!shellInterpreters.has(tool)) return false;
      return arguments_.some((argument) => argument === "--command" || /^-[a-z]*c[a-z]*$/iu.test(argument));
    })
  ) {
    violations.push("build-images contains executable shell command indirection");
  }
  if (
    shellArgv.some((argv) => {
      const [tool, ...arguments_] = argv.map((word) => word.toLowerCase());
      return (tool === "docker" && arguments_.includes("login")) ||
        (tool === "regctl" && arguments_.includes("login")) ||
        ((tool === "oras" || tool === "skopeo") && arguments_.includes("login"));
    })
  ) {
    violations.push("build-images contains an executable shell registry login");
  }
  if (
    shellArgv.some((argv) => {
      const [tool, ...arguments_] = argv.map((word) => word.toLowerCase());
      if (tool === "regctl") return arguments_.includes("copy") || arguments_.includes("import");
      if (tool === "oras") return arguments_.includes("push");
      if (tool === "skopeo") return arguments_.includes("copy");
      if (tool !== "docker") return false;
      if (arguments_.includes("push")) return true;
      const buildx = arguments_.indexOf("buildx");
      if (buildx === -1) return false;
      const buildxArguments = arguments_.slice(buildx + 1);
      if (buildxArguments.includes("imagetools") && buildxArguments.includes("create")) return true;
      if (!buildxArguments.includes("build")) return false;
      if (arguments_.some((argument) => /^--push(?:=(?:true|1))?$/iu.test(argument))) return true;
      return arguments_.some(
        (argument, index) =>
          /^(?:--output|-o)=?type=(?:registry|image)(?:,|$)/iu.test(argument) ||
          (/^(?:--output|-o)$/iu.test(argument) && /^type=(?:registry|image)(?:,|$)/iu.test(arguments_[index + 1] ?? ""))
      );
    })
  ) {
    violations.push("build-images contains an executable shell publication command");
  }
  if (
    shellArgv.some((argv) =>
      /(?:deploy-platos\.sh|trigger\.dev@\S+\s+(?:deploy|promote)|kubectl\s+apply|helm\s+(?:install|upgrade))/u.test(argv.join(" "))
    )
  ) {
    violations.push("build-images contains an executable deployment command");
  }

  return violations;
}

function replaceNth(sourceText, before, after, occurrence) {
  assert.ok(occurrence >= 0, "mutation occurrence must be non-negative");
  let cursor = 0;
  let found = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    found = sourceText.indexOf(before, cursor);
    assert.notEqual(found, -1, `mutation source is missing occurrence ${occurrence + 1} of ${JSON.stringify(before)}`);
    cursor = found + before.length;
  }
  const changed = `${sourceText.slice(0, found)}${after}${sourceText.slice(found + before.length)}`;
  assert.notEqual(changed, sourceText, "fixture mutation must change source");
  return changed;
}

function replaceAfterNthAnchor(sourceText, anchor, before, after, occurrence) {
  let anchorCursor = 0;
  let anchorIndex = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    anchorIndex = sourceText.indexOf(anchor, anchorCursor);
    assert.notEqual(anchorIndex, -1, `mutation source is missing occurrence ${occurrence + 1} of ${JSON.stringify(anchor)}`);
    anchorCursor = anchorIndex + anchor.length;
  }
  const replacementIndex = sourceText.indexOf(before, anchorCursor);
  assert.notEqual(replacementIndex, -1, `anchored mutation source is missing ${JSON.stringify(before)}`);
  const changed = `${sourceText.slice(0, replacementIndex)}${after}${sourceText.slice(replacementIndex + before.length)}`;
  assert.notEqual(changed, sourceText, "anchored fixture mutation must change source");
  return changed;
}

function mutateFixture(input, key, before, after, options = {}) {
  const original = input[key];
  assert.equal(typeof original, "string", `missing string fixture ${key}`);
  const changed = options.all
    ? (() => {
        assert.ok(original.includes(before), `${key} mutation source is missing ${JSON.stringify(before)}`);
        return original.replaceAll(before, after);
      })()
    : replaceNth(original, before, after, options.occurrence ?? 0);
  assert.notEqual(changed, original, `${key} fixture mutation must change source`);
  return { ...input, [key]: changed };
}

function mutateDockerfile(input, file, before, after, options = {}) {
  const original = input.dockerfiles[file];
  assert.equal(typeof original, "string", `missing Dockerfile fixture ${file}`);
  const changed = options.all
    ? (() => {
        assert.ok(original.includes(before), `${file} mutation source is missing ${JSON.stringify(before)}`);
        return original.replaceAll(before, after);
      })()
    : replaceNth(original, before, after, options.occurrence ?? 0);
  assert.notEqual(changed, original, `${file} fixture mutation must change source`);
  return { ...input, dockerfiles: { ...input.dockerfiles, [file]: changed } };
}

function mutateDockerInstallFlag(input, file, occurrence) {
  const original = input.dockerfiles[file];
  assert.equal(typeof original, "string", `missing Dockerfile fixture ${file}`);
  const changed = replaceAfterNthAnchor(
    original,
    "pnpm install",
    "--frozen-lockfile",
    "--no-frozen-lockfile",
    occurrence
  );
  return { ...input, dockerfiles: { ...input.dockerfiles, [file]: changed } };
}

function mutateEventSelector(input, key, eventName) {
  const before = `  ${eventName}:\n    branches: [main, v1]`;
  const after = `  ${eventName}:\n    branches: [main]`;
  return mutateFixture(input, key, before, after);
}

function insertBuildCandidateStep(input, step) {
  return insertWorkflowJobStep(input, "buildImages", "build-candidates", step);
}

function insertWorkflowJobStep(input, key, jobName, step) {
  const original = input[key];
  assert.equal(typeof original, "string", `missing workflow fixture ${key}`);
  const document = parseDocument(original, { prettyErrors: false, uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${key} fixture must be valid YAML`);
  const workflow = document.toJS();
  const steps = workflow?.jobs?.[jobName]?.steps;
  assert.ok(Array.isArray(steps), `${jobName} job is missing steps in ${key}`);
  steps.unshift(step);
  document.contents = document.createNode(workflow);
  const changed = String(document);
  assert.notEqual(changed, original, "workflow job insertion must change source");
  return { ...input, [key]: changed };
}

test("committed CI and image-build policy is executable, correlated, and complete", () => {
  assert.equal(expectedCandidates.length, 3, "candidate selector must be non-empty and explicit");
  assert.equal(shippingDockerfiles.length, 3, "shipping Dockerfile selector must be non-empty and explicit");
  assert.equal(
    [...expectedInstallInstructions.values()].reduce((total, instructions) => total + instructions.length, 0),
    4,
    "shipping install selector must cover all four executable installs"
  );
  assert.equal(relocatedCommands.length, 7, "relocated command selector must cover all seven commands");
  assert.deepEqual(policyViolations(fixtures()), []);
});

test("CI policy controls fail under generated semantic source mutations", async (t) => {
  const pristine = fixtures();
  const controls = [];

  for (const [key, label] of [
    ["ci", "ci.yml"],
    ["buildImages", "build-images.yml"],
  ]) {
    for (const eventName of ["push", "pull_request"]) {
      controls.push({
        name: `${label} ${eventName} selector`,
        expected: `${label} ${eventName} must select exactly main and v1`,
        mutate: (input) => mutateEventSelector(input, key, eventName),
      });
    }
  }

  for (const [file, expectedInstructions] of expectedInstallInstructions) {
    for (let occurrence = 0; occurrence < expectedInstructions.length; occurrence += 1) {
      controls.push(
        {
          name: `${file} executable install ${occurrence + 1} selector`,
          expected: `${file} must contain only its exact frozen pnpm install RUN instruction(s)`,
          mutate: (input) =>
            mutateDockerfile(input, file, "pnpm install", "# pnpm install", { occurrence }),
        },
        {
          name: `${file} executable install ${occurrence + 1} frozen lockfile`,
          expected: `${file} must contain only its exact frozen pnpm install RUN instruction(s)`,
          mutate: (input) => mutateDockerInstallFlag(input, file, occurrence),
        }
      );
    }
    controls.push({
      name: `${file} non-empty executable install selector`,
      expected: `${file} must contain only its exact frozen pnpm install RUN instruction(s)`,
      mutate: (input) => mutateDockerfile(input, file, "pnpm install", "# pnpm install", { all: true }),
    });
  }

  for (const [key, count] of expectedSetupNodeCounts) {
    const label = key === "ci" ? "ci.yml" : "build-images.yml";
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      controls.push({
        name: `${label} setup-node ${occurrence + 1}`,
        expected: `${label} setup-node must derive its version from .nvmrc`,
        mutate: (input) =>
          mutateFixture(input, key, "node-version-file: .nvmrc", "node-version: 20.20.0", { occurrence }),
      });
    }
  }

  for (const modifier of ["|-", "|+", ">-", ">+"]) {
    controls.push({
      name: `block scalar ${modifier} registry exporter publication`,
      expected: "build-push action contains a registry-capable exporter",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "outputs: type=oci,dest=${{ runner.temp }}/${{ matrix.name }}.oci.tar,oci-mediatypes=true",
          `outputs: ${modifier}\n            type=registry`
        ),
    });
  }

  controls.push(
    {
      name: "malformed .nvmrc",
      expected: ".nvmrc must pin exactly v22.14.0",
      mutate: (input) => mutateFixture(input, "nvmrc", "v22.14.0", "not-a-node-version"),
    },
    {
      name: "Node 20 .nvmrc",
      expected: ".nvmrc must pin exactly v22.14.0",
      mutate: (input) => mutateFixture(input, "nvmrc", "v22.14.0", "v20.20.0"),
    },
    {
      name: "wrong matrix candidate",
      expected: "build image matrix candidates must be unique and exact",
      mutate: (input) => mutateFixture(input, "buildImages", "image: platos-agent", "image: wrong-agent"),
    },
    {
      name: "duplicate matrix candidate",
      expected: "build image matrix name values must be unique",
      mutate: (input) => mutateFixture(input, "buildImages", "- name: migrations", "- name: agent"),
    },
    {
      name: "uncorrelated build action",
      expected: "build-push action file must correlate to matrix.dockerfile",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "file: ${{ matrix.dockerfile }}", "file: apps/agent/Dockerfile"),
    },
    {
      name: "package write publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "      contents: read\n    strategy:", "      contents: read\n      packages: write\n    strategy:"),
    },
    {
      name: "quoted package write publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "      contents: read\n    strategy:", "      contents: read\n      \"packages\": write\n    strategy:"),
    },
    {
      name: "quoted root permissions and packages publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "jobs:\n", '"permissions":\n  "packages": write\n\njobs:\n'),
    },
    {
      name: "root package write publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "jobs:\n", "permissions:\n  packages: write\n\njobs:\n"),
    },
    {
      name: "root write-all publication",
      expected: "build-images grants write-all permission",
      mutate: (input) => mutateFixture(input, "buildImages", "jobs:\n", '"permissions": "write-all"\n\njobs:\n'),
    },
    {
      name: "job write-all publication",
      expected: "build-images grants write-all permission",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "    permissions:\n      contents: read\n    strategy:",
          "    permissions: write-all\n    strategy:"
        ),
    },
    {
      name: "registry login publication",
      expected: "build-images contains a registry login action",
      mutate: (input) => insertBuildCandidateStep(input, { name: "Mutation registry login", uses: "docker/login-action@mutation" }),
    },
    {
      name: "build action push publication",
      expected: "build-push action must keep push false",
      mutate: (input) => mutateFixture(input, "buildImages", "push: false", "push: true"),
    },
    {
      name: "block registry exporter publication",
      expected: "build-push action contains a registry-capable exporter",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "outputs: type=oci,dest=${{ runner.temp }}/${{ matrix.name }}.oci.tar,oci-mediatypes=true",
          "outputs: |\n            type=registry"
        ),
    },
    {
      name: "block image exporter publication",
      expected: "build-push action contains a registry-capable exporter",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "outputs: type=oci,dest=${{ runner.temp }}/${{ matrix.name }}.oci.tar,oci-mediatypes=true",
          "outputs: |\n            type=image"
        ),
    },
    {
      name: "shell publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, { name: "Mutation redirected shell publication", run: "docker push>/var/tmp/mutation.log ghcr.io/example/image:mutation" }),
    },
    {
      name: "shell registry login",
      expected: "build-images contains an executable shell registry login",
      mutate: (input) => insertBuildCandidateStep(input, { name: "Mutation shell login", run: "docker login ghcr.io" }),
    },
    {
      name: "shell registry login with docker global options",
      expected: "build-images contains an executable shell registry login",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation global-option shell login",
          run: "docker --config /var/tmp/docker-config login ghcr.io",
        }),
    },
    {
      name: "bash command payload registry login",
      expected: "build-images contains executable shell command indirection",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation bash login payload",
          run: "bash -c 'docker login ghcr.io'",
        }),
    },
    {
      name: "bash command payload publication",
      expected: "build-images contains executable shell command indirection",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation bash publication payload",
          run: "bash -lc 'docker push ghcr.io/example/image:mutation'",
        }),
    },
    {
      name: "eval command payload publication",
      expected: "build-images contains executable shell command indirection",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation eval publication payload",
          run: "eval 'docker push ghcr.io/example/image:mutation'",
        }),
    },
    {
      name: "buildx push publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(
          input,
          { name: "Mutation buildx publication", run: "docker buildx build --push -t ghcr.io/example/image:mutation ." }
        ),
    },
    {
      name: "buildx registry output publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation buildx registry exporter",
          run: "docker buildx build --output=type=registry -t ghcr.io/example/image:mutation .",
        }),
    },
    {
      name: "buildx imagetools create publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation buildx imagetools publication",
          run: "docker buildx imagetools create -t ghcr.io/example/image:mutation source/image:mutation",
        }),
    },
    {
      name: "compose push publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) => insertBuildCandidateStep(input, { name: "Mutation compose publication", run: "docker compose push" }),
    },
    {
      name: "chained prefixed shell publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation chained publication",
          run: "echo preparing && env TARGET=mutation docker push ghcr.io/example/image:mutation",
        }),
    },
    {
      name: "multiple installs in one RUN",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN pnpm install --frozen-lockfile --prod \u0026\u0026 pnpm install --no-frozen-lockfile"
        ),
    },
    {
      name: "frozen lockfile false",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "--frozen-lockfile --prod",
          "--frozen-lockfile=false --prod"
        ),
    },
    {
      name: "lowercase RUN enforcement",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "run pnpm install --frozen-lockfile --prod"
        ),
    },
    {
      name: "JSON RUN enforcement",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN ["pnpm", "install", "--frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "heredoc RUN fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN \u003c\u003cEOF\npnpm install --frozen-lockfile --prod\nEOF"
        ),
    },
    {
      name: "quoted hash pnpm install fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN echo "# pnpm install --frozen-lockfile --prod"'
        ),
    },
    {
      name: "pnpm global option install fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN pnpm --silent install --frozen-lockfile --prod"
        ),
    },
    {
      name: "pnpm install alias fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN pnpm i --no-frozen-lockfile --prod"
        ),
    },
    {
      name: "dynamic pnpm subcommand fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'ARG PNPM_COMMAND=install\nRUN pnpm "$PNPM_COMMAND" --frozen-lockfile --prod'
        ),
    },
    {
      name: "shell-form nested pnpm interpreter payload fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must not contain shell interpreter command payload RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN sh -c 'pnpm i --no-frozen-lockfile --prod'"
        ),
    },
    {
      name: "JSON nested pnpm interpreter payload fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must not contain shell interpreter command payload RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN ["sh", "-c", "pnpm i --no-frozen-lockfile --prod"]'
        ),
    },
    {
      name: "JSON env-wrapped pnpm install alias fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["env", "pnpm", "i", "--no-frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "JSON corepack-wrapped versioned pnpm alias fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["corepack", "pnpm@10.23.0", "i", "--no-frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "JSON env split-string pnpm payload fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["env", "-S", "pnpm i --no-frozen-lockfile --prod"]'
        ),
    },
    {
      name: "JSON dynamic corepack command fails closed",
      expected: "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["corepack", "${PACKAGE_MANAGER}", "i", "--no-frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "webapp typecheck inert text",
      expected: "webapp typecheck must be one executable command scoped to the typecheck job",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "run: pnpm --filter webapp typecheck",
          "run: echo skipped # pnpm --filter webapp typecheck"
        ),
    },
    {
      name: "policy package wiring",
      expected: "package.json must wire the CI policy test executable",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          '"test:ci-policy": "node --test scripts/ci-policy.test.mjs"',
          '"test:ci-policy": "node --test scripts/ci-policy-disabled.test.mjs"'
        ),
    },
    {
      name: "exact YAML parser dependency",
      expected: "package.json must pin yaml 2.6.1 as an exact root devDependency",
      mutate: (input) => mutateFixture(input, "packageJson", '"yaml": "2.6.1"', '"yaml": "^2.6.1"'),
    },
    {
      name: "policy CI wiring inert text",
      expected: "typecheck job must execute the wired CI policy test exactly once",
      mutate: (input) =>
        mutateFixture(input, "ci", "pnpm test:ci-policy", "echo skipped # pnpm test:ci-policy"),
    }
  );

  for (const command of relocatedCommands) {
    controls.push(
      {
        name: `relocated executable command ${command}`,
        expected: `typecheck job must execute relocated command: ${command}`,
        mutate: (input) => mutateFixture(input, "ci", command, `echo skipped # ${command}`),
      },
      {
        name: `relocated command absent from persisted-state ${command}`,
        expected: `persisted-state job must not execute relocated command: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(
            input,
            "buildImages",
            "persisted-state",
            { name: "Mutation slow-job command", run: command }
          ),
      },
      {
        name: `relocated command globally unique ${command}`,
        expected: `CI must execute relocated command exactly once across all jobs: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(
            input,
            "ci",
            "cross-scope-isolation",
            { name: "Mutation decorated duplicate fast command", run: `${command} > /var/tmp/mutation.log` }
          ),
      }
    );
  }

  assert.equal(controls.length, 89, "semantic mutation control table must cover every declared checkpoint");
  for (const control of controls) {
    await t.test(control.name, () => {
      const mutation = control.mutate(pristine);
      assert.notDeepEqual(mutation, pristine, "fixture mutation must change the fixture set");
      const violations = policyViolations(mutation);
      assert.ok(
        violations.some((violation) => violation.includes(control.expected)),
        `${control.name} mutation did not trip ${JSON.stringify(control.expected)}: ${violations.join("; ")}`
      );
    });
  }
});
