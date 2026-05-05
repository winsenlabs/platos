/**
 * Reference entity backend (PPR-49).
 *
 * This is the minimal thing Platos operators need to prove the
 * platools → agent pipeline is wired up end-to-end. It registers ONE
 * tool — `echo({ message }) → { echoed, at }` — and runs forever,
 * reconnecting on drops.
 *
 * Copy this directory into your own repo as a starting point; the
 * real tools (CRM, payments, internal APIs) slot in with more
 * `platools.tool({...}, handler)` calls. The WS transport, HMAC
 * signing, reconnect backoff, schema marshaling, and context
 * propagation are all handled by `@platosdev/platools-sdk`.
 *
 * Required env:
 *   PLATOS_URL    — WS endpoint of the Platos agent, e.g.
 *                   `ws://localhost:3100/tools/sync` in local dev or
 *                   `wss://platos.example.com/tools/sync` in prod.
 *   PLATOS_SECRET — the service secret displayed ONCE on the
 *                   `/agent-entities/new` screen in the dashboard.
 *
 * See ../README.md for the full setup walkthrough.
 */

import { Platools, currentUserId, currentScope } from "@platosdev/platools-sdk";
import { z } from "zod";

const platools = new Platools({
  url: process.env.PLATOS_URL,
  secret: process.env.PLATOS_SECRET,
});

// The one canonical tool. `echo` is the simplest possible shape — it
// proves the wire (agent → entity → agent) end-to-end without
// depending on any external service. Real tools replace the body with
// a call into your CRM / DB / API.
platools.tool(
  {
    name: "echo",
    description:
      "Return the input message along with an ISO timestamp. Useful as a wire-level " +
      "health check for the Platos tool-gateway.",
    input: z.object({
      message: z.string().describe("Free-text message to echo back."),
    }),
    output: z.object({
      echoed: z.string().describe("The message you sent in."),
      at: z.string().datetime().describe("Server-side ISO-8601 timestamp."),
    }),
    auth: "none",
  },
  async ({ message }) => {
    // Demonstrate the context API — these values come from the
    // `__platos` envelope the agent pops before dispatching to us.
    // They're optional (the echo tool has `auth: "none"` so the
    // platform may not forward a userId on every call), which is why
    // we defensively render `?? "<unknown>"`.
    const userId = currentUserId() ?? "<unknown>";
    const { organizationId, projectId, environmentId } = currentScope();
    console.log(
      `[entity-hello-world] echo called — user=${userId} scope=${organizationId}/${projectId}/${environmentId}`,
    );
    return {
      echoed: message,
      at: new Date().toISOString(),
    };
  },
);

async function main(): Promise<void> {
  if (!process.env.PLATOS_URL || !process.env.PLATOS_SECRET) {
    console.error(
      "[entity-hello-world] missing PLATOS_URL or PLATOS_SECRET — copy .env.example to .env and fill them in before starting.",
    );
    process.exit(1);
  }
  console.log(
    `[entity-hello-world] connecting to ${process.env.PLATOS_URL} …`,
  );
  // `connect()` runs forever, reconnecting with exponential backoff on
  // network drops and re-syncing all registered tools on each attempt.
  await platools.connect();
}

main().catch((err) => {
  console.error("[entity-hello-world] fatal:", err);
  process.exit(1);
});
