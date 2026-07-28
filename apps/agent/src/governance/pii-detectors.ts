/**
 * PIFSP-18 — PII detector catalogue.
 *
 * Each entry has a regex (with the global flag so .exec() advances) and an
 * optional checksum validator for high-precision kinds (Aadhaar, credit cards)
 * to cut false positives from random digit sequences.
 *
 * All regexes are compiled once at module load. Keep them stateless — the
 * `global` flag means they carry internal `.lastIndex` state; callers MUST
 * reset lastIndex (or re-construct) between calls. PiiFilterService handles
 * this by using `String.prototype.matchAll` which creates fresh iterators.
 */

export type PiiKind =
  | "aadhaar"
  | "pan"
  | "credit_card"
  | "phone_in"
  | "phone_us"
  | "email"
  | "ip_address"
  | "passport_in"
  | "ssn_us"
  | "custom";

export interface PiiDetector {
  kind: PiiKind | string;
  label: string;
  regex: RegExp;
  /** Optional checksum for precision — returns true if match looks valid. */
  validate?: (match: string) => boolean;
}

// ─── Checksum helpers ────────────────────────────────────────────────────────

/** Luhn algorithm for credit card numbers. */
function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Verhoeff algorithm for Aadhaar numbers. Exported so the safety-service
 * checkText PII pass can checksum-validate its aadhaar hits the same way
 * this catalogue does (12 random digits ≈ 10% false-positive rate without it,
 * and phone numbers with country codes are 12 digits). */
export function verhoeff(digits: string): boolean {
  const d = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ] as const;
  const p = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ] as const;
  const inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const pi = (digits.length - i - 1) % 8;
    const di = parseInt(digits[i]!, 10);
    c = d[c]![p[pi]![di]!]!;
  }
  return inv[c] === 0;
}

// ─── Catalogue ────────────────────────────────────────────────────────────────

export const PII_DETECTORS: Record<string, PiiDetector> = {
  aadhaar: {
    kind: "aadhaar",
    label: "Aadhaar (India 12-digit UID)",
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: (m) => verhoeff(m.replace(/[\s-]/g, "")),
  },
  pan: {
    kind: "pan",
    label: "PAN (India 10-char tax ID)",
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  },
  credit_card: {
    kind: "credit_card",
    label: "Credit card number",
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (m) => luhn(m.replace(/[^0-9]/g, "")),
  },
  phone_in: {
    kind: "phone_in",
    label: "Indian phone number",
    regex: /(?:\+91|91)?[ -]?[6-9]\d{9}\b/g,
  },
  phone_us: {
    kind: "phone_us",
    label: "US phone number",
    regex: /\b\d{3}[-.s]?\d{3}[-.s]?\d{4}\b/g,
  },
  email: {
    kind: "email",
    label: "Email address",
    regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  },
  ip_address: {
    kind: "ip_address",
    label: "IPv4 address",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  passport_in: {
    kind: "passport_in",
    label: "Indian passport number",
    regex: /\b[A-Z]\d{7}\b/g,
  },
  ssn_us: {
    kind: "ssn_us",
    label: "US SSN",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
};
