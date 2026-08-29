import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(32),
  LOGIN_ORIGIN: z.string().url().default("http://localhost:3030"),
  PLATOS_AGENT_API_URL: z.string().url().default("http://localhost:3100"),
  // Authenticates server-to-server dashboard requests to the Agent. It is
  // never exposed to the browser and is distinct from an Environment API key.
  // WIN-293 — REQUIRED. This token is the trust anchor for the webapp→agent
  // control-plane path: the agent's ScopeGuard grants "operator" over the
  // direct-header channel only for callers that present it. Fail fast at boot
  // if unset so a running install can never silently fall back to an
  // unauthenticated operator grant.
  PLATOS_INTERNAL_AUTH_TOKEN: z.string().min(16),
  // WIN-293 clause 4 — workload-identity signing material. Optional so the
  // migration (and rollback) stays safe: without them the legacy shared secret
  // still carries the request. Never logged.
  PLATOS_WORKLOAD_PRIVATE_KEY: z.string().optional(),
  PLATOS_WORKLOAD_KEY_ID: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().default("Platos <no-reply@platos.dev>"),
  BACKDOOR_PLATOS_DEV: z.string().optional(),
  BACKDOOR_PLATOS_DEV_EMAIL: z.string().email().optional(),
  PLATOS_TEST_MODE: z.string().optional(),
}).superRefine((data, ctx) => {
  // WIN-293 — the webapp SENDS this token to the agent, so a webapp running the
  // public `.env.example` placeholder leaks the operator credential regardless
  // of which agent it points at. Reject the placeholder in production, matching
  // the agent's own sentinel check.
  if (
    data.NODE_ENV === "production" &&
    data.PLATOS_INTERNAL_AUTH_TOKEN ===
      "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["PLATOS_INTERNAL_AUTH_TOKEN"],
      message:
        "PLATOS_INTERNAL_AUTH_TOKEN is the .env.example sentinel value — rotate before going to production",
    });
  }
});

export const env = schema.parse(process.env);
