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

// ---------------------------------------------------------------------------
// WIN-270 (M4.4) — WHAT THIS PACKAGE REFUSES, AND WHAT IT DOES NOT OWN.
//
// `<platos-agent>` makes NO authenticated request of its own: it renders an
// iframe at `{base-url}/embed/{agentId}` and forwards `tokenUrl` to it as a
// query parameter, so the unauthenticated-caller path belongs to the page inside
// the frame and to `@platosdev/react-widget`'s token mint, which has its own
// coded-refusal cases. Claiming an unauthenticated proof here would be claiming
// a call this package does not make.
//
// What it DOES own is the refusal above: without both required attributes there
// is no destination, and the component must refuse rather than render a frame
// pointed somewhere it guessed. These cases hold that refusal to being total —
// no iframe in the tree AND no live handle behind it.
// ---------------------------------------------------------------------------

describe("<platos-agent> refuses totally, never partially", () => {
  it("renders no iframe at all when a required attribute is missing", () => {
    const element = document.createElement("platos-agent");
    element.setAttribute("base-url", "https://platos.example.com");
    document.body.append(element);
    expect(element.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(element.shadowRoot?.textContent).toContain("missing required attribute");
  });

  it("drops the iframe handle when a rendered element loses its agent-id", () => {
    const element = document.createElement("platos-agent");
    element.setAttribute("base-url", "https://platos.example.com");
    element.setAttribute("agent-id", "agent_1");
    document.body.append(element);
    expect(element.shadowRoot?.querySelector("iframe")).not.toBeNull();

    element.removeAttribute("agent-id");
    expect(element.shadowRoot?.querySelector("iframe")).toBeNull();
    // The handle the postMessage trust check consults, read through the same
    // public surface a host page has.
    expect((element as unknown as { iframe: unknown }).iframe).toBeNull();
  });

  it("ignores a resize from any window once the frame is gone", () => {
    const element = document.createElement("platos-agent") as HTMLElement;
    element.setAttribute("base-url", "https://platos.example.com");
    element.setAttribute("agent-id", "agent_1");
    document.body.append(element);
    element.removeAttribute("agent-id");

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "platos-agent-resize", height: 800 },
      source: window,
    }));
    expect(element.style.height).toBe("");
  });
});
