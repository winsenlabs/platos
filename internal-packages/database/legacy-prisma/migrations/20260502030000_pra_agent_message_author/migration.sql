-- PRA-AC.1: Add authorAgentId to PlatosAgentMessage.
-- NULL = legacy single-agent message. Non-null = which cluster agent wrote this message.
-- No FK (agent may be removed from cluster; message attribution should survive).

ALTER TABLE "PlatosAgentMessage"
  ADD COLUMN IF NOT EXISTS "authorAgentId" TEXT;
