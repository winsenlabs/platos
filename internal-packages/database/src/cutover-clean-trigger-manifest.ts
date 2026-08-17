import { createHash } from "node:crypto";

export type CleanCatalogObjectKind = "function" | "trigger";
export type CleanTriggerClassification = "MANDATORY_ALWAYS_ON" | "BULK_LOAD_SAFE_DEFERRED";

export interface CleanTriggerFunctionManifestEntry {
  readonly kind: CleanCatalogObjectKind;
  readonly name: string;
  readonly migration: string;
  readonly classification: CleanTriggerClassification;
  readonly fingerprint: string;
  readonly definition: string;
}

/**
 * Exact PostgreSQL 16 pg_get_functiondef/pg_get_triggerdef inventory from a
 * fresh application of every current clean migration. Security, ancestry,
 * immutability, audit, token, provider, and ownership contracts stay active.
 * The one deferred trigger can only observe UPDATEs linked to a reservation;
 * the offline loader inserts attachments and the module separately proves the
 * new reservation table is empty while that trigger is absent.
 */
export const cleanTriggerFunctionManifest = [
  {
    kind: "function",
    name: "cascade_operator_session_revocation()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "a5186e5af8ab4767b8a02dd4b37c3f8ac2edff54f490c5c4587cad9b61a4011c",
    definition:
      'CREATE OR REPLACE FUNCTION public.cascade_operator_session_revocation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL THEN\n    UPDATE "public"."OperatorSession"\n      SET "revokedAt" = COALESCE("revokedAt", NEW."revokedAt")\n      WHERE "parentSessionId" = NEW.id AND "revokedAt" IS NULL;\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_attachment_upload_reservation()",
    migration: "20260817020000_add_attachment_byte_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1d829403109960f011a0361b07e774a08986608f1cdb2872ccbcc8c8bfef8952",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_attachment_upload_reservation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  owner_valid BOOLEAN := FALSE;\n  claim_valid BOOLEAN := FALSE;\n  byte_correction BOOLEAN := FALSE;\nBEGIN\n  IF TG_OP = \'DELETE\' THEN\n    IF OLD."messageAttachmentId" IS NOT NULL AND pg_trigger_depth() <= 1 THEN\n      RAISE EXCEPTION \'claimed AttachmentUploadReservation is retained through attachment deletion\'\n        USING ERRCODE = \'23514\';\n    END IF;\n    RETURN OLD;\n  END IF;\n\n  IF TG_OP = \'INSERT\' AND (NEW."messageAttachmentId" IS NOT NULL OR NEW."claimedAt" IS NOT NULL) THEN\n    RAISE EXCEPTION \'AttachmentUploadReservation must begin unclaimed\'\n      USING ERRCODE = \'23514\';\n  END IF;\n\n  IF TG_OP = \'UPDATE\' THEN\n    byte_correction :=\n      OLD."bytes" IS DISTINCT FROM NEW."bytes" AND\n      NEW."bytes" > 0 AND\n      COALESCE(current_setting(\'platos.attachment_byte_correction\', TRUE) = OLD.id::text, FALSE);\n\n    IF OLD."environmentId" IS DISTINCT FROM NEW."environmentId" OR\n       OLD."uploadedByUserId" IS DISTINCT FROM NEW."uploadedByUserId" OR\n       OLD."uploadedByEndUserId" IS DISTINCT FROM NEW."uploadedByEndUserId" OR\n       OLD."kind" IS DISTINCT FROM NEW."kind" OR\n       OLD."mimeType" IS DISTINCT FROM NEW."mimeType" OR\n       (OLD."bytes" IS DISTINCT FROM NEW."bytes" AND NOT byte_correction) OR\n       OLD."width" IS DISTINCT FROM NEW."width" OR\n       OLD."height" IS DISTINCT FROM NEW."height" OR\n       OLD."durationSec" IS DISTINCT FROM NEW."durationSec" OR\n       OLD."storageKey" IS DISTINCT FROM NEW."storageKey" OR\n       OLD."originalName" IS DISTINCT FROM NEW."originalName" OR\n       OLD."contentHash" IS DISTINCT FROM NEW."contentHash" OR\n       OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN\n      RAISE EXCEPTION \'AttachmentUploadReservation ownership and upload metadata are immutable\'\n        USING ERRCODE = \'23514\';\n    END IF;\n\n    IF OLD."messageAttachmentId" IS NOT NULL THEN\n      IF OLD."messageAttachmentId" IS DISTINCT FROM NEW."messageAttachmentId" OR\n         OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt" OR\n         OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN\n        RAISE EXCEPTION \'claimed AttachmentUploadReservation is immutable\'\n          USING ERRCODE = \'23514\';\n      END IF;\n    ELSIF NEW."messageAttachmentId" IS NULL OR NEW."claimedAt" IS NULL THEN\n      IF OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN\n        RAISE EXCEPTION \'unclaimed AttachmentUploadReservation expiration is immutable\'\n          USING ERRCODE = \'23514\';\n      END IF;\n    ELSIF OLD."expiresAt" <= CURRENT_TIMESTAMP THEN\n      RAISE EXCEPTION \'AttachmentUploadReservation has expired\'\n        USING ERRCODE = \'23514\';\n    END IF;\n  END IF;\n\n  SELECT EXISTS (\n    SELECT 1\n      FROM "public"."Environment" environment\n      JOIN "public"."Project" project ON project.id = environment."projectId"\n      LEFT JOIN "public"."EndUser" end_user\n        ON end_user.id = NEW."uploadedByEndUserId"\n       AND end_user."organizationId" = project."organizationId"\n       AND end_user."disabledAt" IS NULL\n      LEFT JOIN "public"."OrganizationMembership" membership\n        ON membership."organizationId" = project."organizationId"\n       AND membership."userId" = NEW."uploadedByUserId"\n       AND membership."deactivatedAt" IS NULL\n     WHERE environment.id = NEW."environmentId"\n       AND (\n         (NEW."uploadedByEndUserId" IS NOT NULL AND end_user.id IS NOT NULL) OR\n         (NEW."uploadedByUserId" IS NOT NULL AND membership.id IS NOT NULL)\n       )\n  ) INTO owner_valid;\n\n  IF NOT owner_valid THEN\n    RAISE EXCEPTION \'AttachmentUploadReservation crosses its canonical uploader ancestry\'\n      USING ERRCODE = \'23514\';\n  END IF;\n\n  IF NEW."messageAttachmentId" IS NOT NULL THEN\n    SELECT EXISTS (\n      SELECT 1\n        FROM "public"."MessageAttachment" attachment\n        JOIN "public"."Turn" turn ON turn.id = attachment."turnId"\n        JOIN "public"."Thread" thread ON thread.id = turn."threadId"\n       WHERE attachment.id = NEW."messageAttachmentId"\n         AND attachment."environmentId" = NEW."environmentId"\n         AND thread."environmentId" = NEW."environmentId"\n         AND thread."endUserId" = attachment."endUserId"\n         AND (\n           NEW."uploadedByEndUserId" IS NULL OR\n           attachment."endUserId" = NEW."uploadedByEndUserId"\n         )\n         AND attachment."kind" = NEW."kind"\n         AND attachment."mimeType" = NEW."mimeType"\n         AND attachment."bytes" = NEW."bytes"\n         AND attachment."width" IS NOT DISTINCT FROM NEW."width"\n         AND attachment."height" IS NOT DISTINCT FROM NEW."height"\n         AND attachment."durationSec" IS NOT DISTINCT FROM NEW."durationSec"\n         AND attachment."storageKey" = NEW."storageKey"\n         AND attachment."originalName" IS NOT DISTINCT FROM NEW."originalName"\n         AND attachment."contentHash" IS NOT DISTINCT FROM NEW."contentHash"\n         AND attachment."expiresAt" = NEW."expiresAt"\n    ) INTO claim_valid;\n\n    IF NOT claim_valid THEN\n      RAISE EXCEPTION \'AttachmentUploadReservation claim crosses scope or changes reserved metadata\'\n        USING ERRCODE = \'23514\';\n    END IF;\n  END IF;\n\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_domain_ancestry()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "02535ea152355817ca10eb884c72b13979eecf3fff78f59c9ddba7cf18a86137",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_domain_ancestry()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  valid BOOLEAN := FALSE;\nBEGIN\n  CASE TG_TABLE_NAME\n    WHEN \'EndUserSession\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "EndUserIdentity" i\n        JOIN "EndUser" u ON u.id = i."endUserId" AND u."organizationId" = i."organizationId"\n        JOIN "Environment" e ON e.id = NEW."environmentId"\n        JOIN "Project" p ON p.id = e."projectId"\n        WHERE i.id = NEW."identityId" AND u."organizationId" = p."organizationId"\n      ) INTO valid;\n    WHEN \'AgentBinding\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId"\n        JOIN "AgentVersion" active ON active.id = NEW."activeAgentVersionId" AND active."agentId" = a.id\n        LEFT JOIN "AgentVersion" canary ON canary.id = NEW."canaryAgentVersionId" AND canary."agentId" = a.id\n        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."canaryAgentVersionId" IS NULL OR canary.id IS NOT NULL)\n          AND (NEW."clusterId" IS NULL OR cluster.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'PostmanTemplate\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Agent" a ON a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND a.id = NEW."agentId") INTO valid;\n    WHEN \'Thread\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        JOIN "Project" p ON p.id = e."projectId"\n        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        LEFT JOIN "AgentCluster" c ON c.id = NEW."clusterId" AND c."environmentId" = e.id\n        LEFT JOIN "Thread" parent ON parent.id = NEW."parentThreadId" AND parent."environmentId" = e.id AND parent."endUserId" = u.id\n        LEFT JOIN "Turn" cursor ON cursor.id = NEW."compactedUpToTurnId" AND cursor."threadId" = NEW.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."clusterId" IS NULL OR c.id IS NOT NULL)\n          AND (NEW."parentThreadId" IS NULL OR parent.id IS NOT NULL)\n          AND (NEW."compactedUpToTurnId" IS NULL OR cursor.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'Turn\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Thread" t\n        JOIN "AgentVersion" version ON version.id = NEW."agentVersionId" AND version."agentId" = t."agentId"\n        LEFT JOIN "Turn" parent ON parent.id = NEW."parentTurnId" AND parent."threadId" = t.id\n        WHERE t.id = NEW."threadId"\n          AND (NEW."parentTurnId" IS NULL OR parent.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'Artifact\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Thread" t\n        LEFT JOIN "Turn" turn ON turn.id = NEW."producedByTurnId" AND turn."threadId" = t.id\n        WHERE t.id = NEW."threadId" AND t."environmentId" = NEW."environmentId"\n          AND (NEW."producedByTurnId" IS NULL OR turn.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'MessageAttachment\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        JOIN "Project" p ON p.id = e."projectId"\n        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId"\n        LEFT JOIN "Thread" t ON t.id = turn."threadId" AND t."environmentId" = e.id AND t."endUserId" = u.id\n        WHERE e.id = NEW."environmentId" AND (NEW."turnId" IS NULL OR t.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'ChannelConnection\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        LEFT JOIN "Entity" entity ON entity.id = NEW."entityId" AND entity."projectId" = e."projectId"\n        LEFT JOIN "Agent" agent ON agent.id = NEW."defaultAgentId" AND agent."projectId" = e."projectId"\n        LEFT JOIN "Credential" credential ON credential.id = NEW."credentialId" AND credential."environmentId" = e.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."entityId" IS NULL OR entity.id IS NOT NULL)\n          AND (NEW."defaultAgentId" IS NULL OR agent.id IS NOT NULL)\n          AND (NEW."credentialId" IS NULL OR credential.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'ChannelThread\' THEN\n      SELECT EXISTS (SELECT 1 FROM "ChannelConnection" c JOIN "Thread" t ON t."environmentId" = c."environmentId" WHERE c.id = NEW."connectionId" AND t.id = NEW."threadId") INTO valid;\n    WHEN \'ChannelApp\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        LEFT JOIN "Agent" a ON a.id = NEW."defaultAgentId" AND a."projectId" = e."projectId"\n        LEFT JOIN "Credential" c ON c.id = NEW."credentialId" AND c."environmentId" = e.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."defaultAgentId" IS NULL OR a.id IS NOT NULL)\n          AND (NEW."credentialId" IS NULL OR c.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'ChannelInstallation\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "ChannelApp" app JOIN "Environment" e ON e.id = app."environmentId"\n        LEFT JOIN "Agent" a ON a.id = NEW."defaultAgentId" AND a."projectId" = e."projectId"\n        LEFT JOIN "Credential" c ON c.id = NEW."credentialId" AND c."environmentId" = e.id\n        WHERE app.id = NEW."appId"\n          AND (NEW."defaultAgentId" IS NULL OR a.id IS NOT NULL)\n          AND (NEW."credentialId" IS NULL OR c.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'ChannelAppThread\' THEN\n      SELECT EXISTS (SELECT 1 FROM "ChannelInstallation" i JOIN "ChannelApp" app ON app.id = i."appId" JOIN "Thread" t ON t."environmentId" = app."environmentId" WHERE i.id = NEW."installationId" AND t.id = NEW."threadId") INTO valid;\n    WHEN \'EntityMcpClient\' THEN\n      SELECT NEW."credentialId" IS NULL OR EXISTS (\n        SELECT 1 FROM "Entity" entity JOIN "Credential" c ON c.id = NEW."credentialId" JOIN "Environment" e ON e.id = c."environmentId"\n        WHERE entity.id = NEW."entityId" AND entity."projectId" = e."projectId"\n      ) INTO valid;\n    WHEN \'EnvironmentEntityTool\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Entity" entity ON entity."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND entity.id = NEW."entityId") INTO valid;\n    WHEN \'ToolCallAudit\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"\n        LEFT JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        LEFT JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."endUserId" IS NULL OR u.id IS NOT NULL)\n          AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)\n          AND (NEW."threadId" IS NULL OR t.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'AgentApproval\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId"\n        LEFT JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id\n        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = t.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)\n          AND (NEW."threadId" IS NULL OR t.id IS NOT NULL)\n          AND (NEW."turnId" IS NULL OR turn.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'Budget\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)) INTO valid;\n    WHEN \'SafetyEvent\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"\n        LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        LEFT JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        LEFT JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id\n        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = t.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)\n          AND (NEW."endUserId" IS NULL OR u.id IS NOT NULL)\n          AND (NEW."threadId" IS NULL OR t.id IS NOT NULL)\n          AND (NEW."turnId" IS NULL OR turn.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'MessageRating\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"\n        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        JOIN "Turn" turn ON turn.id = NEW."turnId" JOIN "Thread" t ON t.id = turn."threadId" AND t."environmentId" = e.id AND t."endUserId" = u.id\n        LEFT JOIN "AgentVersion" version ON version.id = NEW."agentVersionId" AND version."agentId" = a.id\n        WHERE e.id = NEW."environmentId" AND (NEW."agentVersionId" IS NULL OR version.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'EvalCriterion\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)) INTO valid;\n    WHEN \'AgentEval\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId"\n        JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id\n        JOIN "EvalCriterion" criterion ON criterion.id = NEW."criterionId" AND criterion."environmentId" = e.id\n        LEFT JOIN "AgentVersion" version ON version.id = NEW."agentVersionId" AND version."agentId" = a.id\n        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = t.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."agentVersionId" IS NULL OR version.id IS NOT NULL)\n          AND (NEW."turnId" IS NULL OR turn.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'GoldenSet\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Agent" a ON a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND a.id = NEW."agentId") INTO valid;\n    WHEN \'ProjectSkill\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Project" p JOIN "Skill" s ON s."organizationId" = p."organizationId" WHERE p.id = NEW."projectId" AND s.id = NEW."skillId") INTO valid;\n    WHEN \'EnvironmentSkill\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "ProjectSkill" ps ON ps."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND ps.id = NEW."projectSkillId") INTO valid;\n    WHEN \'AgentSkill\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "AgentVersion" v JOIN "Agent" a ON a.id = v."agentId"\n        JOIN "EnvironmentSkill" es ON es.id = NEW."environmentSkillId" JOIN "Environment" e ON e.id = es."environmentId" AND e."projectId" = a."projectId"\n        WHERE v.id = NEW."agentVersionId"\n      ) INTO valid;\n    WHEN \'Memory\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        JOIN "Project" p ON p.id = e."projectId"\n        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id\n        LEFT JOIN "AgentBinding" binding ON binding."environmentId" = e.id\n          AND binding."agentId" = a.id AND binding."clusterId" = cluster.id\n        LEFT JOIN "Thread" source_thread ON source_thread.id = NEW."sourceThreadId"\n          AND source_thread."environmentId" = e.id AND source_thread."endUserId" = u.id\n          AND source_thread."agentId" = a.id\n          AND (NEW."clusterId" IS NULL OR source_thread."clusterId" = NEW."clusterId")\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."clusterId" IS NULL OR (cluster.id IS NOT NULL AND binding.id IS NOT NULL))\n          AND (NEW."sourceThreadId" IS NULL OR source_thread.id IS NOT NULL)\n          AND NOT EXISTS (\n            SELECT 1 FROM unnest(NEW."sourceTurnIds") source_turn_id\n            WHERE NOT EXISTS (\n              SELECT 1 FROM "Turn" source_turn\n              WHERE source_turn.id = source_turn_id AND source_turn."threadId" = NEW."sourceThreadId"\n            )\n          )\n      ) INTO valid;\n    WHEN \'MemoryEntity\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        JOIN "Project" p ON p.id = e."projectId"\n        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id\n        LEFT JOIN "AgentBinding" binding ON binding."environmentId" = e.id\n          AND binding."agentId" = a.id AND binding."clusterId" = cluster.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."clusterId" IS NULL OR (cluster.id IS NOT NULL AND binding.id IS NOT NULL))\n      ) INTO valid;\n    WHEN \'MemoryRelationship\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e\n        JOIN "Project" p ON p.id = e."projectId"\n        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"\n        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id\n        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id\n        LEFT JOIN "AgentBinding" binding ON binding."environmentId" = e.id\n          AND binding."agentId" = a.id AND binding."clusterId" = cluster.id\n        JOIN "MemoryEntity" source ON source.id = NEW."fromEntityId"\n          AND source."environmentId" = e.id AND source."endUserId" = u.id\n        JOIN "MemoryEntity" target ON target.id = NEW."toEntityId"\n          AND target."environmentId" = e.id AND target."endUserId" = u.id\n        LEFT JOIN "Memory" source_memory ON source_memory.id = NEW."sourceMemoryId"\n          AND source_memory."environmentId" = e.id AND source_memory."endUserId" = u.id\n        WHERE e.id = NEW."environmentId"\n          AND (NEW."clusterId" IS NULL OR (cluster.id IS NOT NULL AND binding.id IS NOT NULL))\n          AND (\n            (NEW."clusterId" IS NULL AND\n              source."clusterId" IS NULL AND target."clusterId" IS NULL AND\n              source."agentId" = a.id AND target."agentId" = a.id) OR\n            (NEW."clusterId" IS NOT NULL AND\n              source."clusterId" = NEW."clusterId" AND target."clusterId" = NEW."clusterId")\n          )\n          AND (\n            NEW."sourceMemoryId" IS NULL OR\n            (NEW."clusterId" IS NULL AND source_memory."clusterId" IS NULL AND source_memory."agentId" = a.id) OR\n            (NEW."clusterId" IS NOT NULL AND source_memory."clusterId" = NEW."clusterId")\n          )\n      ) INTO valid;\n    WHEN \'OAuthClient\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "OrganizationMembership" membership\n        LEFT JOIN "Entity" entity ON entity.id = NEW."entityId" LEFT JOIN "Project" p ON p.id = entity."projectId" AND p."organizationId" = NEW."organizationId"\n        WHERE membership."organizationId" = NEW."organizationId" AND membership."userId" = NEW."registeredByUserId"\n          AND membership."deactivatedAt" IS NULL AND (NEW."entityId" IS NULL OR p.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'OAuthAuthorizationCode\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "OAuthClient" client\n        JOIN "OrganizationMembership" membership ON membership."organizationId" = client."organizationId"\n          AND membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL\n        WHERE client.id = NEW."clientId" AND client."organizationId" = CASE NEW."scopeKind"\n          WHEN \'ORGANIZATION\' THEN NEW."organizationId"\n          WHEN \'PROJECT\' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")\n          WHEN \'ENVIRONMENT\' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")\n        END\n      ) INTO valid;\n    WHEN \'McpAnonymousSession\' THEN\n      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Entity" entity ON entity."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND entity.id = NEW."entityId") INTO valid;\n    WHEN \'McpOidcSession\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e JOIN "Entity" entity ON entity.id = NEW."entityId" AND entity."projectId" = e."projectId"\n        LEFT JOIN "Credential" c ON c.id = NEW."credentialId" AND c."environmentId" = e.id\n        WHERE e.id = NEW."environmentId" AND (NEW."credentialId" IS NULL OR c.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'McpToken\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"\n        JOIN "OrganizationMembership" membership ON membership."organizationId" = p."organizationId"\n          AND membership."userId" = NEW."mintedByUserId" AND membership."deactivatedAt" IS NULL\n        WHERE e.id = NEW."environmentId"\n      ) INTO valid;\n    WHEN \'PersonalAccessToken\' THEN\n      IF NEW."scopeKind" = \'GLOBAL\' THEN\n        valid := TRUE;\n      ELSE\n        SELECT EXISTS (\n          SELECT 1\n          FROM "OrganizationMembership" membership\n          WHERE membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL\n            AND membership."organizationId" = CASE NEW."scopeKind"\n              WHEN \'ORGANIZATION\' THEN NEW."organizationId"\n              WHEN \'PROJECT\' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")\n              WHEN \'ENVIRONMENT\' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")\n            END\n        ) INTO valid;\n      END IF;\n    WHEN \'OAuthAccessToken\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "OAuthClient" client\n        JOIN "OrganizationMembership" membership ON membership."organizationId" = client."organizationId"\n          AND membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL\n        WHERE client.id = NEW."clientId" AND client."organizationId" = CASE NEW."scopeKind"\n          WHEN \'ORGANIZATION\' THEN NEW."organizationId"\n          WHEN \'PROJECT\' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")\n          WHEN \'ENVIRONMENT\' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")\n        END\n      ) INTO valid;\n    WHEN \'OAuthRefreshToken\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "OAuthClient" client\n        JOIN "OrganizationMembership" membership ON membership."organizationId" = client."organizationId"\n          AND membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL\n        LEFT JOIN "OAuthAccessToken" access ON access.id = NEW."accessTokenId"\n          AND access."clientId" = client.id AND access."userId" = NEW."userId"\n        LEFT JOIN "OAuthRefreshToken" parent ON parent.id = NEW."parentRefreshTokenId"\n          AND parent."clientId" = client.id AND parent."userId" = NEW."userId"\n          AND parent."rotationFamilyId" = NEW."rotationFamilyId"\n        WHERE client.id = NEW."clientId" AND client."organizationId" = CASE NEW."scopeKind"\n          WHEN \'ORGANIZATION\' THEN NEW."organizationId"\n          WHEN \'PROJECT\' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")\n          WHEN \'ENVIRONMENT\' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")\n        END\n          AND (NEW."accessTokenId" IS NULL OR access.id IS NOT NULL)\n          AND (NEW."parentRefreshTokenId" IS NULL OR parent.id IS NOT NULL)\n      ) INTO valid;\n    WHEN \'McpBearerToken\' THEN\n      SELECT EXISTS (\n        SELECT 1 FROM "Entity" entity JOIN "Project" p ON p.id = entity."projectId"\n        JOIN "OrganizationMembership" membership ON membership."organizationId" = p."organizationId"\n          AND membership."userId" = NEW."createdByUserId" AND membership."deactivatedAt" IS NULL\n        WHERE entity.id = NEW."entityId"\n      ) INTO valid;\n    ELSE\n      RAISE EXCEPTION \'No ancestry rule for %\', TG_TABLE_NAME USING ERRCODE = \'23514\';\n  END CASE;\n\n  IF NOT valid THEN\n    RAISE EXCEPTION \'% crosses its canonical owner ancestry\', TG_TABLE_NAME\n      USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_external_cutover_evidence_sequence()",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b9471a7e01060d0c3ecb2adc9536deaf225a8bd711ad45459fbd82fe91c9beed",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_external_cutover_evidence_sequence()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."runId"::text, 1));\n  IF NEW."sequence" > 1 AND NOT EXISTS (\n    SELECT 1\n    FROM "public"."ExternalCutoverEvidence" predecessor\n    WHERE predecessor."runId" = NEW."runId"\n      AND predecessor."sequence" = NEW."sequence" - 1\n  ) THEN\n    RAISE EXCEPTION \'ExternalCutoverEvidence entries must be sequential\'\n      USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_external_cutover_run_attempt_sequence()",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "5041efc6163edc15f261e8b4a6f0930925cfa771e3631eb423af12cf829cb164",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_external_cutover_run_attempt_sequence()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."idempotencyKey", 0));\n  IF NEW."attempt" > 1 AND NOT EXISTS (\n    SELECT 1\n    FROM "public"."ExternalCutoverRun" predecessor\n    WHERE predecessor."idempotencyKey" = NEW."idempotencyKey"\n      AND predecessor."attempt" = NEW."attempt" - 1\n  ) THEN\n    RAISE EXCEPTION \'ExternalCutoverRun attempts must be sequential\'\n      USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_object_key_reconciliation_attempt_sequence()",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ba81f1aaf3d60fc29d438fd8ed95e64359dfddc04cb81b427d01e41060944b9b",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_object_key_reconciliation_attempt_sequence()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  PERFORM pg_advisory_xact_lock(hashtextextended(\n    NEW."runId"::text || \':\' || NEW."metadataModel" || \':\' || NEW."metadataRowId"::text,\n    2\n  ));\n  IF NEW."attempt" > 1 AND NOT EXISTS (\n    SELECT 1\n    FROM "public"."ObjectKeyReconciliation" predecessor\n    WHERE predecessor."runId" = NEW."runId"\n      AND predecessor."metadataModel" = NEW."metadataModel"\n      AND predecessor."metadataRowId" = NEW."metadataRowId"\n      AND predecessor."attempt" = NEW."attempt" - 1\n  ) THEN\n    RAISE EXCEPTION \'ObjectKeyReconciliation attempts must be sequential\'\n      USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_operator_session_parent()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "c6f4fd2092e8dd76ee266a68ca6537d13cb3f42a532a660c5e72619d0212acce",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_operator_session_parent()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NEW."parentSessionId" IS NOT NULL AND NOT EXISTS (\n    SELECT 1\n    FROM "public"."OperatorSession" parent\n    WHERE parent.id = NEW."parentSessionId"\n      AND parent."userId" = NEW."userId"\n      AND parent."impersonatedUserId" IS NULL\n      AND parent."revokedAt" IS NULL\n      AND parent."expiresAt" >= NEW."expiresAt"\n  ) THEN\n    RAISE EXCEPTION \'OperatorSession parent must be active and cannot expire before its child\'\n      USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "enforce_token_lifecycle_audit_scope()",
    migration: "20260817010000_add_token_lifecycle_audit",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "d4e420961a9104946fa470e34f50f3947d191335c3180c280e78657a70f9edef",
    definition:
      'CREATE OR REPLACE FUNCTION public.enforce_token_lifecycle_audit_scope()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NEW."family" = \'PERSONAL_ACCESS_TOKEN\' THEN\n    IF NOT EXISTS (\n      SELECT 1\n      FROM "public"."PersonalAccessToken" token\n      WHERE token.id = NEW."personalAccessTokenId"\n        AND token."scopeKind" = NEW."scopeKind"\n        AND token."organizationId" IS NOT DISTINCT FROM NEW."organizationId"\n        AND token."projectId" IS NOT DISTINCT FROM NEW."projectId"\n        AND token."environmentId" IS NOT DISTINCT FROM NEW."environmentId"\n    ) THEN\n      RAISE EXCEPTION \'TokenLifecycleAudit PAT scope must match its persisted token scope\'\n        USING ERRCODE = \'23514\';\n    END IF;\n  ELSIF NEW."family" = \'MCP_TOKEN\' THEN\n    IF NOT EXISTS (\n      SELECT 1\n      FROM "public"."McpToken" token\n      WHERE token.id = NEW."mcpTokenId"\n        AND token."environmentId" = NEW."environmentId"\n    ) THEN\n      RAISE EXCEPTION \'TokenLifecycleAudit MCP scope must match its persisted Environment\'\n        USING ERRCODE = \'23514\';\n    END IF;\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "external_cutover_disposable_rehearsal_report_is_valid(report jsonb)",
    migration: "20260817040000_enable_disposable_external_rehearsal_report",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "801cba971c05a24c3186686a0a1d4136605a52e0c0bb1ed6b7f649a026351a60",
    definition:
      "CREATE OR REPLACE FUNCTION public.external_cutover_disposable_rehearsal_report_is_valid(report jsonb)\n RETURNS boolean\n LANGUAGE sql\n IMMUTABLE STRICT\nAS $function$\n  SELECT\n    jsonb_typeof(report) = 'object' AND\n    (SELECT count(*) FROM jsonb_object_keys(report)) = 7 AND\n    report ?& ARRAY[\n      'contractVersion', 'implementation', 'targetKind', 'state',\n      'manifestSha256', 'clickHouseTables', 'objectStoreObjects'\n    ] AND\n    report -> 'contractVersion' = '1'::jsonb AND\n    report ->> 'implementation' = 'DISPOSABLE_REHEARSAL' AND\n    report ->> 'targetKind' = 'DISPOSABLE_REHEARSAL' AND\n    report ->> 'state' = 'ROLLED_BACK' AND\n    report ->> 'manifestSha256' ~ '^[0-9a-f]{64}$' AND\n    jsonb_typeof(report -> 'clickHouseTables') = 'array' AND\n    jsonb_array_length(report -> 'clickHouseTables') = 12 AND\n    (\n      SELECT count(DISTINCT entry ->> 'table') = 12 AND bool_and(\n        jsonb_typeof(entry) = 'object' AND\n        (SELECT count(*) FROM jsonb_object_keys(entry)) = 9 AND\n        entry ?& ARRAY[\n          'table', 'sourceSchemaSha256', 'sourceRowCount', 'targetRowCount',\n          'sourceSha256', 'targetSha256', 'identitySha256', 'payloadSha256',\n          'rollbackOutcome'\n        ] AND\n        entry ->> 'table' IN (\n          'error_occurrences_v1', 'errors_v1', 'llm_metrics_v1', 'metrics_v1',\n          'platos_spans_v1', 'task_event_usage_by_hour_v1',\n          'task_event_usage_by_minute_v1', 'task_events_search_v1',\n          'task_events_v1', 'task_events_v2', 'task_runs_v1', 'task_runs_v2'\n        ) AND\n        entry ->> 'sourceSchemaSha256' ~ '^[0-9a-f]{64}$' AND\n        entry ->> 'sourceRowCount' ~ '^(0|[1-9][0-9]*)$' AND\n        entry ->> 'targetRowCount' ~ '^(0|[1-9][0-9]*)$' AND\n        entry ->> 'sourceRowCount' = entry ->> 'targetRowCount' AND\n        entry ->> 'sourceSha256' ~ '^[0-9a-f]{64}$' AND\n        entry ->> 'targetSha256' ~ '^[0-9a-f]{64}$' AND\n        entry ->> 'identitySha256' ~ '^[0-9a-f]{64}$' AND\n        entry ->> 'payloadSha256' ~ '^[0-9a-f]{64}$' AND\n        entry ->> 'targetSha256' = entry ->> 'payloadSha256' AND\n        entry ->> 'rollbackOutcome' = 'ROLLED_BACK'\n      )\n      FROM jsonb_array_elements(report -> 'clickHouseTables') entry\n    ) AND\n    jsonb_typeof(report -> 'objectStoreObjects') = 'array' AND\n    NOT EXISTS (\n      SELECT 1\n      FROM jsonb_array_elements(report -> 'objectStoreObjects') entry\n      WHERE\n        jsonb_typeof(entry) <> 'object' OR\n        (SELECT count(*) FROM jsonb_object_keys(entry)) <> 7 OR\n        NOT entry ?& ARRAY[\n          'metadataModel', 'metadataRowIdSha256', 'outcome',\n          'sourceObjectKeySha256', 'targetObjectKeySha256',\n          'expectedByteLength', 'observedByteLength'\n        ] OR\n        entry ->> 'metadataModel' <> 'MessageAttachment' OR\n        entry ->> 'metadataRowIdSha256' !~ '^[0-9a-f]{64}$' OR\n        entry ->> 'outcome' <> 'MATCH' OR\n        entry ->> 'sourceObjectKeySha256' !~ '^[0-9a-f]{64}$' OR\n        entry ->> 'targetObjectKeySha256' !~ '^[0-9a-f]{64}$' OR\n        entry ->> 'sourceObjectKeySha256' <> entry ->> 'targetObjectKeySha256' OR\n        entry ->> 'expectedByteLength' !~ '^(0|[1-9][0-9]*)$' OR\n        entry ->> 'observedByteLength' !~ '^(0|[1-9][0-9]*)$' OR\n        entry ->> 'expectedByteLength' <> entry ->> 'observedByteLength'\n    );\n$function$",
  },
  {
    kind: "function",
    name: "external_cutover_report_is_valid(report jsonb)",
    migration: "20260817040000_enable_disposable_external_rehearsal_report",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "18622b2112327f2c3c7cd8a797a3405e2c11a18b8b99ad69d9b6a733a70f1b0a",
    definition:
      "CREATE OR REPLACE FUNCTION public.external_cutover_report_is_valid(report jsonb)\n RETURNS boolean\n LANGUAGE sql\n IMMUTABLE STRICT\nAS $function$\n  SELECT\n    \"public\".\"external_cutover_stub_report_is_valid\"(report) OR\n    \"public\".\"external_cutover_disposable_rehearsal_report_is_valid\"(report);\n$function$",
  },
  {
    kind: "function",
    name: "external_cutover_metadata_is_safe(metadata jsonb)",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f245117e91aa9934e9fb40053ba113f9d9994de6c95bd923d8b25c31e5f9f5ac",
    definition:
      "CREATE OR REPLACE FUNCTION public.external_cutover_metadata_is_safe(metadata jsonb)\n RETURNS boolean\n LANGUAGE sql\n IMMUTABLE STRICT\nAS $function$\n  SELECT\n    jsonb_typeof(metadata) = 'object' AND\n    NOT EXISTS (\n      SELECT 1\n      FROM jsonb_each(metadata) AS entry(key, value)\n      WHERE entry.key NOT IN (\n        'rowCount',\n        'objectCount',\n        'byteLength',\n        'rowsSha256',\n        'objectsSha256',\n        'contentSha256',\n        'manifestSha256'\n      ) OR CASE\n        WHEN entry.key IN ('rowCount', 'objectCount', 'byteLength') THEN\n          jsonb_typeof(entry.value) <> 'string' OR\n          entry.value #>> '{}' !~ '^(0|[1-9][0-9]*)$'\n        ELSE\n          jsonb_typeof(entry.value) <> 'string' OR\n          entry.value #>> '{}' !~ '^[0-9a-f]{64}$'\n      END\n    );\n$function$",
  },
  {
    kind: "function",
    name: "external_cutover_stub_report_is_valid(report jsonb)",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b812cc3672868c5269e36113ddc13375f6d6be8949569fb9f36bf21afe76b149",
    definition:
      "CREATE OR REPLACE FUNCTION public.external_cutover_stub_report_is_valid(report jsonb)\n RETURNS boolean\n LANGUAGE sql\n IMMUTABLE STRICT\nAS $function$\n  SELECT\n    jsonb_typeof(report) = 'object' AND\n    (SELECT count(*) FROM jsonb_object_keys(report)) = 6 AND\n    report ?& ARRAY[\n      'contractVersion',\n      'implementation',\n      'state',\n      'manifestSha256',\n      'clickHouseTables',\n      'objectStoreObjects'\n    ] AND\n    report -> 'contractVersion' = '1'::jsonb AND\n    report ->> 'implementation' = 'STUB' AND\n    report ->> 'state' = 'STUB_BLOCKED' AND\n    report ->> 'manifestSha256' ~ '^[0-9a-f]{64}$' AND\n    report -> 'clickHouseTables' = '[]'::jsonb AND\n    report -> 'objectStoreObjects' = '[]'::jsonb;\n$function$",
  },
  {
    kind: "function",
    name: "protect_claimed_message_attachment()",
    migration: "20260817020000_add_attachment_byte_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "49eb119c392d20134d440108c5f14a3144f28b32e8e1dfd122d0e19f12edfd3c",
    definition:
      'CREATE OR REPLACE FUNCTION public.protect_claimed_message_attachment()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  reservation_id UUID;\n  byte_correction BOOLEAN := FALSE;\nBEGIN\n  SELECT reservation.id\n    INTO reservation_id\n    FROM "public"."AttachmentUploadReservation" reservation\n   WHERE reservation."messageAttachmentId" = OLD.id;\n\n  IF reservation_id IS NOT NULL THEN\n    byte_correction :=\n      OLD."bytes" IS DISTINCT FROM NEW."bytes" AND\n      NEW."bytes" > 0 AND\n      COALESCE(current_setting(\'platos.attachment_byte_correction\', TRUE) = reservation_id::text, FALSE);\n\n    IF OLD."environmentId" IS DISTINCT FROM NEW."environmentId" OR\n       OLD."endUserId" IS DISTINCT FROM NEW."endUserId" OR\n       OLD."turnId" IS DISTINCT FROM NEW."turnId" OR\n       OLD."kind" IS DISTINCT FROM NEW."kind" OR\n       OLD."mimeType" IS DISTINCT FROM NEW."mimeType" OR\n       (OLD."bytes" IS DISTINCT FROM NEW."bytes" AND NOT byte_correction) OR\n       OLD."width" IS DISTINCT FROM NEW."width" OR\n       OLD."height" IS DISTINCT FROM NEW."height" OR\n       OLD."durationSec" IS DISTINCT FROM NEW."durationSec" OR\n       OLD."storageKey" IS DISTINCT FROM NEW."storageKey" OR\n       OLD."originalName" IS DISTINCT FROM NEW."originalName" OR\n       OLD."contentHash" IS DISTINCT FROM NEW."contentHash" OR\n       OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN\n      RAISE EXCEPTION \'claimed MessageAttachment lifecycle is immutable\'\n        USING ERRCODE = \'23514\';\n    END IF;\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "reconcile_attachment_upload_bytes(reservation_id uuid, expected_environment_id uuid, expected_storage_key text, expected_claimed_bytes integer, observed_actual_bytes integer, organization_quota_bytes bigint)",
    migration: "20260817020000_add_attachment_byte_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "cd502db447624697d04edf288a5eb93842493c68b21dc28b8dc4818947920547",
    definition:
      'CREATE OR REPLACE FUNCTION public.reconcile_attachment_upload_bytes(reservation_id uuid, expected_environment_id uuid, expected_storage_key text, expected_claimed_bytes integer, observed_actual_bytes integer, organization_quota_bytes bigint)\n RETURNS TABLE("claimedBytes" integer, "actualBytes" integer, corrected boolean)\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO \'public\', \'pg_temp\'\nAS $function$\nDECLARE\n  reservation "public"."AttachmentUploadReservation"%ROWTYPE;\n  attachment "public"."MessageAttachment"%ROWTYPE;\n  organization_id UUID;\n  used_bytes BIGINT;\nBEGIN\n  IF observed_actual_bytes <= 0 OR organization_quota_bytes <= 0 THEN\n    RAISE EXCEPTION \'Attachment byte correction values must be positive\'\n      USING ERRCODE = \'22023\';\n  END IF;\n\n  SELECT project."organizationId"\n    INTO organization_id\n    FROM "public"."AttachmentUploadReservation" candidate\n    JOIN "public"."Environment" environment ON environment.id = candidate."environmentId"\n    JOIN "public"."Project" project ON project.id = environment."projectId"\n   WHERE candidate.id = reservation_id\n     AND candidate."environmentId" = expected_environment_id;\n  IF organization_id IS NULL THEN\n    RAISE EXCEPTION \'Attachment upload reservation is not accessible\'\n      USING ERRCODE = \'23514\';\n  END IF;\n\n  PERFORM pg_advisory_xact_lock(hashtextextended(organization_id::text, 0));\n\n  SELECT *\n    INTO reservation\n    FROM "public"."AttachmentUploadReservation" candidate\n   WHERE candidate.id = reservation_id\n     AND candidate."environmentId" = expected_environment_id\n   FOR UPDATE;\n  IF NOT FOUND OR reservation."storageKey" IS DISTINCT FROM expected_storage_key OR\n     reservation."bytes" IS DISTINCT FROM expected_claimed_bytes OR\n     reservation."expiresAt" <= CURRENT_TIMESTAMP THEN\n    RAISE EXCEPTION \'Attachment upload reservation changed during byte reconciliation\'\n      USING ERRCODE = \'23514\';\n  END IF;\n\n  IF reservation."bytes" = observed_actual_bytes THEN\n    RETURN QUERY SELECT reservation."bytes", observed_actual_bytes, FALSE;\n    RETURN;\n  END IF;\n\n  SELECT (\n    COALESCE((\n      SELECT SUM(candidate."bytes")::bigint\n        FROM "public"."AttachmentUploadReservation" candidate\n        JOIN "public"."Environment" environment ON environment.id = candidate."environmentId"\n        JOIN "public"."Project" project ON project.id = environment."projectId"\n       WHERE project."organizationId" = organization_id\n         AND candidate."expiresAt" > CURRENT_TIMESTAMP\n    ), 0) +\n    COALESCE((\n      SELECT SUM(candidate."bytes")::bigint\n        FROM "public"."MessageAttachment" candidate\n        JOIN "public"."Environment" environment ON environment.id = candidate."environmentId"\n        JOIN "public"."Project" project ON project.id = environment."projectId"\n        LEFT JOIN "public"."AttachmentUploadReservation" linked\n          ON linked."messageAttachmentId" = candidate.id\n       WHERE project."organizationId" = organization_id\n         AND linked.id IS NULL\n         AND (candidate."expiresAt" IS NULL OR candidate."expiresAt" > CURRENT_TIMESTAMP)\n    ), 0)\n  )::bigint INTO used_bytes;\n\n  IF used_bytes - reservation."bytes" + observed_actual_bytes > organization_quota_bytes THEN\n    RAISE EXCEPTION \'Attachment upload quota exceeded during byte reconciliation\'\n      USING ERRCODE = \'23514\';\n  END IF;\n\n  PERFORM set_config(\'platos.attachment_byte_correction\', reservation.id::text, TRUE);\n\n  IF reservation."messageAttachmentId" IS NOT NULL THEN\n    SELECT *\n      INTO attachment\n      FROM "public"."MessageAttachment" candidate\n     WHERE candidate.id = reservation."messageAttachmentId"\n     FOR UPDATE;\n    IF NOT FOUND OR attachment."environmentId" IS DISTINCT FROM reservation."environmentId" OR\n       attachment."storageKey" IS DISTINCT FROM reservation."storageKey" OR\n       attachment."bytes" IS DISTINCT FROM reservation."bytes" THEN\n      RAISE EXCEPTION \'Claimed attachment metadata changed during byte reconciliation\'\n        USING ERRCODE = \'23514\';\n    END IF;\n    UPDATE "public"."MessageAttachment"\n       SET "bytes" = observed_actual_bytes\n     WHERE id = attachment.id;\n  END IF;\n\n  UPDATE "public"."AttachmentUploadReservation"\n     SET "bytes" = observed_actual_bytes\n   WHERE id = reservation.id;\n\n  RETURN QUERY SELECT reservation."bytes", observed_actual_bytes, TRUE;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "reject_canonical_owner_change()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ea0e74f8b5e7c74b78ff65261a7aa31b1e1ca81d6fd636ed7bed24792311a0f4",
    definition:
      "CREATE OR REPLACE FUNCTION public.reject_canonical_owner_change()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  owner_key TEXT;\nBEGIN\n  FOREACH owner_key IN ARRAY TG_ARGV LOOP\n    IF to_jsonb(OLD) -> owner_key IS DISTINCT FROM to_jsonb(NEW) -> owner_key THEN\n      RAISE EXCEPTION '% ownership/authorization key % is immutable', TG_TABLE_NAME, owner_key\n        USING ERRCODE = '23514';\n    END IF;\n  END LOOP;\n  RETURN NEW;\nEND;\n$function$",
  },
  {
    kind: "function",
    name: "reject_credential_audit_mutation()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ed087f9ea8877b07bae52007e9dee2d633296d7157abe63943ae44f1029991d2",
    definition:
      "CREATE OR REPLACE FUNCTION public.reject_credential_audit_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RAISE EXCEPTION 'CredentialAudit is immutable' USING ERRCODE = '23514';\nEND;\n$function$",
  },
  {
    kind: "function",
    name: "reject_credential_secret_envelope_change()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "a98ff9f48d09baae0fdc08c9e1cdb44190d9554670f031670bd62b3f70bf6a5a",
    definition:
      'CREATE OR REPLACE FUNCTION public.reject_credential_secret_envelope_change()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF OLD."credentialId" IS DISTINCT FROM NEW."credentialId"\n     OR OLD."secretRevision" IS DISTINCT FROM NEW."secretRevision"\n     OR OLD."formatVersion" IS DISTINCT FROM NEW."formatVersion"\n     OR OLD."rootKeyVersion" IS DISTINCT FROM NEW."rootKeyVersion"\n     OR OLD."salt" IS DISTINCT FROM NEW."salt"\n     OR OLD."nonce" IS DISTINCT FROM NEW."nonce"\n     OR OLD."ciphertext" IS DISTINCT FROM NEW."ciphertext"\n     OR OLD."authTag" IS DISTINCT FROM NEW."authTag"\n     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN\n    RAISE EXCEPTION \'CredentialSecretVersion envelope is immutable\' USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "reject_executable_provider_key_delete()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b0c8f13ad2e1d8bb1ed68cf6d1ad1c0f21796336367af2b5f066d9b6c26ddd78",
    definition:
      'CREATE OR REPLACE FUNCTION public.reject_executable_provider_key_delete()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF EXISTS (\n    SELECT 1\n      FROM "public"."Environment" environment\n      JOIN "public"."Project" project ON project.id = environment."projectId"\n      JOIN "public"."AgentBinding" binding ON binding."environmentId" = environment.id\n      JOIN "public"."Agent" agent ON agent.id = binding."agentId" AND agent."projectId" = project.id\n      JOIN "public"."AgentVersion" version ON version."agentId" = agent.id\n     WHERE environment.id = OLD."environmentId"\n       AND (\n         (\n           version."memoryConfig" #>> \'{__runtime,providerKeyId}\' = OLD.id::text\n           AND split_part(version.model, \':\', 1) = OLD.provider\n         )\n         OR EXISTS (\n           SELECT 1\n             FROM jsonb_array_elements(version."modelRoutes") route\n            WHERE split_part(COALESCE(route ->> \'model\', \'\'), \':\', 1) = OLD.provider\n              AND (\n                route ->> \'providerCredentialId\' = OLD.id::text\n                OR route ->> \'providerKeyId\' = OLD.id::text\n              )\n         )\n       )\n  ) THEN\n    RAISE EXCEPTION \'ProviderKey is referenced by an executable AgentVersion\'\n      USING ERRCODE = \'23503\';\n  END IF;\n  RETURN OLD;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "reject_external_cutover_ledger_mutation()",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "0fa2364b680a5f18936e6d70827d4640416b2e844535a2a49df826ba797a9a01",
    definition:
      "CREATE OR REPLACE FUNCTION public.reject_external_cutover_ledger_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23514';\nEND;\n$function$",
  },
  {
    kind: "function",
    name: "reject_impersonation_audit_mutation()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "720d604f9b0a178e1c8bc3663be4e1bdbd847dab8f09ceb4340dcb7b7ce1f523",
    definition:
      "CREATE OR REPLACE FUNCTION public.reject_impersonation_audit_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RAISE EXCEPTION 'ImpersonationAudit is immutable' USING ERRCODE = '23514';\nEND;\n$function$",
  },
  {
    kind: "function",
    name: "reject_provider_key_credential_mismatch()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "5a1818e65de7b28f119e7d7f34884ab62c868064f3037205e8e1f2a91acec938",
    definition:
      'CREATE OR REPLACE FUNCTION public.reject_provider_key_credential_mismatch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM "public"."Credential" credential\n     WHERE credential.id = NEW."credentialId"\n       AND credential."environmentId" = NEW."environmentId"\n       AND credential.provider = NEW.provider\n       AND credential.name = NEW."environmentKeyName"\n  ) THEN\n    RAISE EXCEPTION \'ProviderKey credential/provider mismatch\' USING ERRCODE = \'23514\';\n  END IF;\n  RETURN NEW;\nEND;\n$function$',
  },
  {
    kind: "function",
    name: "reject_token_lifecycle_audit_mutation()",
    migration: "20260817010000_add_token_lifecycle_audit",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "a2afae2103df229e7966e1bdf5078b1d8600aa9257227214ed2cb5c56daf1c34",
    definition:
      "CREATE OR REPLACE FUNCTION public.reject_token_lifecycle_audit_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RAISE EXCEPTION 'TokenLifecycleAudit is immutable' USING ERRCODE = '23514';\nEND;\n$function$",
  },
  {
    kind: "function",
    name: "revoke_operator_sessions_for_membership_change()",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "7e74624a3ff508dd50c28d83bddc00e40053ca6430e56033e87c9265b2637ae4",
    definition:
      'CREATE OR REPLACE FUNCTION public.revoke_operator_sessions_for_membership_change()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  affected_user_id UUID;\nBEGIN\n  affected_user_id := COALESCE(NEW."userId", OLD."userId");\n  IF TG_OP = \'DELETE\'\n     OR OLD."role" IS DISTINCT FROM NEW."role"\n     OR OLD."deactivatedAt" IS DISTINCT FROM NEW."deactivatedAt" THEN\n    UPDATE "public"."OperatorSession"\n      SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP)\n      WHERE ("userId" = affected_user_id OR "impersonatedUserId" = affected_user_id)\n        AND "revokedAt" IS NULL;\n  END IF;\n  RETURN COALESCE(NEW, OLD);\nEND;\n$function$',
  },
  {
    kind: "trigger",
    name: "AccessKey.AccessKey_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f11c68152faa91406f68fc3c5a9540e236074dbf0ea772d03ba26bb259fb798c",
    definition:
      'CREATE TRIGGER "AccessKey_owner_immutable" BEFORE UPDATE ON "AccessKey" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "Agent.Agent_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "8bf54b009c6cdcc7c7fc26e7cfb4f28a58a79734e52a175c204e0c94e002c9eb",
    definition:
      'CREATE TRIGGER "Agent_owner_immutable" BEFORE UPDATE ON "Agent" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'projectId\')',
  },
  {
    kind: "trigger",
    name: "AgentApproval.AgentApproval_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "2deff3eb20c18811cbd2c9cdbf5f5ceba066ff454c40abcfed39e9a18cc57ef5",
    definition:
      'CREATE TRIGGER "AgentApproval_ancestry" BEFORE INSERT OR UPDATE ON "AgentApproval" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "AgentBinding.AgentBinding_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "0f9f57ed478b98227bf5391b4bc12080e62fe5af30ca105abc315399f3cc7dd0",
    definition:
      'CREATE TRIGGER "AgentBinding_ancestry" BEFORE INSERT OR UPDATE ON "AgentBinding" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "AgentCluster.AgentCluster_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f519ee43984b44d823bdf235ca8b892bc03c77e3a60e8b68ff6e50d1344df0d5",
    definition:
      'CREATE TRIGGER "AgentCluster_owner_immutable" BEFORE UPDATE ON "AgentCluster" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "AgentEval.AgentEval_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "4862b55413239fd6e9d51e9c9d57c79336e1ea3549f20e009c74f7a0263ed02a",
    definition:
      'CREATE TRIGGER "AgentEval_ancestry" BEFORE INSERT OR UPDATE ON "AgentEval" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "AgentSkill.AgentSkill_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "0580b7eefd4646da4030dadd1fef4532c565e1f839d988d3068e5f0f93fbbb23",
    definition:
      'CREATE TRIGGER "AgentSkill_ancestry" BEFORE INSERT OR UPDATE ON "AgentSkill" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "AgentVersion.AgentVersion_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "25c6d703b07937bcf04f9386a52024b3545a51978624feec5f66741fd3bd0a89",
    definition:
      'CREATE TRIGGER "AgentVersion_owner_immutable" BEFORE UPDATE ON "AgentVersion" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'agentId\')',
  },
  {
    kind: "trigger",
    name: "Artifact.Artifact_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f2cc255e39fcec0d00602e21ade0f7765cb4c82c8359d0b45cbf34dcd0208383",
    definition:
      'CREATE TRIGGER "Artifact_ancestry" BEFORE INSERT OR UPDATE ON "Artifact" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "AttachmentUploadReservation.AttachmentUploadReservation_lifecycle",
    migration: "20260817000000_add_upload_reservations",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f28646197ada782c496d39e11b78b389a790a01d1e6c618b41d9175b10361b45",
    definition:
      'CREATE TRIGGER "AttachmentUploadReservation_lifecycle" BEFORE INSERT OR DELETE OR UPDATE ON "AttachmentUploadReservation" FOR EACH ROW EXECUTE FUNCTION enforce_attachment_upload_reservation()',
  },
  {
    kind: "trigger",
    name: "Budget.Budget_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f4bb15abb5aa8f232dbf6bddb43810abc517ffeb0db51185027ec80d9cf91a8c",
    definition:
      'CREATE TRIGGER "Budget_ancestry" BEFORE INSERT OR UPDATE ON "Budget" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ChannelApp.ChannelApp_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "feb6ffecd591c4988e39ba9f8997e6e09458ff58bfc90f034e68d2806fbe625f",
    definition:
      'CREATE TRIGGER "ChannelApp_ancestry" BEFORE INSERT OR UPDATE ON "ChannelApp" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ChannelApp.ChannelApp_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "6faf8f0e0695445c53246d9f026b75a181a52578a634f90950e82794f24ec644",
    definition:
      'CREATE TRIGGER "ChannelApp_owner_immutable" BEFORE UPDATE ON "ChannelApp" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "ChannelAppThread.ChannelAppThread_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "4841e519fb01f9bf4a01945a7c30f5ae5c55425253510a0e29779b03ef268241",
    definition:
      'CREATE TRIGGER "ChannelAppThread_ancestry" BEFORE INSERT OR UPDATE ON "ChannelAppThread" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ChannelConnection.ChannelConnection_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b8ad9df6475cbfe2d896c59a430034dbf3a233b17aaa571f1f5d94ae1c15c569",
    definition:
      'CREATE TRIGGER "ChannelConnection_ancestry" BEFORE INSERT OR UPDATE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ChannelConnection.ChannelConnection_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b885812d12fbd6b83153bef2b8e31e79806e5c46c1eaaf39c954202b5298f520",
    definition:
      'CREATE TRIGGER "ChannelConnection_owner_immutable" BEFORE UPDATE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "ChannelInstallation.ChannelInstallation_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b8d0c240f35fb91b77c048e912e9edaa01097702f35d857e0a2fb4327f45af80",
    definition:
      'CREATE TRIGGER "ChannelInstallation_ancestry" BEFORE INSERT OR UPDATE ON "ChannelInstallation" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ChannelInstallation.ChannelInstallation_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "25a586c375a9ba2381c7739ad3fccdadd155439ff638e762c1b242a41c8ca91d",
    definition:
      'CREATE TRIGGER "ChannelInstallation_owner_immutable" BEFORE UPDATE ON "ChannelInstallation" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'appId\')',
  },
  {
    kind: "trigger",
    name: "ChannelThread.ChannelThread_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "c1d895bfa34311d7bfd6abe9a916180ba1b10524e4922c1c4baf836245addd89",
    definition:
      'CREATE TRIGGER "ChannelThread_ancestry" BEFORE INSERT OR UPDATE ON "ChannelThread" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Credential.Credential_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "07331e5997feea5acce26796eac7a1c070e04e66c18b378b897b07672585e891",
    definition:
      "CREATE TRIGGER \"Credential_owner_immutable\" BEFORE UPDATE ON \"Credential\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('environmentId', 'kind', 'name', 'provider')",
  },
  {
    kind: "trigger",
    name: "CredentialAudit.CredentialAudit_immutable_delete",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "d8e27c4a89a52b0df193de1ba95fe0972e28b63cefe3cf40979a1cb6eb2ba507",
    definition:
      'CREATE TRIGGER "CredentialAudit_immutable_delete" BEFORE DELETE ON "CredentialAudit" FOR EACH ROW EXECUTE FUNCTION reject_credential_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "CredentialAudit.CredentialAudit_immutable_truncate",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b32f8b9190384bba9e839b86ff6db337c76a538d2b46febf53a26c0a57c033e7",
    definition:
      'CREATE TRIGGER "CredentialAudit_immutable_truncate" BEFORE TRUNCATE ON "CredentialAudit" FOR EACH STATEMENT EXECUTE FUNCTION reject_credential_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "CredentialAudit.CredentialAudit_immutable_update",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "a2a74ffdb32505556dfd0e16ad4815255a66af37090467923c73e02edea452fa",
    definition:
      'CREATE TRIGGER "CredentialAudit_immutable_update" BEFORE UPDATE ON "CredentialAudit" FOR EACH ROW EXECUTE FUNCTION reject_credential_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "CredentialSecretVersion.CredentialSecretVersion_envelope_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1020c6ff28192dc1e702fdf0ef711d990fe61aa04c562d39598b7377628a787c",
    definition:
      'CREATE TRIGGER "CredentialSecretVersion_envelope_immutable" BEFORE UPDATE ON "CredentialSecretVersion" FOR EACH ROW EXECUTE FUNCTION reject_credential_secret_envelope_change()',
  },
  {
    kind: "trigger",
    name: "EndUser.EndUser_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "befce5c64191112a2881e0495dd44512f9c177d205e410afb95eeec89ce8e126",
    definition:
      'CREATE TRIGGER "EndUser_owner_immutable" BEFORE UPDATE ON "EndUser" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'organizationId\')',
  },
  {
    kind: "trigger",
    name: "EndUserIdentity.EndUserIdentity_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "353a01869e5e348196f8edd8dd1f4ac7a4482d1937abe37f290af2ad75b2cd74",
    definition:
      "CREATE TRIGGER \"EndUserIdentity_owner_immutable\" BEFORE UPDATE ON \"EndUserIdentity\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('endUserId', 'organizationId')",
  },
  {
    kind: "trigger",
    name: "EndUserSession.EndUserSession_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "6da5a8f3893a2930b1f5d97be2a0b7ff09edbfb9504f2870457e88cce51d635e",
    definition:
      'CREATE TRIGGER "EndUserSession_ancestry" BEFORE INSERT OR UPDATE ON "EndUserSession" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Entity.Entity_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1d17917c22a4470e2331d4f5304236ccc14d4667411c6cbaaf4616363e8a8cbe",
    definition:
      'CREATE TRIGGER "Entity_owner_immutable" BEFORE UPDATE ON "Entity" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'projectId\')',
  },
  {
    kind: "trigger",
    name: "EntityMcpClient.EntityMcpClient_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "973349d5cbb982935595f9fe3933a6b9e9d99b51408ec7ceca626bb76224eea0",
    definition:
      'CREATE TRIGGER "EntityMcpClient_ancestry" BEFORE INSERT OR UPDATE ON "EntityMcpClient" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Environment.Environment_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "209fdfa4084d01417b7e5f2813b5aea0ac3c58b325193bb8bdaeb4ea8c11cdf9",
    definition:
      'CREATE TRIGGER "Environment_owner_immutable" BEFORE UPDATE ON "Environment" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'projectId\')',
  },
  {
    kind: "trigger",
    name: "EnvironmentEntityTool.EnvironmentEntityTool_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "29feedfc57f51d01549418fc669fe417ba46ed065e8a561039bf5bd4c2e0d0ac",
    definition:
      'CREATE TRIGGER "EnvironmentEntityTool_ancestry" BEFORE INSERT OR UPDATE ON "EnvironmentEntityTool" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "EnvironmentSkill.EnvironmentSkill_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b7be86a63d3de47bf10f75d7a4a5f9f4749441f539021cbff77e086cd09647e1",
    definition:
      'CREATE TRIGGER "EnvironmentSkill_ancestry" BEFORE INSERT OR UPDATE ON "EnvironmentSkill" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "EnvironmentSkill.EnvironmentSkill_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "e9169ed33b5951d03e7e65a199fcfea791330b136d99205bde3710ec6ae63e9c",
    definition:
      'CREATE TRIGGER "EnvironmentSkill_owner_immutable" BEFORE UPDATE ON "EnvironmentSkill" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "EvalCriterion.EvalCriterion_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "8535b6f156a6bcd852994a3a6779ca7e821e24a4282244bcf39075b675adeb0f",
    definition:
      'CREATE TRIGGER "EvalCriterion_ancestry" BEFORE INSERT OR UPDATE ON "EvalCriterion" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ExternalClickHouseWriterGrant.ExternalClickHouseWriterGrant_immutable_delete",
    migration: "20260817060000_add_external_writer_fence_plan",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "84499245d81bf8fb97b87561a648b03f2cfbf9defb956b37e11760d2e4c14961",
    definition:
      'CREATE TRIGGER "ExternalClickHouseWriterGrant_immutable_delete" BEFORE DELETE ON "ExternalClickHouseWriterGrant" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalClickHouseWriterGrant.ExternalClickHouseWriterGrant_immutable_truncate",
    migration: "20260817060000_add_external_writer_fence_plan",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "f170a4c13213efc55fd7dfbf50d35399d7192fbc8117fac1ce54376a2076bcfe",
    definition:
      'CREATE TRIGGER "ExternalClickHouseWriterGrant_immutable_truncate" BEFORE TRUNCATE ON "ExternalClickHouseWriterGrant" FOR EACH STATEMENT EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalClickHouseWriterGrant.ExternalClickHouseWriterGrant_immutable_update",
    migration: "20260817060000_add_external_writer_fence_plan",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "98d611615c37ee4ea365e1a02e191edc6aa872761381a615dd2f9a4bb39f8f51",
    definition:
      'CREATE TRIGGER "ExternalClickHouseWriterGrant_immutable_update" BEFORE UPDATE ON "ExternalClickHouseWriterGrant" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverEvidence.ExternalCutoverEvidence_immutable_delete",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "24a71348a52993b46da469898f8eb680337d7f7be7c30b7a3648c66febdcacb4",
    definition:
      'CREATE TRIGGER "ExternalCutoverEvidence_immutable_delete" BEFORE DELETE ON "ExternalCutoverEvidence" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverEvidence.ExternalCutoverEvidence_immutable_truncate",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "167ba2627627cb4c00bba294522b3cdf95e1fa9f7f26b84e9383f295424d095f",
    definition:
      'CREATE TRIGGER "ExternalCutoverEvidence_immutable_truncate" BEFORE TRUNCATE ON "ExternalCutoverEvidence" FOR EACH STATEMENT EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverEvidence.ExternalCutoverEvidence_immutable_update",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "09ae95b2891b8015d6edb34ebdeaf399fd71a0342d41990d897c84ee05bcb289",
    definition:
      'CREATE TRIGGER "ExternalCutoverEvidence_immutable_update" BEFORE UPDATE ON "ExternalCutoverEvidence" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverEvidence.ExternalCutoverEvidence_sequence",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "434fbf0b3c6b95cee8b04d51d38e4a1ebe2209b2d1ec6bed56ceb9b4ee74ca8b",
    definition:
      'CREATE TRIGGER "ExternalCutoverEvidence_sequence" BEFORE INSERT ON "ExternalCutoverEvidence" FOR EACH ROW EXECUTE FUNCTION enforce_external_cutover_evidence_sequence()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverRun.ExternalCutoverRun_attempt_sequence",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ab14f5e9f8efde6ef92b165b6befdd0f348476fcd0395dfcd7d09a498a71e4c4",
    definition:
      'CREATE TRIGGER "ExternalCutoverRun_attempt_sequence" BEFORE INSERT ON "ExternalCutoverRun" FOR EACH ROW EXECUTE FUNCTION enforce_external_cutover_run_attempt_sequence()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverRun.ExternalCutoverRun_immutable_delete",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "e205fa9be604f1750a0eb2d85546063c3ac1cc634acd725e743252a33754c903",
    definition:
      'CREATE TRIGGER "ExternalCutoverRun_immutable_delete" BEFORE DELETE ON "ExternalCutoverRun" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverRun.ExternalCutoverRun_immutable_truncate",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1520e5cc22e434705b9341d12477193b81738db3607da79e0da79bb68d4ed6ad",
    definition:
      'CREATE TRIGGER "ExternalCutoverRun_immutable_truncate" BEFORE TRUNCATE ON "ExternalCutoverRun" FOR EACH STATEMENT EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ExternalCutoverRun.ExternalCutoverRun_immutable_update",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "477adf9bf990bb39ec78144e710de6555f8c072dba4af4178d659f3bd903b3a5",
    definition:
      'CREATE TRIGGER "ExternalCutoverRun_immutable_update" BEFORE UPDATE ON "ExternalCutoverRun" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "GoldenSet.GoldenSet_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "17f66c25ebb7f69312761c1e658b40000745ac21803698489695991130c1d77d",
    definition:
      'CREATE TRIGGER "GoldenSet_ancestry" BEFORE INSERT OR UPDATE ON "GoldenSet" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ImpersonationAudit.ImpersonationAudit_immutable_delete",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "57123d4de77e15d96f52ebbd747f2f53fbde871bbe9918176a09a5ce30628210",
    definition:
      'CREATE TRIGGER "ImpersonationAudit_immutable_delete" BEFORE DELETE ON "ImpersonationAudit" FOR EACH ROW EXECUTE FUNCTION reject_impersonation_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "ImpersonationAudit.ImpersonationAudit_immutable_truncate",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "363f0dcd39653f0774dee641fa04ea011b300aa4585986b449da13dc38afd0b4",
    definition:
      'CREATE TRIGGER "ImpersonationAudit_immutable_truncate" BEFORE TRUNCATE ON "ImpersonationAudit" FOR EACH STATEMENT EXECUTE FUNCTION reject_impersonation_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "ImpersonationAudit.ImpersonationAudit_immutable_update",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "922abe418f8f9c289b87448d85b39fec5e00f847a084c92f7366f6ccb419d723",
    definition:
      'CREATE TRIGGER "ImpersonationAudit_immutable_update" BEFORE UPDATE ON "ImpersonationAudit" FOR EACH ROW EXECUTE FUNCTION reject_impersonation_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "McpAnonymousSession.McpAnonymousSession_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "75d279abe2a38e0bbfe28dd501eada707265ffd26a5f335eef8df10ced046bb8",
    definition:
      'CREATE TRIGGER "McpAnonymousSession_ancestry" BEFORE INSERT OR UPDATE ON "McpAnonymousSession" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "McpBearerToken.McpBearerToken_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "913fb0e68e03fb281a4f27543c8cafee8f1797b431f14afac78d41549f983d46",
    definition:
      'CREATE TRIGGER "McpBearerToken_ancestry" BEFORE INSERT OR UPDATE ON "McpBearerToken" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "McpBearerToken.McpBearerToken_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "27aa9b42e8e1cab7f1d5c2d82b015940c1d126ad56696071f6def2abfb54320d",
    definition:
      "CREATE TRIGGER \"McpBearerToken_owner_immutable\" BEFORE UPDATE ON \"McpBearerToken\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('entityId', 'createdByUserId')",
  },
  {
    kind: "trigger",
    name: "McpOidcSession.McpOidcSession_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "c5926ed34ef906cb746a67860d1320ac048c4b11a3ac1dbea56e523235ba2dcc",
    definition:
      'CREATE TRIGGER "McpOidcSession_ancestry" BEFORE INSERT OR UPDATE ON "McpOidcSession" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "McpToken.McpToken_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "3a1894fa8bac90824ad9c79b7fbe80f42646843795c56cbdc583286e0dbd3989",
    definition:
      'CREATE TRIGGER "McpToken_ancestry" BEFORE INSERT OR UPDATE ON "McpToken" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "McpToken.McpToken_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "5a75d1223499e84f74981f5230d441f81241de77994f99a2e8c4c447a6484110",
    definition:
      "CREATE TRIGGER \"McpToken_owner_immutable\" BEFORE UPDATE ON \"McpToken\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('environmentId', 'mintedByUserId')",
  },
  {
    kind: "trigger",
    name: "Memory.Memory_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "26870e5f303482969430820fa07f48e911b9c219909c7de765aef137bce7f9e9",
    definition:
      'CREATE TRIGGER "Memory_ancestry" BEFORE INSERT OR UPDATE ON "Memory" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Memory.Memory_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "84571d653a6868d0c1201e5713f40ddb9bdb2918cd549ac488b854a8e5c917fb",
    definition:
      "CREATE TRIGGER \"Memory_owner_immutable\" BEFORE UPDATE ON \"Memory\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('environmentId', 'endUserId', 'agentId', 'clusterId', 'sourceThreadId', 'extractorVersion')",
  },
  {
    kind: "trigger",
    name: "MemoryEntity.MemoryEntity_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "63284817125bb2d4ba1124782816d9a3672e7aafb5e32dc7a81cfbadaedea22f",
    definition:
      'CREATE TRIGGER "MemoryEntity_ancestry" BEFORE INSERT OR UPDATE ON "MemoryEntity" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "MemoryEntity.MemoryEntity_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b1c1e2492bf7652f53e585fc84f33a7fdaa3be0bf8c149a61e8c0ecf3dbb95d6",
    definition:
      "CREATE TRIGGER \"MemoryEntity_owner_immutable\" BEFORE UPDATE ON \"MemoryEntity\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('environmentId', 'agentId', 'clusterId')",
  },
  {
    kind: "trigger",
    name: "MemoryEntity.MemoryEntity_subject_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "b1f5d3bc9b2839283e89531783d198e022de86a2b0f44b2ff05b1ffe6f4b9365",
    definition:
      'CREATE TRIGGER "MemoryEntity_subject_immutable" BEFORE UPDATE ON "MemoryEntity" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'endUserId\')',
  },
  {
    kind: "trigger",
    name: "MemoryRelationship.MemoryRelationship_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "9a1a5ccbfdea54e081b34c551076ad175c096bccd35c15bbdad84d1bc3366bc2",
    definition:
      'CREATE TRIGGER "MemoryRelationship_ancestry" BEFORE INSERT OR UPDATE ON "MemoryRelationship" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "MemoryRelationship.MemoryRelationship_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "d117345d7233f10e4c14089945e68b443a7182eec880f9dc80f0cfcfc546daa0",
    definition:
      "CREATE TRIGGER \"MemoryRelationship_owner_immutable\" BEFORE UPDATE ON \"MemoryRelationship\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('environmentId', 'endUserId', 'agentId', 'clusterId', 'fromEntityId', 'toEntityId')",
  },
  {
    kind: "trigger",
    name: "MessageAttachment.MessageAttachment_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "fc9b22a599faa2c93107bbd1df9643be0cb830fad77e5925399a48cd40362df4",
    definition:
      'CREATE TRIGGER "MessageAttachment_ancestry" BEFORE INSERT OR UPDATE ON "MessageAttachment" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "MessageAttachment.MessageAttachment_claimed_lifecycle",
    migration: "20260817000000_add_upload_reservations",
    classification: "BULK_LOAD_SAFE_DEFERRED",
    fingerprint: "8d438dc70a6f824d27a3caf34ad93373086407547c43e45647e549b9a64e9b59",
    definition:
      'CREATE TRIGGER "MessageAttachment_claimed_lifecycle" BEFORE UPDATE ON "MessageAttachment" FOR EACH ROW EXECUTE FUNCTION protect_claimed_message_attachment()',
  },
  {
    kind: "trigger",
    name: "MessageAttachment.MessageAttachment_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "c8d5ef934f8ca80581dbe7b51958f76e9e8a838de69c4e996519228b45da84cf",
    definition:
      "CREATE TRIGGER \"MessageAttachment_owner_immutable\" BEFORE UPDATE ON \"MessageAttachment\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('environmentId', 'endUserId')",
  },
  {
    kind: "trigger",
    name: "MessageRating.MessageRating_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "d455314ab9f1780c283a94c6a19a358e8fb3c969d7f9c66cc78bdb52f989639f",
    definition:
      'CREATE TRIGGER "MessageRating_ancestry" BEFORE INSERT OR UPDATE ON "MessageRating" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "OAuthAccessToken.OAuthAccessToken_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "7edabf26ee50b4caf694bd0c6e08d70ea7bf3f61931be515c10cd3c43dc063aa",
    definition:
      'CREATE TRIGGER "OAuthAccessToken_ancestry" BEFORE INSERT OR UPDATE ON "OAuthAccessToken" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "OAuthAccessToken.OAuthAccessToken_scope_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "e324dad463c8cc015c2620e40bdee392b8496c21d20eb5487904fba04fa0799c",
    definition:
      "CREATE TRIGGER \"OAuthAccessToken_scope_immutable\" BEFORE UPDATE ON \"OAuthAccessToken\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('clientId', 'userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId')",
  },
  {
    kind: "trigger",
    name: "OAuthAuthorizationCode.OAuthAuthorizationCode_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "6d07f5a27cdba9a44d9d9357c6a8fa6f46006451deca2e5d94ef9554b432fe78",
    definition:
      'CREATE TRIGGER "OAuthAuthorizationCode_ancestry" BEFORE INSERT OR UPDATE ON "OAuthAuthorizationCode" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "OAuthAuthorizationCode.OAuthAuthorizationCode_scope_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "abf80985f0ec83b011ec12ea359a02fa29199e9ec47279477f87f636d350e580",
    definition:
      "CREATE TRIGGER \"OAuthAuthorizationCode_scope_immutable\" BEFORE UPDATE ON \"OAuthAuthorizationCode\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('clientId', 'userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId')",
  },
  {
    kind: "trigger",
    name: "OAuthClient.OAuthClient_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "c1c6e9bfb6e3939a669294395b90e494b2d6db9fd3afd93b4471bc1cbdbc055f",
    definition:
      'CREATE TRIGGER "OAuthClient_ancestry" BEFORE INSERT OR UPDATE ON "OAuthClient" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "OAuthClient.OAuthClient_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ee7987915e3c49d9fc53b9776ed054af943e59454c79b92c4458e7b17b769979",
    definition:
      'CREATE TRIGGER "OAuthClient_owner_immutable" BEFORE UPDATE ON "OAuthClient" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'organizationId\')',
  },
  {
    kind: "trigger",
    name: "OAuthRefreshToken.OAuthRefreshToken_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1e29f561d96e0968fccfb12b83307e648ce261054b120f496ec7691bee31d8a1",
    definition:
      'CREATE TRIGGER "OAuthRefreshToken_ancestry" BEFORE INSERT OR UPDATE ON "OAuthRefreshToken" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "OAuthRefreshToken.OAuthRefreshToken_scope_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "c6babe5e8fcc7dbefebfe7d8bc1c501c6c87bf8cebdd3e35897435ba29cf0035",
    definition:
      "CREATE TRIGGER \"OAuthRefreshToken_scope_immutable\" BEFORE UPDATE ON \"OAuthRefreshToken\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('clientId', 'userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId', 'rotationFamilyId', 'parentRefreshTokenId')",
  },
  {
    kind: "trigger",
    name: "ObjectKeyReconciliation.ObjectKeyReconciliation_attempt_sequence",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "83334bbee476ddbbd41eeee08439abca881c20867c925a3943c413fcaab62900",
    definition:
      'CREATE TRIGGER "ObjectKeyReconciliation_attempt_sequence" BEFORE INSERT ON "ObjectKeyReconciliation" FOR EACH ROW EXECUTE FUNCTION enforce_object_key_reconciliation_attempt_sequence()',
  },
  {
    kind: "trigger",
    name: "ObjectKeyReconciliation.ObjectKeyReconciliation_immutable_delete",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "17416f33560fac8b54808ee627c18da2e275ed18c71864396915630c304167c3",
    definition:
      'CREATE TRIGGER "ObjectKeyReconciliation_immutable_delete" BEFORE DELETE ON "ObjectKeyReconciliation" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ObjectKeyReconciliation.ObjectKeyReconciliation_immutable_truncate",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "49faf7e600018cdc35cc3c8edbce335f6a22bd35152f477a29069f82641fce88",
    definition:
      'CREATE TRIGGER "ObjectKeyReconciliation_immutable_truncate" BEFORE TRUNCATE ON "ObjectKeyReconciliation" FOR EACH STATEMENT EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "ObjectKeyReconciliation.ObjectKeyReconciliation_immutable_update",
    migration: "20260817030000_add_external_cutover_reconciliation",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "8fa81fbffaaca63e6bcf68ae7d1b208af34fe7acc092592592a46c96c7c7f6b4",
    definition:
      'CREATE TRIGGER "ObjectKeyReconciliation_immutable_update" BEFORE UPDATE ON "ObjectKeyReconciliation" FOR EACH ROW EXECUTE FUNCTION reject_external_cutover_ledger_mutation()',
  },
  {
    kind: "trigger",
    name: "OperatorSession.OperatorSession_cascade_revocation",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1a2b10d22591aaaf140fd8ecdeb0fd1e2b90686785f522aef2e0c58e21bc5a5f",
    definition:
      'CREATE TRIGGER "OperatorSession_cascade_revocation" AFTER UPDATE OF "revokedAt" ON "OperatorSession" FOR EACH ROW EXECUTE FUNCTION cascade_operator_session_revocation()',
  },
  {
    kind: "trigger",
    name: "OperatorSession.OperatorSession_parent_active",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "2d5d26d268c040e497d526728bd04e48b66426480434e318ad273756a728aba1",
    definition:
      'CREATE TRIGGER "OperatorSession_parent_active" BEFORE INSERT OR UPDATE OF "parentSessionId", "userId", "expiresAt" ON "OperatorSession" FOR EACH ROW EXECUTE FUNCTION enforce_operator_session_parent()',
  },
  {
    kind: "trigger",
    name: "OrganizationMembership.OrganizationMembership_revoke_sessions_delete",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "13ca88f218d5009742d31c39a2d4cdfa5dfb02e5bce182c4ed900b1db36d80f4",
    definition:
      'CREATE TRIGGER "OrganizationMembership_revoke_sessions_delete" AFTER DELETE ON "OrganizationMembership" FOR EACH ROW EXECUTE FUNCTION revoke_operator_sessions_for_membership_change()',
  },
  {
    kind: "trigger",
    name: "OrganizationMembership.OrganizationMembership_revoke_sessions_update",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "05d39cbf8a6534dfb7921fe9926fef92054ab82316266438b73a979fb0aef046",
    definition:
      'CREATE TRIGGER "OrganizationMembership_revoke_sessions_update" AFTER UPDATE OF role, "deactivatedAt" ON "OrganizationMembership" FOR EACH ROW EXECUTE FUNCTION revoke_operator_sessions_for_membership_change()',
  },
  {
    kind: "trigger",
    name: "PersonalAccessToken.PersonalAccessToken_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "9b7a57273bf8c0b04e5069d1c5a41d108d26187c343cb0f56d2df0c5efaf73be",
    definition:
      'CREATE TRIGGER "PersonalAccessToken_ancestry" BEFORE INSERT OR UPDATE ON "PersonalAccessToken" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "PersonalAccessToken.PersonalAccessToken_scope_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "0add9331b2bc683a3aab5c6bfb98c08214422d1f479b14994caf399dcf7e7545",
    definition:
      "CREATE TRIGGER \"PersonalAccessToken_scope_immutable\" BEFORE UPDATE ON \"PersonalAccessToken\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId')",
  },
  {
    kind: "trigger",
    name: "PostmanTemplate.PostmanTemplate_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "0ca49dd6d64b837d24c8272f1d1ebb3a90ab640462a4e8f591c26c4a8cac4597",
    definition:
      'CREATE TRIGGER "PostmanTemplate_ancestry" BEFORE INSERT OR UPDATE ON "PostmanTemplate" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Project.Project_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "8e79a7af0739bed1aa710b0b7453efae499bfbf184d47515c546b93a93a7249d",
    definition:
      'CREATE TRIGGER "Project_owner_immutable" BEFORE UPDATE ON "Project" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'organizationId\')',
  },
  {
    kind: "trigger",
    name: "ProjectSkill.ProjectSkill_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "75368b53a2a08b642a56b9d02cbb36f8c5c0b6a6783539dea71cfd04a9b6fadf",
    definition:
      'CREATE TRIGGER "ProjectSkill_ancestry" BEFORE INSERT OR UPDATE ON "ProjectSkill" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "ProjectSkill.ProjectSkill_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "66cab63f4b317fa4333091e3e3ff2e42f6221cf59bf44ebbab213204716aac6f",
    definition:
      'CREATE TRIGGER "ProjectSkill_owner_immutable" BEFORE UPDATE ON "ProjectSkill" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'projectId\')',
  },
  {
    kind: "trigger",
    name: "ProviderKey.ProviderKey_credential_provider_integrity",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "32de883a78cc9223c392dca94bfca01e1eec217fa95058df299e333eb7e414bc",
    definition:
      'CREATE TRIGGER "ProviderKey_credential_provider_integrity" BEFORE INSERT OR UPDATE ON "ProviderKey" FOR EACH ROW EXECUTE FUNCTION reject_provider_key_credential_mismatch()',
  },
  {
    kind: "trigger",
    name: "ProviderKey.ProviderKey_executable_reference",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "4477e2f5684659dd70387a97c0dc3b04eced8e89d2b66051078a41806e27343c",
    definition:
      'CREATE TRIGGER "ProviderKey_executable_reference" BEFORE DELETE ON "ProviderKey" FOR EACH ROW EXECUTE FUNCTION reject_executable_provider_key_delete()',
  },
  {
    kind: "trigger",
    name: "ProviderKey.ProviderKey_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "6ba568dbf61d403bad520261782d4654096cc4259b0868604970cf9abe78d7f4",
    definition:
      'CREATE TRIGGER "ProviderKey_owner_immutable" BEFORE UPDATE ON "ProviderKey" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "SafetyEvent.SafetyEvent_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ee99b97fcbf55ba342b662d7ff4c9e241483d85b49e02a4af78059da79bf3672",
    definition:
      'CREATE TRIGGER "SafetyEvent_ancestry" BEFORE INSERT OR UPDATE ON "SafetyEvent" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Skill.Skill_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "ea24af56320f72476bb984527ed8ed428782cfa6b022ad79f2d5ceb2462c746e",
    definition:
      'CREATE TRIGGER "Skill_owner_immutable" BEFORE UPDATE ON "Skill" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'organizationId\')',
  },
  {
    kind: "trigger",
    name: "Step.Step_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "6421bc8777ea16f2bd6b1bd203856094bbf2726aa9682b707fb84b27859f52e2",
    definition:
      'CREATE TRIGGER "Step_owner_immutable" BEFORE UPDATE ON "Step" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'turnId\')',
  },
  {
    kind: "trigger",
    name: "Thread.Thread_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1868a6ce9eb367f22786324bfedce4778d5cbaa5e03afca7167a11b9aeacb4ca",
    definition:
      'CREATE TRIGGER "Thread_ancestry" BEFORE INSERT OR UPDATE ON "Thread" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Thread.Thread_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "12d11a223f617f04a011f2110744744b85fa8dbff3cd0acd65a71dfe00edb106",
    definition:
      'CREATE TRIGGER "Thread_owner_immutable" BEFORE UPDATE ON "Thread" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'environmentId\')',
  },
  {
    kind: "trigger",
    name: "Thread.Thread_subject_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "1846c268314707c896eb2ded12a15b2fb2d7552dc8b83cb0d58e9a3a2454257e",
    definition:
      'CREATE TRIGGER "Thread_subject_immutable" BEFORE UPDATE ON "Thread" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change(\'endUserId\')',
  },
  {
    kind: "trigger",
    name: "TokenLifecycleAudit.TokenLifecycleAudit_immutable_delete",
    migration: "20260817010000_add_token_lifecycle_audit",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "8b300647ee2317e0763bceb491412498198d30b43d626e09ae296390ca125256",
    definition:
      'CREATE TRIGGER "TokenLifecycleAudit_immutable_delete" BEFORE DELETE ON "TokenLifecycleAudit" FOR EACH ROW EXECUTE FUNCTION reject_token_lifecycle_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "TokenLifecycleAudit.TokenLifecycleAudit_immutable_truncate",
    migration: "20260817010000_add_token_lifecycle_audit",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "14775e33880872944f93fb019676215c329eb0b3ecd388afb489ca410f2163df",
    definition:
      'CREATE TRIGGER "TokenLifecycleAudit_immutable_truncate" BEFORE TRUNCATE ON "TokenLifecycleAudit" FOR EACH STATEMENT EXECUTE FUNCTION reject_token_lifecycle_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "TokenLifecycleAudit.TokenLifecycleAudit_immutable_update",
    migration: "20260817010000_add_token_lifecycle_audit",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "d87e9b7d273050bccfdee59760f3b61bbb249b5b8f768f7f67ef46387c02a9ef",
    definition:
      'CREATE TRIGGER "TokenLifecycleAudit_immutable_update" BEFORE UPDATE ON "TokenLifecycleAudit" FOR EACH ROW EXECUTE FUNCTION reject_token_lifecycle_audit_mutation()',
  },
  {
    kind: "trigger",
    name: "TokenLifecycleAudit.TokenLifecycleAudit_scope_match",
    migration: "20260817010000_add_token_lifecycle_audit",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "668b6a8d0b54355d0176e1461b665970bcc5dae2f955a89533b1d7beb1263ff6",
    definition:
      'CREATE TRIGGER "TokenLifecycleAudit_scope_match" BEFORE INSERT ON "TokenLifecycleAudit" FOR EACH ROW EXECUTE FUNCTION enforce_token_lifecycle_audit_scope()',
  },
  {
    kind: "trigger",
    name: "ToolCallAudit.ToolCallAudit_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "797369b2c864a0374eaffa22830812007dac92ef5955cd9bd59a9f569a036a93",
    definition:
      'CREATE TRIGGER "ToolCallAudit_ancestry" BEFORE INSERT OR UPDATE ON "ToolCallAudit" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Turn.Turn_ancestry",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "828a60ffa27b2f3c80f90bdd8eaf26d673762004d3b2fcba8592ef38d782634b",
    definition:
      'CREATE TRIGGER "Turn_ancestry" BEFORE INSERT OR UPDATE ON "Turn" FOR EACH ROW EXECUTE FUNCTION enforce_domain_ancestry()',
  },
  {
    kind: "trigger",
    name: "Turn.Turn_owner_immutable",
    migration: "00000000000000_initial",
    classification: "MANDATORY_ALWAYS_ON",
    fingerprint: "70182c568d4e5646ee38d6436adc92c6ed6bfe33073ec7d32f0fdcb4d258c23f",
    definition:
      "CREATE TRIGGER \"Turn_owner_immutable\" BEFORE UPDATE ON \"Turn\" FOR EACH ROW EXECUTE FUNCTION reject_canonical_owner_change('threadId', 'agentVersionId', 'versionBucket')",
  },
] as const satisfies readonly CleanTriggerFunctionManifestEntry[];

export const deferredCleanTriggerManifest = cleanTriggerFunctionManifest.filter(
  (entry) => entry.classification === "BULK_LOAD_SAFE_DEFERRED"
);

export const cleanTriggerFunctionManifestSha256 = createHash("sha256")
  .update(JSON.stringify(cleanTriggerFunctionManifest), "utf8")
  .digest("hex");

if (deferredCleanTriggerManifest.length !== 1) {
  throw new Error(
    "clean trigger manifest must classify exactly one bulk-load-safe deferred trigger"
  );
}
