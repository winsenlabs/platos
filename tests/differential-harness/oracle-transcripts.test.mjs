// WIN-257 — the controls on the recorded oracle, and on the registry that uses it.
//
// The transport differential itself needs Docker, three containers and a built
// deployable. The PROMISES the recording makes do not, and they are the promises
// that decide whether the differential still means anything after WIN-257 T8
// deletes the oracle. So they run here, on every CI run, with no daemon:
//
//   * the transcript names the commit and the moment it was captured;
//   * it pins a digest for EVERY source the oracle driver executes, and a source
//     that has changed since fails until the transcript is re-recorded;
//   * a source that has been DELETED is the post-cutover state and is not a
//     failure — that is the whole point of recording it;
//   * every registered transport scenario has a recorded answer, so none of them
//     can quietly lose its oracle;
//   * nothing in the transcript is credential-shaped.
//
// Each case states the mutation it survives.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ORACLE_SOURCES,
  TRANSCRIPT_PATH,
  compareTranscripts,
  credentialShapedValues,
  oracleSourceDigests,
  readTranscripts,
  transcriptFailures,
} from "./oracle-transcripts.mjs";
import {
  TRANSPORT_NORMALISATION,
  TRANSPORT_SCENARIO_REGISTRY,
  TRANSPORT_SEEDS,
  assertTransportRegistryIsWellFormed,
  transportDimensions,
} from "./transport-scenarios.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const SCENARIO_IDS = TRANSPORT_SCENARIO_REGISTRY.map((scenario) => scenario.id);

// ---------------------------------------------------------------------------
// The committed transcript
// ---------------------------------------------------------------------------

test("the committed transcript is believable: provenance, digests, every scenario, no credential", () => {
  const { failures, deletedSources } = transcriptFailures(repositoryRoot, readTranscripts(repositoryRoot), SCENARIO_IDS);
  assert.deepEqual(failures, []);
  assert.ok(deletedSources >= 0);
});

test("every source the oracle driver executes is pinned, and the driver imports every pinned source", () => {
  const driver = fileURLToPath(new URL("../../apps/webapp/test/differential-oracle.mts", import.meta.url));
  // READ as a source file rather than imported: importing the driver would pull
  // the webapp's whole module graph, which needs a database, and this case must
  // run on a machine with none.
  const text = readFileSync(driver, "utf8");
  // The route modules are named by the driver as `~/routes/<id>`; the services
  // as `~/services/<name>`. Both are checked against the pinned list rather than
  // against a second copy of it, so a step that starts executing a new route
  // fails here until the transcript pins that route's digest too.
  const imported = [...text.matchAll(/from "~\/([^"]+)"|import\("~\/([^"]+)"\)/gu)].map(
    (match) => `apps/webapp/app/${match[1] ?? match[2] ?? ""}`,
  );
  const pinned = new Set(ORACLE_SOURCES.map((path) => path.replace(/\.(ts|tsx)$/u, "")));
  for (const specifier of imported) {
    assert.ok(
      pinned.has(specifier) || pinned.has(`${specifier}/route`),
      `${specifier} is executed by the oracle driver and no digest is pinned for it`,
    );
  }
  assert.ok(imported.length >= 8, `expected the driver to import the oracle, saw ${String(imported.length)} specifiers`);
});

// ---------------------------------------------------------------------------
// The mutations the transcript must survive
// ---------------------------------------------------------------------------

function scratchTranscript(steps, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "m2m4-evidence-registers-transcript-"));
  mkdirSync(dirname(join(root, TRANSCRIPT_PATH)), { recursive: true });
  const artifact = {
    version: 1,
    provenance: {
      commit: "a".repeat(40),
      capturedAt: "2026-09-16T00:00:00.000Z",
      oracleSources: oracleSourceDigests(repositoryRoot),
      ...(overrides.provenance ?? {}),
    },
    steps,
  };
  writeFileSync(join(root, TRANSCRIPT_PATH), JSON.stringify(artifact, null, 2));
  return { root, artifact };
}

test("MUTATION: a source that changed since the recording fails until the transcript is re-recorded", () => {
  const { artifact } = scratchTranscript({});
  const moved = {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      oracleSources: artifact.provenance.oracleSources.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "0".repeat(32) } : entry,
      ),
    },
  };
  const { failures } = transcriptFailures(repositoryRoot, moved, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /has changed since the transcript was recorded/u);
});

test("a source that has been DELETED is the post-cutover state, not a failure", () => {
  const { artifact } = scratchTranscript({});
  // The digests are read from the REAL repository, where every source still
  // exists, so this case simulates the other half of the transcript's life by
  // reading a root that has none of them.
  const empty = mkdtempSync(join(tmpdir(), "m2m4-evidence-registers-postcutover-"));
  try {
    const { failures, deletedSources } = transcriptFailures(empty, artifact, []);
    assert.deepEqual(failures, [], "a deleted oracle must not fail the gate; the transcript is what survives it");
    assert.equal(deletedSources, ORACLE_SOURCES.length);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("MUTATION: a transcript with no provenance is a fixture and is refused", () => {
  const { failures } = transcriptFailures(repositoryRoot, { steps: {} }, []);
  assert.match(failures.join("\n"), /carries no provenance/u);
});

test("MUTATION: a scenario with no recorded answer is refused", () => {
  const { artifact } = scratchTranscript({});
  const { failures } = transcriptFailures(repositoryRoot, artifact, ["transport-organization-list"]);
  assert.match(failures.join("\n"), /has no recorded oracle answer/u);
});

test("MUTATION: a credential in a transcript is refused, and an email or a path is not", () => {
  assert.deepEqual(
    credentialShapedValues({ steps: { a: { facts: { email: "operator@example.test", redirectTo: "/orgs/alpha/projects/new" } } } }),
    [],
  );
  const leaked = credentialShapedValues({ steps: { a: { facts: { token: "plt_os_0123456789abcdef0123456789" } } } });
  assert.equal(leaked.length, 1);
  assert.match(leaked[0] ?? "", /Platos credential prefix/u);
  const opaque = credentialShapedValues({ steps: { a: { facts: { value: "K".repeat(48) } } } });
  assert.equal(opaque.length, 1);
});

test("drift in either direction is reported, including a scenario the transcript has never seen", () => {
  const recorded = { one: { status: 200, facts: { ok: true } }, gone: { status: 200, facts: {} } };
  const live = { one: { status: 401, facts: { ok: true } }, fresh: { status: 200, facts: {} } };
  const drift = compareTranscripts(recorded, live);
  assert.equal(drift.length, 3);
  assert.ok(drift.some((entry) => entry.startsWith("one:")));
  assert.ok(drift.some((entry) => entry.startsWith("fresh has no recorded")));
  assert.ok(drift.some((entry) => entry.startsWith("gone is recorded and was not driven")));
  assert.deepEqual(compareTranscripts(recorded, recorded), []);
});

// ---------------------------------------------------------------------------
// The registry the transcript belongs to
// ---------------------------------------------------------------------------

test("the transport registry is well-formed and every dimension has exactly one designated prover", () => {
  assert.deepEqual(assertTransportRegistryIsWellFormed(), []);
  const provers = new Map();
  for (const seed of TRANSPORT_SEEDS) for (const dimension of seed.proves) provers.set(dimension, seed.id);
  assert.deepEqual([...provers.keys()].sort(), transportDimensions());
});

test("MUTATION: a dimension whose prover is deleted fails the registry", () => {
  const failures = assertTransportRegistryIsWellFormed(
    TRANSPORT_SCENARIO_REGISTRY,
    TRANSPORT_SEEDS.filter((seed) => !seed.proves.includes("store")),
  );
  assert.match(failures.join("\n"), /dimension store is declared .* no seed is designated/u);
});

test("MUTATION: a normaliser switched off without prose is refused", () => {
  const silent = TRANSPORT_SCENARIO_REGISTRY.map((scenario) =>
    scenario.id === "transport-sign-out" ? { ...scenario, normalisation: { skip: ["instant-rank"], why: "" } } : scenario,
  );
  const failures = assertTransportRegistryIsWellFormed(silent, TRANSPORT_SEEDS);
  assert.match(failures.join("\n"), /switches off instant-rank without saying why/u);
});

test("the one normaliser these scenarios switch off is declared once, with its loss stated", () => {
  assert.deepEqual([...TRANSPORT_NORMALISATION.skip], ["instant-rank"]);
  assert.ok(TRANSPORT_NORMALISATION.why.length > 120, "the weakening must be argued, not asserted");
  for (const scenario of TRANSPORT_SCENARIO_REGISTRY) {
    assert.equal(scenario.normalisation, TRANSPORT_NORMALISATION, `${scenario.id} normalises on its own terms`);
  }
});

test("MUTATION: an approval with no issue or no rationale is refused", () => {
  const mute = TRANSPORT_SCENARIO_REGISTRY.map((scenario) =>
    scenario.id === "transport-sign-out"
      ? { ...scenario, approvedDifferences: [{ code: "status-changed", rationale: "because", issue: "" }] }
      : scenario,
  );
  const failures = assertTransportRegistryIsWellFormed(mute, TRANSPORT_SEEDS);
  assert.match(failures.join("\n"), /with no rationale/u);
  assert.match(failures.join("\n"), /with no issue/u);
});
