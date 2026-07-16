// Probe the server-side continuation mechanism: after turn 1's run COMPLETES,
// does the session row reflect it, and does a second append re-trigger a run?
// Usage: TRIGGER_SECRET_KEY=tr_prod_... node scripts/probe-session-continuation.mjs
import { AgentChat } from "@trigger.dev/sdk/chat";
import { sessions, runs } from "@trigger.dev/sdk";

const chatId = `probe-${Math.random().toString(36).slice(2, 10)}`;
const clientData = {
  agentId: "cmreyqssd0001s4018uqp4cd8",
  threadId: "cmrmej5e00007qx018s7oqd2b", // Ada's existing thread (avoid orphan threads)
  scope: {
    organizationId: "cmrci93gg0009pb0jjcekjh6o",
    projectId: "cmrci97tt000cpb0jtcwm8h7s",
    environmentId: "cmrci97ty000dpb0jq01pbdac",
    userId: "cmrci21ns0004pb0jm1681sr5",
  },
};

const dump = async (label) => {
  try {
    const s = await sessions.retrieve(chatId);
    console.log(`[${label}] session:`, JSON.stringify({
      id: s?.id, status: s?.status, currentRunId: s?.currentRunId ?? s?.runId,
      externalId: s?.externalId, closedAt: s?.closedAt,
    }));
  } catch (e) {
    console.log(`[${label}] sessions.retrieve failed: ${e?.message}`);
  }
};

const chat1 = new AgentChat({ agent: "platos.chat.session", id: chatId, clientData,
  onTriggered: ({ runId }) => console.log(`[t1] triggered run: ${runId}`),
  onTurnComplete: (info) => console.log(`[t1] onTurnComplete:`, JSON.stringify(info)),
});
console.log(`[probe] chatId=${chatId} — turn 1…`);
const s1 = await chat1.sendMessage("Probe turn 1: reply with the word ONE only.");
let t1 = "";
for await (const p of s1) if (p?.type === "text-delta") t1 += p.delta ?? "";
console.log(`[t1] text: "${t1.slice(0, 60)}" | session state:`, JSON.stringify(chat1.session));

await dump("after-t1");
await new Promise((r) => setTimeout(r, 8000)); // let the run fully COMPLETE
await dump("after-t1+8s");

// Turn 2 with a FRESH client carrying the cursor from client 1.
const chat2 = new AgentChat({ agent: "platos.chat.session", id: chatId, clientData,
  session: chat1.session?.lastEventId ? { lastEventId: chat1.session.lastEventId } : undefined,
  onTriggered: ({ runId }) => console.log(`[t2] triggered run: ${runId}`),
});
console.log(`[probe] turn 2 (fresh client, cursor=${chat1.session?.lastEventId ?? "none"})…`);
const s2 = await chat2.sendMessage("Probe turn 2: reply with the word TWO only.");
let t2 = "";
const timeout = setTimeout(() => { console.log("[t2] 90s timeout"); process.exit(2); }, 90_000);
for await (const p of s2) {
  if (p?.type === "text-delta") t2 += p.delta ?? "";
}
clearTimeout(timeout);
console.log(`[t2] text: "${t2.slice(0, 60)}"`);
await dump("after-t2");
const recent = [];
for await (const r of runs.list({ limit: 6 })) { recent.push(`${r.id} ${r.status} ${r.taskIdentifier}`); if (recent.length >= 6) break; }
console.log("[runs]", recent.filter((x) => x.includes("chat.session")).join(" | "));
console.log(t2.length > 0 ? "[probe] PASS — turn 2 answered" : "[probe] FAIL — turn 2 empty");
