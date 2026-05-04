import { Injectable } from "@nestjs/common";

interface SafetyFlag {
  type: "pii" | "injection" | "exfiltration" | "grounded" | "tool_param";
  severity: "low" | "medium" | "high";
  detail: string;
  matchedText?: string;
  piiType?: string;
  injectionPattern?: string;
}

export interface SafetyCheckResult {
  passed: boolean;
  flags: Array<SafetyFlag>;
}

/**
 * Theme H.1 — PII detection policy.
 * "redact" replaces matches with `[<TYPE>]`, "warn" flags without blocking,
 * "block" fails the turn on high-severity matches.
 */
export type SafetyPolicy = "allow" | "warn" | "redact" | "block";

export interface SafetyPolicyConfig {
  pii: SafetyPolicy;
  injection: SafetyPolicy;
  exfiltration: SafetyPolicy;
  grounded: SafetyPolicy;
}

const DEFAULT_POLICY: SafetyPolicyConfig = {
  pii: "warn",
  injection: "block",
  exfiltration: "warn",
  grounded: "warn",
};

// PII patterns — regex-based detection.
const PII_PATTERNS: Array<{ type: string; pattern: RegExp; severity: "low" | "medium" | "high" }> = [
  { type: "credit_card", pattern: /\b(?:\d[ -]*?){13,19}\b/g, severity: "high" },
  { type: "ssn", pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, severity: "high" },
  { type: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, severity: "low" },
  { type: "phone", pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, severity: "medium" },
  { type: "ip_address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, severity: "low" },
  { type: "aadhaar", pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, severity: "high" },
  { type: "pan", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, severity: "high" },
  // Theme H.1 — additional high-signal patterns
  { type: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, severity: "high" },
  { type: "us_passport", pattern: /\b[A-Z]\d{8}\b/g, severity: "high" },
  { type: "aws_access_key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: "high" },
];

// Prompt injection patterns
const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: "medium" | "high"; name: string }> = [
  { name: "ignore_previous", pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)/i, severity: "high" },
  { name: "you_are_now", pattern: /you\s+are\s+now\s+(a|an)\s+/i, severity: "medium" },
  { name: "system_hijack", pattern: /system\s*:\s*(you|your|the)\s/i, severity: "high" },
  { name: "dan_mode", pattern: /\bDAN\b.*\bmode\b/i, severity: "high" },
  { name: "pretend", pattern: /pretend\s+(you'?re?|to\s+be)\s/i, severity: "medium" },
  { name: "reveal_prompt", pattern: /reveal\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions)/i, severity: "high" },
  { name: "no_restrictions", pattern: /act\s+as\s+if\s+(you\s+have\s+no|there\s+are\s+no)\s+restrictions/i, severity: "high" },
  { name: "special_tokens", pattern: /\[INST\]|\[\/INST\]|<<SYS>>|<\|im_start\|>/i, severity: "high" },
  // Theme H.2 — tool-output exfiltration framing
  { name: "exfil_url", pattern: /(?:exfiltrate|send|leak|post)\s+(?:the\s+)?(?:data|content|text)\s+to\s+https?:\/\//i, severity: "high" },
  { name: "disregard_safety", pattern: /(?:disregard|bypass|skip|override)\s+(?:safety|security|ethical)\s+(?:guidelines|rules|checks)/i, severity: "high" },
];

/**
 * Luhn algorithm for credit card validation.
 */
function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

@Injectable()
export class SafetyService {
  /**
   * Check text for PII, prompt injection, and data exfiltration.
   * Returns all flags; caller applies policy (block vs warn vs redact).
   */
  checkText(text: string): SafetyCheckResult {
    const flags: SafetyFlag[] = [];

    // LAUNCH-10 hardening — defensive null-guard. Malformed request bodies
    // sometimes reach this service with `text=undefined` (e.g. a turn POST
    // missing the expected `message` field). Without the guard, the
    // first `.match()` below throws TypeError and surfaces as a 500. Fail
    // soft: empty input → no flags. Validation upstream still produces
    // a clean 400 for malformed bodies; this just closes the late-fail path.
    if (typeof text !== "string" || text.length === 0) {
      return { passed: true, flags };
    }

    // PII detection
    for (const { type, pattern, severity } of PII_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          if (type === "credit_card" && !luhnCheck(match)) continue;
          flags.push({
            type: "pii",
            severity,
            detail: `${type} detected`,
            matchedText: match.slice(0, 4) + "***",
            piiType: type,
          });
        }
      }
    }

    // Prompt injection detection
    for (const { pattern, severity, name } of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        flags.push({
          type: "injection",
          severity,
          detail: `Potential prompt injection detected (${name})`,
          injectionPattern: name,
        });
      }
    }

    // Data exfiltration detection (unusually large output)
    if (text.length > 50000) {
      flags.push({
        type: "exfiltration",
        severity: "medium",
        detail: `Response unusually large: ${text.length} chars`,
      });
    }

    return {
      passed: flags.filter((f) => f.severity === "high").length === 0,
      flags,
    };
  }

  /**
   * Theme H.1 — redact PII matches in a message body. Replaces matches
   * with `[<TYPE>]` markers. Non-PII flags are left for the policy layer.
   */
  redactPII(text: string): { redacted: string; redactions: Array<{ type: string; count: number }> } {
    const counts = new Map<string, number>();
    let out = text;
    for (const { type, pattern } of PII_PATTERNS) {
      const label = `[${type.toUpperCase()}]`;
      out = out.replace(pattern, (m) => {
        if (type === "credit_card" && !luhnCheck(m)) return m;
        counts.set(type, (counts.get(type) ?? 0) + 1);
        return label;
      });
    }
    const redactions = Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
    return { redacted: out, redactions };
  }

  /**
   * Theme H.3 — Groundedness flag.
   * Compares assistant claims against tool-result sources. Returns a
   * heuristic list of claims that do not appear (lexically) in any source.
   *
   * This is a lightweight baseline; a judge-LLM pass is out of scope for
   * the initial wiring but the plumbing + dashboard card is already here.
   * Operators who want stricter groundedness can plug in a judge model
   * later by overriding this method.
   */
  checkGroundedness(
    assistantText: string,
    sources: string[],
  ): { grounded: boolean; unsupportedClaims: string[] } {
    if (!assistantText || sources.length === 0) {
      return { grounded: true, unsupportedClaims: [] };
    }
    const sourceBlob = sources.join(" \n ").toLowerCase();
    // Sentence-level split; trivial but fine as a first pass.
    const claims = assistantText
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 30);

    const unsupported: string[] = [];
    for (const claim of claims) {
      // Extract content words >=5 chars; if fewer than 3 appear in sources,
      // treat as unsupported. This is deliberately conservative — we err
      // toward flagging, policy layer decides what to do.
      const words = Array.from(
        claim
          .toLowerCase()
          .match(/[a-z][a-z0-9]{4,}/g) ?? [],
      );
      const unique = Array.from(new Set(words));
      if (unique.length < 4) continue; // too-short claim, skip
      const matched = unique.filter((w) => sourceBlob.includes(w));
      if (matched.length < Math.ceil(unique.length * 0.3)) {
        unsupported.push(claim);
      }
    }
    return { grounded: unsupported.length === 0, unsupportedClaims: unsupported };
  }

  /**
   * Theme H.9 — tool-call parameter scan.
   *
   * Scans stringified tool params for PII + injection patterns before
   * dispatch. Policy-driven — on "block" and high-severity hits, the gate
   * refuses to call the tool.
   */
  scanToolParams(
    toolName: string,
    params: Record<string, unknown> | null | undefined,
    policy: SafetyPolicyConfig = DEFAULT_POLICY,
  ): SafetyCheckResult {
    if (!params || typeof params !== "object") {
      return { passed: true, flags: [] };
    }
    const flat = JSON.stringify(params);
    const result = this.checkText(flat);
    // Re-tag flags as "tool_param" so consumers can distinguish message-level
    // vs call-level events.
    const tagged: SafetyFlag[] = result.flags.map((f) => ({
      ...f,
      type: "tool_param",
      detail: `${f.detail} (tool=${toolName})`,
    }));
    const highOrInjection = tagged.filter(
      (f) => f.severity === "high" || (policy.injection === "block" && f.injectionPattern),
    );
    const passed =
      policy.pii !== "block" || !tagged.some((f) => f.piiType && f.severity === "high")
        ? highOrInjection.length === 0 || policy.injection !== "block"
        : false;
    return { passed, flags: tagged };
  }

  /**
   * Resolve a SafetyPolicyConfig, falling back to defaults for missing
   * fields. Accepts partial configs from the agent config's `safetyPolicy`
   * column (future).
   */
  resolvePolicy(partial?: Partial<SafetyPolicyConfig> | null): SafetyPolicyConfig {
    return { ...DEFAULT_POLICY, ...(partial ?? {}) };
  }
}
