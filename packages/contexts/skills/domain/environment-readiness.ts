// Whether a skill's declared environment keys are actually set here.
//
// A skill declares the NAMES of the environment variables its tools need. This
// context never sees the values — they live behind the secrets boundary — so
// readiness is answered against a directory that reports, for a set of names,
// which are set. That is the whole of the coupling, and it is why the question
// is a pure function over a map here and a port lookup one layer out.
//
// READINESS IS ASKED TWICE, ON PURPOSE, AND THE TWO ANSWERS DIFFER IN KIND.
//
//   At BIND time it is a GATE: a skill with an unset required key is refused,
//     with the missing names returned so an operator can go and set them.
//
//   At LOAD time it is a FILTER: a skill whose keys have since been unset is
//     silently dropped from the turn rather than failing the turn. A key removed
//     after binding must not break every conversation in the environment; the
//     skill just stops being offered.
//
// A skill declaring NO required keys is always ready. That is not a special case
// so much as the common one — most skills need nothing.

import type { EnvironmentKey } from "./identifiers.js";

/** Which of a queried set of names are set in this environment. */
export type EnvironmentKeyPresence = Readonly<Record<string, boolean>>;

export function isKeySet(presence: EnvironmentKeyPresence, key: EnvironmentKey): boolean {
  return presence[key] === true;
}

/** The declared keys that are NOT set, in declaration order. */
export function missingKeys(
  required: readonly EnvironmentKey[],
  presence: EnvironmentKeyPresence,
): readonly EnvironmentKey[] {
  return required.filter((key) => !isKeySet(presence, key));
}

export function isEnvironmentReady(
  required: readonly EnvironmentKey[],
  presence: EnvironmentKeyPresence,
): boolean {
  return required.every((key) => isKeySet(presence, key));
}

/**
 * The `envReady` field as the library surface reports it.
 *
 * Three-valued, and the third value carries information the other two cannot:
 * `null` means readiness was NOT EVALUATED, which is the honest answer for a
 * catalogue row read outside any environment — the official-seeding path reads
 * exactly that way. Collapsing it to `false` would paint every freshly seeded
 * skill as broken; collapsing it to `true` would claim a check that never ran.
 */
export function environmentReadiness(
  required: readonly EnvironmentKey[],
  presence: EnvironmentKeyPresence | null,
): boolean | null {
  if (presence === null) return null;
  return isEnvironmentReady(required, presence);
}

/** The distinct key names a set of skills needs, for one batched lookup. */
export function distinctRequiredKeys(
  declarations: readonly (readonly EnvironmentKey[])[],
): readonly EnvironmentKey[] {
  const seen = new Set<EnvironmentKey>();
  for (const declaration of declarations) {
    for (const key of declaration) seen.add(key);
  }
  return [...seen];
}
