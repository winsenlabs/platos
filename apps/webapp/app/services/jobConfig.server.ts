import {
  booleanField,
  enumField,
  jsonObject,
  numberField,
  optionalText,
  requiredText,
  stringList,
} from "./m4Mutation.server";

export function parseJobForm(form: FormData, mode: "create" | "update") {
  const invocationType = enumField(form, "invocationType", ["manual", "schedule", "webhook"] as const, "manual");
  const handler = mode === "create" ? requiredText(form, "handler", "Handler source") : optionalText(form, "handler");
  return {
    ...(mode === "create" ? { jobId: requiredText(form, "jobId", "Job ID") } : {}),
    ...(mode === "create"
      ? { displayName: requiredText(form, "displayName", "Display name") }
      : { displayName: optionalText(form, "displayName") }),
    description: optionalText(form, "description"),
    invocationType,
    scheduleCron: invocationType === "schedule" ? optionalText(form, "scheduleCron") : undefined,
    scheduleTimezone: invocationType === "schedule" ? optionalText(form, "scheduleTimezone") : undefined,
    allowedAgentIds: stringList(form, "allowedAgentIds"),
    payloadSchema: jsonObject(form, "payloadSchema"),
    ...(handler !== undefined ? { handler } : {}),
    timeout: numberField(form, "timeout", { min: 1, max: 590, integer: true, fallback: 300 }),
    maxRetries: numberField(form, "maxRetries", { min: 0, max: 10, integer: true, fallback: 3 }),
    ...(mode === "update" ? { isActive: booleanField(form, "isActive") } : {}),
  };
}
