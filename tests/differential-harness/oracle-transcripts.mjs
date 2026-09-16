// WIN-257 / WIN-284 — THE ORACLE TRANSCRIPT, AND WHY IT IS COMMITTED.
//
// WIN-257 T8 deletes `apps/webapp/app/services/database.server.ts`, the fifteen
// Prisma operations in the webapp's routes and the `PlatosAuthService` calls
// beside them. Every one of those is an ORACLE the transport differential runs
// against today. A differential whose oracle has been deleted does not go red;
// it goes QUIET — the scenarios still execute, the candidate still answers, and
// the comparison has nothing to compare against. That is the worst failure a
// parity harness has, because it looks exactly like success.
//
// So the oracle is RECORDED AS IT RUNS, before the cutover removes it, and the
// recording is joined to the source that produced it:
//
//   WHILE THE SOURCES EXIST  their digests are pinned here. A change to
//                            `auth.server.ts` or to a route the driver executes
//                            moves a digest, and `--check` fails until the
//                            transcript is re-recorded and the diff read. So a
//                            stale transcript cannot masquerade as a fresh one.
//   AFTER THE CUTOVER        a source that no longer exists is recorded as
//                            `absent`. The transcript is then the frozen record
//                            of what the deleted code answered, the candidate is
//                            still compared against it, and the artifact says in
//                            its own fields which half of its life it is in.
//
// ROUND-2 CORRECTION — WHAT "THE CANDIDATE IS COMPARED AGAINST IT" COST.
//
// The sentence above was written before the code that makes it true. Two things
// were wrong and both are fixed here:
//
//   1. THE RECORDING WAS INCOMPLETE. Only `{status, facts, auth}` was written.
//      The `store` dimension — the half that passes through no projection at all,
//      and the half that carries the whole meaning of a scenario like
//      `transport-environment-variable-set`, whose facts are the single boolean
//      `{"written": true}` — was never recorded. A transcript missing it cannot
//      stand in for the oracle after the cutover, because the thing the oracle
//      was most useful for is precisely what was not kept.
//   2. NOTHING COMPARED THE CANDIDATE AGAINST IT. `compareTranscripts` compares
//      the recording against the LIVE oracle. That is a real gate — it is the
//      drift detector that stops a stale recording passing as fresh — but it is
//      not a post-cutover oracle, and calling it one made the design read as
//      finished while half of it was missing.
//
// So a transcript step is now a whole twin-run OBSERVATION, recorded THROUGH THE
// NORMALISER REGISTER, and `recordedOracleSubject` hands it back to `twinRun` as
// a subject. The candidate is compared against the frozen record by the same
// engine, the same comparators and the same approved differences that compare it
// against the live oracle — one comparison engine in this harness, not two.
// Recording the NORMALISED observation rather than the raw one is what lets the
// same engine read it twice: `normalise` is idempotent over its own output (a
// case in `oracle-transcripts.test.mjs` asserts exactly that), and it is also
// what keeps a session `tokenHash` out of a committed artifact, because
// `digest-ordinal` has already turned it into `<digest:0>` before anything is
// written.
//
// NOTHING IN A TRANSCRIPT MAY BE A CREDENTIAL. The facts recorded are booleans,
// slugs, names, roles and seeded identifiers. `Set-Cookie` is used by the running
// suite and dropped before anything is written, and `credentialShapedValues`
// enforces that from the other side: a committed transcript carrying a live
// session token would be a raw-secret artifact of exactly the class WIN-259
// counts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TRANSCRIPT_PATH = "tests/differential-harness/oracle-transcripts.json";

/**
 * The files the oracle IS.
 *
 * A path constant list, not a glob: these are the exact modules
 * `apps/webapp/test/differential-oracle.mts` imports, and the reason each one is
 * here is that deleting or changing it changes what the oracle answers. A glob
 * over `app/routes` would pin 84 files whose contents this differential never
 * executes, and a digest that moves for an unrelated screen is a digest nobody
 * re-reads.
 */
export const ORACLE_SOURCES = Object.freeze([
  "apps/webapp/app/services/auth.server.ts",
  "apps/webapp/app/services/database.server.ts",
  "apps/webapp/app/services/projectAccess.server.ts",
  "apps/webapp/app/routes/login._index/route.tsx",
  "apps/webapp/app/routes/logout.tsx",
  "apps/webapp/app/routes/_app.orgs.new/route.tsx",
  "apps/webapp/app/routes/_app.orgs.$organizationSlug._index/route.tsx",
  "apps/webapp/app/routes/_app.orgs.$organizationSlug_.projects.new/route.tsx",
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-accounts._index/route.tsx",
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx",
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx",
  "internal-packages/tenancy-database/src/auth.ts",
]);

/**
 * THE EXECUTABLE THE ORACLE WAS. Deleted by WIN-257 T8.
 *
 * `apps/webapp/test/differential-oracle.mts` is the one process that could ever
 * ask the oracle a question: it imports the real route modules and the real
 * `auth.server` exports and runs them against a real PostgreSQL. While it exists
 * the recording can be re-made, and a source that has moved since must be
 * re-recorded (that is `transcriptFailures`'s digest rule). Once it is gone there
 * is nothing left to re-record FROM, and the transcript is the only surviving
 * account of what those files answered.
 *
 * Which is why its presence — not a flag, not a date — is what switches this
 * module between its two lives.
 */
export const ORACLE_DRIVER = "apps/webapp/test/differential-oracle.mts";

/**
 * THE ORACLE'S OWN MODULES, the two T8 deletes outright.
 *
 * `database.server.ts` is the `PrismaClient`; `projectAccess.server.ts` is the
 * visibility rule that existed only as a `Prisma.ProjectWhereInput`. After the
 * cutover neither may come back, because either one coming back would mean the
 * webapp holds a database client again and the transcript's claim to be the
 * record of something that no longer exists would be false.
 */
export const ORACLE_OWN_MODULES = Object.freeze([
  "apps/webapp/app/services/database.server.ts",
  "apps/webapp/app/services/projectAccess.server.ts",
]);

/**
 * Whether the oracle can still be asked a question.
 *
 * TRUE while the driver exists — the transcript is a RECORDING that must match
 * what the sources answer today, and a drifted source fails until it is
 * re-recorded. FALSE once T8 has deleted it — the transcript is the FROZEN
 * RECORD, and what must be checked instead is that it can never be contradicted:
 * see `retirementFailures`.
 */
export function oracleIsLive(root) {
  return existsSync(join(root, ORACLE_DRIVER));
}

/**
 * A surviving oracle source that could still reach a database.
 *
 * THE POST-CUTOVER GATE, AND IT IS NOT A RELAXATION OF THE DIGEST RULE — it is a
 * STRONGER join. While the oracle is live the question is "has this file moved
 * since we recorded it?", which a digest answers. Once it is deleted that
 * question has no answer anybody can act on: `auth.server.ts` still exists and is
 * SUPPOSED to have changed, because T8 rewrote it to call core-api. Pinning its
 * digest forever would freeze a file the cutover exists to change; dropping the
 * check entirely would leave the transcript claiming to record something nobody
 * checks any more.
 *
 * So the claim that is checked is the one that actually matters afterwards: THE
 * ORACLE IS UNRECOVERABLE. Its two own modules are gone, and no surviving source
 * imports the canonical client or calls a Prisma delegate. If any of that stopped
 * being true, the webapp would hold a database client again — and the transcript
 * would be the frozen record of an oracle that had come back to life, which is
 * the one state in which believing it is wrong.
 *
 * It is a byte scan and not an import graph on purpose: it runs with no install,
 * on every CI run, beside the other transcript controls. `webapp-no-prisma`
 * (scripts/arch) is the structural enforcement and this is the join the
 * transcript makes for itself, so neither stands alone.
 */
export function retirementFailures(root) {
  const failures = [];
  for (const path of ORACLE_OWN_MODULES) {
    if (existsSync(join(root, path))) {
      failures.push(
        `${path} exists again. The transcript is the frozen record of an oracle that was deleted; an oracle that ` +
          "came back cannot be recorded by a file nobody re-runs",
      );
    }
  }
  for (const path of ORACLE_SOURCES) {
    if (ORACLE_OWN_MODULES.includes(path)) continue;
    if (!path.startsWith("apps/webapp/")) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    for (const finding of oracleRevivalsIn(readFileSync(absolute, "utf8"))) {
      failures.push(`${path} ${finding}; the oracle this transcript recorded is back`);
    }
  }
  return failures;
}

/**
 * Ways one file could be an oracle again, scanned LINE BY LINE with comment
 * lines skipped.
 *
 * THE COMMENTS ARE THE REASON THIS IS NOT A WHOLE-FILE REGEX. Every file T8
 * rewrote explains what it used to do, in prose, quoting the delegate calls it
 * deleted — `auth.server.ts` names `database.environment.findFirst` in its own
 * banner. A scan that read those would report the explanation of the cutover as
 * evidence the cutover was undone, which is the kind of false positive that gets
 * a gate switched off.
 */
export function oracleRevivalsIn(text) {
  const found = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    if (/from\s+["']@platos\/tenancy-database["']/u.test(line) || /require\(["']@platos\/tenancy-database["']\)/u.test(line)) {
      found.push("imports the canonical client again");
    }
    if (/(?:^|[^A-Za-z0-9_$.])(?:database|transaction)\.[A-Za-z$][A-Za-z0-9_]*\s*[.(]/u.test(line)) {
      found.push("calls a Prisma delegate again");
    }
  }
  return [...new Set(found)];
}

function digestOf(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return { path, present: false, sha256: null };
  return { path, present: true, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex").slice(0, 32) };
}

export function oracleSourceDigests(root) {
  return ORACLE_SOURCES.map((path) => digestOf(root, path));
}

function headCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function readTranscripts(root) {
  const absolute = join(root, TRANSCRIPT_PATH);
  if (!existsSync(absolute)) return { version: 1, provenance: null, steps: {} };
  return JSON.parse(readFileSync(absolute, "utf8"));
}

export function writeTranscripts(root, steps) {
  const artifact = {
    version: 1,
    issue: "WIN-257",
    title: "Recorded answers of the webapp Prisma/PlatosAuthService oracle",
    why:
      "WIN-257 T8 deletes this oracle. Recorded before the cutover so the transport differential keeps its meaning " +
      "afterwards: while the sources below exist the live oracle must still answer this, and once they are gone this " +
      "is the frozen record the candidate is compared against by recordedOracleSubject -> twinRun.",
    recordedThrough:
      "the normaliser register, with the transport scenarios' declared skips applied — so a step is in the same " +
      "shape both sides are compared in, normalise() may read it a second time without moving it, and no digest, " +
      "instant or generated identifier is written verbatim",
    dimensions: ["status", "facts", "auth", "store"],
    provenance: {
      commit: headCommit(root),
      capturedAt: new Date().toISOString(),
      capturedBy: "apps/core-api/src/composition/transport-differential.integration.test.ts",
      oracleSources: oracleSourceDigests(root),
    },
    contains:
      "booleans, slugs, names, roles and seeded identifiers only; Set-Cookie is used by the running suite and " +
      "dropped before anything is written here",
    steps: Object.fromEntries(Object.entries(steps).sort(([left], [right]) => (left < right ? -1 : 1))),
  };
  writeFileSync(join(root, TRANSCRIPT_PATH), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

/**
 * THE POST-CUTOVER ORACLE: one recorded step, as a twin-run observation.
 *
 * This is the half that makes the transcript an oracle rather than a souvenir.
 * The step was recorded through the normaliser register, so it is already in the
 * shape both sides are compared in, and `twinRun` may normalise it a second time
 * without moving it.
 *
 * `storeIdentity` is recorded, not invented. It is the name of the database the
 * rows were dumped from, which is what `twinRun`'s isolation refusal needs to be
 * able to tell the two sides apart — and after the cutover it is an honest piece
 * of provenance rather than a live handle: it says where these rows came from
 * when the code that wrote them still existed.
 */
export function recordedObservation(recorded, scenarioId) {
  const step = (recorded ?? {})[scenarioId];
  if (step === undefined || step === null || typeof step !== "object") {
    throw new Error(
      `no recorded oracle answer for ${scenarioId}; the transcript cannot stand in for an oracle it never saw`,
    );
  }
  if (step.store === null || typeof step.store !== "object" || Array.isArray(step.store)) {
    throw new Error(
      `the recorded answer for ${scenarioId} carries no store; it cannot replay the dimension that passes through ` +
        "no projection",
    );
  }
  return {
    scenario: scenarioId,
    side: "oracle",
    subject: RECORDED_SUBJECT,
    storeIdentity: step.storeIdentity ?? "differential_oracle",
    response: { status: step.status, headers: {}, body: step.facts },
    events: [],
    auth: step.auth,
    sideEffects: [],
    usage: { inputUnits: 0, outputUnits: 0, costMicros: 0, durationMs: 0, measured: [] },
    store: step.store,
  };
}

export const RECORDED_SUBJECT = "webapp-prisma-oracle (recorded)";

/** The recorded step as a `twinRun` subject, so the replay uses the live engine. */
export function recordedOracleSubject(recorded, scenarioId) {
  return { run: () => recordedObservation(recorded, scenarioId) };
}

/**
 * The shape a step must have to be replayable, checked without a Docker daemon.
 *
 * Declared separately from `transcriptFailures` because this is the obligation
 * the ROUND-2 correction added: a transcript that records a status and a boolean
 * and calls itself an oracle is the failure this list exists to name.
 */
export function replayFailures(artifact, scenarioIds = []) {
  const failures = [];
  const steps = artifact.steps ?? {};
  for (const id of scenarioIds) {
    const step = steps[id];
    if (step === undefined) {
      failures.push(`${id} has no recorded step, so nothing can be replayed against it`);
      continue;
    }
    for (const field of ["status", "facts", "auth", "store", "storeIdentity"]) {
      if (step[field] === undefined) {
        failures.push(`${id} records no ${field}; the candidate cannot be compared against a partial recording`);
      }
    }
    if (step.store !== undefined && Object.keys(step.store ?? {}).length === 0) {
      failures.push(
        `${id} records an EMPTY store. Every transport scenario declares store tables, so an empty dump is a ` +
          "recording of nothing rather than a recording of no rows",
      );
    }
  }
  return failures;
}

/**
 * A stable serialisation whose keys are sorted AT EVERY DEPTH.
 *
 * THIS REPLACES A GATE THAT COMPARED ALMOST NOTHING, found by a round-2
 * mutation of my own. `JSON.stringify(value, Object.keys(value).sort())` reads
 * as "serialise with the keys in a stable order". It is not: the second argument
 * of `JSON.stringify` is not a key ORDER, it is a key FILTER, and it applies at
 * every depth. With the top-level names as the filter, `{"facts":{"written":
 * true}}` serialises to `{"facts":{}}` — so two transcripts differing in every
 * fact, every auth principal and every stored row compared EQUAL, and the drift
 * detector could only ever have caught a changed `status`. The bug was invisible
 * while the recording was `{status, facts, auth}` of mostly-constant shape; it
 * surfaced the moment a mutation of a recorded ROW failed to move it.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Where the LIVE oracle stopped answering what was recorded.
 *
 * THIS IS THE DRIFT DETECTOR, NOT THE REPLAY. It compares the recording against
 * what the webapp answers TODAY, so a recording that has gone stale fails rather
 * than being quietly re-recorded. The replay — the candidate against the frozen
 * record — is `recordedOracleSubject` fed to `twinRun`. Both exist; neither
 * stands in for the other, and the first stops working the moment T8 deletes the
 * sources while the second is what T8 leaves behind.
 *
 * A missing recording is drift too, and stated as such: a scenario the transcript
 * has never seen is a scenario whose meaning nothing preserves after the cutover.
 */
export function compareTranscripts(recorded, live) {
  const drift = [];
  for (const [id, answer] of Object.entries(live)) {
    const before = recorded[id];
    if (before === undefined) {
      drift.push(`${id} has no recorded oracle answer; it would lose its meaning the moment the oracle is deleted`);
      continue;
    }
    const left = canonicalJson(before);
    const right = canonicalJson(answer);
    if (left !== right) drift.push(`${id}: recorded ${left} but the live oracle answered ${right}`);
  }
  for (const id of Object.keys(recorded)) {
    if (!(id in live)) drift.push(`${id} is recorded and was not driven; a transcript nobody re-runs is not an oracle`);
  }
  return drift;
}

/**
 * Anything in a transcript that has the shape of a credential.
 *
 * Deliberately blunt: a long opaque string with no spaces is what a token looks
 * like, and the facts this transcript is allowed to carry are short and
 * meaningful. A rule that tried to recognise each mint's prefix would miss the
 * next one.
 */
export function credentialShapedValues(artifact) {
  const found = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (/^plt_/u.test(value)) {
        found.push(`${path}: a value with a Platos credential prefix`);
        return;
      }
      // A credential is LONG and OPAQUE: no spaces, no `@`, no `/`, no `:` and
      // nothing but the token alphabet. An email address, a redirect path and a
      // UUID are none of those, and a rule that flagged them would be a rule
      // somebody turns off. What it still catches is the shape every mint in
      // this tree emits.
      if (value.length >= 32 && /^[A-Za-z0-9_-]+$/u.test(value) && !/^[0-9a-f-]{36}$/iu.test(value)) {
        found.push(`${path}: a ${String(value.length)}-character opaque token-shaped string`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) walk(entry, `${path}[${String(index)}]`);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
    }
  };
  walk(artifact.steps ?? {}, "steps");
  return found;
}

/**
 * Why a committed transcript may not be believed, if anything.
 *
 * This is the half that runs without Docker, so the artifact's provenance is
 * checked on every CI run rather than only on a machine with a daemon.
 */
export function transcriptFailures(root, artifact = readTranscripts(root), scenarioIds = []) {
  const failures = [];
  if (artifact.provenance === null || typeof artifact.provenance !== "object") {
    failures.push(`${TRANSCRIPT_PATH} carries no provenance; a recording that cannot say where it came from is a fixture`);
    return { failures, deletedSources: 0 };
  }
  if (!/^[0-9a-f]{7,40}$/u.test(artifact.provenance.commit ?? "")) {
    failures.push(`${TRANSCRIPT_PATH} does not name the commit it was captured from`);
  }
  if (typeof artifact.provenance.capturedAt !== "string" || artifact.provenance.capturedAt.trim() === "") {
    failures.push(`${TRANSCRIPT_PATH} does not name the moment it was captured`);
  }

  const recordedSources = new Map((artifact.provenance.oracleSources ?? []).map((entry) => [entry.path, entry]));
  if (recordedSources.size !== ORACLE_SOURCES.length) {
    failures.push(
      `${TRANSCRIPT_PATH} pins ${String(recordedSources.size)} oracle source(s) and the driver executes ` +
        `${String(ORACLE_SOURCES.length)}; re-record it`,
    );
  }
  // WHICH HALF OF THE TRANSCRIPT'S LIFE THIS TREE IS IN. See `oracleIsLive`: the
  // driver's presence is the switch, because the driver is the only thing that
  // could ever re-record.
  const live = oracleIsLive(root);
  let deleted = 0;
  for (const current of oracleSourceDigests(root)) {
    const before = recordedSources.get(current.path);
    if (before === undefined) {
      failures.push(`${current.path} is an oracle source and the transcript pins no digest for it`);
      continue;
    }
    if (!current.present) {
      // THE POST-CUTOVER STATE, AND IT IS NOT A FAILURE. The source this
      // transcript recorded has been deleted, which is what T8 is for. The
      // transcript is now the frozen record of what it answered.
      deleted += 1;
      continue;
    }
    if (before.present === false) {
      failures.push(`${current.path} exists again but the transcript records it as deleted; re-record the transcript`);
    } else if (before.sha256 !== current.sha256 && live) {
      // ONLY WHILE THE ORACLE CAN ANSWER. Afterwards a moved digest is not a
      // failure and not an excuse either: `retirementFailures` replaces it with
      // the claim that survives — that the oracle cannot come back. Half the
      // pinned sources are files T8 REWRITES (`auth.server.ts`, five routes), so
      // keeping the digest rule here would freeze exactly the files the cutover
      // exists to change.
      failures.push(
        `${current.path} has changed since the transcript was recorded (${String(before.sha256)} -> ${String(current.sha256)}); ` +
          "re-record with PLATOS_DIFFERENTIAL_RECORD=1 and read the diff, or the differential is comparing the " +
          "candidate against an oracle that no longer exists",
      );
    }
  }
  if (!live) failures.push(...retirementFailures(root));

  for (const id of scenarioIds) {
    if (!(id in (artifact.steps ?? {}))) {
      failures.push(`scenario ${id} has no recorded oracle answer; it would lose its meaning when the oracle is deleted`);
    }
  }
  for (const value of credentialShapedValues(artifact)) {
    failures.push(`${TRANSCRIPT_PATH} ${value}; a committed transcript may carry no credential`);
  }
  return { failures, deletedSources: deleted, oracleLive: live };
}
