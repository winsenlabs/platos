import { legacyModelDispositionLedger } from "./cutover-ledger";
import { retainedAgentToolBatch1SourceModels } from "./cutover-agent-tool-batch1";
import { retainedChannelBatch5SourceModels } from "./cutover-channel-batch5";
import { retainedConversationBatch2SourceModels } from "./cutover-conversation-batch2";
import { retainedOperationalBatch6SourceModels } from "./cutover-operational-batch6";
import { retainedProviderOauthBatch4SourceModels } from "./cutover-provider-oauth-batch4";
import { retainedBatch3SourceModels } from "./cutover-retained-batch3";

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
const supplementalAuthOwnedSourceModels = ["OrgMemberInvite", "ImpersonationAuditLog"] as const;
const implementedRetainedSet = new Set<string>([
  ...supplementalAuthOwnedSourceModels,
  ...retainedAgentToolBatch1SourceModels,
  ...retainedConversationBatch2SourceModels,
  ...retainedBatch3SourceModels,
  ...retainedProviderOauthBatch4SourceModels,
  ...retainedChannelBatch5SourceModels,
  ...retainedOperationalBatch6SourceModels,
]);

const sourceModelsFor = (disposition: "BACKFILL" | "EXPORT_DROP" | "EPHEMERAL_DROP") =>
  legacyModelDispositionLedger
    .filter(
      (entry) =>
        entry.disposition === disposition &&
        !coreSet.has(entry.sourceModel) &&
        !implementedRetainedSet.has(entry.sourceModel)
    )
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
    id: "supplemental-auth-mfa",
    implementation: "IMPLEMENTED",
    sourceModels: supplementalAuthOwnedSourceModels,
    summary: "Organization invitations, impersonation history, and User-owned operator MFA",
  },
  {
    id: "retained-agent-tool-batch-1",
    implementation: "IMPLEMENTED",
    sourceModels: retainedAgentToolBatch1SourceModels,
    summary: "Tool, Agent, AgentBinding, AgentVersion, and AgentCluster retained-domain cutover",
  },
  {
    id: "retained-conversation-batch-2",
    implementation: "IMPLEMENTED",
    sourceModels: retainedConversationBatch2SourceModels,
    summary: "End user, identity, thread, turn, step, tool-call, artifact, attachment, and Postman cutover",
  },
  {
    id: "retained-entity-mcp-batch-3",
    implementation: "IMPLEMENTED",
    sourceModels: retainedBatch3SourceModels,
    summary: "Entity, MCP configuration, credential, session, policy, and bearer-token cutover",
  },
  {
    id: "retained-provider-oauth-batch-4",
    implementation: "IMPLEMENTED",
    sourceModels: retainedProviderOauthBatch4SourceModels,
    summary: "Provider, access-key, MCP token, PAT, OAuth, and organization MCP-policy cutover",
  },
  {
    id: "retained-channel-batch-5",
    implementation: "IMPLEMENTED",
    sourceModels: retainedChannelBatch5SourceModels,
    summary: "Channel connection, thread, app, installation, and channel credential cutover",
  },
  {
    id: "retained-operational-batch-6",
    implementation: "IMPLEMENTED",
    sourceModels: retainedOperationalBatch6SourceModels,
    summary: "Operational, audit, approval, budget, safety, event, notification, and erasure cutover",
  },
  {
    id: "final-message-re-encryption-read-probes",
    implementation: "STUB",
    sourceModels: [],
    summary: "Final target message re-encryption and Batch 6 retained-audit re-encryption plus target-reader semantic probes",
  },
  {
    id: "remaining-retained-backfill",
    implementation: "STUB",
    sourceModels: sourceModelsFor("BACKFILL"),
    summary: "Later retained secret, policy, evaluation, skill, and memory Batch 7/8 backfills",
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
    summary: "Remaining provider, channel, entity, OIDC, Batch 6 audit, memory, and credential decrypt/read probes",
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
