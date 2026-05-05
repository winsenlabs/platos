import React from "react";
import ReactDOM from "react-dom/client";
import { ChatWidget } from "../ChatWidget";

const agentId = import.meta.env.VITE_PLATOS_AGENT_ID || "agt_demo";
const baseUrl = import.meta.env.VITE_PLATOS_BASE_URL || "http://localhost:3100";
const sessionToken = import.meta.env.VITE_PLATOS_SESSION_TOKEN || "";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Platos React widget</h1>
      <p>
        Drop a chat widget into any React app via <code>@platosdev/client</code> and{" "}
        <code>@platos/react-hooks</code>.
      </p>
      <ChatWidget
        baseUrl={baseUrl}
        agentId={agentId}
        sessionToken={sessionToken}
      />
    </div>
  </React.StrictMode>,
);
