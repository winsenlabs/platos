// The PostgreSQL `AgentsRepository`, assembled from its three halves.
//
// It is three modules and not one because the port has three scoping regimes and
// they are genuinely different reads: `Agent` and `AgentVersion` hang off a
// PROJECT, `AgentBinding` and `AgentCluster` off an ENVIRONMENT, and `AgentSkill`
// off a VERSION. The ADR M0.3 §6 budget points at those same seams.
//
// THE DEFAULTS POLICY IS A CONSTRUCTOR ARGUMENT AND NOT A CONSTANT. Reading a
// stored version means running it back through `readVersionRow`, which fills
// every field the `__runtime` envelope never carried with the policy's default —
// so an installation that raised a ceiling and a store that hard-coded the
// shipped one would disagree about what a row means. `DEFAULT_AGENTS_POLICY` is
// the default because it is the value the context itself ships, not because
// there is only one.
//
// ONE CLAUSE OF `updateBinding`'s CONTRACT CANNOT BE HONOURED HERE, and it is
// recorded rather than quietly approximated. The port says an implementation
// "MUST refuse rather than clobber when the row moved underneath it". A
// compare-and-move needs the PRE-image of the row the caller read, and the
// record this method is handed is the POST-image: `activateVersion` and
// `applyCanary` both return a binding whose mutable columns are already the new
// ones and whose `updatedAt` is already `now`, so nothing on it describes the row
// as it was read. What IS available is the row's identity, and that is what is
// compared: id, environment and agent together, so a deleted or re-identified
// binding is refused (`binding_moved_underneath`) instead of being re-created.
// A concurrent change to `canaryPercent` between the caller's read and its write
// is NOT detectable from this port's parameters and is not claimed to be. The
// serialisation the port's own note describes is real and is elsewhere: the
// parent `Agent` row lock in `observedVersionNumbers`, which every save takes
// before it mints a number.

import type {
  AgentDefaultsPolicy,
  AgentsRepository,
} from "@platos/context-agents/application/ports/index.js";
import { DEFAULT_AGENTS_POLICY } from "@platos/context-agents/application/ports/index.js";

import { createAgentCatalog } from "./agents-catalog.js";
import { createAgentClusters } from "./agents-clusters.js";
import { createAgentVersions } from "./agents-versions.js";
import type { TenancyTransactions } from "./transaction.js";

export function createAgentsRepository(
  transactions: TenancyTransactions,
  defaults: AgentDefaultsPolicy = DEFAULT_AGENTS_POLICY.defaults,
): AgentsRepository {
  return {
    ...createAgentCatalog(transactions, defaults),
    ...createAgentVersions(transactions, defaults),
    ...createAgentClusters(transactions),
  };
}
