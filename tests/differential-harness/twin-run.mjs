// WIN-284 — the twin-run engine.
//
// Runs one scenario against two subjects backed by isolated equivalent stores,
// normalises both sides with the SAME register, compares the dimensions the
// scenario declares, and returns a verdict.
//
// The engine's real job is not the comparison — that is the easy part — but
// refusing to report parity it did not measure. Four separate guards exist for
// that, and each corresponds to a way this kind of harness has historically
// gone quietly vacuous:
//
//   invalid   a subject returned something that is not an observation. Rejected
//             loudly instead of being coerced into a shape that compares equal.
//   vacuous   a declared dimension carried zero comparable facts on one or both
//             sides. Two sides that both produced no events are not in
//             agreement about events; they are silent, and silence is not
//             evidence. This is the same failure as an architecture gate
//             reporting green while scanning zero files.
//   stale     the scenario approved an intentional difference that did not
//             occur. An approval list that is never reconciled becomes a
//             blanket mute, so an unmatched approval fails the run.
//   unsound   the scenario declared a dimension with no comparator, or asked
//             for `events` to be order-normalised. Both are refused.

import { DIMENSIONS, assertObservation, countComparableFacts } from "./observation.mjs";
import { COMPARATORS, assertComparatorCoverage, assertVolatileHeaders } from "./comparators.mjs";
import { normalise } from "./normalisers.mjs";

export const VERDICTS = Object.freeze(["parity", "divergent", "vacuous", "invalid", "stale-approval", "unsound"]);

function validateScenario(scenario) {
  const failures = [];
  if (typeof scenario?.id !== "string" || scenario.id.trim() === "") failures.push("scenario.id is required");
  if (!Array.isArray(scenario?.dimensions) || scenario.dimensions.length === 0) {
    // A scenario that declares no dimensions compares nothing and would report
    // parity for free. Refused outright.
    failures.push(`${scenario?.id ?? "<unnamed>"} declares no dimensions; it would compare nothing`);
  } else {
    for (const dimension of scenario.dimensions) {
      if (!DIMENSIONS.includes(dimension)) failures.push(`${scenario.id} declares unknown dimension ${dimension}`);
      else if (typeof COMPARATORS[dimension] !== "function") {
        failures.push(`${scenario.id} declares ${dimension}, which has no comparator`);
      }
    }
  }
  try {
    assertVolatileHeaders(scenario?.volatileHeaders ?? []);
  } catch (error) {
    failures.push(`${scenario?.id ?? "<unnamed>"}: ${error.message}`);
  }
  for (const [index, approval] of (scenario?.approvedDifferences ?? []).entries()) {
    const label = `${scenario.id}.approvedDifferences[${index}]`;
    if (typeof approval?.code !== "string" || approval.code.trim() === "") failures.push(`${label}.code is required`);
    if (typeof approval?.rationale !== "string" || approval.rationale.trim().length < 30) {
      failures.push(`${label}.rationale must explain the intentional difference in prose`);
    }
    if (!/^WIN-\d+$/u.test(approval?.issue ?? "")) {
      failures.push(`${label}.issue must name the WIN issue that authorised the difference`);
    }
  }
  return failures;
}

function vacuityFailures(scenario, oracle, candidate) {
  const failures = [];
  for (const dimension of scenario.dimensions) {
    const oracleFacts = countComparableFacts(oracle, dimension);
    const candidateFacts = countComparableFacts(candidate, dimension);
    if (oracleFacts === 0 || candidateFacts === 0) {
      failures.push(
        `${scenario.id}: dimension ${dimension} carried ${oracleFacts} oracle and ${candidateFacts} candidate facts; ` +
          "a dimension with nothing in it is silence, not parity",
      );
    }
  }
  return failures;
}

function matchesApproval(approval, entry) {
  if (approval.code !== entry.code) return false;
  if (approval.path !== undefined && approval.path !== entry.path) return false;
  return true;
}

export function partitionApprovals(divergences, approvedDifferences = []) {
  const approved = [];
  const unapproved = [];
  const used = new Set();
  for (const entry of divergences) {
    const index = approvedDifferences.findIndex(
      (approval, position) => !used.has(position) && matchesApproval(approval, entry),
    );
    if (index === -1) unapproved.push(entry);
    else {
      used.add(index);
      approved.push({ ...entry, approval: approvedDifferences[index] });
    }
  }
  const stale = approvedDifferences
    .map((approval, position) => ({ approval, position }))
    .filter(({ position }) => !used.has(position))
    .map(({ approval }) => approval);
  return { approved, unapproved, stale };
}

// Runs the scenario against both subjects and compares. `subjects` is
// { oracle, candidate }, each an object with `run(scenario) -> Observation`.
// The two subjects MUST be backed by isolated equivalent stores; the engine
// does not create that isolation, it asserts the two sides declared different
// store identities so a scenario cannot accidentally run twice against one
// store and report perfect parity.
export async function twinRun(scenario, subjects, options = {}) {
  const started = new Date().toISOString();
  const unsound = [...validateScenario(scenario), ...assertComparatorCoverage()];
  if (unsound.length) {
    return { scenario: scenario?.id ?? "<unnamed>", verdict: "unsound", failures: unsound, divergences: [], startedAt: started };
  }

  let oracle;
  let candidate;
  try {
    oracle = assertObservation(await subjects.oracle.run(scenario));
    candidate = assertObservation(await subjects.candidate.run(scenario));
  } catch (error) {
    return {
      scenario: scenario.id,
      verdict: "invalid",
      failures: [error.message],
      divergences: [],
      startedAt: started,
    };
  }

  if (oracle.side !== "oracle" || candidate.side !== "candidate") {
    return {
      scenario: scenario.id,
      verdict: "invalid",
      failures: [`sides are mislabelled: saw ${oracle.side} and ${candidate.side}`],
      divergences: [],
      startedAt: started,
    };
  }

  // Isolation assertion. Two sides that report the same store identity were
  // not twin-run against isolated equivalent stores, they were run twice
  // against one store — which compares equal for free.
  const oracleStore = oracle.storeIdentity ?? null;
  const candidateStore = candidate.storeIdentity ?? null;
  if (oracleStore !== null && oracleStore === candidateStore) {
    return {
      scenario: scenario.id,
      verdict: "invalid",
      failures: [
        `both sides reported store identity ${oracleStore}; twin-running one store against itself cannot diverge`,
      ],
      divergences: [],
      startedAt: started,
    };
  }

  const vacuity = vacuityFailures(scenario, oracle, candidate);
  if (vacuity.length) {
    return { scenario: scenario.id, verdict: "vacuous", failures: vacuity, divergences: [], startedAt: started };
  }

  const normaliseOptions = {
    unorderedCollections: scenario.unorderedCollections ?? [],
    skip: options.skipNormalisers ?? [],
  };
  let normalisedOracle;
  let normalisedCandidate;
  try {
    normalisedOracle = normalise(oracle, normaliseOptions);
    normalisedCandidate = normalise(candidate, normaliseOptions);
  } catch (error) {
    return { scenario: scenario.id, verdict: "unsound", failures: [error.message], divergences: [], startedAt: started };
  }

  const divergences = [];
  for (const dimension of scenario.dimensions) {
    const comparator = COMPARATORS[dimension];
    const found = comparator(normalisedOracle, normalisedCandidate, {
      tolerance: scenario.tolerance,
      volatileHeaders: scenario.volatileHeaders ?? [],
    });
    divergences.push(...found);
  }

  const { approved, unapproved, stale } = partitionApprovals(divergences, scenario.approvedDifferences ?? []);
  if (stale.length) {
    return {
      scenario: scenario.id,
      verdict: "stale-approval",
      failures: stale.map(
        (approval) =>
          `${scenario.id} approves ${approval.code} (${approval.issue}) but that difference did not occur; ` +
          "a standing approval that never matches is a permanent mute",
      ),
      divergences: unapproved,
      approved,
      startedAt: started,
    };
  }

  return {
    scenario: scenario.id,
    verdict: unapproved.length === 0 ? "parity" : "divergent",
    failures: [],
    divergences: unapproved,
    approved,
    dimensions: [...scenario.dimensions],
    factCounts: Object.fromEntries(
      scenario.dimensions.map((dimension) => [
        dimension,
        { oracle: countComparableFacts(oracle, dimension), candidate: countComparableFacts(candidate, dimension) },
      ]),
    ),
    startedAt: started,
  };
}

export function formatResult(result) {
  const lines = [`${result.scenario}: ${result.verdict.toUpperCase()}`];
  for (const failure of result.failures ?? []) lines.push(`  FAIL: ${failure}`);
  for (const entry of result.divergences ?? []) {
    lines.push(`  DIVERGENCE [${entry.dimension}/${entry.code}] ${entry.path}: ${entry.message}`);
  }
  for (const entry of result.approved ?? []) {
    lines.push(`  APPROVED  [${entry.dimension}/${entry.code}] ${entry.path}: ${entry.approval.issue} — ${entry.approval.rationale}`);
  }
  if (result.factCounts) {
    const counts = Object.entries(result.factCounts)
      .map(([dimension, value]) => `${dimension}=${value.oracle}/${value.candidate}`)
      .join(" ");
    lines.push(`  facts compared (oracle/candidate): ${counts}`);
  }
  return lines.join("\n");
}
