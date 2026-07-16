// End-to-end WS smoke for the Trigger-Sessions durable chat path (Phase 5).
// Connects to test.platos exactly like the dashboard chat (socket.io /agent
// namespace), sends one message to a durable agent with NO threadId, and
// expects: meta {durable:true, session:true} → token stream → done.
//
// Usage: PLATOS_SESSION_SECRET=... node scripts/ws-smoke-session.mjs
import { io } from "socket.io-client";
import crypto from "node:crypto";

const secret = process.env.PLATOS_SESSION_SECRET;
if (!secret) {
  console.error("PLATOS_SESSION_SECRET required");
  process.exit(1);
}

const scope = {
  organizationId: "cmrci93gg0009pb0jjcekjh6o",
  projectId: "cmrci97tt000cpb0jtcwm8h7s",
  environmentId: "cmrci97ty000dpb0jq01pbdac",
  userId: "cmrci21ns0004pb0jm1681sr5",
};
const AGENT_ID = "cmreyqssd0001s4018uqp4cd8"; // Ada (durable)

const now = Math.floor(Date.now() / 1000);
const payload = { ...scope, iss: "platos-platform", iat: now, exp: now + 3600 };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
const token = `${signingInput}.${sig}`;

const socket = io("wss://test.platos.dev/agent", {
  path: "/agent-io/socket.io",
  transports: ["websocket"],
  auth: { token },
});

// MULTI-TURN: the original single-message smoke missed the entire
// idle/replay failure class (turn 1 always works; turns 2+ broke). This
// smoke sends TWO messages on the same thread and asserts turn 2 streams
// fresh text (not a replay of turn 1) and reaches done.
let sawSessionMeta = false;
let turn = 1;
const turnText = { 1: "", 2: "" };
let threadId = null;
const bail = (msg, code = 1) => {
  console.log(`\n[ws-smoke] ${msg}`);
  socket.close();
  process.exit(code);
};
const timer = setTimeout(() => bail(`TIMEOUT after 240s — stuck in turn ${turn}`, 1), 240_000);

const MSG1 = "WS session smoke turn 1: in one short sentence, what is your core job?";
const MSG2 = "Turn 2 check: reply with exactly the word SECOND and nothing else.";

socket.on("connect", () => {
  console.log("[ws-smoke] connected — turn 1 (no threadId, durable agent)");
  socket.emit("message", { message: MSG1, agentId: AGENT_ID });
});
socket.on("connect_error", (e) => bail(`connect_error: ${e.message}`));
socket.on("error", (e) => console.log(`[ws-smoke] error frame: ${JSON.stringify(e).slice(0, 200)}`));
socket.on("agent_event", (ev) => {
  if (ev?.type === "meta") {
    threadId = ev.threadId ?? ev.thread_id ?? threadId;
    // Accept either durable transport: session path (ev.session) or the
    // durable-turn task path (ev.durable without session).
    if (ev.session || ev.durable) sawSessionMeta = true;
    console.log(`[ws-smoke] meta(t${turn}): durable=${ev.durable} session=${ev.session} thread=${threadId}`);
  } else if (ev?.type === "token") {
    turnText[turn] += ev.text ?? "";
    process.stdout.write(ev.text ?? "");
  } else if (ev?.type === "error") {
    console.log(`\n[ws-smoke] agent error (t${turn}): ${ev.message}`);
  } else if (ev?.type === "done") {
    console.log(`\n[ws-smoke] done(t${turn}): ${turnText[turn].length} chars`);
    if (turn === 1) {
      if (!sawSessionMeta || turnText[1].length < 5) bail(`FAIL — turn 1 bad (session=${sawSessionMeta}, chars=${turnText[1].length})`);
      turn = 2;
      console.log(`[ws-smoke] sending turn 2 on thread ${threadId}`);
      socket.emit("message", { message: MSG2, agentId: AGENT_ID, threadId });
    } else {
      clearTimeout(timer);
      const replayed = turnText[2].includes(turnText[1].slice(0, 40)) && turnText[1].length > 40;
      if (replayed) bail("FAIL — turn 2 replayed turn 1's text (cursor bug)");
      if (turnText[2].length < 2) bail("FAIL — turn 2 produced no text");
      bail(`PASS — turn2="${turnText[2].slice(0, 80)}"`, 0);
    }
  } else {
    console.log(`[ws-smoke] event(t${turn}): ${JSON.stringify(ev).slice(0, 140)}`);
  }
});
