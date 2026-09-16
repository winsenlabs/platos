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

import { normalise } from "./normalisers.mjs";
import {
  ORACLE_SOURCES,
  TRANSCRIPT_PATH,
  compareTranscripts,
  credentialShapedValues,
  oracleSourceDigests,
  readTranscripts,
  recordedObservation,
  recordedOracleSubject,
  replayFailures,
  transcriptFailures,
} from "./oracle-transcripts.mjs";
import { twinRun } from "./twin-run.mjs";
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

test("MUTATION: drift in a NESTED fact is reported — the comparison is not a key filter", () => {
  // THE DEFECT THIS CLOSES, found in round 2 by a mutation of the committed
  // transcript's store that the drift detector did not notice. The comparison
  // was `JSON.stringify(value, Object.keys(value).sort())`, which is a key
  // FILTER applied at every depth, not a key order — so everything below the top
  // level serialised to `{}` and two transcripts differing in every fact, every
  // principal and every stored row compared equal.
  const recorded = {
    one: {
      status: 200,
      facts: { written: true },
      auth: { principal: "<id:0>", scopes: [], decision: "allow", reason: null },
      store: { EnvironmentVariable: [{ key: "WRITTEN_PLAIN", value: "written-value" }] },
      storeIdentity: "differential_oracle",
    },
  };
  const perturbedFact = { one: { ...recorded.one, facts: { written: false } } };
  const perturbedRow = {
    one: { ...recorded.one, store: { EnvironmentVariable: [{ key: "WRITTEN_PLAIN", value: "something-else" }] } },
  };
  const perturbedAuth = { one: { ...recorded.one, auth: { ...recorded.one.auth, decision: "deny" } } };
  for (const [label, live] of [["fact", perturbedFact], ["row", perturbedRow], ["auth", perturbedAuth]]) {
    assert.equal(compareTranscripts(recorded, live).length, 1, `a changed ${label} must be drift`);
  }
  // Key ORDER still must not be drift, which is what the sorting is for.
  const reordered = {
    one: {
      storeIdentity: "differential_oracle",
      store: { EnvironmentVariable: [{ value: "written-value", key: "WRITTEN_PLAIN" }] },
      auth: { reason: null, decision: "allow", scopes: [], principal: "<id:0>" },
      facts: { written: true },
      status: 200,
    },
  };
  assert.deepEqual(compareTranscripts(recorded, reordered), []);
});

// ---------------------------------------------------------------------------
// THE REPLAY — the candidate against the frozen record, with no Docker daemon
// ---------------------------------------------------------------------------

test("every committed step is REPLAYABLE: all four dimensions, store included", () => {
  // The round-2 defect, as a permanent case. A transcript of
  // {status, facts, auth} cannot stand in for an oracle whose most load-bearing
  // answer is the row it left behind — `transport-environment-variable-set`
  // records the single fact {"written": true}, and everything else it means is
  // in the store.
  const artifact = readTranscripts(repositoryRoot);
  assert.deepEqual(replayFailures(artifact, SCENARIO_IDS), []);
  for (const id of SCENARIO_IDS) {
    const step = artifact.steps[id];
    assert.ok(Object.keys(step.store ?? {}).length > 0, `${id} records an empty store`);
  }
});

test("MUTATION: a recorded step with no store is refused as an oracle", () => {
  const artifact = readTranscripts(repositoryRoot);
  const id = SCENARIO_IDS[0];
  const { store, ...withoutStore } = artifact.steps[id];
  assert.ok(store !== undefined);
  const failures = replayFailures({ steps: { ...artifact.steps, [id]: withoutStore } }, SCENARIO_IDS);
  assert.ok(failures.some((entry) => entry.includes("records no store")), failures.join("\n"));
  assert.throws(
    () => recordedObservation({ ...artifact.steps, [id]: withoutStore }, id),
    /carries no store/u,
  );
});

test("the RECORDED DIMENSIONS are idempotent under the normalisers, which is what lets one engine read them twice", () => {
  // The transcript is written through the normalisers so `twinRun` may read it
  // back as a subject and normalise it a second time. If that second pass moved
  // a recorded dimension, every replay would be a false divergence — so it is
  // asserted over the committed recording itself rather than assumed.
  //
  // `usage` is deliberately NOT asserted and deliberately not recorded: no
  // transport scenario declares it, `recordedObservation` reconstructs it as
  // zeroes, and `duration-elided` then erases the field on both sides. Asserting
  // idempotency over a field nothing compares would be asserting the shape of
  // the reconstruction rather than the meaning of the record.
  const artifact = readTranscripts(repositoryRoot);
  const recordedDimensions = (observation) => ({
    status: observation.response.status,
    facts: observation.response.body,
    auth: observation.auth,
    store: observation.store,
  });
  for (const id of SCENARIO_IDS) {
    const scenario = TRANSPORT_SCENARIO_REGISTRY.find((entry) => entry.id === id);
    const options = { unorderedCollections: scenario.unorderedCollections ?? [], skip: scenario.normalisation.skip };
    const once = recordedObservation(artifact.steps, id);
    assert.deepEqual(
      recordedDimensions(normalise(once, options)),
      recordedDimensions(once),
      `${id} moved when normalised a second time`,
    );
  }
});

test("THE REPLAY IS NOT VACUOUS: a candidate that did not write the row diverges from the frozen record", async () => {
  const artifact = readTranscripts(repositoryRoot);
  const id = "transport-environment-variable-set";
  const scenario = TRANSPORT_SCENARIO_REGISTRY.find((entry) => entry.id === id);
  const recordedSide = recordedObservation(artifact.steps, id);

  // A candidate that answers exactly what was recorded replays clean.
  const faithful = { ...recordedSide, side: "candidate", storeIdentity: "differential_candidate" };
  const parity = await twinRun(
    scenario,
    { oracle: recordedOracleSubject(artifact.steps, id), candidate: { run: () => faithful } },
    { skipNormalisers: scenario.normalisation.skip },
  );
  assert.equal(parity.verdict, "parity", JSON.stringify(parity.divergences ?? parity.failures));

  // The same candidate missing the row the write was supposed to leave must not.
  // ONE ROW, NOT THE WHOLE TABLE: emptying it is refused as VACUOUS by twinRun
  // before any comparison happens — a correct refusal, and one that would have
  // let this control pass while proving nothing about the comparison. `facts` is
  // untouched and still says {"written": true}, which is the whole reason the
  // store had to be recorded.
  const table = Object.keys(faithful.store)[0];
  assert.ok(faithful.store[table].length >= 2, `${table} needs a row to drop and a row to keep`);
  const drifted = await twinRun(
    scenario,
    {
      oracle: recordedOracleSubject(artifact.steps, id),
      candidate: { run: () => ({ ...faithful, store: { ...faithful.store, [table]: faithful.store[table].slice(0, -1) } }) },
    },
    { skipNormalisers: scenario.normalisation.skip },
  );
  assert.equal(drifted.verdict, "divergent", JSON.stringify(drifted));
  assert.ok(
    (drifted.divergences ?? []).some((entry) => entry.dimension === "store"),
    JSON.stringify(drifted.divergences),
  );
});

test("the replay works with every oracle source DELETED, which is the state it exists for", () => {
  // Post-cutover: `recordedObservation` reads the committed artifact and touches
  // no webapp source, so the replay above is exactly as runnable when
  // `apps/webapp/app/routes` is gone as it is today.
  const artifact = readTranscripts(repositoryRoot);
  for (const id of SCENARIO_IDS) {
    const observation = recordedObservation(artifact.steps, id);
    assert.equal(observation.side, "oracle");
    assert.equal(observation.scenario, id);
    assert.ok(typeof observation.storeIdentity === "string" && observation.storeIdentity.length > 0);
  }
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
