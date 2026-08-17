-- PRA-TC.1c: Rename parentMessageId → editParentMessageId on PlatosAgentMessage.
-- Disambiguates edit/rerun lineage (editParentMessageId) from thread reply parent
-- (threadReplyToId) — two distinct self-referential relations on the same model.

ALTER TABLE "PlatosAgentMessage"
  RENAME COLUMN "parentMessageId" TO "editParentMessageId";

-- Recreate the index under the new column name.
-- DROP + CONCURRENTLY-CREATE is safer than RENAME IF EXISTS (which silently
-- succeeds if the old name doesn't match, leaving the index missing entirely).
DROP INDEX IF EXISTS "PlatosAgentMessage_parentMessageId_idx";
