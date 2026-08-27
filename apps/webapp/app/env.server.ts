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
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().default("Platos <no-reply@platos.dev>"),
  BACKDOOR_PLATOS_DEV: z.string().optional(),
  BACKDOOR_PLATOS_DEV_EMAIL: z.string().email().optional(),
  PLATOS_TEST_MODE: z.string().optional(),
});

export const env = schema.parse(process.env);
