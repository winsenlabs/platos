// THE `/tools/sync` REQUEST, AND THE ONE PLACE A WIRE FRAME BECOMES A COMMAND.
//
// Split out of the controller beside it so that neither file has to choose
// between the ADR M0.3 §6 budget and a validator that reports EVERY violation.
// The split is also what lets the shape be exercised without a Nest application:
// `tool-sync-body.test.ts` calls the function.
//
// -----------------------------------------------------------------------------
// THE FIELD NAMES ARE THE SDK'S, NOT A THIRD SPELLING
//
// The platools wire protocol names a declared tool's schema `input_schema`
// (`packages/platools-js/src/transport/protocol.ts`, `ToolSchemaPayload`) and the
// oracle's socket normalises `t.input_schema ?? t.paramSchema ?? {}` before
// handing it to the registry. Both spellings are accepted here for the same
// reason the oracle accepts both — a platools client sends the first and this
// repository's own contexts speak the second — and `annotations.category ||
// category` is the same fallback the oracle applies, in the same order.
//
// `tools_health` IS ACCEPTED IN THE SDK'S OWN SHAPE: a map from tool name to
// `{ status, avg_latency_ms }`. A route that demanded an array of objects would
// be asking every platools client to reshape a frame it already emits.
//
// -----------------------------------------------------------------------------
// `environmentId` IS A BODY FIELD, WHICH IS A BREAK FROM THE LEGACY SURFACE
//
// The oracle resolves the environment from a `?env=` query parameter against the
// entity's project, and its tenancy arrives through `X-Platos-*` headers on the
// REST side. An operation whose tenancy is in headers cannot be described by an
// OpenAPI request schema, cannot be validated by the chassis pipe and cannot
// report a missing tenant in `fields[]`. So it is a named field, refused by name
// when absent, and re-derived by `tenancy` from the leaf before anything is
// written — the same decision `provider-keys.controller.ts` records.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT VALIDATED HERE, AND IT IS DELIBERATE
//
// Tool NAMES, descriptions and parameter schemas are the DOMAIN's:
// `admitDeclaration` in `packages/contexts/tools/domain/declaration.ts` refuses
// an empty name, a duplicate, an over-long description. Repeating any of that
// here would be a second declaration of a policy the domain owns, and the day a
// limit moved one of the two would be wrong. The same goes for the health
// vocabulary: `HEALTH_REPORTS` is checked by `recordToolHealth`, which answers
// `TOOLS_HEALTH_REPORT_INVALID`. What this file refuses is the SHAPE — absent,
// not a string, not an object, not an array — because those are the mistakes
// whose answer has to name `body.<field>`.

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";

import { requestInvalid } from "../rest/transport-errors.js";

/** One declared tool, in either of the two spellings the oracle accepts. */
export interface ToolSyncDeclaration {
  readonly name: string;
  readonly description: string;
  readonly paramSchema: Readonly<Record<string, unknown>>;
  readonly category: string | null;
}

/** One entry of the SDK's `tools_health` map, flattened and named. */
export interface ToolSyncHealthReport {
  readonly toolName: string;
  readonly status: string;
  readonly avgLatencyMs: number | null;
}

export interface ToolSyncBody {
  readonly environmentId: string;
  readonly entityId: string;
  readonly externalEntityId: string;
  readonly tools: readonly ToolSyncDeclaration[];
  readonly callbackUrl: string | null;
  /**
   * `connected` or `disconnected`. OPTIONAL, and absent means "do not touch the
   * column" rather than "connected" — a client re-declaring its tools over a
   * connection it already announced must not be made to re-announce it, and a
   * default of `connected` would make an absent field a write.
   */
  readonly connectionStatus: string | null;
  readonly health: readonly ToolSyncHealthReport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(
  body: Record<string, unknown>,
  field: string,
  violations: FieldViolation[],
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    violations.push({
      field: `body.${field}`,
      code: value === undefined ? "missing" : "invalid",
      message: "Send a non-empty string.",
    });
    return "";
  }
  return value;
}

function readDeclarations(
  value: unknown,
  violations: FieldViolation[],
): readonly ToolSyncDeclaration[] {
  if (!Array.isArray(value)) {
    violations.push({
      field: "body.tools",
      code: value === undefined ? "missing" : "invalid",
      message: "Send the complete declaration as an array.",
    });
    return [];
  }
  const declarations: ToolSyncDeclaration[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      violations.push({
        field: `body.tools[${index}]`,
        code: "invalid",
        message: "Send a JSON object.",
      });
      return;
    }
    const name = entry["name"];
    if (typeof name !== "string" || name.trim() === "") {
      violations.push({
        field: `body.tools[${index}].name`,
        code: name === undefined ? "missing" : "invalid",
        message: "Send a non-empty string.",
      });
      return;
    }
    const schema = entry["input_schema"] ?? entry["paramSchema"];
    const annotations = entry["annotations"];
    const annotated = isRecord(annotations) ? annotations["category"] : undefined;
    const category = typeof annotated === "string" && annotated !== ""
      ? annotated
      : typeof entry["category"] === "string" && entry["category"] !== ""
        ? (entry["category"] as string)
        : null;
    declarations.push({
      name,
      description: typeof entry["description"] === "string" ? entry["description"] : "",
      paramSchema: isRecord(schema) ? schema : {},
      category,
    });
  });
  return declarations;
}

function readHealth(value: unknown, violations: FieldViolation[]): readonly ToolSyncHealthReport[] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) {
    violations.push({
      field: "body.tools_health",
      code: "invalid",
      message: "Send the SDK's tools_health map: tool name to a health entry.",
    });
    return [];
  }
  const reports: ToolSyncHealthReport[] = [];
  for (const [toolName, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      violations.push({
        field: `body.tools_health.${toolName}`,
        code: "invalid",
        message: "Send a JSON object.",
      });
      continue;
    }
    const status = entry["status"];
    if (typeof status !== "string") {
      violations.push({
        field: `body.tools_health.${toolName}.status`,
        code: status === undefined ? "missing" : "invalid",
        message: "Send a string.",
      });
      continue;
    }
    const latency = entry["avg_latency_ms"] ?? entry["avgLatencyMs"];
    reports.push({
      toolName,
      status,
      avgLatencyMs: typeof latency === "number" && Number.isFinite(latency) ? latency : null,
    });
  }
  return reports;
}

/**
 * EVERY VIOLATION IS COLLECTED BEFORE ANY IS REPORTED, for the reason M0.4 §2's
 * envelope carries `fields[]`: a caller with two mistakes should not take two
 * round trips.
 */
export const toolSyncValidator = (input: unknown): Result<ToolSyncBody> => {
  if (!isRecord(input)) {
    return err(
      requestInvalid([{ field: "body", code: "malformed", message: "Send a JSON object." }]),
    );
  }
  const violations: FieldViolation[] = [];
  const environmentId = requireText(input, "environmentId", violations);
  const entityId = requireText(input, "entityId", violations);
  const externalEntityId = requireText(input, "externalEntityId", violations);
  const tools = readDeclarations(input["tools"], violations);
  const health = readHealth(input["tools_health"], violations);

  const callback = input["callback_url"] ?? input["callbackUrl"];
  if (callback !== undefined && callback !== null && typeof callback !== "string") {
    violations.push({
      field: "body.callback_url",
      code: "invalid",
      message: "Send a string, or omit it for an entity reached by session.",
    });
  }

  const status = input["connectionStatus"];
  if (status !== undefined && status !== null && typeof status !== "string") {
    violations.push({
      field: "body.connectionStatus",
      code: "invalid",
      message: "Send connected or disconnected.",
    });
  }

  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({
    environmentId,
    entityId,
    externalEntityId,
    tools,
    callbackUrl: typeof callback === "string" && callback !== "" ? callback : null,
    connectionStatus: typeof status === "string" ? status : null,
    health,
  });
};
