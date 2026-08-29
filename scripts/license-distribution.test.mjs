// WIN-252 (M1.2) — Apache-2.0 distribution obligations must survive containerisation.
//
// Apache-2.0 §4(a): "You must give any other recipients of the Work or Derivative
// Works a copy of this License."  §4(d): if the work has a NOTICE file, its
// attributions must be reproduced in the distributions you give.
//
// A shipped Docker image IS a distribution. Before this gate, `.dockerignore`
// excluded LICENSE from the build context entirely and neither Dockerfile copied
// LICENSE or NOTICE into its final stage — so every published image was
// distributed without them. These tests are the tripwire against a silent
// regression, and each carries a negative control proving it can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const EXPECTED_SHIPPED_CANDIDATES = [
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
const LEGAL_FILES = ["LICENSE", "NOTICE"];

export function shippedCandidates(workflowSource) {
  const document = parseDocument(workflowSource);
  assert.deepEqual(document.errors, [], "build-images.yml must be valid YAML");
  const candidates = document.toJS()?.jobs?.["build-candidates"]?.strategy?.matrix?.include;
  assert.deepEqual(
    candidates,
    EXPECTED_SHIPPED_CANDIDATES,
    "build-images.yml must declare exactly the reviewed agent, webapp, and migrations candidates"
  );
  return candidates;
}

/** A .dockerignore line excludes `name` when it matches it bare or /-anchored. */
export function dockerignoreExcludes(dockerignore, name) {
  const lines = dockerignore
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  let excluded = false;
  for (const line of lines) {
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replace(/^\//, "").replace(/\/$/, "");
    if (pattern === name) excluded = !negated;
  }
  return excluded;
}

function dockerShellWords(value) {
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  const flush = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      flush();
    } else {
      word += character;
    }
  }
  if (escaped || quote !== null) return null;
  flush();
  return words;
}

function copySources(instruction) {
  let operandsText = instruction.trim();
  while (operandsText.startsWith("--")) {
    const option = operandsText.match(/^--[A-Za-z][A-Za-z-]*(?:=[^\s]+)?(?:\s+|$)/u);
    if (!option) return [];
    operandsText = operandsText.slice(option[0].length).trimStart();
  }
  let operands;
  if (operandsText.startsWith("[")) {
    try {
      operands = JSON.parse(operandsText);
    } catch {
      return [];
    }
    if (!Array.isArray(operands) || !operands.every((operand) => typeof operand === "string")) return [];
  } else {
    operands = dockerShellWords(operandsText);
  }
  return operands && operands.length >= 2 ? operands.slice(0, -1) : [];
}

/** Does the final image stage COPY repository legal file `name` as a source? */
export function dockerfileCopies(dockerfile, name) {
  const stages = [...dockerfile.matchAll(/^\s*FROM(?:\s|$)/gim)];
  if (stages.length === 0) return false;
  const finalStage = dockerfile.slice(stages.at(-1).index);
  for (const match of finalStage.matchAll(/^\s*COPY(?:\s+(.*))?$/gim)) {
    const sources = copySources(match[1] ?? "");
    if (sources.some((source) => source.replace(/\/+$/u, "").split("/").at(-1) === name)) return true;
  }
  return false;
}

test("the repository actually ships Apache-2.0 with a NOTICE (premise of this gate)", () => {
  assert.match(read("LICENSE"), /Apache License/i);
  assert.ok(read("NOTICE").trim().length > 0, "NOTICE must not be empty");
});

test("LICENSE and NOTICE reach the Docker build context", () => {
  const di = read(".dockerignore");
  for (const f of LEGAL_FILES) {
    assert.equal(
      dockerignoreExcludes(di, f),
      false,
      `${f} is excluded by .dockerignore, so it cannot be COPYed into any image — Apache-2.0 §4 violation`
    );
  }
});

test("every shipped image COPYs LICENSE and NOTICE into its final stage", () => {
  const candidates = shippedCandidates(read(".github/workflows/build-images.yml"));
  for (const { dockerfile } of candidates) {
    const df = read(dockerfile);
    for (const f of LEGAL_FILES) {
      assert.ok(
        dockerfileCopies(df, f),
        `${dockerfile} never COPYs ${f} into its final stage, so the published image is distributed without it — Apache-2.0 §4 violation`
      );
    }
  }
});

// ── Negative controls: prove the checks above can actually fail ──────────────

test("NEGATIVE CONTROL: the dockerignore matcher detects a bare and an anchored exclusion", () => {
  assert.equal(dockerignoreExcludes("LICENSE", "LICENSE"), true);
  assert.equal(dockerignoreExcludes("/LICENSE", "LICENSE"), true);
  assert.equal(dockerignoreExcludes("# LICENSE\nREADME.md", "LICENSE"), false);
  // a later negation re-includes it
  assert.equal(dockerignoreExcludes("LICENSE\n!LICENSE", "LICENSE"), false);
});

test("NEGATIVE CONTROL: omitting migrations fails the exact shipped-candidate assertion", () => {
  const workflow = read(".github/workflows/build-images.yml");
  const withoutMigrations = workflow.replace(
    /\n          - name: migrations\n            image: platos-migrations\n            dockerfile: internal-packages\/tenancy-database\/Dockerfile\.migrations\n            env_name: MIGRATIONS/,
    ""
  );
  assert.notEqual(withoutMigrations, workflow, "negative control must change the workflow source");
  assert.throws(() => shippedCandidates(withoutMigrations), /must declare exactly the reviewed/);
});

test("NEGATIVE CONTROL: the COPY matcher requires an exact legal source in the final stage", () => {
  assert.equal(dockerfileCopies("FROM base\nCOPY LICENSE ./LICENSE", "LICENSE"), true);
  assert.equal(dockerfileCopies('FROM base\nCOPY ["/build/LICENSE", "./LICENSE"]', "LICENSE"), true);
  assert.equal(dockerfileCopies("COPY --from=b /build/dist ./dist", "LICENSE"), false);
  assert.equal(
    dockerfileCopies("FROM base AS builder\nCOPY LICENSE ./LICENSE\nFROM base AS runtime\nCOPY app ./app", "LICENSE"),
    false
  );
  assert.equal(dockerfileCopies("FROM base\nCOPY app ./LICENSE", "LICENSE"), false);
  assert.equal(dockerfileCopies('FROM base\nCOPY ["app", "./LICENSE"]', "LICENSE"), false);
  assert.equal(dockerfileCopies("FROM base\nCOPY NOTICE.md ./NOTICE", "NOTICE"), false);
  assert.equal(dockerfileCopies('FROM base\nCOPY ["NOTICE.md", "./NOTICE"]', "NOTICE"), false);
  // a mention in a comment must NOT count as shipping it
  assert.equal(dockerfileCopies("FROM base\n# remember to add LICENSE\nCOPY x y", "LICENSE"), false);
});
