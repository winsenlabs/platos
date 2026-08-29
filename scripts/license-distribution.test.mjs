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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** The images we publish. Add a Dockerfile here when a new image ships. */
const SHIPPED_IMAGES = ["apps/agent/Dockerfile", "apps/webapp/Dockerfile.platos"];
const LEGAL_FILES = ["LICENSE", "NOTICE"];

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

/** Does this Dockerfile COPY `name` into a stage (i.e. into the image)? */
export function dockerfileCopies(dockerfile, name) {
  return new RegExp(`^COPY\\b.*\\b${name}\\b`, "m").test(dockerfile);
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
  for (const image of SHIPPED_IMAGES) {
    const df = read(image);
    for (const f of LEGAL_FILES) {
      assert.ok(
        dockerfileCopies(df, f),
        `${image} never COPYs ${f}, so the published image is distributed without it — Apache-2.0 §4 violation`
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

test("NEGATIVE CONTROL: the COPY matcher rejects a Dockerfile that never copies the file", () => {
  assert.equal(dockerfileCopies("COPY --from=b /build/LICENSE ./LICENSE", "LICENSE"), true);
  assert.equal(dockerfileCopies("COPY --from=b /build/dist ./dist", "LICENSE"), false);
  // a mention in a comment must NOT count as shipping it
  assert.equal(dockerfileCopies("# remember to add LICENSE\nCOPY x y", "LICENSE"), false);
});
