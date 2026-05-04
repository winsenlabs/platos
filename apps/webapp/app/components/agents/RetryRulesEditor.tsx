/**
 * LAUNCH-2 phase 2 — per-agent retry/fallback waterfall editor.
 *
 * Lets the operator declare rules like:
 *   - "On rate-limit → wait Retry-After, retry 2x"
 *   - "On temporary 5xx → retry 3x with exp backoff, then fall back to <route>"
 *   - "On auth-error → fail immediately"
 *   - "On network-error → retry 1x"
 *
 * Mirrors the `ModelRoutesEditor` pattern: rule cards, add/remove,
 * hidden JSON input named `name`, parsed in the form action.
 *
 * The shape on the wire is:
 *   { rules: Array<{ trigger, action, retryCount?, backoffMs?,
 *                    backoffMultiplier?, waitForRetryAfter?,
 *                    fallbackToRouteLabel? }> }
 *
 * When the operator hasn't configured anything, the agent runtime falls
 * back to `DEFAULT_RETRY_RULES` from `apps/agent/src/agent-runtime/retry-fetch.ts`
 * (retry 2x on 429/5xx, fail-fast on 401/403, retry once on network error).
 */

import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";

export type RetryTrigger =
  | "rate-limit"
  | "temporary-error"
  | "auth-error"
  | "network-error";

export type RetryAction = "fail" | "retry" | "fallback";

export interface RetryRule {
  trigger: RetryTrigger;
  action: RetryAction;
  retryCount?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  waitForRetryAfter?: boolean;
  fallbackToRouteLabel?: string;
}

interface Props {
  /** Hidden input name — receives the JSON-serialised `{rules: [...]}` shape. */
  name: string;
  /** Current rules from the agent (empty for new agents). */
  initialRules?: RetryRule[];
  /** Available model-route labels for the fallback target picker. Pass `agent.modelRoutes.map(r => r.label)`. */
  routeLabels?: string[];
}

const TRIGGERS: Array<{ value: RetryTrigger; label: string; hint: string }> = [
  { value: "rate-limit", label: "Rate limit (429)", hint: "Provider returned 429 Too Many Requests" },
  { value: "temporary-error", label: "Temporary error (5xx)", hint: "408 / 500 / 502 / 503 / 504" },
  { value: "auth-error", label: "Auth error (401 / 403)", hint: "Invalid or expired API key" },
  { value: "network-error", label: "Network error", hint: "fetch threw — DNS, TCP reset, abort" },
];

const ACTIONS: Array<{ value: RetryAction; label: string; hint: string }> = [
  { value: "retry", label: "Retry", hint: "Retry up to N times with exp backoff" },
  { value: "fail", label: "Fail fast", hint: "Surface the error immediately, no retries" },
  { value: "fallback", label: "Fallback to another route", hint: "Switch to a different model route" },
];

const DEFAULT_RULE: RetryRule = {
  trigger: "rate-limit",
  action: "retry",
  retryCount: 2,
  backoffMs: 500,
  backoffMultiplier: 2,
  waitForRetryAfter: true,
};

export function RetryRulesEditor({ name, initialRules, routeLabels }: Props) {
  const [rules, setRules] = useState<RetryRule[]>(initialRules ?? []);
  const [serialized, setSerialized] = useState<string>("");

  useEffect(() => {
    setSerialized(rules.length === 0 ? "" : JSON.stringify({ rules }));
  }, [rules]);

  const addRule = () => setRules((prev) => [...prev, { ...DEFAULT_RULE }]);
  const removeRule = (i: number) =>
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<RetryRule>) =>
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-text-dimmed max-w-prose">
          Declare a waterfall of how the agent reacts to provider failures. Each rule fires
          when its trigger matches; the order shown here is the order applied. When no rules
          match, the agent uses sensible built-in defaults (retry 2× on 429/5xx, fail fast
          on auth errors, retry 1× on network errors). Leave the list empty to keep defaults.
        </div>
        <button
          type="button"
          onClick={addRule}
          className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
        >
          <PlusIcon className="size-3" />
          Add rule
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="rounded border border-dashed border-charcoal-700 bg-charcoal-900/40 px-3 py-4 text-[11px] text-text-dimmed text-center">
          No custom rules. Agent uses built-in defaults. Click <span className="text-emerald-300">Add rule</span> to override.
        </div>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule, i) => (
            <li
              key={i}
              className="rounded border border-charcoal-700 bg-charcoal-850 p-3 space-y-2"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-charcoal-700 px-1.5 py-0.5 text-[10px] font-mono text-text-dimmed">
                  #{i + 1}
                </span>
                <span className="text-[11px] text-text-dimmed">When</span>
                <select
                  value={rule.trigger}
                  onChange={(e) =>
                    update(i, { trigger: e.target.value as RetryTrigger })
                  }
                  className="rounded border border-charcoal-600 bg-charcoal-900 px-2 py-0.5 text-xs text-text-bright"
                >
                  {TRIGGERS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <span className="text-[11px] text-text-dimmed">→</span>
                <select
                  value={rule.action}
                  onChange={(e) =>
                    update(i, { action: e.target.value as RetryAction })
                  }
                  className="rounded border border-charcoal-600 bg-charcoal-900 px-2 py-0.5 text-xs text-text-bright"
                >
                  {ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeRule(i)}
                  className="ml-auto rounded p-1 text-rose-400 hover:bg-rose-500/10"
                  title="Remove rule"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>

              {rule.action === "retry" && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <label className="space-y-1">
                    <span className="text-text-dimmed">Retry count</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={rule.retryCount ?? 2}
                      onChange={(e) =>
                        update(i, { retryCount: Math.max(1, Math.min(10, Number(e.target.value))) })
                      }
                      className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-text-dimmed">Initial backoff (ms)</span>
                    <input
                      type="number"
                      min={50}
                      max={10000}
                      step={50}
                      value={rule.backoffMs ?? 500}
                      onChange={(e) =>
                        update(i, { backoffMs: Math.max(50, Math.min(10000, Number(e.target.value))) })
                      }
                      className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-text-dimmed">Multiplier</span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      step={0.5}
                      value={rule.backoffMultiplier ?? 2}
                      onChange={(e) =>
                        update(i, { backoffMultiplier: Math.max(1, Math.min(5, Number(e.target.value))) })
                      }
                      className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                    />
                  </label>
                  {rule.trigger === "rate-limit" && (
                    <label className="col-span-3 inline-flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={!!rule.waitForRetryAfter}
                        onChange={(e) =>
                          update(i, { waitForRetryAfter: e.target.checked })
                        }
                      />
                      <span className="text-text-dimmed">
                        Honor <code>Retry-After</code> header when present (overrides backoff)
                      </span>
                    </label>
                  )}
                </div>
              )}

              {rule.action === "fallback" && (
                <div className="text-[11px] space-y-1">
                  <span className="text-text-dimmed">Fall back to model route:</span>
                  {routeLabels && routeLabels.length > 0 ? (
                    <select
                      value={rule.fallbackToRouteLabel ?? ""}
                      onChange={(e) =>
                        update(i, { fallbackToRouteLabel: e.target.value || undefined })
                      }
                      className="w-full rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                    >
                      <option value="">— pick a route —</option>
                      {routeLabels.map((label) => (
                        <option key={label} value={label}>{label}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-300">
                      No model routes defined. Add at least one route in the Model section
                      above to enable fallback.
                    </div>
                  )}
                </div>
              )}

              {rule.action === "fail" && (
                <div className="text-[11px] text-text-dimmed">
                  Fail fast — error surfaces to the user immediately. Useful for auth
                  errors where retrying the same key won't help.
                </div>
              )}

              <div className="text-[10px] text-text-dimmed italic">
                {TRIGGERS.find((t) => t.value === rule.trigger)?.hint}
              </div>
            </li>
          ))}
        </ul>
      )}

      <input type="hidden" name={name} value={serialized} />
    </div>
  );
}
