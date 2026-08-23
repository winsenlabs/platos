import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page } from "~/components/platos/DashboardShell";
import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  PanelFailure,
  SectionHeader,
  StatusChip,
} from "~/components/platos/ProductPrimitives";
import { asArray, asBoolean, asRecord, asString, firstArray } from "~/components/platos/safe";
import { requireEnvironmentScope } from "~/services/auth.server";
import { credentialErrorMessage, credentialPanel, credentialRequest } from "~/services/platosAgent.server";

async function scoped(args: LoaderFunctionArgs | ActionFunctionArgs, access: "metadata" | "secret:mutate") {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  return requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access });
}

export async function loader(args: LoaderFunctionArgs) {
  const { scope } = await scoped(args, "metadata");
  const [providers, keys, models] = await Promise.all([
    credentialPanel("/api/v1/agent/providers", scope),
    credentialPanel("/api/v1/agent/providers/keys", scope),
    credentialPanel("/api/v1/agent/providers/models", scope),
  ]);
  return json({ providers, keys, models });
}

function safeProvider(value: FormDataEntryValue | null): string {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,48}$/.test(provider)) throw new Error("Invalid provider");
  return provider;
}

function safeId(value: FormDataEntryValue | null): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid key id");
  return id;
}

export async function action(args: ActionFunctionArgs) {
  const { scope } = await scoped(args, "secret:mutate");
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  if ([...form.keys()].some((key) => key !== "intent" && /secret|apiKey|rawKey|credentialValue/i.test(key))) {
    return json({ ok: false, error: "Provider key material is not accepted by this route" }, { status: 400 });
  }

  try {
    let result: unknown;
    if (intent === "create-key") {
      result = await credentialRequest("/api/v1/agent/providers/keys", scope, {
        method: "POST",
        body: {
          provider: safeProvider(form.get("provider")),
          label: String(form.get("label") ?? "").trim(),
          envVarName: String(form.get("envVarName") ?? "").trim(),
          isDefault: form.get("isDefault") === "on",
        },
      });
    } else if (intent === "create-secret") {
      const plaintext = String(form.get("plaintext") ?? "");
      if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid provider secret");
      result = await credentialRequest("/api/v1/agent/providers/keys/byok", scope, {
        method: "POST",
        body: {
          provider: safeProvider(form.get("provider")),
          label: String(form.get("label") ?? "").trim(),
          envVarName: String(form.get("envVarName") ?? "").trim(),
          plaintext,
          isDefault: form.get("isDefault") === "on",
        },
      });
    } else if (intent === "rotate-secret") {
      const plaintext = String(form.get("plaintext") ?? "");
      if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid provider secret");
      result = await credentialRequest(
        `/api/v1/agent/providers/keys/${encodeURIComponent(safeId(form.get("keyId")))}/rotate-secret`,
        scope,
        { method: "POST", body: { plaintext } },
      );
    } else if (intent === "default-key") {
      result = await credentialRequest(`/api/v1/agent/providers/keys/${encodeURIComponent(safeId(form.get("keyId")))}`, scope, {
        method: "PATCH",
        body: { isDefault: true },
      });
    } else if (intent === "delete-key") {
      result = await credentialRequest(`/api/v1/agent/providers/keys/${encodeURIComponent(safeId(form.get("keyId")))}`, scope, { method: "DELETE" });
    } else if (intent === "probe") {
      result = await credentialRequest(`/api/v1/agent/providers/${encodeURIComponent(safeProvider(form.get("provider")))}/health`, scope);
    } else if (intent === "link" || intent === "unlink") {
      result = await credentialRequest(`/api/v1/agent/providers/${encodeURIComponent(safeProvider(form.get("provider")))}/link`, scope, { method: intent === "link" ? "POST" : "DELETE" });
    } else if (intent === "toggle") {
      result = await credentialRequest(`/api/v1/agent/providers/${encodeURIComponent(safeProvider(form.get("provider")))}`, scope, {
        method: "PATCH",
        body: { enabled: form.get("enabled") === "true" },
      });
    } else {
      return json({ ok: false, error: "Unsupported provider operation" }, { status: 400 });
    }
    return json({ ok: true, result });
  } catch (error) {
    return json({ ok: false, error: credentialErrorMessage(error, "Provider operation") }, { status: 400 });
  }
}

const fieldClass = "mt-1 w-full rounded-md border border-grid-bright bg-background-bright px-3 py-2 text-sm text-text-bright";

function providerId(value: unknown, index: number): string {
  const provider = asRecord(value);
  return asString(provider.id, asString(provider.displayName, `provider-${index + 1}`)).toLowerCase();
}

function modelRows(value: unknown): Array<{ provider: string; displayName: string; model: string }> {
  return asArray(value).flatMap((entry, providerIndex) => {
    const provider = asRecord(entry);
    const id = asString(provider.provider, asString(provider.displayName, `Provider ${providerIndex + 1}`));
    return asArray(provider.models).map((model) => ({
      provider: id,
      displayName: asString(provider.displayName, id),
      model: asString(model, "Unknown model"),
    }));
  });
}

export default function ProvidersRoute() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const providerRows = data.providers.ok ? firstArray(asRecord(data.providers.data), "providers", "items") : [];
  const keyRows = data.keys.ok ? firstArray(asRecord(data.keys.data), "keys", "items") : [];
  const catalogue = modelRows(data.models.ok ? data.models.data : []);
  const busy = fetcher.state !== "idle";
  const missing = providerRows.filter((value) => !asBoolean(asRecord(value).envReady));
  const feedbackError = fetcher.data && "error" in fetcher.data
    ? asString(fetcher.data.error, "The operation failed without exposing credential detail.")
    : "The operation failed without exposing credential detail.";

  return (
    <Page>
      <PageHeader
        title="Providers and model routes"
        description="Credential readiness and model availability from safe Environment metadata. Stored provider secrets are never revealed after submission."
        breadcrumbs={[{ label: "Platos" }, { label: "Providers" }]}
        actions={<StatusChip tone={missing.length ? "warning" : "good"}>{missing.length ? `${missing.length} need credentials` : "Provider routes ready"}</StatusChip>}
      />

      {fetcher.data && (
        <div className="mb-5">
          {fetcher.data.ok
            ? <Alert tone="good" title="Provider operation persisted">The canonical Agent API accepted the operation. Credential material was not returned or rendered.</Alert>
            : <Alert tone="danger" title="Provider operation failed">{feedbackError}</Alert>}
        </div>
      )}

      {missing.length > 0 && (
        <Alert tone="warning" title="One or more provider routes are inert">
          A missing same-Environment credential keeps the affected provider unavailable. Platos does not fall back to deployment environment variables.
        </Alert>
      )}

      <section className="mt-5">
        <SectionHeader title="Provider readiness" description="Run a live probe only after the provider is linked to safe credential metadata." />
        {!data.providers.ok ? <PanelFailure error={data.providers.error} /> : providerRows.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {providerRows.map((value, index) => {
              const provider = asRecord(value);
              const id = providerId(value, index);
              const linked = asBoolean(provider.linked);
              const enabled = asBoolean(provider.enabled);
              const ready = asBoolean(provider.envReady);
              const models = asArray(provider.models);
              return (
                <Panel key={id} tone={!ready ? "warning" : "default"} className="min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-semibold">{asString(provider.displayName, id)}</h2>
                      <p className="mt-1 break-words text-xs text-text-dimmed">{asString(provider.description, "Environment-scoped model provider")}</p>
                    </div>
                    <StatusChip tone={ready && linked && enabled ? "good" : ready ? "accent" : "warning"}>
                      {ready && linked && enabled ? "ready" : ready ? "credential ready" : "credential required"}
                    </StatusChip>
                  </div>
                  <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs">
                    <div className="min-w-0"><dt className="text-text-dimmed">Probe model</dt><dd className="mt-1 break-all font-mono">{asString(provider.probeModel, "catalog default")}</dd></div>
                    <div className="min-w-0"><dt className="text-text-dimmed">Catalogue</dt><dd className="mt-1">{models.length} model{models.length === 1 ? "" : "s"}</dd></div>
                    <div className="min-w-0"><dt className="text-text-dimmed">Credential</dt><dd className="mt-1">{linked ? "Linked" : "Not linked"}</dd></div>
                    <div className="min-w-0"><dt className="text-text-dimmed">Runtime</dt><dd className="mt-1">{enabled ? "Enabled" : "Disabled"}</dd></div>
                  </dl>
                  <fetcher.Form method="post" className="mt-4 flex flex-wrap gap-2">
                    <input type="hidden" name="provider" value={id} />
                    <Button type="submit" name="intent" value="probe" disabled={busy || !ready} className="min-h-8 py-1 text-xs">Test credential</Button>
                    <Button type="submit" name="intent" value={linked ? "unlink" : "link"} disabled={busy || (!ready && !linked)} className="min-h-8 py-1 text-xs">{linked ? "Unlink" : "Link"}</Button>
                    {linked && <Button type="submit" name="intent" value="toggle" disabled={busy} tone="ghost" className="min-h-8 py-1 text-xs">{enabled ? "Disable" : "Enable"}</Button>}
                    {linked && <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />}
                  </fetcher.Form>
                </Panel>
              );
            })}
          </div>
        ) : <EmptyState title="No providers registered" description="The canonical provider endpoint returned no safe provider metadata." />}
      </section>

      <section className="mt-6">
        <SectionHeader title="Credential route readiness" description="Bare credential names are compatibility references; the same-Environment Credential ID remains authoritative." />
        {!data.keys.ok ? <PanelFailure error={data.keys.error} /> : (
          <DataTable
            headers={["Provider", "Credential", "Reference", "Resolution", "Last used", "Actions"]}
            rows={keyRows.map((value, index) => {
              const key = asRecord(value);
              const id = asString(key.id, `key-${index}`);
              return [
                asString(key.provider),
                <div><div className="font-medium">{asString(key.label, "Unnamed credential")}</div><code className="text-[10px] text-text-dimmed">{id}</code></div>,
                <code className="text-xs">{asString(key.envVarName, "No compatibility name")}</code>,
                <StatusChip tone={asBoolean(key.isDefault) ? "accent" : "good"}>{asBoolean(key.isDefault) ? "provider default" : "available"}</StatusChip>,
                asString(key.lastUsedAt, "Never"),
                <fetcher.Form method="post" className="flex flex-wrap gap-3">
                  <input type="hidden" name="keyId" value={id} />
                  {!asBoolean(key.isDefault) && <button name="intent" value="default-key" className="text-xs text-[var(--accent)]">Make default</button>}
                  <button name="intent" value="delete-key" className="text-xs text-[var(--danger)]">Delete</button>
                </fetcher.Form>,
              ];
            })}
            empty={<EmptyState title="No provider credentials" description="Create an encrypted BYOK credential or link a stored same-Environment credential below." />}
          />
        )}
      </section>

      <section className="mt-6">
        <SectionHeader title="Model catalogue" description="Model names come from the canonical provider catalogue. Pricing classes are omitted because this endpoint does not expose pinned rate provenance." />
        {!data.models.ok ? <PanelFailure error={data.models.error} /> : (
          <DataTable
            headers={["Provider", "Display name", "Model", "Rate provenance"]}
            rows={catalogue.map((row) => [row.provider, row.displayName, <code className="text-xs">{row.model}</code>, "Not exposed by catalogue"])}
            empty={<EmptyState title="Model catalogue is empty" description="No canonical provider model names are available for this Environment." />}
          />
        )}
      </section>

      <section className="mt-6">
        <SectionHeader title="Credential operations" description="Guided operations submit plaintext only to the encrypted Environment store. No operation reveals an already-stored value." />
        <div className="grid gap-4 xl:grid-cols-3">
          <fetcher.Form method="post">
            <Panel className="h-full">
              <input type="hidden" name="intent" value="create-key" />
              <SectionHeader title="Link stored credential" description="Reference an existing bare same-Environment credential name." />
              <label className="block text-xs">Provider<input required name="provider" className={fieldClass} placeholder="anthropic" /></label>
              <label className="mt-3 block text-xs">Label<input required name="label" className={fieldClass} placeholder="Primary" /></label>
              <label className="mt-3 block text-xs">Credential reference<input required name="envVarName" className={`${fieldClass} font-mono`} placeholder="ANTHROPIC_API_KEY" /></label>
              <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="isDefault" /> Default for this provider</label>
              <Button type="submit" disabled={busy} tone="primary" className="mt-4">Link credential</Button>
            </Panel>
          </fetcher.Form>

          <fetcher.Form method="post">
            <Panel className="h-full">
              <input type="hidden" name="intent" value="create-secret" />
              <SectionHeader title="Create encrypted BYOK credential" description="The submitted value is never returned in provider payloads." />
              <label className="block text-xs">Provider<input required name="provider" className={fieldClass} placeholder="anthropic" /></label>
              <label className="mt-3 block text-xs">Label<input required name="label" className={fieldClass} placeholder="Primary" /></label>
              <label className="mt-3 block text-xs">Credential name<input required name="envVarName" className={`${fieldClass} font-mono`} placeholder="ANTHROPIC_API_KEY" /></label>
              <label className="mt-3 block text-xs">Provider secret<input required type="password" autoComplete="new-password" name="plaintext" className={`${fieldClass} font-mono`} /></label>
              <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="isDefault" /> Default for this provider</label>
              <Button type="submit" disabled={busy} tone="primary" className="mt-4">Encrypt and link</Button>
            </Panel>
          </fetcher.Form>

          <fetcher.Form method="post">
            <Panel className="h-full">
              <input type="hidden" name="intent" value="rotate-secret" />
              <SectionHeader title="Rotate encrypted credential" description="Select safe ProviderKey metadata; no manual ID transcription or reveal response." />
              <label className="block text-xs">Provider credential
                <select required name="keyId" className={fieldClass} defaultValue="">
                  <option value="" disabled>Select credential</option>
                  {keyRows.map((value, index) => {
                    const key = asRecord(value);
                    const id = asString(key.id, `key-${index}`);
                    return <option key={id} value={id}>{asString(key.provider)} · {asString(key.label, id)}</option>;
                  })}
                </select>
              </label>
              <label className="mt-3 block text-xs">Replacement secret<input required type="password" autoComplete="new-password" name="plaintext" className={`${fieldClass} font-mono`} /></label>
              <Button type="submit" disabled={busy || !keyRows.length} className="mt-4">Rotate active version</Button>
            </Panel>
          </fetcher.Form>
        </div>
      </section>
    </Page>
  );
}
