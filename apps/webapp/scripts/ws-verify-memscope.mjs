import { io } from "socket.io-client";
import crypto from "node:crypto";
const secret = process.env.PLATOS_SESSION_SECRET;
const scope = {
  organizationId: "cmrci93gg0009pb0jjcekjh6o",
  projectId: "cmrci97tt000cpb0jtcwm8h7s",
  environmentId: "cmrci97ty000dpb0jq01pbdac",
  userId: "cmrci21ns0004pb0jm1681sr5",
};
const MARK = "cmrd8he3n0003sd01gda2cpgg";
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const si = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ ...scope, iss: "platos-platform", iat: now, exp: now + 3600 })}`;
const token = `${si}.${crypto.createHmac("sha256", secret).update(si).digest("base64url")}`;
const socket = io("wss://test.platos.dev/agent", { path: "/agent-io/socket.io", transports: ["websocket"], auth: { token } });
let text = "";
const bail = (m, c = 1) => { console.log(`\n[verify] ${m}`); socket.close(); process.exit(c); };
setTimeout(() => bail("TIMEOUT"), 180_000);
socket.on("connect", () => socket.emit("message", {
  message: "Before we start: tell me honestly, what background context or memories do you have about me or my projects?",
  agentId: MARK,
}));
socket.on("agent_event", (ev) => {
  if (ev?.type === "token") { text += ev.text ?? ""; process.stdout.write(ev.text ?? ""); }
  else if (ev?.type === "done") {
    const leaked = /pulsegrid|outreach|cold.?email|sdr|prospect/i.test(text);
    bail(leaked ? "FAIL — Ada context still leaking" : "PASS — no cross-agent context", leaked ? 1 : 0);
  }
});
