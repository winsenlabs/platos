/**
 * Theme S.4 — `/skills` library UI.
 *
 * Browse official + community + custom skills registered in the current
 * (org, project, env). Filter by tag, preview manifest, import from a URL
 * (claude.ai skill library, raw github, or gist).
 *
 * The skill CRUD lives on the agent service at `/api/v1/agent/skills`.
 */
import {
  BookOpenIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ArrowDownTrayIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, Link, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Skills | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

export type SkillRecord = {
  id: string;
  skillId: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  origin: string;
  isOfficial: boolean;
  tags: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  envReady: boolean | null;
  envSetMap: Record<string, boolean>;
  importedFrom: string | null;
};

function scopeHeaders(scope: Scope) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

async function agentFetch<T>(
  path: string,
  scope: Scope,
  opts?: { method?: string; body?: unknown },
): Promise<T | null> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method || "GET",
      headers: scopeHeaders(scope),
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const data = await agentFetch<{ skills: SkillRecord[] }>("/api/v1/agent/skills", scope);
  const envVarsPath = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
  )}/environment-variables`;

  return typedjson({
    skills: data?.skills ?? [],
    agentReachable: !!data,
    envVarsPath,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return typedjson({ error: "Project not found" }, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return typedjson({ error: "Environment not found" }, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "import") {
    const url = String(formData.get("url") ?? "").trim();
    if (!url) return typedjson({ error: "URL is required" }, { status: 400 });
    const result = await agentFetch<{ skill?: SkillRecord; error?: string }>(
      "/api/v1/agent/skills/import",
      scope,
      { method: "POST", body: { url } },
    );
    if (!result) return typedjson({ error: "Agent service unreachable" }, { status: 502 });
    if (result.error) return typedjson({ error: result.error }, { status: 400 });
    return typedjson({ ok: true });
  }

  if (intent === "delete") {
    const id = String(formData.get("skillId") ?? "");
    if (!id) return typedjson({ error: "Missing skill id" }, { status: 400 });
    await agentFetch(`/api/v1/agent/skills/${id}`, scope, { method: "DELETE" });
    return typedjson({ ok: true });
  }

  return typedjson({ error: "Unknown intent" }, { status: 400 });
}

export default function SkillsLibrary() {
  const { skills, agentReachable, envVarsPath } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const official = skills.filter((s) => s.isOfficial);
  const community = skills.filter((s) => !s.isOfficial && s.origin === "community");
  const custom = skills.filter((s) => !s.isOfficial && s.origin === "custom");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Skills" />
        <div className="ml-auto flex items-center gap-2">
          <DocsLink slug="skills" />
          <LinkButton variant="primary/small" to="../skills/new" LeadingIcon={PlusIcon}>
            New skill
          </LinkButton>
        </div>
      </NavBar>
      <PageBody>
        {!agentReachable ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4">
            <Paragraph>
              The agent service is unreachable. Skills will appear here once it comes back online.
            </Paragraph>
          </div>
        ) : null}

        <section className="space-y-4">
          <Header3>Import a skill</Header3>
          <Paragraph variant="small">
            Paste a claude.ai skill library URL, a raw GitHub link, or a gist URL. We fetch the
            manifest, parse it, and register it in this environment.
          </Paragraph>
          <Form method="post" className="flex gap-2 items-center">
            <input type="hidden" name="intent" value="import" />
            <Input
              name="url"
              placeholder="https://claude.ai/skills/web-search or https://github.com/…/skill.md"
              className="flex-1"
            />
            <Button variant="primary/small" type="submit" disabled={isSubmitting} LeadingIcon={ArrowDownTrayIcon}>
              {isSubmitting ? "Importing…" : "Import"}
            </Button>
          </Form>
        </section>

        <Section title="Official skills" skills={official} envVarsPath={envVarsPath} canDelete={false} />
        <Section title="Community skills" skills={community} envVarsPath={envVarsPath} canDelete={true} />
        <Section title="Custom skills" skills={custom} envVarsPath={envVarsPath} canDelete={true} />
      </PageBody>
    </PageContainer>
  );
}

function Section({
  title,
  skills,
  envVarsPath,
  canDelete,
}: {
  title: string;
  skills: SkillRecord[];
  envVarsPath: string;
  canDelete: boolean;
}) {
  return (
    <section className="mt-6 space-y-3">
      <Header3>{title}</Header3>
      {skills.length === 0 ? (
        <Paragraph variant="small" className="text-text-dimmed">
          No {title.toLowerCase()} yet.
        </Paragraph>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              envVarsPath={envVarsPath}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillCard({
  skill,
  envVarsPath,
  canDelete,
}: {
  skill: SkillRecord;
  envVarsPath: string;
  canDelete: boolean;
}) {
  const missing = skill.requiredEnv.filter((k) => !skill.envSetMap[k]);
  return (
    <div className="rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpenIcon className="h-4 w-4 text-text-dimmed" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{skill.name}</span>
              <Badge variant="small">v{skill.version}</Badge>
              {skill.isOfficial ? <Badge variant="small">official</Badge> : null}
            </div>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              {skill.skillId}
              {skill.author ? ` · by ${skill.author}` : ""}
            </Paragraph>
          </div>
        </div>
        {skill.envReady ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircleIcon className="h-4 w-4" /> env ready
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-warning">
            <ExclamationTriangleIcon className="h-4 w-4" /> missing env
          </span>
        )}
      </div>
      <Paragraph variant="small" className="mt-2">
        {skill.description}
      </Paragraph>
      {skill.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {skill.tags.map((t) => (
            <Badge key={t} variant="small">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}
      {missing.length > 0 ? (
        <div className="mt-3 rounded border border-warning/30 bg-warning/10 p-2 text-xs">
          Missing env vars: <code>{missing.join(", ")}</code>.
          {" "}
          <Link className="underline" to={envVarsPath}>
            Link env
          </Link>
        </div>
      ) : null}
      {canDelete ? (
        <div className="mt-3 flex justify-end">
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="skillId" value={skill.id} />
            <Button variant="tertiary/small" type="submit" LeadingIcon={TrashIcon}>
              Remove
            </Button>
          </Form>
        </div>
      ) : null}
    </div>
  );
}
