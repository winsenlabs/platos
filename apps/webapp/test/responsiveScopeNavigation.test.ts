import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createRemixStub } from "@remix-run/testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const organization = { id: "org_1", name: "Winsen Labs", slug: "winsen-labs" };
const project = {
  id: "project_1",
  name: "Credential Cutover",
  slug: "credential-cutover",
  environments: [
    { id: "development", name: "Development" },
    { id: "production", name: "Production" },
  ],
};

vi.mock("~/hooks/useOrganizations", () => ({
  useOrganizations: () => [organization],
  useOrganization: () => organization,
}));
vi.mock("~/hooks/useProject", () => ({ useProject: () => project }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => project.environments[0],
}));
vi.mock("~/components/layout/AppLayout", () => ({
  MainBody: ({ children }: { children: React.ReactNode }) => createElement("main", null, children),
}));

import Project from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";

const rootSource = readFileSync(resolve(process.cwd(), "app/root.tsx"), "utf8");
const dashboardSource = readFileSync(
  resolve(
    process.cwd(),
    "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx"
  ),
  "utf8"
);

function renderScopedProject() {
  const RemixStub = createRemixStub([
    {
      id: "scoped-project",
      path: "/orgs/:organizationSlug/projects/:projectParam",
      Component: Project,
    },
  ]);

  return renderToStaticMarkup(
    createElement(RemixStub, {
      initialEntries: ["/orgs/winsen-labs/projects/credential-cutover"],
    })
  );
}

describe("responsive scoped-project navigation", () => {
  it("uses the device width viewport in route metadata and in the error document", () => {
    const metadataFunction = rootSource.match(
      /export const meta: MetaFunction = \(\{ data \}\) => \{([\s\S]*?)\n\};\n\nexport const loader/
    )?.[1];

    expect(metadataFunction).toContain('name: "viewport"');
    expect(metadataFunction).toContain('content: "width=device-width, initial-scale=1"');
    expect(metadataFunction).not.toContain("width=1024");

    const errorBoundary = rootSource.match(
      /export function ErrorBoundary\(\) \{([\s\S]*?)\n\}\n\nexport default function App/
    )?.[1];

    expect(errorBoundary).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(errorBoundary).not.toContain("width=1024");
  });

  it("renders direct environment links in the compact navigation and preserves the desktop rail", () => {
    const html = renderScopedProject();
    const developmentPath = "/orgs/winsen-labs/projects/credential-cutover/env/development";
    const productionPath = "/orgs/winsen-labs/projects/credential-cutover/env/production";

    expect(html).toContain(`href="${developmentPath}"`);
    expect(html).toContain(`href="${productionPath}"`);
    expect(html.match(/aria-label="Scope navigation"/g)).toHaveLength(2);
    expect(html.match(new RegExp(`aria-current="page"[^>]*href="${developmentPath}"`, "g"))).toHaveLength(2);

    // The rail stays a desktop-only navigation while the compact header stays mobile-only.
    expect(html).toContain('hidden min-h-0 flex-col border-r border-grid-bright bg-background-dimmed p-3 sm:flex');
    expect(html).toContain('border-b border-grid-bright bg-background-dimmed px-3 py-2 sm:hidden');
    expect(html).toContain('grid min-h-0 grid-cols-1 overflow-hidden sm:grid-cols-[15rem_1fr]');
  });

  it("keeps the environment-switch destination within the compact viewport", () => {
    expect(dashboardSource).toContain('<PageBody className="overflow-x-hidden">');
    expect(dashboardSource).toContain('grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6');
    expect(dashboardSource).toContain('<span className="hidden sm:block">');
  });
});
