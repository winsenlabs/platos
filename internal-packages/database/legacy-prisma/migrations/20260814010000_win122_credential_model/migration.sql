-- WIN-122: remove the inherited Trigger.dev tr_pat_ authorization-code
-- exchange and add one append-only lifecycle ledger for retained Platos
-- long-lived bearer credentials. Historical migrations remain unchanged.

DROP TABLE IF EXISTS "AuthorizationCode";
DROP TABLE IF EXISTS "PersonalAccessToken";

CREATE TABLE "PlatosCredentialAudit" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "environmentId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosCredentialAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platos_credential_audit_credential_idx"
    ON "PlatosCredentialAudit"("family", "credentialId", "createdAt" DESC);
CREATE INDEX "platos_credential_audit_scope_idx"
    ON "PlatosCredentialAudit"("organizationId", "projectId", "environmentId", "createdAt" DESC);
CREATE INDEX "platos_credential_audit_actor_idx"
    ON "PlatosCredentialAudit"("actorUserId", "createdAt" DESC);

-- Erasure retries are idempotent only inside one organization. The subject
-- binding is additionally checked in the service before a receipt is returned.
DROP INDEX IF EXISTS "PlatosErasureOperation_idempotencyKey_key";
CREATE UNIQUE INDEX "platos_erasure_operation_org_idempotency_key"
    ON "PlatosErasureOperation"("organizationId", "idempotencyKey");
