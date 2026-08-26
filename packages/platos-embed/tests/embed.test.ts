// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import "../src/embed.js";

describe("<platos-agent> host contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("registers the element and renders missing-attribute guidance", () => {
    expect(customElements.get("platos-agent")).toBeDefined();
    const element = document.createElement("platos-agent");
    document.body.append(element);
    expect(element.shadowRoot?.textContent).toContain("missing required attribute");
  });

  it("builds the iframe URL and applies attribute updates", () => {
    const element = document.createElement("platos-agent");
    element.setAttribute("base-url", "https://platos.example.com/root");
    element.setAttribute("agent-id", "agent/1");
    element.setAttribute("theme", "dark");
    element.setAttribute("token-url", "/api/token");
    document.body.append(element);

    const iframe = element.shadowRoot?.querySelector("iframe")!;
    const src = new URL(iframe.src);
    expect(src.pathname).toBe("/embed/agent%2F1");
    expect(src.searchParams.get("theme")).toBe("dark");
    expect(src.searchParams.get("tokenUrl")).toBe("/api/token");

    element.setAttribute("agent-id", "agent_2");
    expect(new URL(element.shadowRoot?.querySelector("iframe")!.src ?? "").pathname)
      .toBe("/embed/agent_2");
  });

  it("accepts resize events only from its iframe and clamps height", () => {
    const element = document.createElement("platos-agent") as HTMLElement;
    element.setAttribute("base-url", "https://platos.example.com");
    element.setAttribute("agent-id", "agent_1");
    document.body.append(element);
    const iframe = element.shadowRoot?.querySelector("iframe")!;

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "platos-agent-resize", height: 5000 },
      source: window,
    }));
    expect(element.style.height).toBe("");

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "platos-agent-resize", height: 5000 },
      source: iframe.contentWindow,
    }));
    expect(element.style.height).toBe("1200px");
  });
});
