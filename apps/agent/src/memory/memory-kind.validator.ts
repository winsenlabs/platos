import { z } from "zod";
import {
  MEMORY_KINDS,
  normalizeMemoryProfileKey,
  type MemoryKind,
} from "@platos/tenancy-database";

/**
 * Theme O.4 — memory-kind validator.
 *
 * Each `kind` in clean `Memory` has its own content + metadata expectations.
 * Keeping them as Zod schemas here lets both the REST controller and the
 * `remember` meta-tool pipe inputs through the same gate before they touch
 * the embedding service or the DB.
 *
 * The content rules are deliberately permissive — we don't want to reject a
 * perfectly reasonable fact because the extractor happened to write two
 * sentences. The validator's goal is structural: require non-empty content,
 * require the metadata shape, keep the taxonomy predictable.
 *
 * Invariants honoured here:
 *   - "relationship" memories MUST carry { from, to, type } in metadata,
 *     so a relationship memory always links back to an addressable pair
 *     even when the KG tables aren't updated (see O.4 spec).
 *   - "event" memory `at` timestamps, when present, are valid ISO strings.
 */

const BASE_CONTENT = z
  .string()
  .trim()
  .min(1, "content must be non-empty")
  .max(4000, "content exceeds 4000 character cap");

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const factMetadata = z
  .object({
    subject: z.string().optional(),
    topic: z.string().optional(),
  })
  .catchall(z.unknown())
  .optional()
  .nullable();

const preferenceMetadata = z
  .object({
    over: z.array(z.string()).optional(),
    ordering: z
      .union([z.literal("prefer_a_over_b"), z.string()])
      .optional(),
  })
  .catchall(z.unknown())
  .optional()
  .nullable();

const eventMetadata = z
  .object({
    at: z
      .string()
      .refine(
        (v) => ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v)),
        "`at` must be a valid ISO datetime",
      )
      .optional(),
    location: z.string().optional(),
    participants: z.array(z.string()).optional(),
  })
  .catchall(z.unknown())
  .optional()
  .nullable();

const relationshipMetadata = z
  .object({
    from: z.string().min(1, "metadata.from is required for relationship memories"),
    to: z.string().min(1, "metadata.to is required for relationship memories"),
    type: z.string().min(1, "metadata.type is required for relationship memories"),
  })
  .catchall(z.unknown());

/**
 * Theme M.1 — "profile" memory kind.
 *
 * A structured per-user fact keyed by `metadata.profileKey` (e.g. "name",
 * "role", "preferences.theme"). Unlike "fact", profile rows are a
 * denormalized view meant for turn-start prelude lookup (M.5) and explicit
 * write via the profile meta-tool (M.2). One row per (user, profileKey) is
 * the canonical shape — the profile writer upserts rather than appending.
 */
const profileMetadata = z
  .object({
    profileKey: z
      .string()
      .trim()
      .min(1, "metadata.profileKey is required for profile memories"),
  })
  .catchall(z.unknown())
  .transform((metadata) => ({
    ...metadata,
    profileKey: normalizeMemoryProfileKey(metadata.profileKey),
  }));

const kindSchemas = {
  fact: z.object({
    kind: z.literal("fact"),
    content: BASE_CONTENT,
    metadata: factMetadata,
  }),
  preference: z.object({
    kind: z.literal("preference"),
    content: BASE_CONTENT,
    metadata: preferenceMetadata,
  }),
  event: z.object({
    kind: z.literal("event"),
    content: BASE_CONTENT,
    metadata: eventMetadata,
  }),
  relationship: z.object({
    kind: z.literal("relationship"),
    content: BASE_CONTENT,
    metadata: relationshipMetadata,
  }),
  profile: z.object({
    kind: z.literal("profile"),
    content: BASE_CONTENT,
    metadata: profileMetadata,
  }),
} as const;

export { MEMORY_KINDS, type MemoryKind };

export interface MemoryValidationInput {
  kind?: string;
  content: string;
  metadata?: unknown;
}

export interface MemoryValidationResult {
  ok: true;
  kind: MemoryKind;
  content: string;
  metadata: unknown;
}

export interface MemoryValidationFailure {
  ok: false;
  errors: string[];
}

/**
 * Validate a memory add / update payload. Returns a tagged result so
 * callers can branch without catching exceptions. The REST controller
 * maps failures to HTTP 400; the meta-tool returns them as the tool
 * result error so the agent can retry with corrected content.
 */
export function validateMemoryPayload(
  input: MemoryValidationInput,
): MemoryValidationResult | MemoryValidationFailure {
  const kind = (input.kind || "fact").toLowerCase();
  if (!MEMORY_KINDS.includes(kind as MemoryKind)) {
    return {
      ok: false,
      errors: [
        `kind must be one of ${MEMORY_KINDS.join(", ")} (got "${input.kind}")`,
      ],
    };
  }

  const schema = kindSchemas[kind as MemoryKind];
  const parsed = schema.safeParse({
    kind,
    content: input.content,
    metadata: input.metadata ?? null,
  });
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  const value = parsed.data;
  return {
    ok: true,
    kind: value.kind,
    content: value.content,
    metadata: value.metadata ?? null,
  };
}

/**
 * Throwing wrapper — used by MemoryService.add() so the REST controller's
 * outer try/catch surfaces a single `error` key. The controller maps it
 * to HTTP 400.
 */
export function requireValidMemoryPayload(
  input: MemoryValidationInput,
): MemoryValidationResult {
  const out = validateMemoryPayload(input);
  if (!out.ok) {
    const msg = `MemoryKindValidator: ${out.errors.join("; ")}`;
    const err = new Error(msg);
    (err as any).status = 400;
    (err as any).validationErrors = out.errors;
    throw err;
  }
  return out;
}
