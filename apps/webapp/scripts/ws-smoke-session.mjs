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

let sawSessionMeta = false;
let text = "";
let threadId = null;
const bail = (msg, code = 1) => {
  console.log(`\n[ws-smoke] ${msg}`);
  socket.close();
  process.exit(code);
};
const timer = setTimeout(() => bail("TIMEOUT after 150s — no done event", 1), 150_000);

socket.on("connect", () => {
  console.log("[ws-smoke] connected — sending message (no threadId, durable agent)");
  socket.emit("message", {
    message: "WS session smoke: in one short sentence, what is your core job?",
    agentId: AGENT_ID,
  });
});
socket.on("connect_error", (e) => bail(`connect_error: ${e.message}`));
socket.on("error", (e) => console.log(`[ws-smoke] error frame: ${JSON.stringify(e).slice(0, 200)}`));
socket.on("agent_event", (ev) => {
  if (ev?.type === "meta") {
    threadId = ev.threadId ?? ev.thread_id ?? threadId;
    if (ev.session) sawSessionMeta = true;
    console.log(`[ws-smoke] meta: durable=${ev.durable} session=${ev.session} thread=${threadId}`);
  } else if (ev?.type === "token") {
    text += ev.text ?? "";
    process.stdout.write(ev.text ?? "");
  } else if (ev?.type === "error") {
    console.log(`\n[ws-smoke] agent error: ${ev.message}`);
  } else if (ev?.type === "done") {
    clearTimeout(timer);
    console.log(`\n[ws-smoke] done. sessionMeta=${sawSessionMeta} textChars=${text.length}`);
    if (sawSessionMeta && text.length > 5) bail("PASS", 0);
    bail(`FAIL — sessionMeta=${sawSessionMeta} textChars=${text.length}`);
  } else {
    console.log(`[ws-smoke] event: ${JSON.stringify(ev).slice(0, 160)}`);
  }
});
