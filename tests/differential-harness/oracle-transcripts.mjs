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
      "is the frozen record the candidate is compared against.",
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
 * Where the live oracle stopped answering what was recorded.
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
    const left = JSON.stringify(before, Object.keys(before).sort());
    const right = JSON.stringify(answer, Object.keys(answer).sort());
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
    } else if (before.sha256 !== current.sha256) {
      failures.push(
        `${current.path} has changed since the transcript was recorded (${String(before.sha256)} -> ${String(current.sha256)}); ` +
          "re-record with PLATOS_DIFFERENTIAL_RECORD=1 and read the diff, or the differential is comparing the " +
          "candidate against an oracle that no longer exists",
      );
    }
  }

  for (const id of scenarioIds) {
    if (!(id in (artifact.steps ?? {}))) {
      failures.push(`scenario ${id} has no recorded oracle answer; it would lose its meaning when the oracle is deleted`);
    }
  }
  for (const value of credentialShapedValues(artifact)) {
    failures.push(`${TRANSCRIPT_PATH} ${value}; a committed transcript may carry no credential`);
  }
  return { failures, deletedSources: deleted };
}
