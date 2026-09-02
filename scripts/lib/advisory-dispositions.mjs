// SPDX-License-Identifier: Apache-2.0
//
// advisory-dispositions.mjs — the WIN-299 (M2.6) advisory disposition gate.
//
// `scripts/audit-advisory.mjs --check` already proves the OSV receipt reconciles
// against the exact lockfile and the exact webapp image inventory. That is a
// FRESHNESS contract: it says the finding list is honest about what ships. It
// says nothing at all about whether anybody has looked at the findings.
//
// That gap is how GHSA-gr94-w7qr-f4j3 (engine.io) and GHSA-xwg4-73v4-xw9w
// (nanoid) arrived on `v1` unowned: they are pre-existing dependencies with
// newly published advisories, so `scanSetSha256` never moved and no gate had an
// opinion. This module supplies the missing opinion.
//
// THE CONTRACT
//
//   Every CRITICAL/HIGH finding in the receipt must carry an explicit, dated,
//   owned disposition in docs/audits/sbom/advisory/advisory-policy.json.
//
// Dispositions come in exactly two states, and the distinction is deliberate —
// a reader must never have to guess which one they are looking at:
//
//   waived  — somebody assessed reachability and wrote the argument down.
//   carried — nobody has assessed it yet. This is NOT a safety claim. It is a
//             written admission that a live CRITICAL/HIGH is unassessed, with
//             an owner and a date attached so it cannot rot quietly.
//
// An UPGRADED advisory is not a disposition at all — it simply stops appearing
// in the receipt. Those are recorded separately in `resolved[]`, and the gate
// verifies each such claim by proving the finding is genuinely ABSENT. So a
// false "we fixed it" fails just as loudly as an unowned finding.
//
// WHY EACH RULE EXISTS (all seven are independently provable failures; see
// scripts/verify-advisory-nonvacuity.mjs):
//
//   1. unowned      — a new CRITICAL/HIGH with no entry. The original gap.
//   2. stale        — an entry matching no live finding, so the register cannot
//                     accumulate reassuring text about things that are gone.
//   3. expired      — reviewBy in the past. A waiver is a loan, not a pardon.
//   4. unreasoned   — empty/token argument, owner, or issue.
//   5. drift        — entry's `images` disagree with the receipt's, so a finding
//                     that spreads to another image loses its disposition.
//   6. false-fix    — a `resolved[]` claim whose finding is still present.
//   7. narrowed     — gatedSeverities edited away from CRITICAL+HIGH. Without
//                     this the whole gate can be disabled by a one-word diff.

export const ADVISORY_POLICY_SCHEMA = 'platos.audit.advisory-policy/v1';

// The gated severity floor is a CONSTANT, not a policy knob. `advisory-policy.json`
// must restate it exactly; any disagreement fails rule 7. Making it configurable
// would let a future edit silence the gate without deleting a single disposition.
export const GATED_SEVERITIES = Object.freeze(['CRITICAL', 'HIGH']);

export const DISPOSITION_STATES = Object.freeze(['waived', 'carried']);
export const REACHABILITY_VERDICTS = Object.freeze(['inert', 'reachable', 'unassessed']);

// Long enough that "n/a", "TODO" and "see ticket" cannot pass as an argument.
const MIN_ARGUMENT_LENGTH = 80;
const ISSUE_PATTERN = /^WIN-\d+$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function findingKey({ package: name, version, id }) {
  return `${name}@${version}/${id}`;
}

function isGated(finding) {
  return GATED_SEVERITIES.includes(finding.severity);
}

function parseDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function dispositionKey(entry) {
  return `${entry.package}@${entry.version}/${entry.advisory}`;
}

function resolvedKey(entry) {
  return `${entry.package}@${entry.fromVersion}/${entry.advisory}`;
}

/**
 * Evaluate the committed disposition policy against a committed OSV receipt.
 *
 * Pure: no filesystem, no network, no clock beyond the injected `now`. Returns
 * the full error list rather than throwing on the first problem so a reader
 * fixing the register sees every outstanding item in one pass.
 */
export function evaluateDispositions(receipt, policy, { now = new Date() } = {}) {
  const errors = [];

  if (policy?.$schema !== ADVISORY_POLICY_SCHEMA) {
    errors.push(`advisory policy schema must be ${ADVISORY_POLICY_SCHEMA}`);
  }

  // Rule 7 — the severity floor is not negotiable from inside the data file.
  if (JSON.stringify(policy?.gatedSeverities) !== JSON.stringify(GATED_SEVERITIES)) {
    errors.push(
      `advisory policy gatedSeverities must be exactly ${JSON.stringify(GATED_SEVERITIES)}; ` +
      `narrowing it would disable the gate without removing a single disposition`,
    );
  }

  const dispositions = Array.isArray(policy?.dispositions) ? policy.dispositions : [];
  const resolved = Array.isArray(policy?.resolved) ? policy.resolved : [];
  if (!Array.isArray(policy?.dispositions)) errors.push('advisory policy dispositions must be an array');
  if (!Array.isArray(policy?.resolved)) errors.push('advisory policy resolved must be an array');

  const findings = Array.isArray(receipt?.findings) ? receipt.findings : [];
  const gated = findings.filter(isGated);
  const gatedByKey = new Map(gated.map((finding) => [findingKey(finding), finding]));
  const allByKey = new Map(findings.map((finding) => [findingKey(finding), finding]));

  const seen = new Set();
  for (const entry of dispositions) {
    const key = dispositionKey(entry);

    if (seen.has(key)) errors.push(`duplicate disposition: ${key}`);
    seen.add(key);

    // Rule 2 — the register may only describe findings that are actually live.
    const finding = gatedByKey.get(key);
    if (!finding) {
      errors.push(
        `stale disposition: ${key} matches no CRITICAL/HIGH finding in the receipt ` +
        `(remove it, or record it under resolved[] if it was upgraded away)`,
      );
      continue;
    }

    // Rule 4 — a disposition without a reason is a suppression with paperwork.
    if (!DISPOSITION_STATES.includes(entry.state)) {
      errors.push(`${key}: state must be one of ${DISPOSITION_STATES.join(', ')}`);
    }
    if (!REACHABILITY_VERDICTS.includes(entry.reachability)) {
      errors.push(`${key}: reachability must be one of ${REACHABILITY_VERDICTS.join(', ')}`);
    }
    if (!nonEmpty(entry.owner)) errors.push(`${key}: owner is required`);
    if (!nonEmpty(entry.issue) || !ISSUE_PATTERN.test(entry.issue.trim())) {
      errors.push(`${key}: issue must be a WIN-nnn identifier`);
    }
    if (!nonEmpty(entry.argument) || entry.argument.trim().length < MIN_ARGUMENT_LENGTH) {
      errors.push(
        `${key}: argument must be a written reachability argument of at least ` +
        `${MIN_ARGUMENT_LENGTH} characters`,
      );
    }

    // A `carried` entry is an admission of ignorance; claiming a reachability
    // verdict at the same time is incoherent, and would let an unassessed
    // finding read as though somebody had cleared it.
    if (entry.state === 'carried' && entry.reachability !== 'unassessed') {
      errors.push(`${key}: a carried disposition must declare reachability "unassessed"`);
    }
    if (entry.state === 'waived' && entry.reachability === 'unassessed') {
      errors.push(`${key}: a waived disposition cannot declare reachability "unassessed"`);
    }
    // Waiving something you know is reachable is possible, but only against a
    // named compensating control — never on the strength of prose alone.
    if (entry.state === 'waived' && entry.reachability === 'reachable' && !nonEmpty(entry.compensatingControl)) {
      errors.push(`${key}: waiving a REACHABLE finding requires a named compensatingControl`);
    }

    // Rule 5 — the facts a reader relies on must track the receipt. Image
    // membership matters because a finding that spreads from agent to webapp
    // must be re-examined rather than silently covered by the old entry;
    // severity matters because an argument written about a HIGH must not be
    // left standing when the advisory is re-scored CRITICAL.
    if (JSON.stringify(entry.images) !== JSON.stringify(finding.images)) {
      errors.push(
        `${key}: images ${JSON.stringify(entry.images)} disagree with the receipt ` +
        `${JSON.stringify(finding.images)}`,
      );
    }
    if (entry.severity !== finding.severity) {
      errors.push(
        `${key}: severity ${JSON.stringify(entry.severity)} disagrees with the receipt ` +
        `${JSON.stringify(finding.severity)} — re-assess before re-dating this entry`,
      );
    }

    // Rule 3 — dated, and it expires.
    const acceptedOn = parseDate(entry.acceptedOn);
    const reviewBy = parseDate(entry.reviewBy);
    if (!acceptedOn) errors.push(`${key}: acceptedOn must be a YYYY-MM-DD date`);
    if (!reviewBy) errors.push(`${key}: reviewBy must be a YYYY-MM-DD date`);
    if (acceptedOn && acceptedOn.getTime() > now.getTime()) {
      errors.push(`${key}: acceptedOn ${entry.acceptedOn} is in the future`);
    }
    if (acceptedOn && reviewBy && reviewBy.getTime() <= acceptedOn.getTime()) {
      errors.push(`${key}: reviewBy ${entry.reviewBy} must be after acceptedOn ${entry.acceptedOn}`);
    }
    if (reviewBy && reviewBy.getTime() < now.getTime()) {
      errors.push(
        `expired disposition: ${key} was due for review on ${entry.reviewBy}; ` +
        `re-assess it or upgrade the dependency — an expired waiver is not a disposition`,
      );
    }
  }

  // Rule 1 — the gap this whole module exists to close.
  for (const [key, finding] of gatedByKey) {
    if (seen.has(key)) continue;
    errors.push(
      `unowned ${finding.severity} advisory: ${key} (${finding.summary ?? 'no summary'}) ` +
      `ships in ${JSON.stringify(finding.images)} and has no disposition in the advisory overlay`,
    );
  }

  // Rule 6 — a resolution claim is checked, not trusted.
  const resolvedSeen = new Set();
  for (const entry of resolved) {
    const key = resolvedKey(entry);
    if (resolvedSeen.has(key)) errors.push(`duplicate resolved entry: ${key}`);
    resolvedSeen.add(key);

    if (!nonEmpty(entry.advisory)) errors.push(`resolved entry ${key}: advisory is required`);
    if (!nonEmpty(entry.mechanism)) errors.push(`resolved entry ${key}: mechanism is required`);
    if (!nonEmpty(entry.toVersion)) errors.push(`resolved entry ${key}: toVersion is required`);
    if (!nonEmpty(entry.issue) || !ISSUE_PATTERN.test(String(entry.issue).trim())) {
      errors.push(`resolved entry ${key}: issue must be a WIN-nnn identifier`);
    }
    if (!parseDate(entry.resolvedOn)) errors.push(`resolved entry ${key}: resolvedOn must be a YYYY-MM-DD date`);

    if (allByKey.has(key)) {
      errors.push(
        `false resolution claim: ${key} is recorded as resolved via "${entry.mechanism}" ` +
        `but is still present in the receipt`,
      );
    }
  }

  return {
    errors,
    summary: {
      findings: findings.length,
      gated: gated.length,
      waived: dispositions.filter((entry) => entry.state === 'waived').length,
      carried: dispositions.filter((entry) => entry.state === 'carried').length,
      resolved: resolved.length,
    },
  };
}

/** Throwing wrapper used by `audit:advisory:check`. */
export function assertDispositions(receipt, policy, options = {}) {
  const { errors, summary } = evaluateDispositions(receipt, policy, options);
  if (errors.length) {
    throw new Error(`advisory disposition drift:\n  - ${errors.join('\n  - ')}`);
  }
  return summary;
}
