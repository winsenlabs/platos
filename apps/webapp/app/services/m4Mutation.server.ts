import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireEnvironmentScope } from "./auth.server";
import { agentRequest, PlatosAgentApiError, UnsafeCredentialResponseError } from "./platosAgent.server";

export async function m4MutationContext(args: ActionFunctionArgs) {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) {
    throw new Response("Invalid scope", { status: 400 });
  }
  const { scope } = await requireEnvironmentScope({
    request: args.request,
    organizationSlug,
    projectSlug,
    environmentSlug,
    access: "secret:mutate",
  });
  return { scope, form: await args.request.formData() };
}

export async function m4Mutation(
  args: ActionFunctionArgs,
  operation: string,
  request: (context: Awaited<ReturnType<typeof m4MutationContext>>) => Promise<unknown>,
) {
  try {
    const result = await request(await m4MutationContext(args));
    return json({ ok: true as const, result });
  } catch (error) {
    // Remix redirect/not-found/auth Responses carry routing semantics. Turning
    // them into mutation JSON creates false 400s and can bypass login redirects.
    if (error instanceof Response) throw error;
    const code = error instanceof PlatosAgentApiError || error instanceof UnsafeCredentialResponseError
      ? error.code
      : "INVALID_REQUEST";
    const status = error instanceof PlatosAgentApiError && error.status >= 400 && error.status < 600
      ? error.status
      : 400;
    return json(
      {
        ok: false as const,
        error: {
          code,
          message: error instanceof PlatosAgentApiError || error instanceof UnsafeCredentialResponseError
            ? `${operation} failed (${code})`
            : error instanceof Error
              ? error.message
              : `${operation} failed`,
        },
      },
      { status },
    );
  }
}

export function requiredText(form: FormData, name: string, label = name): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function optionalText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function enumField<const T extends readonly string[]>(
  form: FormData,
  name: string,
  values: T,
  fallback?: T[number],
): T[number] {
  const value = optionalText(form, name) ?? fallback;
  if (!value || !values.includes(value)) {
    throw new Error(`${name} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}

export function numberField(
  form: FormData,
  name: string,
  options: { min?: number; max?: number; fallback?: number; integer?: boolean } = {},
): number {
  const raw = optionalText(form, name);
  const value = raw === undefined ? options.fallback : Number(raw);
  if (value === undefined || !Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${options.integer ? "an integer" : "a number"}`);
  }
  if (options.min !== undefined && value < options.min) throw new Error(`${name} must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new Error(`${name} must be at most ${options.max}`);
  return value;
}

export function booleanField(form: FormData, name: string): boolean {
  return ["true", "1", "on", "yes"].includes(String(form.get(name) ?? "").toLowerCase());
}

export function stringList(form: FormData, name: string): string[] {
  const raw = optionalText(form, name);
  if (!raw) return [];
  return [...new Set(raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))];
}

export function jsonObject(form: FormData, name: string): Record<string, unknown> {
  const raw = optionalText(form, name);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function jsonArray(form: FormData, name: string): unknown[] {
  const raw = optionalText(form, name);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array`);
  return value;
}

export { agentRequest };
