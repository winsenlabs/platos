/**
 * Connect page — messaging-channel CRUD resource route.
 *
 *   POST /orgs/:org/projects/:proj/env/:env/agent-connect/channels
 *
 * Thin server-side proxy in front of the agent service's operator-only
 * `ChannelsController` (`/api/v1/agent/channels`). Mirrors the fetch+scope-header
 * pattern used by `agents._index` — it forwards the four `X-Platos-*` scope
 * headers so the agent's `ScopeGuard` + `requireOperator` posture applies, and
 * relays the one-time `{ webhookSecret, webhookPath }` reveal from create/rotate
 * straight back to the Connect page's fetcher.
 *
 * Intents (form field `intent`):
 *   - create        → POST   /channels           { provider, agentId, displayName, credentials, config }
 *   - toggle/patch  → PATCH  /channels/:id        { enabled?, displayName?, credentials? }
 *   - delete        → DELETE /channels/:id
 *   - rotate-secret → POST   /channels/:id/rotate-secret
 *
 * Per-provider credential fields arrive as `cred_<key>` form entries and are
 * bucketed into the encrypted `credentials` object; non-secret extras arrive as
 * `cfg_<key>` and land in `config`. Keeping the provider field schema on the
 * client means this route stays provider-agnostic.
 */

import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

function scopeHeaders(scope: Scope) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  } as const;
}

/** Pull the human-readable message out of the agent's HttpException JSON. */
function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") return b.message;
    if (typeof b.error === "string") return b.error;
  }
  return `Request failed (HTTP ${status})`;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) return json({ error: "Environment not found" }, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = scopeHeaders(scope);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  try {
    if (intent === "create") {
      const provider = String(fd.get("provider") ?? "").trim().toLowerCase();
      const agentId = String(fd.get("agentId") ?? "").trim();
      const displayNameRaw = fd.get("displayName");
      const displayName =
        typeof displayNameRaw === "string" && displayNameRaw.trim() !== ""
          ? displayNameRaw.trim()
          : undefined;

      if (!provider) return json({ error: "Provider is required" }, { status: 400 });
      if (!agentId) return json({ error: "Agent is required" }, { status: 400 });

      // Bucket cred_*/cfg_* form entries into the encrypted credentials object
      // and the plaintext config object. Empty inputs are dropped so optional
      // fields don't persist blank strings.
      const credentials: Record<string, string> = {};
      const config: Record<string, string> = {};
      fd.forEach((value, key) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (trimmed === "") return;
        if (key.startsWith("cred_")) credentials[key.slice(5)] = trimmed;
        else if (key.startsWith("cfg_")) config[key.slice(4)] = trimmed;
      });

      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/channels`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider,
          agentId,
          displayName,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          config: Object.keys(config).length > 0 ? config : undefined,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return json({ error: errorMessage(body, res.status) }, { status: res.status });
      // { channel, webhookSecret, webhookPath } — the one-time reveal.
      return json({ ok: true, created: body });
    }

    if (intent === "toggle" || intent === "patch") {
      const id = String(fd.get("id") ?? "").trim();
      if (!id) return json({ error: "Channel id is required" }, { status: 400 });

      const patch: Record<string, unknown> = {};
      const enabledRaw = fd.get("enabled");
      if (enabledRaw != null) patch.enabled = String(enabledRaw) === "true";
      if (fd.has("displayName")) {
        const dn = fd.get("displayName");
        patch.displayName = typeof dn === "string" && dn.trim() !== "" ? dn.trim() : null;
      }

      // Optional `credentials` — a JSON-encoded object of the fields to re-encrypt
      // (the backend PATCH re-seals whatever it's handed). Only forward it when it
      // parses to a non-empty plain object; empty-object or invalid JSON is dropped
      // rather than sent, so a blank form never wipes stored secrets.
      const credentialsRaw = fd.get("credentials");
      if (typeof credentialsRaw === "string" && credentialsRaw.trim() !== "") {
        try {
          const parsed = JSON.parse(credentialsRaw) as unknown;
          if (
            parsed != null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            Object.keys(parsed as Record<string, unknown>).length > 0
          ) {
            patch.credentials = parsed;
          }
        } catch {
          // Malformed JSON — omit credentials rather than forwarding garbage.
        }
      }

      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/channels/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return json({ error: errorMessage(body, res.status) }, { status: res.status });
      return json({ ok: true, channel: body.channel });
    }

    if (intent === "delete") {
      const id = String(fd.get("id") ?? "").trim();
      if (!id) return json({ error: "Channel id is required" }, { status: 400 });

      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/channels/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return json({ error: errorMessage(body, res.status) }, { status: res.status });
      return json({ ok: true, deleted: true, id });
    }

    if (intent === "rotate-secret") {
      const id = String(fd.get("id") ?? "").trim();
      if (!id) return json({ error: "Channel id is required" }, { status: 400 });

      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/channels/${encodeURIComponent(id)}/rotate-secret`,
        { method: "POST", headers, signal: AbortSignal.timeout(10000) }
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return json({ error: errorMessage(body, res.status) }, { status: res.status });
      // { channel, webhookSecret, webhookPath } — one-time reveal, same shape as create.
      return json({ ok: true, created: body });
    }

    return json({ error: `Unknown intent: ${intent}` }, { status: 400 });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Agent service unreachable" },
      { status: 502 }
    );
  }
}

// Block GETs — explicit 405 rather than Remix's default 404 from a
// loaderless resource route.
export function loader() {
  return json({ error: "method_not_allowed" }, { status: 405 });
}
