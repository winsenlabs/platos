/**
 * Theme S.11 — Skill authoring UI (`/skills/new`).
 *
 * Minimal markdown editor + live preview. The form POSTs the raw source to
 * the agent service which parses it via the shared parser (same path as the
 * claude.ai URL importer). On success we redirect back to the library.
 */
import { useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useNavigation,
  type MetaFunction,
} from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "New Skill | Platos" }];

const STARTER_TEMPLATE = `---
id: mycompany.my_skill
name: My Skill
description: One-line summary that the picker shows.
version: 0.1.0
author: You
tags:
  - custom
required_env:
  - MY_SKILL_API_KEY
provides_tools:
  - name: my_tool
    description: What the tool does.
    inputSchema: {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
---

Describe when to use this skill and how to call its tools. This markdown
block is spliced into the agent's system prompt at runtime.
`;

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

async function scopeFromRequest(request: Request, params: Record<string, string | undefined>) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });
  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  const listPath = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { id: envParam },
  )}/skills`;
  return { scope, listPath };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { listPath } = await scopeFromRequest(request, params);
  return typedjson({ listPath, starter: STARTER_TEMPLATE });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { scope, listPath } = await scopeFromRequest(request, params);
  const formData = await request.formData();
  const source = String(formData.get("source") ?? "").trim();
  if (!source) return typedjson({ error: "Source is required" }, { status: 400 });

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const res = await fetch(`${AGENT_API_URL}/api/v1/agent/skills`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
    },
    body: JSON.stringify({ source, origin: "custom" }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Agent service error" }));
    return typedjson(
      { error: (body as any).error ?? "Failed to register skill" },
      { status: 400 },
    );
  }
  return redirect(listPath);
}

export default function NewSkill() {
  const { listPath, starter } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const [source, setSource] = useState(starter);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="New skill" />
        <div className="ml-auto flex items-center gap-2">
          <DocsLink slug="import-claude-skill" kind="guides" label="Guide" />
          <LinkButton variant="tertiary/small" to={listPath}>
            Cancel
          </LinkButton>
        </div>
      </NavBar>
      <PageBody>
        <Paragraph variant="small" className="mb-4">
          Skills are Claude-skills-format markdown files. The YAML frontmatter declares the
          manifest (id, required env vars, provided tools); the body below <code>---</code> is
          the prompt block spliced into the agent&apos;s system prompt.
        </Paragraph>
        <Form method="post" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Header3>Source</Header3>
              <textarea
                name="source"
                rows={24}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="mt-2 w-full rounded-md border border-grid-dimmed bg-background-dimmed p-3 font-mono text-xs leading-relaxed"
                spellCheck={false}
              />
            </div>
            <div>
              <Header3>Preview</Header3>
              <pre className="mt-2 max-h-[500px] overflow-auto whitespace-pre-wrap rounded-md border border-grid-dimmed bg-background p-3 font-mono text-xs leading-relaxed">
                {source}
              </pre>
            </div>
          </div>
          {actionData && typeof actionData === "object" && "error" in actionData ? (
            <div className="rounded border border-error/40 bg-error/10 p-3 text-sm text-error">
              {String((actionData as { error: unknown }).error)}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Link to={listPath}>
              <Button variant="tertiary/small" type="button">
                Cancel
              </Button>
            </Link>
            <Button variant="primary/small" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save skill"}
            </Button>
          </div>
        </Form>
      </PageBody>
    </PageContainer>
  );
}
