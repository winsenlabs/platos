import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";

/**
 * Scope-aware model picker.
 *
 * Driven by the agent service's `/api/v1/agent/providers` endpoint, which
 * returns every provider manifest tagged with `envReady` + `enabled` for
 * the current `(org, project, env)`. Only providers that are BOTH enabled
 * AND envReady are shown as selectable options. Unlinked providers are
 * rendered as a disabled group with a "Link env" link to `/agent-providers`.
 *
 * Used by both the `/agents/new` create flow and the `/agents/:id` edit flow.
 */

export type ProviderForPicker = {
  id: string;
  displayName: string;
  envReady: boolean;
  enabled: boolean;
  linked: boolean;
  models: string[];
};

export type ModelPickerProps = {
  name: string;
  providers: ProviderForPicker[];
  /** Selected model string, e.g. "anthropic:claude-sonnet-4-6". */
  defaultValue?: string;
  /** Path to `/agent-providers` — shown in the CTA when no providers are enabled. */
  providersPath: string;
  className?: string;
  /** Whitelist subset (e.g. sub-agent picker allows only a few). */
  restrictToModels?: string[];
};

export function ModelPicker(props: ModelPickerProps) {
  const ready = props.providers.filter((p) => p.envReady && p.enabled);
  const unready = props.providers.filter((p) => !p.envReady || !p.enabled);

  const whitelist = props.restrictToModels ? new Set(props.restrictToModels) : null;
  const filterModels = (models: string[]) =>
    whitelist ? models.filter((m) => whitelist.has(m)) : models;

  const readyModelsCount = ready.reduce((sum, p) => sum + filterModels(p.models).length, 0);

  if (readyModelsCount === 0) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-sm text-amber-400 mb-2">
          <ExclamationTriangleIcon className="size-4 inline mr-1.5" />
          No providers are ready in this environment.
        </p>
        <p className="text-xs text-text-dimmed">
          Set the required env vars and enable at least one provider on{" "}
          <Link to={props.providersPath} className="underline text-text-bright">
            the Providers page
          </Link>
          . Until then, agents created here will fall back to the process-level default provider.
        </p>
        <input
          type="hidden"
          name={props.name}
          value={props.defaultValue || "anthropic:claude-sonnet-4-6"}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <select
        name={props.name}
        defaultValue={props.defaultValue}
        className={
          props.className ||
          "w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
        }
      >
        {ready.map((p) => {
          const models = filterModels(p.models);
          if (models.length === 0) return null;
          return (
            <optgroup key={p.id} label={p.displayName}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          );
        })}
        {unready.length > 0 && (
          <optgroup label="— not available (link env vars) —">
            {unready.map((p) => (
              <option key={p.id} value={p.id} disabled>
                {p.displayName} (env not ready)
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {unready.length > 0 && (
        <p className="text-[11px] text-text-dimmed">
          {unready.length} provider{unready.length === 1 ? "" : "s"} need env vars —{" "}
          <Link to={props.providersPath} className="underline text-text-bright">
            manage on the Providers page
          </Link>
          .
        </p>
      )}
    </div>
  );
}
