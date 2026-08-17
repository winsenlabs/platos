import { legacyModelDispositionLedger } from "./cutover-ledger";

export type CutoverPhaseImplementation = "IMPLEMENTED" | "STUB";

export interface CutoverDomainPhase {
  readonly id: string;
  readonly implementation: CutoverPhaseImplementation;
  readonly sourceModels: readonly string[];
  readonly summary: string;
}

const coreSourceModels = [
  "User",
  "Organization",
  "OrgMember",
  "Project",
  "RuntimeEnvironment",
] as const;

const coreSet = new Set<string>(coreSourceModels);

const sourceModelsFor = (disposition: "BACKFILL" | "EXPORT_DROP" | "EPHEMERAL_DROP") =>
  legacyModelDispositionLedger
    .filter((entry) => entry.disposition === disposition && !coreSet.has(entry.sourceModel))
    .map((entry) => entry.sourceModel);

/**
 * Exhaustive implementation ledger. A STUB is an operational blocker, never a
 * successful no-op. The only executable data phase in Phase 3 core is the
 * initial tenancy/auth slice requested for rehearsal.
 */
export const cutoverDomainPhases = [
  {
    id: "core-tenancy-auth",
    implementation: "IMPLEMENTED",
    sourceModels: coreSourceModels,
    summary: "User, operator identity, organization, membership, project, project access, and Environment",
  },
  {
    id: "remaining-retained-backfill",
    implementation: "STUB",
    sourceModels: sourceModelsFor("BACKFILL"),
    summary: "Retained invitation, MFA, secret, audit, and normalized Platos domain transformations",
  },
  {
    id: "unsupported-trigger-export",
    implementation: "STUB",
    sourceModels: sourceModelsFor("EXPORT_DROP"),
    summary: "Encrypted unsupported and Trigger-owned export with count and checksum proofs",
  },
  {
    id: "ephemeral-session-recovery-disposition",
    implementation: "STUB",
    sourceModels: sourceModelsFor("EPHEMERAL_DROP"),
    summary: "Explicit browser-session and recovery-code invalidation report",
  },
  {
    id: "clean-trigger-defer-install",
    implementation: "STUB",
    sourceModels: [],
    summary: "Defer bulk-load-sensitive clean triggers and install them after retained-domain validation",
  },
  {
    id: "cryptographic-read-probes",
    implementation: "STUB",
    sourceModels: [],
    summary: "MFA, provider, channel, entity, OIDC, message, audit, and memory decrypt/read probes",
  },
  {
    id: "external-analytics-object-rekey",
    implementation: "STUB",
    sourceModels: [],
    summary: "ClickHouse UUID re-key/swap and object-store reconciliation contracts",
  },
] as const satisfies readonly CutoverDomainPhase[];

export const incompleteCutoverPhaseIds = cutoverDomainPhases
  .filter((phase) => phase.implementation === "STUB")
  .map((phase) => phase.id);

export function assertCutoverPhaseLedgerIsExhaustive(): void {
  const assigned = cutoverDomainPhases.flatMap((phase) => phase.sourceModels);
  const expected = legacyModelDispositionLedger.map((entry) => entry.sourceModel);
  if (assigned.length !== expected.length || new Set(assigned).size !== expected.length) {
    throw new Error("cutover phase ledger must assign every inherited model exactly once");
  }
  const actual = [...assigned].sort();
  const wanted = [...expected].sort();
  if (actual.some((name, index) => name !== wanted[index])) {
    throw new Error("cutover phase ledger does not match inherited model disposition ledger");
  }
}
