import {
  Form,
  useActionData,
  useFetcher,
  useNavigation,
  useSearchParams,
  type MetaFunction,
} from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Budget caps | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

/**
 * Theme SM.4 — cap row shape with tier/skill/agent filters. `tier` defaults
 * to "llm" for rows persisted before SM.3, so the UI treats it as optional
 * on the wire and fills in the default when rendering.
 */
type Cap = {
  id: string;
  scopeType: "scope" | "agent" | "user";
  targetId: string;
  period: "day" | "week" | "month";
  limitCents: number;
  runsLimit: number;
  alertThresholds: number[];
  alertWebhookUrl: string | null;
  alertEmails: string | null;
  enabled: boolean;
  overrideUntil: string | null;
  overrideBy: string | null;
  tier?: "llm" | "skill";
  skillSlug?: string | null;
  agentId?: string | null;
  createdAt: string;
  updatedAt: string;
};

type AgentOption = { id: string; name: string };
type SkillOption = { skillId: string; name: string };

/**
 * PRELAUNCH-A3-2 — per-cap progress status from `/budgets/status`. The cap
 * page used to render only the configured limit; switching to /status
 * gives operators a live progress bar + breached badge per cap.
 */
type CapStatus = {
  capId: string;
  spentCents: number;
  runs: number;
  percent: number;
  runsPercent: number;
  blocked: boolean;
  overrideActive: boolean;
};

type LoaderData = {
  agentReachable: boolean;
  caps: Cap[];
  capStatuses: CapStatus[];
  agents: AgentOption[];
  skills: SkillOption[];
};

function agentHeaders(scope: Scope) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

  // SM.4 + PRELAUNCH-A3-2 — fetch caps + caps STATUS + agent picker data
  // + skill dropdown data in parallel. The /status endpoint returns
  // BudgetStatus[] (with spentCents/percent/blocked) for every cap; we
  // join it onto the configured caps list so the page can render
  // progress bars + breached badges. Each call is defensive: a failure
  // to load agents/skills/status degrades the UI but never breaks CRUD.
  const [capsRes, statusRes, agentsRes, skillsRes] = await Promise.allSettled([
    fetch(`${AGENT_API_URL}/api/v1/agent/budgets`, { headers: agentHeaders(scope) }),
    fetch(`${AGENT_API_URL}/api/v1/agent/budgets/status`, { headers: agentHeaders(scope) }),
    fetch(`${AGENT_API_URL}/api/v1/agent/agents`, { headers: agentHeaders(scope) }),
    fetch(`${AGENT_API_URL}/api/v1/agent/skills`, { headers: agentHeaders(scope) }),
  ]);

  if (capsRes.status !== "fulfilled" || !capsRes.value.ok) {
    const data: LoaderData = {
      agentReachable: false,
      caps: [],
      capStatuses: [],
      agents: [],
      skills: [],
    };
    return typedjson(data);
  }

  const capsJson = (await capsRes.value.json()) as { caps: Cap[] };
  let capStatuses: CapStatus[] = [];
  if (statusRes.status === "fulfilled" && statusRes.value.ok) {
    try {
      const sj = (await statusRes.value.json()) as {
        caps?: Array<{
          cap?: { id?: string };
          spentCents?: number;
          runs?: number;
          percent?: number;
          runsPercent?: number;
          blocked?: boolean;
          overrideActive?: boolean;
        }>;
      };
      capStatuses = (sj.caps ?? [])
        .filter((s) => !!s.cap?.id)
        .map((s) => ({
          capId: s.cap!.id!,
          spentCents: Number(s.spentCents ?? 0),
          runs: Number(s.runs ?? 0),
          percent: Number(s.percent ?? 0),
          runsPercent: Number(s.runsPercent ?? 0),
          blocked: Boolean(s.blocked),
          overrideActive: Boolean(s.overrideActive),
        }));
    } catch {
      capStatuses = [];
    }
  }
  let agents: AgentOption[] = [];
  let skills: SkillOption[] = [];
  if (agentsRes.status === "fulfilled" && agentsRes.value.ok) {
    try {
      const j = (await agentsRes.value.json()) as {
        agents: Array<{ id: string; name: string }>;
      };
      agents = (j.agents ?? []).map((a) => ({ id: a.id, name: a.name }));
    } catch {
      // leave empty
    }
  }
  if (skillsRes.status === "fulfilled" && skillsRes.value.ok) {
    try {
      const j = (await skillsRes.value.json()) as {
        skills: Array<{ skillId: string; name: string }>;
      };
      // Dedupe on skillId (same manifest id can appear as official + imported).
      const seen = new Set<string>();
      for (const s of j.skills ?? []) {
        if (seen.has(s.skillId)) continue;
        seen.add(s.skillId);
        skills.push({ skillId: s.skillId, name: s.name });
      }
      skills.sort((a, b) => a.skillId.localeCompare(b.skillId));
    } catch {
      // leave empty
    }
  }

  const data: LoaderData = {
    agentReachable: true,
    caps: capsJson.caps ?? [],
    capStatuses,
    agents,
    skills,
  };
  return typedjson(data);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";

  if (intent === "upsert") {
    // SM.4 — tier / skillSlug / agentId are always optional on the wire.
    // BudgetService defaults tier to "llm" when unset and rejects skillSlug
    // on non-skill tiers, so we pass blank strings through as null.
    const rawTier = String(form.get("tier") || "llm");
    const tier: "llm" | "skill" = rawTier === "skill" ? "skill" : "llm";
    const rawSkill = String(form.get("skillSlug") || "").trim();
    const rawAgent = String(form.get("agentIdFilter") || "").trim();
    const body = {
      scopeType: String(form.get("scopeType") || "scope"),
      targetId: String(form.get("targetId") || ""),
      period: String(form.get("period") || "day"),
      limitCents: Math.max(0, parseInt(String(form.get("limitCents") || "0"), 10) || 0),
      runsLimit: Math.max(0, parseInt(String(form.get("runsLimit") || "0"), 10) || 0),
      alertWebhookUrl: String(form.get("alertWebhookUrl") || "") || null,
      alertEmails: String(form.get("alertEmails") || "") || null,
      enabled: form.get("enabled") === "on" || form.get("enabled") === "true",
      tier,
      // Only forward skillSlug when tier="skill" — BudgetService.validate
      // rejects skillSlug on tier="llm" rather than silently ignoring.
      skillSlug: tier === "skill" && rawSkill.length > 0 ? rawSkill : null,
      agentId: rawAgent.length > 0 ? rawAgent : null,
    };
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/budgets`, {
        method: "POST",
        headers: agentHeaders(scope),
        body: JSON.stringify(body),
      });
      // Read the body once; the agent returns `{ error: "..." }` on
      // BadRequest (400). Older builds returned a 200 with `{ error, status: 400 }`
      // so we also treat a 200 with an `error` field as a failure to keep
      // the UI honest during a rolling deploy.
      const json = await res.json().catch(() => null) as
        | { cap?: unknown; error?: string }
        | null;
      const message = json && typeof json.error === "string" ? json.error : null;
      if (!res.ok || message) {
        return typedjson(
          { ok: false, error: message ?? `agent ${res.status}` },
          { status: res.ok ? 400 : 502 },
        );
      }
      return typedjson({ ok: true });
    } catch (err: any) {
      return typedjson({ ok: false, error: err?.message ?? "fetch failed" }, { status: 502 });
    }
  }

  if (intent === "delete") {
    const id = String(form.get("capId") || "");
    if (!id) return typedjson({ ok: false, error: "capId missing" }, { status: 400 });
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/budgets/${id}`, {
        method: "DELETE",
        headers: agentHeaders(scope),
      });
      const json = (await res.json().catch(() => null)) as
        | { deleted?: boolean; error?: string }
        | null;
      const message = json && typeof json.error === "string" ? json.error : null;
      if (!res.ok || message) {
        return typedjson(
          { ok: false, error: message ?? `agent ${res.status}` },
          { status: res.ok ? 400 : 502 },
        );
      }
      return typedjson({ ok: true });
    } catch (err: any) {
      return typedjson({ ok: false, error: err?.message ?? "fetch failed" }, { status: 502 });
    }
  }

  if (intent === "override") {
    const id = String(form.get("capId") || "");
    const minutes = Math.max(0, parseInt(String(form.get("minutes") || "0"), 10) || 0);
    if (!id) return typedjson({ ok: false, error: "capId missing" }, { status: 400 });
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/budgets/${id}/override`, {
        method: "POST",
        headers: agentHeaders(scope),
        body: JSON.stringify({ minutes }),
      });
      const json = (await res.json().catch(() => null)) as
        | { cap?: unknown; error?: string }
        | null;
      const message = json && typeof json.error === "string" ? json.error : null;
      if (!res.ok || message) {
        return typedjson(
          { ok: false, error: message ?? `agent ${res.status}` },
          { status: res.ok ? 400 : 502 },
        );
      }
      return typedjson({ ok: true });
    } catch (err: any) {
      return typedjson({ ok: false, error: err?.message ?? "fetch failed" }, { status: 502 });
    }
  }

  return typedjson({ ok: false, error: "unknown intent" }, { status: 400 });
}

function fmtCents(c: number): string {
  if (!c || c <= 0) return "$0.00";
  return `$${(c / 100).toFixed(2)}`;
}

/** SM.4 — sentinel used in both filter-bar selects and the form for "any". */
const FILTER_ANY = "";

type ActionResult = { ok: true } | { ok: false; error: string };

export default function Page() {
  const { agentReachable, caps, capStatuses, agents, skills } =
    useTypedLoaderData<typeof loader>();
  // PRELAUNCH-A3-2 — fast lookup from capId to its live status row.
  const statusByCapId = useMemo(() => {
    const m = new Map<string, CapStatus>();
    for (const s of capStatuses ?? []) m.set(s.capId, s);
    return m;
  }, [capStatuses]);
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const fetcher = useFetcher<ActionResult>();
  // Bug fix: previously the action's error/success was never surfaced. The
  // agent backend would silently reject invalid caps and the user thought
  // the cap saved. Show the action result inline.
  const submissionError =
    (actionData && "ok" in actionData && actionData.ok === false ? actionData.error : null) ??
    (fetcher.data && "ok" in fetcher.data && fetcher.data.ok === false
      ? fetcher.data.error
      : null);
  const submissionOk =
    (actionData && "ok" in actionData && actionData.ok === true) ||
    (fetcher.data && "ok" in fetcher.data && fetcher.data.ok === true);
  const isSubmitting = navigation.state === "submitting" || fetcher.state === "submitting";

  const [formTier, setFormTier] = useState<"llm" | "skill">("llm");
  // Tracks which scope type the operator is configuring so we can show the
  // right target picker below.
  const [formScopeType, setFormScopeType] = useState<"scope" | "agent" | "user">("scope");
  // For user-scoped caps: "wildcard" = applies to all users (targetId="*");
  // "specific" = one named userId.
  const [userTargetMode, setUserTargetMode] = useState<"wildcard" | "specific">("wildcard");

  // SM.4 — filter bar state lives in ?tier=&skill=&agent= so operators can
  // share a pre-filtered URL and refresh without losing context.
  const [searchParams, setSearchParams] = useSearchParams();
  const tierFilter = searchParams.get("tier") ?? FILTER_ANY;
  const skillFilter = searchParams.get("skill") ?? FILTER_ANY;
  const agentFilter = searchParams.get("agent") ?? FILTER_ANY;

  const setFilter = (key: "tier" | "skill" | "agent", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const agentNameById = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents],
  );

  const filteredCaps = useMemo(() => {
    return caps.filter((c) => {
      const t = c.tier ?? "llm";
      if (tierFilter && t !== tierFilter) return false;
      if (skillFilter && (c.skillSlug ?? "") !== skillFilter) return false;
      if (agentFilter && (c.agentId ?? "") !== agentFilter) return false;
      return true;
    });
  }, [caps, tierFilter, skillFilter, agentFilter]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Budget caps" />
        <PageAccessories>
          <DocsLink slug="budgets" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        {!agentReachable ? (
          <Paragraph>Agent service unreachable — cannot load budget caps.</Paragraph>
        ) : (
          <div className="flex flex-col gap-6">
            <section>
              <h2 className="mb-2 text-sm font-semibold text-text-bright">
                Create or update a budget cap
              </h2>
              <Paragraph>
                Hard-stop fires at 100% of the cap window. Alerts fire at 50% / 80%
                / 100% by default, delivered via webhook + email when configured.
                Cap modifications go through the existing tier-1 approval path.
              </Paragraph>
              {submissionError && !isSubmitting && (
                <div className="mt-3 rounded-md border border-red-700 bg-red-950/40 p-2 text-xs text-red-300">
                  Save failed: {submissionError}
                </div>
              )}
              {submissionOk && !isSubmitting && !submissionError && (
                <div className="mt-3 rounded-md border border-emerald-700 bg-emerald-950/40 p-2 text-xs text-emerald-300">
                  Cap saved.
                </div>
              )}
              <Form method="post" className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <input type="hidden" name="intent" value="upsert" />

                {/* SM.4 — tier toggle. Default "llm" keeps pre-SM.3 behaviour. */}
                <fieldset className="md:col-span-2 flex items-center gap-4 text-xs">
                  <span className="text-text-dimmed">Tier</span>
                  <label className="flex items-center gap-1 text-text-bright">
                    <input
                      type="radio"
                      name="tier"
                      value="llm"
                      checked={formTier === "llm"}
                      onChange={() => setFormTier("llm")}
                    />
                    LLM
                  </label>
                  <label className="flex items-center gap-1 text-text-bright">
                    <input
                      type="radio"
                      name="tier"
                      value="skill"
                      checked={formTier === "skill"}
                      onChange={() => setFormTier("skill")}
                    />
                    Skill
                  </label>
                </fieldset>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-dimmed">Scope type</span>
                  <select
                    name="scopeType"
                    value={formScopeType}
                    onChange={(e) => setFormScopeType(e.target.value as any)}
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  >
                    <option value="scope">Scope-wide (entire environment)</option>
                    <option value="agent">Per-agent</option>
                    <option value="user">Per-user (end-user level)</option>
                  </select>
                </label>

                {/* Target picker — changes shape based on scope type */}
                {formScopeType === "scope" && (
                  <input type="hidden" name="targetId" value="" />
                )}

                {formScopeType === "agent" && (
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-text-dimmed">Agent</span>
                    {agents.length > 0 ? (
                      <select
                        name="targetId"
                        className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                      >
                        <option value="">All agents (scope-wide)</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name="targetId"
                        placeholder="Agent ID"
                        className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                      />
                    )}
                  </label>
                )}

                {formScopeType === "user" && (
                  <div className="flex flex-col gap-2 text-xs">
                    <span className="text-text-dimmed font-medium">Apply to</span>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="_userTargetMode"
                        value="wildcard"
                        checked={userTargetMode === "wildcard"}
                        onChange={() => setUserTargetMode("wildcard")}
                        className="mt-0.5"
                      />
                      <span className="text-text-bright">
                        <strong>All users</strong>
                        <span className="ml-1 text-text-dimmed">
                          — default per-user cap. Each end-user tracked independently;
                          one user hitting their limit does not affect others.
                          This is the recommended setting for a managed platform.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="_userTargetMode"
                        value="specific"
                        checked={userTargetMode === "specific"}
                        onChange={() => setUserTargetMode("specific")}
                        className="mt-0.5"
                      />
                      <span className="text-text-bright">
                        <strong>Specific user</strong>
                        <span className="ml-1 text-text-dimmed">
                          — enter a single userId for a one-off override.
                        </span>
                      </span>
                    </label>
                    {userTargetMode === "wildcard" ? (
                      <input type="hidden" name="targetId" value="*" />
                    ) : (
                      <input
                        name="targetId"
                        placeholder="User ID (e.g. cmo123abc...)"
                        className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright font-mono"
                      />
                    )}
                  </div>
                )}

                {/* SM.4 — skill dropdown. Only rendered when tier="skill".
                    Blank value = "all skills" (catch-all cap). */}
                {formTier === "skill" && (
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-text-dimmed">
                      Skill (optional — blank = all skills)
                    </span>
                    <select
                      name="skillSlug"
                      className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                    >
                      <option value="">All skills</option>
                      {skills.map((s) => (
                        <option key={s.skillId} value={s.skillId}>
                          {s.name} ({s.skillId})
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {/* SM.4 — agent filter. Composes with tier+skill (e.g. agent A
                    spending on skill X). Blank = scope-wide (all agents). */}
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-dimmed">
                    Agent filter (optional — blank = all agents)
                  </span>
                  <select
                    name="agentIdFilter"
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  >
                    <option value="">All agents</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-dimmed">Period</span>
                  <select
                    name="period"
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  >
                    <option value="day">Daily</option>
                    <option value="week">Weekly (rolling 7)</option>
                    <option value="month">Monthly (calendar)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-dimmed">Daily/period cap (USD cents)</span>
                  <input
                    type="number"
                    name="limitCents"
                    min="0"
                    placeholder="e.g. 1000 = $10"
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-dimmed">Runs limit (optional)</span>
                  <input
                    type="number"
                    name="runsLimit"
                    min="0"
                    placeholder="0 disables"
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-dimmed">Alert webhook URL (optional)</span>
                  <input
                    name="alertWebhookUrl"
                    placeholder="https://example.com/budget-alert"
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs md:col-span-2">
                  <span className="text-text-dimmed">Alert emails (comma-separated)</span>
                  <input
                    name="alertEmails"
                    placeholder="ops@example.com, finance@example.com"
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1.5 text-sm text-text-bright"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="enabled" defaultChecked />
                  <span className="text-text-bright">Enabled</span>
                </label>
                <div className="md:col-span-2">
                  <Button type="submit" variant="primary/small">
                    Save cap
                  </Button>
                </div>
              </Form>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold text-text-bright">
                Configured caps
              </h2>

              {/* SM.4 — filter bar. Changes reflect into URL params so the
                  filtered list is link-shareable. */}
              <div className="mb-3 flex flex-wrap items-end gap-3 rounded-md border border-charcoal-700 bg-charcoal-900 p-3">
                <label className="flex flex-col gap-1 text-[11px]">
                  <span className="text-text-dimmed">Tier</span>
                  <select
                    value={tierFilter}
                    onChange={(e) => setFilter("tier", e.target.value)}
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1 text-xs text-text-bright"
                  >
                    <option value="">All</option>
                    <option value="llm">LLM</option>
                    <option value="skill">Skill</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px]">
                  <span className="text-text-dimmed">Skill</span>
                  <select
                    value={skillFilter}
                    onChange={(e) => setFilter("skill", e.target.value)}
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1 text-xs text-text-bright"
                  >
                    <option value="">All</option>
                    {skills.map((s) => (
                      <option key={s.skillId} value={s.skillId}>
                        {s.skillId}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px]">
                  <span className="text-text-dimmed">Agent</span>
                  <select
                    value={agentFilter}
                    onChange={(e) => setFilter("agent", e.target.value)}
                    className="rounded-md border border-charcoal-700 bg-charcoal-850 p-1 text-xs text-text-bright"
                  >
                    <option value="">All</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                {(tierFilter || skillFilter || agentFilter) && (
                  <Button
                    type="button"
                    variant="tertiary/small"
                    onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
                  >
                    Clear filters
                  </Button>
                )}
                <span className="ml-auto text-[11px] text-text-dimmed">
                  {filteredCaps.length} of {caps.length} caps
                </span>
              </div>

              {filteredCaps.length === 0 ? (
                <Paragraph>
                  {caps.length === 0
                    ? "No caps configured yet."
                    : "No caps match the current filters."}
                </Paragraph>
              ) : (
                <div className="flex flex-col gap-2">
                  {filteredCaps.map((c) => {
                    const tier = c.tier ?? "llm";
                    const agentLabel =
                      c.agentId && agentNameById.has(c.agentId)
                        ? agentNameById.get(c.agentId)!
                        : c.agentId ?? "all agents";
                    // PRELAUNCH-A3-2 — live status (spent / percent / blocked).
                    const status = statusByCapId.get(c.id);
                    const pct = status?.percent ?? 0;
                    const pctClamped = Math.min(100, Math.max(0, pct));
                    const barColor =
                      pct >= 100
                        ? "bg-rose-500"
                        : pct >= 80
                          ? "bg-amber-400"
                          : "bg-emerald-400";
                    return (
                      <div
                        key={c.id}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <p className="text-sm font-semibold text-text-bright">
                              {c.scopeType === "scope" && "Scope-wide"}
                              {c.scopeType === "agent" && `Agent: ${agentNameById.get(c.targetId) ?? c.targetId}`}
                              {c.scopeType === "user" && c.targetId === "*" && "All users (default per-user cap)"}
                              {c.scopeType === "user" && c.targetId !== "*" && `User: ${c.targetId}`}
                              {" · "}{c.period}
                            </p>
                            {c.scopeType === "user" && c.targetId === "*" && (
                              <p className="text-[11px] text-emerald-400">
                                Each end-user has their own independent spending window.
                              </p>
                            )}
                            <p className="text-xs text-text-dimmed">
                              {status
                                ? `${fmtCents(status.spentCents)} of ${fmtCents(c.limitCents)} (${pct.toFixed(1)}%)`
                                : `Limit ${fmtCents(c.limitCents)}`}
                              {c.runsLimit > 0
                                ? status
                                  ? ` · ${status.runs} of ${c.runsLimit} runs`
                                  : ` · ${c.runsLimit} runs`
                                : ""}
                            </p>
                            {status && (
                              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-charcoal-700">
                                <div
                                  className={`h-full ${barColor}`}
                                  style={{ width: `${pctClamped}%` }}
                                />
                              </div>
                            )}
                            <div className="mt-1 flex flex-wrap gap-1">
                              <Badge variant="outline-rounded">Tier: {tier}</Badge>
                              <Badge variant="outline-rounded">
                                Skill: {c.skillSlug ?? "all"}
                              </Badge>
                              <Badge variant="outline-rounded">Agent: {agentLabel}</Badge>
                              {c.scopeType === "user" && c.targetId === "*" && (
                                <Badge variant="success">Default per-user</Badge>
                              )}
                              {status?.blocked && (
                                <Badge variant="error">BREACHED</Badge>
                              )}
                              {status?.overrideActive && (
                                <span className="grid h-4 place-items-center whitespace-nowrap rounded-full border border-amber-800 bg-amber-950 px-1.5 text-xxs uppercase tracking-wider text-amber-300">
                                  override
                                </span>
                              )}
                            </div>
                            {c.overrideUntil && (
                              <p className="mt-1 text-[11px] text-amber-300">
                                Override active until{" "}
                                {new Date(c.overrideUntil).toLocaleString()} (by{" "}
                                {c.overrideBy})
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={c.enabled ? "success" : "outline-rounded"}>
                              {c.enabled ? "enabled" : "disabled"}
                            </Badge>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="override" />
                              <input type="hidden" name="capId" value={c.id} />
                              <input type="hidden" name="minutes" value="30" />
                              <Button type="submit" variant="secondary/small">
                                +30m override
                              </Button>
                            </fetcher.Form>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="capId" value={c.id} />
                              <Button type="submit" variant="danger/small">
                                Delete
                              </Button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}
