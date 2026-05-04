/**
 * Minimal Node CLI using @platos/client. Streams an agent reply to
 * stdout. Theme I.11.
 *
 * Usage:
 *   export PLATOS_BASE_URL=...
 *   export PLATOS_SESSION_TOKEN=...
 *   export PLATOS_AGENT_ID=...
 *   tsx cli.ts "your prompt"
 */

import { PlatosClient, PlatosError } from "@platos/client";

async function main(): Promise<void> {
  const baseUrl = process.env.PLATOS_BASE_URL;
  const sessionToken = process.env.PLATOS_SESSION_TOKEN;
  const agentId = process.env.PLATOS_AGENT_ID;
  const prompt = process.argv.slice(2).join(" ") || "Say hello in one sentence.";

  if (!baseUrl || !sessionToken || !agentId) {
    console.error(
      "Missing env. Set PLATOS_BASE_URL, PLATOS_SESSION_TOKEN, and PLATOS_AGENT_ID.",
    );
    process.exit(1);
  }

  const client = new PlatosClient({ baseUrl, sessionToken });

  try {
    const thread = await client.threads.create(undefined, { agentId });
    process.stderr.write(`\n[thread ${thread.id}]\n`);
    for await (const event of client.threads.send(thread.id, prompt, { agentId })) {
      if (event.type === "token" && typeof (event as any).text === "string") {
        process.stdout.write((event as any).text);
      } else if (event.type === "tool_call") {
        process.stderr.write(`\n[tool → ${(event as any).name}]`);
      } else if (event.type === "reconnecting") {
        process.stderr.write(`\n[reconnecting attempt ${(event as any).attempt}]`);
      } else if (event.type === "error") {
        process.stderr.write(`\n[error] ${(event as any).message}\n`);
      } else if (event.type === "done") {
        process.stdout.write("\n");
        break;
      }
    }
  } catch (err) {
    if (err instanceof PlatosError) {
      console.error(`Platos error ${err.status}: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exit(2);
  }
}

void main();
