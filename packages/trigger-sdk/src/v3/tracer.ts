import { TriggerTracer } from "@platos/core/v3/tracer";
import { VERSION } from "../version.js";

export const tracer = new TriggerTracer({ name: "@platos/sdk", version: VERSION });
