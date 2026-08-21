import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireEnvironmentScope } from "./auth.server";
import { agentRequest } from "./platosAgent.server";

type ModelRoute = {
  label: string;
  model: string;
  isDefault: boolean;
  providerKeyId?: string | null;
};

function requiredText(form: FormData, name: string): string {
  const value = String(form.get(name) ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalText(form: FormData, name: string): string | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value || undefined;
}

function integer(form: FormData, name: string, minimum: number, maximum: number): number {
  const value = Number(form.get(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function objectArray(form: FormData, name: string): Array<Record<string, unknown>> {
  const raw = requiredText(form, name);
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${name} must be a JSON array of objects`);
  }
  return value as Array<Record<string, unknown>>;
}

function modelRoutes(form: FormData): ModelRoute[] {
  const routes = objectArray(form, "modelRoutes").map((route, index) => {
    const label = typeof route.label === "string" ? route.label.trim() : "";
    const model = typeof route.model === "string" ? route.model.trim() : "";
    if (!label || !model || typeof route.isDefault !== "boolean") {
      throw new Error(`modelRoutes[${index}] requires label, model, and boolean isDefault`);
    }
    const providerKeyId = route.providerKeyId;
    if (providerKeyId !== undefined && providerKeyId !== null && typeof providerKeyId !== "string") {
      throw new Error(`modelRoutes[${index}].providerKeyId must be a string or null`);
    }
    return {
      label,
      model,
      isDefault: route.isDefault,
      ...(providerKeyId === undefined ? {} : { providerKeyId }),
    };
  });
  if (routes.length === 0 || routes.filter((route) => route.isDefault).length !== 1) {
    throw new Error("modelRoutes must contain exactly one default route");
  }
  if (new Set(routes.map((route) => route.label)).size !== routes.length) {
    throw new Error("modelRoutes labels must be unique");
  }
  return routes;
}

function enumValue<T extends string>(form: FormData, name: string, allowed: readonly T[]): T {
  const value = String(form.get(name) ?? "");
  if (!allowed.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
}

export async function mutateAgentConfig(args: ActionFunctionArgs, mode: "create" | "update") {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  if (mode === "update" && !args.params.agentId) throw new Response("Invalid Agent", { status: 400 });

  const { scope } = await requireEnvironmentScope({
    request: args.request,
    organizationSlug,
    projectSlug,
    environmentSlug,
    access: "secret:mutate",
  });
  const form = await args.request.formData();

  try {
    const model = requiredText(form, "model");
    const body = {
      ...(mode === "create" ? { name: requiredText(form, "name"), slug: optionalText(form, "slug") } : { name: optionalText(form, "name") }),
      model,
      systemPrompt: String(form.get("systemPrompt") ?? ""),
      maxSteps: integer(form, "maxSteps", 1, 100),
      contextLimit: integer(form, "contextLimit", 1, 1000),
      historyMode: enumValue(form, "historyMode", ["rolling", "compact"] as const),
      compactThreshold: integer(form, "compactThreshold", 1, 2000),
      executionMode: enumValue(form, "executionMode", ["direct", "durable"] as const),
      toolsBlockConfig: {
        mode: enumValue(form, "toolMode", ["direct", "sub-agent", "execute-tool"] as const),
        toolExposure: enumValue(form, "toolExposure", ["direct", "meta"] as const),
      },
      modelRoutes: modelRoutes(form),
      promptBlocks: objectArray(form, "promptBlocks"),
      ...(mode === "update" ? { versionNote: optionalText(form, "versionNote") } : {}),
    };
    const path = mode === "create"
      ? "/api/v1/agent/agents"
      : `/api/v1/agent/agents/${encodeURIComponent(args.params.agentId!)}`;
    const result = await agentRequest(path, scope, { method: mode === "create" ? "POST" : "PATCH", body });
    return json({ ok: true, result });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Agent configuration failed" }, { status: 400 });
  }
}
