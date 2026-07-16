// Smoke test for the platos.chat.session durable chat worker (Phase 2′).
// Drives a session server-side via AgentChat — the same way the Platos
// gateway will in Phase 5 (client never touches Trigger).
//
// Usage: TRIGGER_SECRET_KEY=tr_prod_... node scripts/smoke-chat-session.mjs
import { AgentChat } from "@trigger.dev/sdk/chat";

const chatId = `smoke-p2-${process.env.SMOKE_ID || Math.random().toString(36).slice(2, 10)}`;

// Ada the SDR on test.platos + her existing thread (same fixture as the
// durable-turn smoke that proved the relay path).
const clientData = {
  agentId: "cmreyqssd0001s4018uqp4cd8",
  threadId: "cmrmej5e00007qx018s7oqd2b",
  scope: {
    organizationId: "cmrci93gg0009pb0jjcekjh6o",
    projectId: "cmrci97tt000cpb0jtcwm8h7s",
    environmentId: "cmrci97ty000dpb0jq01pbdac",
    userId: "cmrci21ns0004pb0jm1681sr5",
  },
};

const chat = new AgentChat({
  agent: "platos.chat.session",
  id: chatId,
  clientData,
  onTriggered: ({ runId }) => console.log(`[smoke] session run triggered: ${runId}`),
});

console.log(`[smoke] chatId=${chatId} — sending message…`);
const stream = await chat.sendMessage(
  "Durable-session smoke test: in one short sentence, what is your core job?",
);

let chunks = 0;
let dataEvents = 0;
let text = "";
for await (const part of stream) {
  chunks++;
  if (part?.type === "data-platos-event") dataEvents++;
  if (part?.type === "text-delta") {
    text += part.delta ?? "";
    process.stdout.write(part.delta ?? "");
  } else console.log(`[chunk] ${JSON.stringify(part).slice(0, 300)}`);
}
console.log(`\n[smoke] stream ended: ${chunks} chunks, ${dataEvents} platos data events, ${text.length} text chars`);

// Assert on the streamed deltas — that's what the Phase-5 proxy-bridge
// consumes. (stream.result().text is not populated for customAgent relays.)
if (text.length < 5) {
  console.error("[smoke] FAIL — no streamed text");
  process.exit(1);
}
console.log("[smoke] PASS");
process.exit(0);
