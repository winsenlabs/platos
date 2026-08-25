// @vitest-environment jsdom

import { json } from "@remix-run/node";
import { createRemixStub } from "@remix-run/testing";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { M4Surface, type SurfaceData } from "../app/components/platos/M4Surface";
import { Button } from "../app/components/platos/ProductPrimitives";
import ApiKeysRoute from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route";
import ProvidersRoute from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route";

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount();
  document.body.replaceChildren();
});

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  flushSync(() => root.render(element));
  return container;
}

async function findButton(container: HTMLElement, text: string) {
  for (let retry = 0; retry < 50; retry += 1) {
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === text);
    if (button) return button;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

function captureNativeSubmission(button: HTMLButtonElement) {
  const form = button.closest("form");
  if (!form) throw new Error("Expected submit control to belong to a form");
  const submitted = new Promise<SubmitEvent>((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      resolve(event as SubmitEvent);
    }, { once: true });
  });
  return { form, submitted };
}

describe("shared Button form semantics", () => {
  it("keeps non-submit controls safe by default", async () => {
    const container = await mount(<form><Button>Navigate</Button></form>);
    expect(container.querySelector("button")?.type).toBe("button");
  });

  it("submits the provider Link fetcher form with its named intent", async () => {
    const Stub = createRemixStub([{
      path: "/",
      Component: ProvidersRoute,
      loader: () => json({
        providers: {
          ok: true,
          data: {
            providers: [{
              id: "openai",
              displayName: "OpenAI",
              linked: false,
              enabled: true,
              envReady: true,
              models: ["openai:gpt-4.1"],
            }],
          },
        },
        keys: { ok: true, data: { keys: [] } },
        models: { ok: true, data: [] },
      }),
    }]);
    const container = await mount(<Stub initialEntries={["/"]} />);
    const link = await findButton(container, "Link");

    expect(link).toBeDefined();
    expect(link?.type).toBe("submit");
    expect(link?.closest("form")?.method).toBe("post");
    const capture = captureNativeSubmission(link!);
    link?.click();

    const event = await capture.submitted;
    expect(event.submitter).toBe(link);
    expect(link?.name).toBe("intent");
    expect(link?.value).toBe("link");
    expect(new FormData(capture.form).get("provider")).toBe("openai");
  });

  it("submits Agent Create through its fetcher form", async () => {
    const data: SurfaceData = {
      surface: "agent-create",
      title: "Create Agent",
      description: "Create",
      panel: {
        ok: true,
        data: {
          providers: [{
            id: "openai",
            displayName: "OpenAI",
            linked: true,
            enabled: true,
            envReady: true,
            models: ["openai:gpt-4.1"],
          }],
        },
      },
      secondary: {
        ok: true,
        data: { blocks: [{ type: "system", label: "Identity", content: "Canonical prompt" }] },
      },
    };
    const Stub = createRemixStub([{
      path: "/",
      Component: () => <M4Surface data={data} />,
    }]);
    const container = await mount(<Stub initialEntries={["/"]} />);
    const create = await findButton(container, "Create Agent");

    expect(create).toBeDefined();
    expect(create?.type).toBe("submit");
    expect(create?.closest("form")?.method).toBe("post");
    const capture = captureNativeSubmission(create!);
    create?.click();

    const event = await capture.submitted;
    expect(event.submitter).toBe(create);
    const form = new FormData(capture.form);
    expect(form.get("name")).toBe("support-agent");
    expect(form.get("model")).toBe("openai:gpt-4.1");
  });

  it("blocks AccessKey rotation and revoke before submission when confirmation is declined", async () => {
    const action = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const Stub = createRemixStub([{
      path: "/",
      Component: ApiKeysRoute,
      loader: () => json({
        panel: {
          ok: true,
          data: {
            key: { id: "key-1", keyPrefix: "platos_live_active", createdAt: "2026-08-25T00:00:00.000Z" },
            retiringKey: null,
          },
        },
      }),
      action,
    }]);
    const container = await mount(<Stub initialEntries={["/"]} />);
    const rotate = await findButton(container, "Rotate key");
    const revoke = await findButton(container, "Revoke");

    rotate?.click();
    revoke?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
  });

  it("blocks Postman template deletion before submission when confirmation is declined", async () => {
    const action = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const data: SurfaceData = {
      surface: "postman",
      title: "Postman templates",
      description: "Debug templates",
      panel: {
        ok: true,
        data: {
          templates: [{
            id: "template-1",
            name: "Support flow",
            simulateUserId: "user-1",
            sessionContext: {},
            isDefault: false,
          }],
          pagination: { total: 1 },
        },
      },
    };
    const Stub = createRemixStub([{
      path: "/",
      Component: () => <M4Surface data={data} />,
      action,
    }]);
    const container = await mount(<Stub initialEntries={["/"]} />);
    const remove = await findButton(container, "Delete");

    remove?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(confirm).toHaveBeenCalledWith("Delete Support flow?");
    expect(action).not.toHaveBeenCalled();
  });
});
