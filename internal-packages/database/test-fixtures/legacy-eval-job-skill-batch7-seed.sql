-- Retained evaluation/job/skill Batch 7 fixture.
-- Apply after legacy core, Batch 1 agent/tool, and Batch 2 conversation fixtures.

INSERT INTO "PlatosMessageRating"
  (id, "organizationId", "projectId", "environmentId", "messageId", "threadId",
   "agentId", "agentVersionId", "userId", rating, comment, "createdAt", "updatedAt")
VALUES
  ('cllegacyrating0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacymessage0002', 'cllegacythread0001', 'cllegacyagent0001',
   'cllegacyversion0001', 'external-user-001', 1, 'Fixture thumbs up',
   '2025-01-05T00:00:00Z', '2025-01-05T00:00:00Z');

INSERT INTO "PlatosEvalCriterion"
  (id, "organizationId", "projectId", "environmentId", "agentId", name,
   description, "judgePrompt", rubric, "judgeModel", "scoreScaleMin",
   "scoreScaleMax", "isActive", "createdBy", "createdAt", "updatedAt")
VALUES
  ('cllegacycriterion0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'Fixture correctness', 'Checks the fixture answer',
   'Evaluate {conversation}', '1 is poor; 5 is excellent', 'anthropic:judge-fixture',
   1, 5, true, 'cllegacyuser0001', '2025-01-05T00:00:01Z', '2025-01-05T00:00:01Z');

INSERT INTO "PlatosAgentEval"
  (id, "organizationId", "projectId", "environmentId", "agentId", "agentVersionId",
   "threadId", "messageId", "criterionId", "criterionSnapshot", "judgeModel",
   "judgePromptUsed", "rawResponse", score, rationale, passed, "runId",
   "baselineVersionId", "costCents", "latencyMs", "createdAt")
VALUES
  ('cllegacyeval0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'cllegacyversion0001', 'cllegacythread0001',
   'cllegacymessage0002', 'cllegacycriterion0001',
   '{"name":"Fixture correctness","scale":{"min":1,"max":5}}'::jsonb,
   'anthropic:judge-fixture', 'Evaluate fixture transcript', '{"score":4}',
   80, 'Correct fixture response', true, 'export-only-run', 'export-only-baseline',
   0.125, 45, '2025-01-05T00:00:02Z');

INSERT INTO "PlatosGoldenSet"
  (id, "organizationId", "projectId", "environmentId", "agentId", name,
   description, "threadIds", "criterionIds", "createdBy", "createdAt", "updatedAt")
VALUES
  ('cllegacygoldenset0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'Fixture regression set', 'One mapped thread and criterion',
   ARRAY['cllegacythread0001'], ARRAY['cllegacycriterion0001'], 'cllegacyuser0001',
   '2025-01-05T00:00:03Z', '2025-01-05T00:00:03Z');

INSERT INTO "PlatosTask"
  (id, "organizationId", "projectId", "environmentId", "taskId", "displayName",
   description, "triggerType", "scheduleCron", "scheduleTimezone", "webhookSecret",
   "allowedAgentIds", "payloadSchema", handler, "compiledHandler", "handlerVersion",
   timeout, "maxRetries", "isActive", "createdBy", "createdAt", "updatedAt", "lastRunAt")
VALUES
  ('cllegacytask0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'fixture-job', 'Fixture job', 'A retained inactive job', 'agent-spawn', NULL, NULL,
   'export-only-webhook-secret', ARRAY['cllegacyagent0001'],
   '{"type":"object","properties":{"query":{"type":"string"}}}'::jsonb,
   'return { ok: true };', 'export-only-compiled-handler', 3, 120, 2, false,
   'cllegacyuser0001', '2025-01-05T00:00:04Z', '2025-01-05T00:00:04Z', NULL);

INSERT INTO "PlatosSkill"
  (id, "organizationId", "projectId", "environmentId", "skillId", name,
   description, version, author, origin, "isOfficial", tags, source, manifest,
   "promptBlock", "providesTools", "requiredEnv", "optionalEnv", "importedFrom",
   "createdAt", "updatedAt")
VALUES
  ('cllegacyskill0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'fixture.lookup', 'Fixture lookup', 'Looks up deterministic fixture data', '1.2.3',
   'Fixture Author', 'custom', false, ARRAY['fixture','lookup'],
   '---\nid: fixture.lookup\n---\nUse fixture lookup.',
   '{"id":"fixture.lookup","name":"Fixture lookup","version":"1.2.3"}'::jsonb,
   'Use fixture lookup.',
   '[{"name":"fixture_lookup","description":"Look up fixture data","inputSchema":{"type":"object"}}]'::jsonb,
   ARRAY['FIXTURE_REQUIRED'], ARRAY['FIXTURE_OPTIONAL'], NULL,
   '2025-01-05T00:00:05Z', '2025-01-05T00:00:05Z');

INSERT INTO "PlatosAgentSkill"
  (id, "agentId", "skillId", "organizationId", "projectId", "environmentId",
   enabled, config, "enabledAt", "updatedAt")
VALUES
  ('cllegacyagentskill0001', 'cllegacyagent0001', 'cllegacyskill0001',
   'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001', true,
   '{"maxResults":3}'::jsonb, '2025-01-05T00:00:06Z', '2025-01-05T00:00:06Z');
