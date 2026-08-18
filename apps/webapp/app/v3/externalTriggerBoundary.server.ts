import { RunEngineVersionSchema } from "@platos/core/v3";
import { z } from "zod";

export const ExternalTriggerHeadersSchema = z.object({
  "idempotency-key": z.string().nullish(),
  "idempotency-key-ttl": z.string().nullish(),
  "trigger-version": z.string().nullish(),
  "x-trigger-span-parent-as-link": z.coerce.number().nullish(),
  "x-trigger-worker": z.string().nullish(),
  "x-trigger-client": z.string().nullish(),
  "x-trigger-engine-version": RunEngineVersionSchema.nullish(),
  "x-trigger-request-idempotency-key": z.string().nullish(),
  "x-trigger-realtime-streams-version": z.string().nullish(),
  "x-trigger-source": z.string().nullish(),
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

export class ExternalTriggerOnlyError extends Error {
  readonly code = "EXTERNAL_TRIGGER_REQUIRED";

  constructor() {
    super("Task execution is owned by the configured external Trigger application.");
    this.name = "ExternalTriggerOnlyError";
  }
}

export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
  }
}

export const MAX_TRIGGER_ATTEMPTS = 2;

export function rejectLocalTaskTrigger(): never {
  throw new ExternalTriggerOnlyError();
}

export function rejectLocalScheduleOperation(): never {
  throw new ExternalTriggerOnlyError();
}
