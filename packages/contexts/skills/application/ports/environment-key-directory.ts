// The `EnvironmentKeyDirectory` port — which environment keys are SET here.
//
// A skill declares the names of the environment variables its tools need. This
// context has to know whether those names are set in an environment, and it must
// never learn what they are set TO.
//
// So the port answers exactly one question — presence, by name — and its return
// type makes the stronger answer unrepresentable. `secrets` is the encryption
// boundary and the sole holder of the values (ADR M0.3 §1, context 3), and
// `skills` may not depend on it: the §1 allow-list for this context is tenancy,
// files and the kernel. A presence-only port is what lets both facts hold at
// once — the coupling is an interface this context owns, and the adapter behind
// it is wired at the composition root.
//
// A NAME THAT IS NOT SET IS `false`, NEVER ABSENT. An implementation returns an
// entry for every key it was asked about. A caller reading a missing key off the
// map cannot tell "not set" from "not asked", and every consumer would have to
// remember the difference.
//
// AN OUTAGE IS NOT AN ANSWER. If the directory cannot be reached the result is a
// failure, not an empty map. An empty map would read as "nothing is set", which
// would disable every skill in the environment on a transient blip — the exact
// availability failure the live runtime's fail-open comments were written about.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { EnvironmentKey, EnvironmentKeyPresence } from "../../domain/index.js";

export interface EnvironmentKeyDirectory {
  /**
   * Which of these names are set in this environment.
   *
   * Batched by design: readiness for a whole catalogue page is one call, not one
   * per skill. An empty `keys` list is answered with an empty map without a
   * round trip.
   */
  presenceOf(
    scope: EnvironmentScope,
    keys: readonly EnvironmentKey[],
  ): Promise<Result<EnvironmentKeyPresence>>;
}
