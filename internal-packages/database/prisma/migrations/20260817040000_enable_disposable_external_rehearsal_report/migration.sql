-- The only executable external contract is a forced-rollback disposable
-- rehearsal. Production/full execution remains disabled in the command.
CREATE FUNCTION "public"."external_cutover_disposable_rehearsal_report_is_valid"(report JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    jsonb_typeof(report) = 'object' AND
    (SELECT count(*) FROM jsonb_object_keys(report)) = 7 AND
    report ?& ARRAY[
      'contractVersion', 'implementation', 'targetKind', 'state',
      'manifestSha256', 'clickHouseTables', 'objectStoreObjects'
    ] AND
    report -> 'contractVersion' = '1'::jsonb AND
    report ->> 'implementation' = 'DISPOSABLE_REHEARSAL' AND
    report ->> 'targetKind' = 'DISPOSABLE_REHEARSAL' AND
    report ->> 'state' = 'ROLLED_BACK' AND
    report ->> 'manifestSha256' ~ '^[0-9a-f]{64}$' AND
    jsonb_typeof(report -> 'clickHouseTables') = 'array' AND
    jsonb_array_length(report -> 'clickHouseTables') = 12 AND
    (
      SELECT count(DISTINCT entry ->> 'table') = 12 AND bool_and(
        jsonb_typeof(entry) = 'object' AND
        (SELECT count(*) FROM jsonb_object_keys(entry)) = 9 AND
        entry ?& ARRAY[
          'table', 'sourceSchemaSha256', 'sourceRowCount', 'targetRowCount',
          'sourceSha256', 'targetSha256', 'identitySha256', 'payloadSha256',
          'rollbackOutcome'
        ] AND
        entry ->> 'table' IN (
          'error_occurrences_v1', 'errors_v1', 'llm_metrics_v1', 'metrics_v1',
          'platos_spans_v1', 'task_event_usage_by_hour_v1',
          'task_event_usage_by_minute_v1', 'task_events_search_v1',
          'task_events_v1', 'task_events_v2', 'task_runs_v1', 'task_runs_v2'
        ) AND
        entry ->> 'sourceSchemaSha256' ~ '^[0-9a-f]{64}$' AND
        entry ->> 'sourceRowCount' ~ '^(0|[1-9][0-9]*)$' AND
        entry ->> 'targetRowCount' ~ '^(0|[1-9][0-9]*)$' AND
        entry ->> 'sourceRowCount' = entry ->> 'targetRowCount' AND
        entry ->> 'sourceSha256' ~ '^[0-9a-f]{64}$' AND
        entry ->> 'targetSha256' ~ '^[0-9a-f]{64}$' AND
        entry ->> 'identitySha256' ~ '^[0-9a-f]{64}$' AND
        entry ->> 'payloadSha256' ~ '^[0-9a-f]{64}$' AND
        entry ->> 'targetSha256' = entry ->> 'payloadSha256' AND
        entry ->> 'rollbackOutcome' = 'ROLLED_BACK'
      )
      FROM jsonb_array_elements(report -> 'clickHouseTables') entry
    ) AND
    jsonb_typeof(report -> 'objectStoreObjects') = 'array' AND
    NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(report -> 'objectStoreObjects') entry
      WHERE
        jsonb_typeof(entry) <> 'object' OR
        (SELECT count(*) FROM jsonb_object_keys(entry)) <> 7 OR
        NOT entry ?& ARRAY[
          'metadataModel', 'metadataRowIdSha256', 'outcome',
          'sourceObjectKeySha256', 'targetObjectKeySha256',
          'expectedByteLength', 'observedByteLength'
        ] OR
        entry ->> 'metadataModel' <> 'MessageAttachment' OR
        entry ->> 'metadataRowIdSha256' !~ '^[0-9a-f]{64}$' OR
        entry ->> 'outcome' <> 'MATCH' OR
        entry ->> 'sourceObjectKeySha256' !~ '^[0-9a-f]{64}$' OR
        entry ->> 'targetObjectKeySha256' !~ '^[0-9a-f]{64}$' OR
        entry ->> 'sourceObjectKeySha256' <> entry ->> 'targetObjectKeySha256' OR
        entry ->> 'expectedByteLength' !~ '^(0|[1-9][0-9]*)$' OR
        entry ->> 'observedByteLength' !~ '^(0|[1-9][0-9]*)$' OR
        entry ->> 'expectedByteLength' <> entry ->> 'observedByteLength'
    );
$$ LANGUAGE SQL IMMUTABLE STRICT;

CREATE FUNCTION "public"."external_cutover_report_is_valid"(report JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    "public"."external_cutover_stub_report_is_valid"(report) OR
    "public"."external_cutover_disposable_rehearsal_report_is_valid"(report);
$$ LANGUAGE SQL IMMUTABLE STRICT;

ALTER TABLE "public"."ExternalCutoverRun"
  DROP CONSTRAINT "ExternalCutoverRun_report_check",
  ADD CONSTRAINT "ExternalCutoverRun_report_check" CHECK (
    "report" IS NULL OR (
      "report" ->> 'manifestSha256' = "manifestSha256" AND
      (
        ("status" = 'STUB_BLOCKED' AND "report" ->> 'implementation' = 'STUB') OR
        ("status" = 'ROLLED_BACK' AND "report" ->> 'implementation' = 'DISPOSABLE_REHEARSAL')
      ) AND
      "public"."external_cutover_report_is_valid"("report")
    )
  );

-- Reassert the append-only privilege boundary in the enabling migration.
REVOKE UPDATE, DELETE, TRUNCATE
ON TABLE "public"."ExternalCutoverRun", "public"."ExternalCutoverEvidence", "public"."ObjectKeyReconciliation"
FROM PUBLIC;
