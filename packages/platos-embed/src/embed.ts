/**
 * `<platos-agent>` — drop-in chatbot web component for public Platos agents.
 *
 * Usage (plain HTML page, no build step):
 *
 *   <script src="https://platos.example.com/embed/v1.js"></script>
 *   <platos-agent
 *     base-url="https://platos.example.com"
 *     agent-id="agt_demo123"
 *     theme="light"
 *     token-url="/api/platos-guest-token"></platos-agent>
 *
 * Attributes:
 *   - `base-url`   (required) — the Platos deployment.
 *   - `agent-id`   (required) — public agent id (only `visibility: "public-guest"` agents accept anonymous traffic).
 *   - `theme`      ("light" | "dark" | "auto") — defaults to `auto`.
 *   - `token-url`  (optional) — server endpoint minting guest session tokens. When omitted, the component calls `{base-url}/api/v1/public/guest-token?agentId=...`.
 *
 * Isolation:
 *   The component creates a shadow root + an iframe to `{base-url}/embed/{agentId}` so the customer's page CSS + globals can't bleed into the chat UI and vice versa. The parent page only exchanges postMessage with the iframe for theme + resize.
 *
 * This single file is all the bootstrap anyone needs. Drop the tag,
 * publish the agent, done.
 *
 * EOBD.90. Minimal v0.1 — runtime stabilises once EOBD.89 ships the
 * public guest-token endpoint in the agent.
 */

const COMPONENT_NAME = "platos-agent";
const DEFAULT_HEIGHT = "600px";
const DEFAULT_WIDTH = "400px";

function resolveTheme(attr: string | null): "light" | "dark" {
  if (attr === "light" || attr === "dark") return attr;
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

class PlatosAgentElement extends HTMLElement {
  static get observedAttributes() {
    return ["base-url", "agent-id", "theme", "token-url", "height", "width"];
  }

  private shadow: ShadowRoot;
  private iframe: HTMLIFrameElement | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
    // Handle iframe-originated resize events so the embed can grow
    // with conversation length.
    window.addEventListener("message", this.onMessage);
  }

  disconnectedCallback() {
    window.removeEventListener("message", this.onMessage);
  }

  attributeChangedCallback() {
    // Cheap re-render on any attribute change; the iframe handles
    // smooth in-place theme updates via postMessage.
    if (this.isConnected) this.render();
  }

  private render() {
    const baseUrl = this.getAttribute("base-url");
    const agentId = this.getAttribute("agent-id");
    const theme = resolveTheme(this.getAttribute("theme"));
    const tokenUrl = this.getAttribute("token-url") || undefined;
    const height = this.getAttribute("height") || DEFAULT_HEIGHT;
    const width = this.getAttribute("width") || DEFAULT_WIDTH;

    if (!baseUrl || !agentId) {
      this.shadow.innerHTML = `
        <div style="color:#b91c1c;padding:8px;font:14px system-ui;">
          &lt;platos-agent&gt; missing required attribute: base-url and/or agent-id.
        </div>`;
      return;
    }

    const src = new URL(`/embed/${encodeURIComponent(agentId)}`, baseUrl);
    src.searchParams.set("theme", theme);
    if (tokenUrl) src.searchParams.set("tokenUrl", tokenUrl);

    this.shadow.innerHTML = `
      <style>
        :host {
          display: inline-block;
          box-sizing: border-box;
          width: ${width};
          height: ${height};
        }
        iframe {
          width: 100%;
          height: 100%;
          border: 0;
          border-radius: 12px;
          box-shadow: 0 2px 16px rgba(0, 0, 0, 0.08);
          background: ${theme === "dark" ? "#0a0a0a" : "#ffffff"};
        }
      </style>
      <iframe
        src="${src.toString()}"
        allow="clipboard-write"
        title="Platos agent chat"></iframe>
    `;
    this.iframe = this.shadow.querySelector("iframe");
  }

  private onMessage = (event: MessageEvent) => {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    const data = event.data as { type?: string; height?: number } | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "platos-agent-resize" && typeof data.height === "number") {
      this.style.height = `${Math.max(240, Math.min(1200, data.height))}px`;
    }
  };
}

if (typeof customElements !== "undefined" && !customElements.get(COMPONENT_NAME)) {
  customElements.define(COMPONENT_NAME, PlatosAgentElement);
}

// Expose the class for bundlers that want to register it elsewhere.
export { PlatosAgentElement };
