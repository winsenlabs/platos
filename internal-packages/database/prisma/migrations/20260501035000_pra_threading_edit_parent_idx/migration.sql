-- PRA-TC.1c (idx): Create index on the renamed editParentMessageId column.
-- Separated from the RENAME COLUMN migration per CONCURRENTLY rules.

CREATE INDEX IF NOT EXISTS "PlatosAgentMessage_editParentMessageId_idx"
  ON "PlatosAgentMessage" ("editParentMessageId");
