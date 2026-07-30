/**
 * Volatile prompt variables — keep the live clock out of the cached prefix.
 *
 * Anthropic prompt caching matches on the exact bytes of `tools → system →
 * messages`, so ANY byte that changes between turns invalidates the whole
 * prefix from that point on: the system prompt, the tool definitions before it,
 * and every cached message after it. One millisecond-precision timestamp in the
 * system prompt is therefore enough to guarantee a 0% cross-turn hit rate for
 * that agent, no matter how many breakpoints are placed downstream.
 *
 * `user.current_time` is exactly that. Platos auto-injects it into every turn's
 * sessionContext as `new Date().toISOString()`, and `substitutePromptVars`
 * resolves `{{user.current_time}}` wherever it appears — including inside the
 * agent's own systemPrompt, which sits inside the cached region.
 *
 * The repo already solved this shape once, for the `datetime` prompt block: the
 * fresh timestamp is rendered into `dynamicContext` (which is appended to the
 * user message, i.e. AFTER the last cache breakpoint) rather than into the
 * cached systemPrompt. This module extends that same fix to the promptVar path.
 *
 * The substitution is a POINTER, not a stale value. Writing a stale timestamp
 * into the prompt would be worse than the cache miss — the model would see two
 * contradictory times. Writing a pointer keeps the prompt truthful and keeps the
 * authoritative value exactly one place: the post-breakpoint `<context>` block,
 * which the caller is guaranteed to receive because relocation reports back that
 * it happened.
 *
 * Pure and dependency-free so it unit tests without Nest, the SDK, or a network.
 */

/**
 * Session-context keys whose value is a live clock reading by definition, and
 * so must never be baked into the cached prefix.
 *
 * Deliberately narrow. It is tempting to relocate anything that merely *looks*
 * like an ISO timestamp, but a fixed timestamp (`contract.signed_at`) is
 * perfectly cache-stable — it does not change between turns — and replacing it
 * with a pointer would degrade the prompt for no cache benefit. Only keys that
 * mean "now" belong here.
 */
export const VOLATILE_PROMPT_VAR_PATHS: readonly string[] = ["user.current_time"];

/**
 * What replaces the placeholder inside the cached region. Names the block the
 * live value actually lands in (`renderDateTimeBlockText` emits
 * `Current date: … Current time: … UTC.`) so the model can follow the pointer.
 */
export const VOLATILE_VAR_POINTER =
  '(see "Current time" in the <context> block of the latest message)';

export interface RelocateResult {
  /** The prompt with volatile placeholders swapped for the pointer. */
  prompt: string;
  /**
   * Which volatile paths were actually present. Non-empty means the caller MUST
   * ensure a fresh datetime block is present post-breakpoint, or the pointer
   * dangles.
   */
  relocated: string[];
}

/** Escape a dotted context path for embedding in a RegExp. */
function escapeForRegExp(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace `{{user.current_time}}`-style placeholders with a pointer to the
 * post-breakpoint context block.
 *
 * Whitespace-tolerant (`{{ user.current_time }}`) to match
 * `substitutePromptVars`, which accepts `\s*` around the key. Anything else is
 * left untouched — this runs BEFORE substitution, so every non-volatile
 * placeholder still resolves normally.
 *
 * Honours `promptVars` (the operator's substitution allow-list): if the operator
 * declared an allow-list that excludes `user.current_time`, then substitution
 * would have left the placeholder verbatim anyway, so relocating it would change
 * behaviour rather than preserve it.
 */
export function relocateVolatilePromptVars(
  prompt: string | null | undefined,
  options?: { promptVars?: string[]; paths?: readonly string[] },
): RelocateResult {
  const paths = options?.paths ?? VOLATILE_PROMPT_VAR_PATHS;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { prompt: prompt ?? "", relocated: [] };
  }
  const allow =
    Array.isArray(options?.promptVars) && options!.promptVars!.length > 0
      ? new Set(options!.promptVars!)
      : null;

  let out = prompt;
  const relocated: string[] = [];
  for (const path of paths) {
    if (allow && !allow.has(path)) continue;
    const re = new RegExp(`\\{\\{\\s*${escapeForRegExp(path)}\\s*\\}\\}`, "g");
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, VOLATILE_VAR_POINTER);
    relocated.push(path);
  }
  return { prompt: out, relocated };
}
