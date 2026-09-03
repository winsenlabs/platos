// WIN-284 — the recorded subject.
//
// Replays a pre-captured observation for a scenario. Two uses:
//
//   1. FREEZING THE ORACLE. `main` is pinned at 89c12b8 and admin-enforced, so
//      its behaviour cannot drift. A recording taken from it is therefore a
//      legitimate oracle: re-running the frozen commit would produce the same
//      answer, and the recording carries the commit it came from so a reviewer
//      can tell which oracle they are reading.
//   2. EXERCISING THE HARNESS ITSELF. The negative controls need a subject with
//      no moving parts, or a failure to catch a seeded difference could be
//      blamed on the environment rather than the comparator.
//
// A recording is NOT a substitute for running the candidate. It is explicitly
// refused as the candidate side unless the caller passes `allowRecordedCandidate`
// with a stated reason — otherwise "twin-run" would mean replaying two files at
// each other, which compares equal for free and proves nothing about a system.

import { assertObservation } from "../observation.mjs";

export function createRecordedSubject(options) {
  const { side, recordings, provenance, allowRecordedCandidate } = options;
  if (side !== "oracle" && side !== "candidate") throw new Error(`side must be oracle or candidate, saw ${side}`);
  if (side === "candidate" && !allowRecordedCandidate) {
    throw new Error(
      "a recorded candidate is refused: replaying two recordings at each other is not a twin-run. " +
        "Pass allowRecordedCandidate with a reason if you are exercising the harness itself.",
    );
  }
  if (typeof provenance?.commit !== "string" || !/^[a-f0-9]{7,40}$/u.test(provenance.commit)) {
    throw new Error("a recording must carry the commit it was captured from");
  }
  if (typeof provenance?.capturedAt !== "string" || provenance.capturedAt.trim() === "") {
    throw new Error("a recording must carry the moment it was captured");
  }

  return {
    name: `recorded:${side}@${provenance.commit}`,
    provenance,
    async run(scenario) {
      const recording = recordings[scenario.id];
      if (recording === undefined) {
        // Never return an empty observation for a missing recording. An empty
        // observation compares equal to another empty observation and the run
        // reads as parity over a scenario that was never executed.
        throw new Error(`no recording for scenario ${scenario.id} on the ${side} side`);
      }
      return assertObservation({ ...recording, scenario: scenario.id, side });
    },
  };
}

// Builds a candidate subject from a transform over the oracle recording. This
// is how the negative-control runner seeds a difference: the candidate is the
// oracle plus exactly one deliberate change, so anything the harness reports
// is attributable to that change and nothing else.
export function createSeededCandidateSubject(options) {
  const { recordings, provenance, transform, label } = options;
  if (typeof transform !== "function") throw new Error("a seeded candidate needs a transform");
  const inner = createRecordedSubject({
    side: "candidate",
    recordings,
    provenance,
    allowRecordedCandidate: `negative control: ${label}`,
  });
  return {
    name: `seeded:${label}`,
    provenance,
    async run(scenario) {
      const base = await inner.run(scenario);
      return assertObservation(transform(base));
    },
  };
}
