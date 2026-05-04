import { metrics } from "@opentelemetry/api";
import { traceContext } from "@platos/core/v3";

export const otel = {
  withExternalTrace: <T>(fn: () => T): T => {
    return traceContext.withExternalTrace(fn);
  },
  metrics,
};
