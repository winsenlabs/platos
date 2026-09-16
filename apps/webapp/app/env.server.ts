import { z } from "zod";

// WHAT THE DASHBOARD IS ALLOWED TO KNOW, AFTER T8.
//
// This schema used to open with `DATABASE_URL` and `ENCRYPTION_KEY`, and those
// two lines were the whole of the coupling T8 exists to remove: the first put a
// PostgreSQL superuser DSN in the process that renders HTML to a browser, the
// second put the credential-sealing root beside it. Neither has a reader left —
// `app/services/database.server.ts` and the `PlatosAuthService` it constructed
// are deleted — so both are GONE FROM THE SCHEMA, not merely unused. A variable
// a Zod schema still demands is a variable every deployment still has to supply,
// and a webapp that still demands a database password is one an operator will
// still give a database password.
//
// `LOGIN_ORIGIN`, `RESEND_API_KEY`, `FROM_EMAIL`, `BACKDOOR_PLATOS_DEV`,
// `BACKDOOR_PLATOS_DEV_EMAIL` and `PLATOS_TEST_MODE` go with them, and each for a
// reason rather than as tidying:
//
//   LOGIN_ORIGIN / RESEND_API_KEY / FROM_EMAIL  D20 moved the magic-link email to
//     core-api's notifier-email adapter, which composes the link from
//     `PLATOS_CHANNELS_EMAIL_LOGIN_URL` and sends it through the configured
//     relay. The webapp no longer builds a link and no longer sends mail, so
//     holding a mail-provider API key would be holding a credential for a job it
//     does not do.
//   BACKDOOR_PLATOS_DEV / _EMAIL / PLATOS_TEST_MODE  they gated the login
//     action's direct sign-in, which worked only because the BFF held a
//     login-capable token. D20 says it never receives one. `bff/magic-link.
//     controller.ts` records the divergence in full and asks T8 to say so when it
//     deletes the action; this is T8 saying so. A local sign-in without SMTP is
//     now a relay (Mailpit) plus the link from its API, which is what
//     `composition/identity-tenancy-rest.integration.test.ts` already does.

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PLATOS_AGENT_API_URL: z.string().url().default("http://localhost:3100"),
  // T8 — THE CORE BASE URL, AND WHY IT IS NOT `PLATOS_AGENT_API_URL`.
  //
  // `PLATOS_AGENT_API_URL` means exactly one thing today: the legacy agent
  // process, at `agent:3100` inside compose, reached DIRECTLY and not through
  // Caddy. The cutover adds a second upstream with a different identity — the V1
  // composition root, `core-api:3030` inside compose — and widening the agent
  // variable to mean "whichever of the two serves this path" would make the one
  // knob that says where the dashboard's data comes from unreadable, and would
  // silently re-point every legacy route the first time a deployment set it to
  // core-api.
  //
  // So the core base URL is its own variable, with its own default matching the
  // loopback host port `docker-compose.platos.yml` publishes for the `core-api`
  // profile. `app/services/coreApi.server.ts` is its only reader, and the
  // operation table in that file is the only place a core path is written.
  PLATOS_CORE_API_URL: z.string().url().default("http://localhost:3200"),
  // Authenticates server-to-server dashboard requests to the Agent. It is
  // never exposed to the browser and is distinct from an Environment API key.
  // WIN-293 — REQUIRED. This token is the trust anchor for the webapp→agent
  // control-plane path: the agent's ScopeGuard grants "operator" over the
  // direct-header channel only for callers that present it. Fail fast at boot
  // if unset so a running install can never silently fall back to an
  // unauthenticated operator grant.
  //
  // IT IS NOT SENT TO CORE-API. The core client forwards the OPERATOR'S OWN
  // session cookie and nothing else: every V1 route the dashboard calls
  // authenticates that operator and authorizes the scope from it, so a
  // service-to-service secret there would be a second, weaker way in.
  PLATOS_INTERNAL_AUTH_TOKEN: z.string().min(16),
  // WIN-293 clause 4 — workload-identity signing material. Optional so the
  // migration (and rollback) stays safe: without them the legacy shared secret
  // still carries the request. Never logged.
  PLATOS_WORKLOAD_PRIVATE_KEY: z.string().optional(),
  PLATOS_WORKLOAD_KEY_ID: z.string().optional(),
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
