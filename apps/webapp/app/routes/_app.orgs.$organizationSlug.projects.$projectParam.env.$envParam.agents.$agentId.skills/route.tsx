/**
 * PIFSP-13 — Per-agent skills picker (rebuilt).
 *
 * Lists every skill visible in the scope + an "enable on agent" toggle.
 * Enablement is rejected by the agent service when any `required_env` is
 * missing (HTTP 412 → we surface a "Link env" CTA).
 * Lazy-seed runs server-side — the list endpoint triggers it.
 */
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  BookOpenIcon,
  LinkIcon,
  WrenchScrewdriverIcon,
  ArrowUpTrayIcon,
} from "@heroicons/react/20/solid";
import { Form, Link, useFetcher, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";
import { z } from "zod";
import { telemetry } from "~/services/telemetry.server";

export const meta: MetaFunction = () => [{ title: "Agent Skills | Platos" }];

const ParamSchema = EnvironmentParamSchema.extend({ agentId: z.string() });

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

type SkillRecord = {
  id: string;
  skillId: string;
  name: string;
  description: string;
  version: string;
  isOfficial: boolean;
  origin: string;
  category: string;
  requiredEnv: string[];
  optionalEnv: string[];
  envSetMap: Record<string, boolean>;
  envReady: boolean | null;
  tags: string[];
  promptBlock: string;
  providesTools: Array<{ name: string; description: string }>;
};

type AgentSkillRecord = SkillRecord & {
  agentSkillId: string;
  enabled: boolean;
  enabledAt: string;
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
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method || "GET",
      headers: scopeHeaders(scope),
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const data = res.ok ? ((await res.json()) as T) : null;
    const body = !res.ok ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, data: res.ok ? data : (body as any) };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function scopeFrom(request: Request, params: Record<string, string | undefined>) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, agentId } = ParamSchema.parse(params);
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
  return {
    scope,
    agentId,
    envVarsPath: `${v3EnvironmentPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { id: envParam },
    )}/environment-variables`,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { scope, agentId, envVarsPath } = await scopeFrom(request, params);
  const [all, enabled] = await Promise.all([
    agentFetch<{ skills: SkillRecord[] }>(`/api/v1/agent/skills`, scope),
    agentFetch<{ skills: AgentSkillRecord[] }>(`/api/v1/agent/skills/agent/${agentId}`, scope),
  ]);
  return typedjson({
    agentReachable: all.ok && enabled.ok,
    allSkills: all.data?.skills ?? [],
    enabledSkills: enabled.data?.skills ?? [],
    envVarsPath,
    agentId,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { scope, agentId } = await scopeFrom(request, params);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const skillRowId = String(formData.get("skillId") ?? "");

  if (intent === "import_url") {
    const url = String(formData.get("url") ?? "").trim();
    if (!url) return typedjson({ error: "URL is required" }, { status: 400 });
    const res = await agentFetch(`/api/v1/agent/skills/import`, scope, {
      method: "POST",
      body: { url },
    });
    if (!res.ok) {
      const body = res.data as any;
      return typedjson({ error: body?.error ?? "Import failed", reason: body?.reason }, { status: res.status || 500 });
    }
    return typedjson({ ok: true, imported: true });
  }

  if (!skillRowId) return typedjson({ error: "Missing skill id" }, { status: 400 });

  if (intent === "enable") {
    const res = await agentFetch(`/api/v1/agent/skills/agent/${agentId}/${skillRowId}`, scope, {
      method: "POST",
    });
    if (!res.ok) {
      const body = res.data as any;
      return typedjson(
        {
          error: body?.error ?? (res.status === 412 ? "Missing required env vars" : "Enable failed"),
          missing: body?.details?.missing ?? [],
          reason: body?.reason ?? null,
          status: res.status,
        },
        { status: res.status || 500 },
      );
    }
    void telemetry.platos.skillToggled({ organizationId: scope.organizationId, agentId, skillSlug: skillRowId, enabled: true });
    return typedjson({ ok: true });
  }

  if (intent === "remove") {
    await agentFetch(`/api/v1/agent/skills/agent/${agentId}/${skillRowId}`, scope, {
      method: "DELETE",
    });
    void telemetry.platos.skillToggled({ organizationId: scope.organizationId, agentId, skillSlug: skillRowId, enabled: false });
    return typedjson({ ok: true });
  }

  return typedjson({ error: "Unknown intent" }, { status: 400 });
}

export default function AgentSkills() {
  const { agentReachable, allSkills, enabledSkills, envVarsPath } =
    useTypedLoaderData<typeof loader>();
  const nav = useNavigation();
  const isSubmitting = nav.state !== "idle";
  const [showImport, setShowImport] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const enabledSet = new Set(enabledSkills.map((s) => s.id));
  const disabled = allSkills.filter((s) => !enabledSet.has(s.id));

  // Build unique category list from all skills
  const categories = Array.from(
    new Set(allSkills.map((s) => s.category ?? "uncategorized"))
  ).sort();

  const filterSkills = <T extends SkillRecord>(skills: T[]): T[] => {
    if (categoryFilter === "all") return skills;
    return skills.filter((s) => (s.category ?? "uncategorized") === categoryFilter);
  };

  return (
    <PageBody>
      {!agentReachable ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4">
          <Paragraph>Agent service is unreachable. Refresh once it&apos;s back online.</Paragraph>
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-dimmed">Category:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-xs text-text-bright focus:outline-none"
          >
            <option value="all">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 rounded border border-charcoal-600 bg-charcoal-800 px-3 py-1.5 text-xs text-text-bright hover:bg-charcoal-700"
          >
            <ArrowUpTrayIcon className="size-3.5" />
            Install from URL
          </button>
        </div>
      </div>

      {/* Import from URL modal */}
      {showImport && (
        <ImportFromUrlModal onClose={() => setShowImport(false)} />
      )}

      <Section
        title="Enabled on this agent"
        rows={filterSkills(enabledSkills).map((s) => ({ skill: s, status: "enabled" as const }))}
        emptyMessage={categoryFilter !== "all" ? "No enabled skills in this category." : "No skills enabled yet. Pick one from below."}
        envVarsPath={envVarsPath}
        isSubmitting={isSubmitting}
      />
      <Section
        title="Available"
        rows={filterSkills(disabled).map((s) => ({ skill: s, status: "available" as const }))}
        emptyMessage={categoryFilter !== "all" ? "No available skills in this category." : "You've enabled every registered skill."}
        envVarsPath={envVarsPath}
        isSubmitting={isSubmitting}
      />
    </PageBody>
  );
}

function ImportFromUrlModal({ onClose }: { onClose: () => void }) {
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as any;
  const isSubmitting = fetcher.state !== "idle";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-text-bright">Install skill from URL</h2>
        <p className="mb-4 text-xs text-text-dimmed">
          Paste a URL pointing to a Claude-skills-format markdown file. The manifest is fetched, validated, and registered in this scope.
        </p>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="import_url" />
          <input
            name="url"
            type="url"
            placeholder="https://example.com/my-skill.skill.md"
            required
            className="w-full rounded border border-charcoal-600 bg-charcoal-800 px-3 py-2 text-xs text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          {result?.error && (
            <p className="mt-2 text-xs text-rose-300">{result.error}</p>
          )}
          {result?.ok && result?.imported && (
            <p className="mt-2 text-xs text-emerald-300">Skill imported successfully.</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-charcoal-600 px-3 py-1.5 text-xs text-text-dimmed hover:text-text-bright"
            >
              Cancel
            </button>
            <Button variant="primary/small" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Importing…" : "Import"}
            </Button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

function Section({
  title,
  rows,
  emptyMessage,
  envVarsPath,
  isSubmitting,
}: {
  title: string;
  rows: Array<{ skill: SkillRecord | AgentSkillRecord; status: "enabled" | "available" }>;
  emptyMessage: string;
  envVarsPath: string;
  isSubmitting: boolean;
}) {
  return (
    <section className="mt-6 space-y-3">
      <Header3>{title}</Header3>
      {rows.length === 0 ? (
        <Paragraph variant="small" className="text-text-dimmed">
          {emptyMessage}
        </Paragraph>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map(({ skill, status }) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              status={status}
              envVarsPath={envVarsPath}
              isSubmitting={isSubmitting}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillRow({
  skill,
  status,
  envVarsPath,
  isSubmitting,
}: {
  skill: SkillRecord | AgentSkillRecord;
  status: "enabled" | "available";
  envVarsPath: string;
  isSubmitting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const missing = skill.requiredEnv.filter((k) => !skill.envSetMap[k]);
  const envReady = missing.length === 0;
  const ChevronIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="rounded-md border border-grid-dimmed bg-background-dimmed p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpenIcon className="h-4 w-4 flex-shrink-0 text-text-dimmed" />
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{skill.name}</span>
              <Badge variant="small">v{skill.version}</Badge>
              {skill.isOfficial ? <Badge variant="small">official</Badge> : null}
              {skill.category ? (
                <span className="rounded bg-charcoal-700 px-1.5 py-0.5 text-[10px] text-text-dimmed">
                  {skill.category}
                </span>
              ) : null}
            </div>
            <Paragraph variant="extra-small" className="font-mono text-text-dimmed">
              {skill.skillId}
            </Paragraph>
          </div>
        </div>
        {envReady ? (
          <span className="inline-flex flex-shrink-0 items-center gap-1 text-success">
            <CheckCircleIcon className="h-4 w-4" />
          </span>
        ) : (
          <span className="inline-flex flex-shrink-0 items-center gap-1 text-warning">
            <ExclamationTriangleIcon className="h-4 w-4" />
          </span>
        )}
      </div>

      <Paragraph variant="small" className="mt-2">
        {skill.description}
      </Paragraph>

      {missing.length > 0 ? (
        <div className="mt-3 rounded border border-warning/30 bg-warning/10 p-2 text-xs">
          Missing: <code>{missing.join(", ")}</code>.{" "}
          <Link className="inline-flex items-center gap-1 underline" to={envVarsPath}>
            <LinkIcon className="h-3 w-3" /> Link env
          </Link>
        </div>
      ) : null}

      {/* Expandable details */}
      {(skill.providesTools?.length > 0 || skill.promptBlock) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 flex items-center gap-1 text-[11px] text-text-dimmed hover:text-text-bright"
        >
          <ChevronIcon className="size-3" />
          {expanded ? "Hide details" : `Details · ${skill.providesTools?.length ?? 0} tool(s)`}
        </button>
      )}

      {expanded && (
        <div className="mt-2 space-y-2">
          {skill.providesTools?.length > 0 && (
            <div className="rounded border border-charcoal-700 bg-charcoal-900/60 p-2">
              <p className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold text-text-dimmed">
                <WrenchScrewdriverIcon className="size-3" /> Tools provided
              </p>
              <ul className="space-y-1">
                {skill.providesTools.map((t) => (
                  <li key={t.name} className="text-[11px]">
                    <code className="text-sky-300">{t.name}</code>
                    {t.description && (
                      <span className="ml-1.5 text-text-dimmed">— {t.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {skill.promptBlock && (
            <details className="rounded border border-charcoal-700 bg-charcoal-900/60">
              <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-text-dimmed hover:text-text-bright">
                Prompt block
              </summary>
              <pre className="max-h-40 overflow-y-auto px-2 py-1.5 text-[10px] text-text-dimmed whitespace-pre-wrap">
                {skill.promptBlock}
              </pre>
            </details>
          )}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        {status === "enabled" ? (
          <Form method="post">
            <input type="hidden" name="intent" value="remove" />
            <input type="hidden" name="skillId" value={skill.id} />
            <Button variant="tertiary/small" type="submit" disabled={isSubmitting}>
              Remove from agent
            </Button>
          </Form>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="enable" />
            <input type="hidden" name="skillId" value={skill.id} />
            <span title={envReady ? "Enable skill" : "Link the missing env vars first"}>
              <Button
                variant="primary/small"
                type="submit"
                disabled={isSubmitting || !envReady}
              >
                Enable on agent
              </Button>
            </span>
          </Form>
        )}
      </div>
    </div>
  );
}
