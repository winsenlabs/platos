// Admitting a job definition — what a caller may register, and what it becomes.
//
// The live rules are spread across the MCP `jobs.create` tool: a JSON Schema
// declares the bounds, then the handler re-checks three of them imperatively and
// silently drops the rest. This module states all of them once, as data, and
// returns field-level violations so a transport can render them without
// re-deriving which input was at fault.
//
// TRIMMING IS PART OF THE RULE, NOT A COURTESY. `displayName` is trimmed before
// the emptiness check in the live tool (`String(...).trim()` then `!displayName`),
// so a name of three spaces is a refusal, not a row named "   ". The handler is
// checked with `.trim()` but STORED untrimmed, because leading whitespace in
// source is meaningful to a stack trace and the check is only asking whether
// there is any source at all.

import { asIdentifier, err, ok, type FieldViolation, type JsonValue, type Result } from "@platos/kernel";

import { jobDefinitionInvalid } from "./errors.js";
import type { AgentId, JobKey } from "./identifiers.js";
import { parseJobKey } from "./job-key.js";
import type { JobExecutionBudget, JobSchedule, JobStatus } from "./job.js";
import { parseStoredInvocationType, type StoredInvocationType } from "./invocation.js";

/** The bounds the live `jobs.create` input schema declares. */
export const JOB_DEFINITION_LIMITS = Object.freeze({
  maxDisplayNameLength: 200,
  maxDescriptionLength: 2000,
  maxHandlerLength: 200_000,
  maxAllowedAgentIds: 100,
  maxScheduleCronLength: 200,
  maxScheduleTimezoneLength: 100,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 3600,
  minRetries: 0,
  maxRetries: 10,
});

/** The live defaults applied when a field is omitted. */
export const JOB_DEFINITION_DEFAULTS = Object.freeze({
  invocationType: "manual" as StoredInvocationType,
  timeoutSeconds: 300,
  // The COLUMN default is 0; the live MCP create path passes 3 explicitly, so 3
  // is what a job registered through the supported surface actually gets.
  maxRetries: 3,
});

export interface JobDefinitionDraft {
  readonly jobKey: string;
  readonly displayName: string;
  readonly description?: string | null;
  readonly invocationType?: string | null;
  readonly scheduleCron?: string | null;
  readonly scheduleTimezone?: string | null;
  readonly allowedAgentIds?: readonly string[] | null;
  readonly payloadSchema?: JsonValue | null;
  readonly handler: string;
  readonly timeoutSeconds?: number | null;
  readonly maxRetries?: number | null;
}

/** A draft that has passed every rule. */
export interface JobDefinition {
  readonly jobKey: JobKey;
  readonly displayName: string;
  readonly description: string | null;
  readonly invocationType: StoredInvocationType;
  readonly schedule: JobSchedule;
  readonly allowedAgentIds: readonly AgentId[];
  readonly payloadSchema: JsonValue | null;
  readonly handler: string;
  readonly budget: JobExecutionBudget;
}

function violation(field: string, code: string, message: string): FieldViolation {
  return { field, code, message };
}

function checkText(
  value: string,
  field: string,
  max: number,
  violations: FieldViolation[],
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) violations.push(violation(field, "REQUIRED", `${field} is required`));
  else if (trimmed.length > max) {
    violations.push(violation(field, "TOO_LONG", `${field} exceeds ${max} characters`));
  }
  return trimmed;
}

function checkBounded(
  value: number,
  field: string,
  min: number,
  max: number,
  violations: FieldViolation[],
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    violations.push(violation(field, "OUT_OF_RANGE", `${field} must be an integer in [${min}, ${max}]`));
  }
  return value;
}

function checkOptionalText(
  value: string | null | undefined,
  field: string,
  max: number,
  violations: FieldViolation[],
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    violations.push(violation(field, "TOO_LONG", `${field} exceeds ${max} characters`));
  }
  return trimmed.length === 0 ? null : trimmed;
}

function checkAgentIds(
  value: readonly string[] | null | undefined,
  violations: FieldViolation[],
): readonly AgentId[] {
  if (value === null || value === undefined) return [];
  if (value.length > JOB_DEFINITION_LIMITS.maxAllowedAgentIds) {
    violations.push(
      violation(
        "allowedAgentIds",
        "TOO_MANY",
        `allowedAgentIds exceeds ${JOB_DEFINITION_LIMITS.maxAllowedAgentIds} entries`,
      ),
    );
  }
  return value.filter((entry) => entry.length > 0).map((entry) => asIdentifier<AgentId>(entry));
}

/**
 * Admit a draft, or refuse it with EVERY violation it carries.
 *
 * Collecting all violations rather than returning on the first is deliberate: a
 * caller registering a job through an API should not have to make one round trip
 * per mistake.
 */
export function admitJobDefinition(draft: JobDefinitionDraft): Result<JobDefinition> {
  const violations: FieldViolation[] = [];

  const key = parseJobKey(draft.jobKey);
  if (!key.ok) violations.push(violation("jobKey", "INVALID", key.error.message));

  const displayName = checkText(
    draft.displayName,
    "displayName",
    JOB_DEFINITION_LIMITS.maxDisplayNameLength,
    violations,
  );
  const handler = draft.handler;
  if (handler.trim().length === 0) {
    violations.push(violation("handler", "REQUIRED", "handler is required"));
  } else if (handler.length > JOB_DEFINITION_LIMITS.maxHandlerLength) {
    violations.push(
      violation("handler", "TOO_LONG", `handler exceeds ${JOB_DEFINITION_LIMITS.maxHandlerLength} characters`),
    );
  }

  const invocation = parseStoredInvocationType(draft.invocationType ?? JOB_DEFINITION_DEFAULTS.invocationType);
  if (!invocation.ok) violations.push(violation("invocationType", "INVALID", invocation.error.message));

  const description = checkOptionalText(
    draft.description,
    "description",
    JOB_DEFINITION_LIMITS.maxDescriptionLength,
    violations,
  );
  const cron = checkOptionalText(
    draft.scheduleCron,
    "scheduleCron",
    JOB_DEFINITION_LIMITS.maxScheduleCronLength,
    violations,
  );
  const timezone = checkOptionalText(
    draft.scheduleTimezone,
    "scheduleTimezone",
    JOB_DEFINITION_LIMITS.maxScheduleTimezoneLength,
    violations,
  );
  const allowedAgentIds = checkAgentIds(draft.allowedAgentIds, violations);

  const timeoutSeconds = checkBounded(
    draft.timeoutSeconds ?? JOB_DEFINITION_DEFAULTS.timeoutSeconds,
    "timeoutSeconds",
    JOB_DEFINITION_LIMITS.minTimeoutSeconds,
    JOB_DEFINITION_LIMITS.maxTimeoutSeconds,
    violations,
  );
  const maxRetries = checkBounded(
    draft.maxRetries ?? JOB_DEFINITION_DEFAULTS.maxRetries,
    "maxRetries",
    JOB_DEFINITION_LIMITS.minRetries,
    JOB_DEFINITION_LIMITS.maxRetries,
    violations,
  );

  if (violations.length > 0 || !key.ok || !invocation.ok) {
    return err(jobDefinitionInvalid("job definition is not admissible", violations));
  }

  return ok({
    jobKey: key.value,
    displayName,
    description,
    invocationType: invocation.value,
    schedule: { cron, timezone },
    allowedAgentIds,
    payloadSchema: draft.payloadSchema ?? null,
    handler,
    budget: { timeoutSeconds, maxRetries },
  });
}

/**
 * The status a newly registered job takes.
 *
 * The live tool syntax-checks the handler and stores `FAILED` when it does not
 * parse, keeping the row so the author can see the error. Parsing is a capability
 * of the sandbox, not of this layer, so the VERDICT arrives as a parameter and
 * only the consequence is decided here.
 */
export function registrationStatus(syntaxError: string | null): JobStatus {
  return syntaxError === null ? "active" : "registration-failed";
}
