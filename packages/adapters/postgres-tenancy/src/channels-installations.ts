// `ChannelInstallation` — one workspace's install of an app, and the durable
// rotating-grant fence stored across five columns of it.
//
// TWO STATEMENTS PER READ, AND THE SECOND ONE IS NOT AN N+1. `credentialRevision`
// is not a column of this table: `domain/installation.ts` calls it "a READ-TIME
// PROJECTION ... the repository joins the credential and reads its revision",
// because `secrets` counts `CredentialSecretVersion.secretRevision` up when it
// replaces a credential's material IN PLACE, and that rotation moves neither the
// credential's id nor this context's `tokenGeneration`. It is the third axis of
// `RefreshExpectation` and the only one that can catch a claim holding an
// already-dead grant. The count is per CALL and not per row — this port has no
// method that returns more than one installation — so it is flat in the size of
// the table, which is the property the statement-count suite pins.
//
// AND WHEN THERE IS NO CREDENTIAL THERE IS NO SECOND STATEMENT. The projection
// is zero, because "no credential has revision zero, so the placeholder cannot
// be mistaken for a real one", and asking the database for the revision of a
// null id would be a round trip whose answer is already known.
//
// WHAT `saveInstallation` CANNOT DO, STATED RATHER THAN APPROXIMATED. The value
// it is handed carries a `credentialRevision`, and there is no column to put it
// in. A caller that saves an installation claiming revision 7 against a
// credential whose active version is revision 1 is told 1, because 1 is what the
// row means. That is the honest answer and it is pinned as a named case; the
// alternative — echoing the caller's number back — would hand the NEXT refresh
// claim an expectation built from a value nothing in the database agrees with,
// which is precisely the failure the revision axis exists to catch.
//
// THE OWNER COLUMN IS IN THE UPDATE BRANCH ON PURPOSE. `appId` is this table's
// ownership key and the database's own owner rule refuses to move it. Writing it
// is what turns a re-parent into a refusal the caller sees rather than a silent
// no-op that reports success for a row that did not move.

import type {
  ChannelAppId,
  ChannelInstallation,
  ChannelInstallationId,
  ExternalInstallationId,
  Result,
  TransactionScope,
} from "@platos/context-channels/application/ports/index.js";
import { err, ok } from "@platos/context-channels/application/ports/index.js";

import type { InstallationRow } from "./channels-rows.js";
import { readInstallationRow } from "./channels-rows.js";
import {
  firstRefusal,
  guarded,
  requireGeneration,
  requireInstallationStatus,
  requireOptionalUuid,
  requireRefreshCoherence,
  requireRefreshState,
  requireRoutingTable,
  requireTextList,
  requireUuid,
} from "./channels-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/** The projection that has no credential behind it. */
const NO_CREDENTIAL_REVISION = 0;

/** Every column of the installation the domain names, and nothing else. */
const INSTALLATION_COLUMNS = {
  id: true,
  appId: true,
  externalInstallationId: true,
  displayName: true,
  credentialId: true,
  grantedScopes: true,
  defaultAgentId: true,
  agentRouting: true,
  status: true,
  revokedAt: true,
  lastEventAt: true,
  tokenRefreshState: true,
  tokenRefreshClaimId: true,
  tokenRefreshStartedAt: true,
  tokenRefreshRepairCode: true,
  tokenGeneration: true,
  createdAt: true,
} as const;

export interface ChannelInstallationStore {
  findInstallation(
    installationId: ChannelInstallationId,
  ): Promise<Result<ChannelInstallation | null>>;
  findInstallationByExternalId(
    appId: ChannelAppId,
    externalInstallationId: ExternalInstallationId,
  ): Promise<Result<ChannelInstallation | null>>;
  saveInstallation(
    installation: ChannelInstallation,
    transaction: TransactionScope,
  ): Promise<Result<ChannelInstallation>>;
}

export function createChannelInstallationStore(
  transactions: TenancyTransactions,
): ChannelInstallationStore {
  /**
   * The active version's revision for one credential, or zero.
   *
   * A JOIN WRITTEN OUT rather than two nested `select`s, for the reason
   * `channels-connections.ts` gives: the client loads each relation level as its
   * own query, so the obvious spelling is two round trips where this is one.
   */
  async function credentialRevision(credentialId: string | null): Promise<number> {
    if (credentialId === null) return NO_CREDENTIAL_REVISION;
    const rows = await transactions.reader().$queryRaw<readonly { readonly secretRevision: number }[]>`
      SELECT version."secretRevision" AS "secretRevision"
      FROM "public"."Credential" credential
      JOIN "public"."CredentialSecretVersion" version
        ON version."id" = credential."activeSecretVersionId"
      WHERE credential."id" = ${credentialId}::uuid`;
    // A credential with no ACTIVE version is a credential with no material, and
    // the join drops it. Zero is right there for the same reason it is right for
    // a null id: there is nothing whose replacement a claim could be holding.
    return rows[0]?.secretRevision ?? NO_CREDENTIAL_REVISION;
  }

  async function readBack(row: InstallationRow | null): Promise<Result<ChannelInstallation | null>> {
    if (row === null) return ok(null);
    const revision = await credentialRevision(row.credentialId);
    const read = readInstallationRow(row, revision);
    return read.ok ? ok(read.value) : err(read.error);
  }

  return {
    async findInstallation(installationId) {
      const operation = "findInstallation";
      const malformed = requireUuid<ChannelInstallation | null>(
        operation,
        "installationId",
        installationId,
      );
      if (malformed !== null) return malformed;
      return guarded(operation, async () => {
        const row = await transactions.reader().channelInstallation.findUnique({
          where: { id: installationId },
          select: INSTALLATION_COLUMNS,
        });
        return readBack(row);
      });
    },

    async findInstallationByExternalId(appId, externalInstallationId) {
      const operation = "findInstallationByExternalId";
      const malformed = requireUuid<ChannelInstallation | null>(operation, "appId", appId);
      if (malformed !== null) return malformed;
      return guarded(operation, async () => {
        // Through the `[appId, externalInstallationId]` UNIQUE, which is the
        // only way in from an OAuth callback: it knows the provider's ids and no
        // Platos id at all. The provider's id alone is NOT unique — the same
        // workspace can install two different apps — which is why this takes
        // both halves and why there is no single-argument form of it.
        const row = await transactions.reader().channelInstallation.findUnique({
          where: {
            appId_externalInstallationId: { appId, externalInstallationId },
          },
          select: INSTALLATION_COLUMNS,
        });
        return readBack(row);
      });
    },

    async saveInstallation(installation, transaction) {
      const operation = "saveInstallation";
      const checked = firstRefusal(installation, [
        requireUuid<ChannelInstallation>(operation, "installationId", installation.installationId),
        requireUuid<ChannelInstallation>(operation, "appId", installation.appId),
        requireOptionalUuid<ChannelInstallation>(
          operation,
          "credentialId",
          installation.credentialId,
        ),
        requireOptionalUuid<ChannelInstallation>(
          operation,
          "defaultAgentId",
          installation.defaultAgentId,
        ),
        requireInstallationStatus<ChannelInstallation>(operation, installation.status),
        requireRefreshState<ChannelInstallation>(operation, installation.refreshState),
        requireRefreshCoherence<ChannelInstallation>(
          operation,
          installation.refreshState,
          installation.refreshClaimId,
          installation.refreshStartedAt,
          installation.refreshRepairCode,
        ),
        requireGeneration<ChannelInstallation>(
          operation,
          "tokenGeneration",
          installation.tokenGeneration,
        ),
        requireTextList<ChannelInstallation>(
          operation,
          "grantedScopes",
          installation.grantedScopes,
        ),
        requireRoutingTable<ChannelInstallation>(operation, installation.agentRouting),
      ]);
      if (!checked.ok) return checked;

      return guarded(operation, async () => {
        const written = await transactions.writer(transaction).channelInstallation.upsert({
          where: { id: installation.installationId },
          create: {
            id: installation.installationId,
            appId: installation.appId,
            externalInstallationId: installation.externalInstallationId,
            displayName: installation.displayName,
            credentialId: installation.credentialId,
            grantedScopes: [...installation.grantedScopes],
            defaultAgentId: installation.defaultAgentId,
            agentRouting: [...installation.agentRouting],
            status: installation.status,
            revokedAt: installation.revokedAt,
            lastEventAt: installation.lastEventAt,
            tokenRefreshState: installation.refreshState,
            tokenRefreshClaimId: installation.refreshClaimId,
            tokenRefreshStartedAt: installation.refreshStartedAt,
            tokenRefreshRepairCode: installation.refreshRepairCode,
            tokenGeneration: installation.tokenGeneration,
            createdAt: installation.createdAt,
          },
          update: {
            appId: installation.appId,
            externalInstallationId: installation.externalInstallationId,
            displayName: installation.displayName,
            credentialId: installation.credentialId,
            grantedScopes: [...installation.grantedScopes],
            defaultAgentId: installation.defaultAgentId,
            agentRouting: [...installation.agentRouting],
            status: installation.status,
            revokedAt: installation.revokedAt,
            lastEventAt: installation.lastEventAt,
            tokenRefreshState: installation.refreshState,
            tokenRefreshClaimId: installation.refreshClaimId,
            tokenRefreshStartedAt: installation.refreshStartedAt,
            tokenRefreshRepairCode: installation.refreshRepairCode,
            tokenGeneration: installation.tokenGeneration,
          },
          select: { credentialId: true },
        });
        // The PROJECTION, re-read rather than echoed. See the header: the number
        // the caller handed over has nowhere to live, and the number the fence
        // will be judged against is the one the credential row carries.
        return ok({
          ...installation,
          credentialRevision: await credentialRevision(written.credentialId),
        });
      });
    },
  };
}
