/**
 * PIFSP-18 — PII filter service.
 *
 * Scans text against the configured per-agent governance policy and returns:
 *   - action: "allow" | "block" | "redact" | "warn"
 *   - filteredText: original or redacted version
 *   - hits: every match that triggered a filter
 *
 * Design:
 *   - Regex-first (fast, deterministic)
 *   - Optional Verhoeff / Luhn checksum validation for high-precision kinds
 *   - Per-hit mode wins the most restrictive of (block > redact > warn > allow)
 *   - Fail-open: any exception returns { action: "allow", filteredText: text }
 *     so a governance bug never blocks a conversation turn
 */

import { Injectable, Logger } from "@nestjs/common";
import type { RequestScope } from "../auth/scope.guard";
import { PII_DETECTORS } from "./pii-detectors";
import RE2 from "re2";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PiiApplyTo =
  | "user_message"
  | "assistant_response"
  | "tool_args"
  | "tool_result";

export type PiiMode = "block" | "redact" | "warn";

export interface PiiFilterConfig {
  kind: string;
  mode: PiiMode;
  applyTo: PiiApplyTo[];
  customRegex?: string;
  redactReplacement?: string;
}

export interface GovernanceConfig {
  pii?: {
    enabled: boolean;
    filters: PiiFilterConfig[];
    secondaryLlmValidation?: boolean;
  };
}

export interface PiiHit {
  kind: string;
  match: string;
  span: [number, number];
  mode: PiiMode;
  label: string;
}

export interface ScanResult {
  action: "allow" | "block" | "redact" | "warn";
  filteredText: string;
  hits: PiiHit[];
}

// ─── Mode precedence (block > redact > warn > allow) ─────────────────────────

const MODE_RANK: Record<PiiMode, number> = { block: 3, redact: 2, warn: 1 };

function highestMode(modes: PiiMode[]): PiiMode {
  if (modes.includes("block")) return "block";
  if (modes.includes("redact")) return "redact";
  if (modes.includes("warn")) return "warn";
  return "warn";
}

// ─── Custom-regex ReDoS guard (M8) ───────────────────────────────────────────
//
// Admin-supplied customRegex is compiled and run against every scanned message
// on the single event loop. Without an RE2 (linear-time) engine there is no
// reliable in-thread timeout for a synchronous regex, so we defend at the
// config boundary: (1) cap pattern length, (2) reject patterns with a nested
// quantifier — a quantified group whose body already contains a quantifier,
// the classic catastrophic-backtracking shape ((a+)+, (.*)*, (a?)+ …), and
// (3) bound the input length any custom pattern is scanned against so a
// pathological pattern that slips the heuristic still has a bounded worst case.
// NOTE: heuristic-only — the durable fix is to run custom patterns through RE2.

const MAX_CUSTOM_REGEX_LEN = 512;
const MAX_CUSTOM_SCAN_INPUT = 50_000;
// A group containing *,+,? that is itself quantified by *,+,? or {n}.
const NESTED_QUANTIFIER = /\([^()]*[*+?][^()]*\)[*+?{]/;

function isSafeCustomRegex(pattern: string): boolean {
  if (pattern.length > MAX_CUSTOM_REGEX_LEN) return false;
  if (NESTED_QUANTIFIER.test(pattern)) return false;
  return true;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class PiiFilterService {
  private readonly logger = new Logger(PiiFilterService.name);

  /**
   * Scan `text` against the agent's governanceConfig.pii filters.
   * Returns allow immediately when governance is disabled or no filters match.
   *
   * Fail-open: any internal error returns { action: "allow", filteredText: text, hits: [] }.
   */
  async scan(
    text: string,
    governanceConfig: GovernanceConfig | null | undefined,
    applyTo: PiiApplyTo,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "agentId">,
  ): Promise<ScanResult> {
    try {
      return this._scan(text, governanceConfig, applyTo, scope);
    } catch (err) {
      this.logger.error(
        `[pii] scan error for agent=${scope.agentId} applyTo=${applyTo}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { action: "allow", filteredText: text, hits: [] };
    }
  }

  private _scan(
    text: string,
    governanceConfig: GovernanceConfig | null | undefined,
    applyTo: PiiApplyTo,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "agentId">,
  ): ScanResult {
    const pii = governanceConfig?.pii;
    if (!pii?.enabled || !pii.filters?.length) {
      return { action: "allow", filteredText: text, hits: [] };
    }

    const activeFilters = pii.filters.filter((f) => f.applyTo.includes(applyTo));
    if (activeFilters.length === 0) {
      return { action: "allow", filteredText: text, hits: [] };
    }

    const allHits: PiiHit[] = [];

    for (const filter of activeFilters) {
      const detector = PII_DETECTORS[filter.kind];
      // Custom regex or known detector regex
      let regex: RegExp | RE2;
      if (filter.kind === "custom" && filter.customRegex) {
        if (!isSafeCustomRegex(filter.customRegex)) {
          this.logger.warn(
            `[pii] rejected unsafe customRegex (length/nested-quantifier) for agent=${scope.agentId}: ${filter.customRegex.slice(0, 128)}`,
          );
          continue;
        }
        try {
          // M8 durable fix — compile admin-supplied patterns with RE2 (linear
          // time, no backtracking) so no custom regex can catastrophically blow
          // up the single event loop. RE2 throws on invalid patterns AND on
          // shapes it does not support (backreferences, lookaround); both fall
          // through to skip-the-filter — the same fail-safe the old RegExp path
          // had. The length cap in isSafeCustomRegex and the
          // MAX_CUSTOM_SCAN_INPUT slice below stay as cheap pre-filters, and
          // RE2 closes the alternation-overlap shapes ((a|ab)*) the heuristic
          // missed.
          regex = new RE2(filter.customRegex, "g");
        } catch {
          this.logger.warn(`[pii] invalid or unsupported customRegex for filter kind=custom: ${filter.customRegex}`);
          continue;
        }
      } else if (detector) {
        // Re-create from source so lastIndex doesn't leak between calls
        regex = new RegExp(detector.regex.source, "g");
      } else {
        continue;
      }

      const label = detector?.label ?? filter.kind;
      // M8 — bound the input a custom pattern is scanned against; a prefix
      // slice keeps match spans (m.index) valid against the original text.
      // Built-in detector kinds still scan the full text unchanged.
      const scanTarget =
        filter.kind === "custom" && text.length > MAX_CUSTOM_SCAN_INPUT
          ? text.slice(0, MAX_CUSTOM_SCAN_INPUT)
          : text;
      // RE2 does NOT implement String.prototype.matchAll, so we drive both
      // engines through the exec()/lastIndex contract that RegExp and RE2 both
      // honor under the global flag. m.index / m[0] carry the exact same
      // redaction-span semantics matchAll gave us.
      let m: RegExpExecArray | null;
      while ((m = regex.exec(scanTarget)) !== null) {
        const match = m[0];
        // matchAll advanced past zero-width matches internally; the manual
        // exec loop must bump lastIndex itself or it spins forever.
        if (match.length === 0) regex.lastIndex++;
        // Validate checksum if available
        if (detector?.validate && !detector.validate(match)) continue;
        allHits.push({
          kind: filter.kind,
          match,
          span: [m.index, m.index + match.length],
          mode: filter.mode,
          label,
        });
      }
    }

    if (allHits.length === 0) {
      return { action: "allow", filteredText: text, hits: [] };
    }

    const topMode = highestMode(allHits.map((h) => h.mode));

    if (topMode === "block") {
      this.logger.warn(
        `[pii] BLOCK: agent=${scope.agentId} applyTo=${applyTo} kinds=${allHits.map((h) => h.kind).join(",")}`,
      );
      return { action: "block", filteredText: text, hits: allHits };
    }

    if (topMode === "redact") {
      // Redact all redact+block hits in reverse span order so indexes stay valid
      const toRedact = allHits.filter((h) => h.mode === "redact" || h.mode === "block");
      const sorted = [...toRedact].sort((a, b) => b.span[0] - a.span[0]);
      let result = text;
      for (const hit of sorted) {
        const activeFilter = activeFilters.find((f) => f.kind === hit.kind);
        const replacement = activeFilter?.redactReplacement ?? `[REDACTED:${hit.kind}]`;
        result = result.slice(0, hit.span[0]) + replacement + result.slice(hit.span[1]);
      }
      this.logger.log(
        `[pii] REDACT: agent=${scope.agentId} applyTo=${applyTo} ${toRedact.length} hit(s)`,
      );
      return { action: "redact", filteredText: result, hits: allHits };
    }

    // warn — log + pass through
    this.logger.warn(
      `[pii] WARN: agent=${scope.agentId} applyTo=${applyTo} kinds=${allHits.map((h) => h.kind).join(",")}`,
    );
    return { action: "warn", filteredText: text, hits: allHits };
  }
}
