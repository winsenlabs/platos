// GENERATED FILE — DO NOT EDIT.
//
// Emitted by `pnpm generate:sdk-v1` (scripts/sdk/v1-contract.mjs) from the V1
// OpenAPI document, the operation manifest and core-api's idempotency policy.
// `pnpm audit:sdk-v1` regenerates this file and fails when the committed copy
// differs, so an edit here is reverted by the next check rather than shipped.

/* eslint-disable */

/** Every `error.code` the canonical taxonomy admits, as the V1 document enumerates it. */
export const WIRE_ERROR_CODES = [
  "ACCESS_KEY_ROTATION_SUPERSEDED",
  "AGENTS_AGENT_ALREADY_EXISTS",
  "AGENTS_AGENT_METADATA_INVALID",
  "AGENTS_AGENT_NOT_BOUND",
  "AGENTS_AGENT_NOT_FOUND",
  "AGENTS_CANARY_ABSENT",
  "AGENTS_CLUSTER_ALREADY_EXISTS",
  "AGENTS_CLUSTER_NOT_FOUND",
  "AGENTS_MACRO_INVALID",
  "AGENTS_MACRO_NOT_EDITABLE",
  "AGENTS_MACRO_NOT_FOUND",
  "AGENTS_MACRO_RECORDING_UNKNOWN",
  "AGENTS_PROVIDER_KEY_UNAVAILABLE",
  "AGENTS_REPOSITORY_UNAVAILABLE",
  "AGENTS_ROUTE_INVALID",
  "AGENTS_ROUTE_NOT_FOUND",
  "AGENTS_SCOPE_MISMATCH",
  "AGENTS_SKILL_NOT_LOADED",
  "AGENTS_TEMPLATE_INVALID",
  "AGENTS_TEMPLATE_NOT_FOUND",
  "AGENTS_VERSION_INVALID",
  "AGENTS_VERSION_NOT_FOUND",
  "BOOTSTRAP_GRANT_UNAVAILABLE",
  "CHANNELS_ADAPTER_REJECTED",
  "CHANNELS_ADAPTER_UNAUTHORIZED",
  "CHANNELS_ADAPTER_UNAVAILABLE",
  "CHANNELS_APP_NOT_FOUND",
  "CHANNELS_CONNECTION_DISABLED",
  "CHANNELS_CONNECTION_NOT_FOUND",
  "CHANNELS_DELIVERY_INDETERMINATE",
  "CHANNELS_ERASURE_PLAN_FOREIGN",
  "CHANNELS_EVENT_DUPLICATE",
  "CHANNELS_EVENT_LEASE_LOST",
  "CHANNELS_EVENT_NOT_CLAIMABLE",
  "CHANNELS_EVENT_NOT_FOUND",
  "CHANNELS_EVENT_PAYLOAD_INVALID",
  "CHANNELS_INSTALLATION_NOT_FOUND",
  "CHANNELS_INSTALLATION_REVOKED",
  "CHANNELS_PROVIDER_UNSUPPORTED",
  "CHANNELS_REFRESH_LOST",
  "CHANNELS_REFRESH_NOT_CLAIMABLE",
  "CHANNELS_REFRESH_REPAIR_REQUIRED",
  "CHANNELS_REPOSITORY_UNAVAILABLE",
  "CHANNELS_ROUTING_AGENT_UNKNOWN",
  "CHANNELS_ROUTING_INVALID",
  "CHANNELS_ROUTING_UNRESOLVED",
  "CHANNELS_SIGNATURE_ABSENT",
  "CHANNELS_SIGNATURE_INVALID",
  "CHANNELS_SIGNATURE_STALE",
  "CHANNELS_THREAD_KEY_INVALID",
  "CHANNELS_THREAD_LINK_CONFLICT",
  "CONVERSATIONS_AGENT_NOT_VISIBLE",
  "CONVERSATIONS_AGENT_VERSION_NOT_VISIBLE",
  "CONVERSATIONS_ATTACHMENT_COUNT_EXCEEDED",
  "CONVERSATIONS_ATTACHMENT_FOREIGN",
  "CONVERSATIONS_ATTACHMENT_MEDIA_TYPE_REFUSED",
  "CONVERSATIONS_ATTACHMENT_TOO_LARGE",
  "CONVERSATIONS_ATTACHMENT_TURN_TOO_LARGE",
  "CONVERSATIONS_BUDGET_EXHAUSTED",
  "CONVERSATIONS_COMPACTION_CURSOR_REGRESSED",
  "CONVERSATIONS_COMPACTION_IN_PROGRESS",
  "CONVERSATIONS_COMPACTION_LOCK_HELD",
  "CONVERSATIONS_COMPACTION_SUMMARY_TOO_LONG",
  "CONVERSATIONS_ERASURE_PLAN_FOREIGN",
  "CONVERSATIONS_FORK_CEILING_EXCEEDED",
  "CONVERSATIONS_FORK_DEPTH_EXCEEDED",
  "CONVERSATIONS_FORK_TURN_FOREIGN",
  "CONVERSATIONS_GENERATION_FAILED",
  "CONVERSATIONS_OUTPUT_SCHEMA_INVALID",
  "CONVERSATIONS_OUTPUT_UNPARSABLE",
  "CONVERSATIONS_PAGE_REQUEST_INVALID",
  "CONVERSATIONS_POSTMAN_ALREADY_SETTLED",
  "CONVERSATIONS_POSTMAN_FINGERPRINT_MISMATCH",
  "CONVERSATIONS_POSTMAN_HANDLE_EXPIRED",
  "CONVERSATIONS_POSTMAN_NOT_FOUND",
  "CONVERSATIONS_POSTMAN_REQUEST_REPLAYED",
  "CONVERSATIONS_QUEUE_UNAVAILABLE",
  "CONVERSATIONS_REPOSITORY_UNAVAILABLE",
  "CONVERSATIONS_SCOPE_MISMATCH",
  "CONVERSATIONS_SESSION_CONTEXT_INVALID",
  "CONVERSATIONS_SESSION_CONTEXT_TOO_LARGE",
  "CONVERSATIONS_STEP_ALREADY_SETTLED",
  "CONVERSATIONS_STEP_CEILING_EXCEEDED",
  "CONVERSATIONS_STEP_NOT_FOUND",
  "CONVERSATIONS_STEP_RATE_MISSING",
  "CONVERSATIONS_STEP_SEQUENCE_TAKEN",
  "CONVERSATIONS_STEP_USAGE_INVALID",
  "CONVERSATIONS_SUB_AGENTS_DISABLED",
  "CONVERSATIONS_SUB_AGENT_CYCLE",
  "CONVERSATIONS_SUB_AGENT_DEPTH_EXCEEDED",
  "CONVERSATIONS_SUB_AGENT_FAN_OUT_EXCEEDED",
  "CONVERSATIONS_THREAD_ARCHIVED",
  "CONVERSATIONS_THREAD_FORBIDDEN",
  "CONVERSATIONS_THREAD_NOT_FOUND",
  "CONVERSATIONS_THREAD_TAGS_INVALID",
  "CONVERSATIONS_THREAD_TITLE_INVALID",
  "CONVERSATIONS_TOOL_CATALOGUE_EXCEEDED",
  "CONVERSATIONS_TOOL_NOT_OFFERED",
  "CONVERSATIONS_TURNS_DISABLED",
  "CONVERSATIONS_TURN_ABORTED",
  "CONVERSATIONS_TURN_ALREADY_SETTLED",
  "CONVERSATIONS_TURN_CEILING_EXCEEDED",
  "CONVERSATIONS_TURN_IDEMPOTENCY_CONFLICT",
  "CONVERSATIONS_TURN_INPUT_INVALID",
  "CONVERSATIONS_TURN_INPUT_TOO_LARGE",
  "CONVERSATIONS_TURN_NOT_FOUND",
  "CONVERSATIONS_TURN_SEQUENCE_TAKEN",
  "COST_ALERT_CHANNEL_EXISTS",
  "COST_ALERT_CHANNEL_INVALID",
  "COST_ALERT_CHANNEL_NOT_FOUND",
  "COST_ALERT_CHANNEL_UNCHANGED",
  "COST_ALERT_TOPIC_INVALID",
  "COST_BUDGET_INVALID",
  "COST_BUDGET_NOT_FOUND",
  "COST_BUDGET_TARGET_INVALID",
  "COST_DELIVERY_FAILED",
  "COST_DELIVERY_NOT_FOUND",
  "COST_DELIVERY_UNAVAILABLE",
  "COST_LEDGER_UNAVAILABLE",
  "COST_REPOSITORY_UNAVAILABLE",
  "COST_SCOPE_MISMATCH",
  "COST_SPEND_INVALID",
  "COST_THRESHOLD_EVENT_UNAVAILABLE",
  "COST_THRESHOLD_INVALID",
  "COST_WINDOW_INVALID",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_FORBIDDEN",
  "CREDENTIAL_MATERIAL_INVALID",
  "CREDENTIAL_MINT_REFUSED",
  "CREDENTIAL_NAME_TAKEN",
  "CREDENTIAL_NOT_FOUND",
  "CREDENTIAL_REVOCATION_NOT_APPLIED",
  "CREDENTIAL_REVOKED",
  "CREDENTIAL_SUBJECT_MISMATCH",
  "CREDENTIAL_UNAVAILABLE",
  "ENVELOPE_FORMAT_UNWRITABLE",
  "ENVIRONMENT_VARIABLE_KEY_INVALID",
  "ENVIRONMENT_VARIABLE_UNAVAILABLE",
  "ENVIRONMENT_VARIABLE_VALUE_REQUIRED",
  "ENVIRONMENT_VARIABLE_VALUE_TOO_LONG",
  "ENVIRONMENT_VARIABLE_VERSION_CONFLICT",
  "EVENTING_ERASURE_PLAN_FOREIGN",
  "EVENTING_QUEUE_UNAVAILABLE",
  "EVENTING_REPOSITORY_UNAVAILABLE",
  "EVENTING_RULE_DESTINATION_INVALID",
  "EVENTING_RULE_DESTINATION_REJECTED",
  "EVENTING_RULE_DISABLED",
  "EVENTING_RULE_FILTERS_INVALID",
  "EVENTING_RULE_NAME_INVALID",
  "EVENTING_RULE_NAME_TAKEN",
  "EVENTING_RULE_NOT_FOUND",
  "EVENTING_RULE_PATTERN_INVALID",
  "EVENTING_SCREEN_UNAVAILABLE",
  "FILES_ARTIFACT_CONTENT_INVALID",
  "FILES_ARTIFACT_CONTENT_TOO_LARGE",
  "FILES_ARTIFACT_KEY_INVALID",
  "FILES_ARTIFACT_KIND_IMMUTABLE",
  "FILES_ARTIFACT_REVISION_CONFLICT",
  "FILES_ARTIFACT_REVISION_NOT_FOUND",
  "FILES_ATTACHMENT_BINDING_CONFLICT",
  "FILES_ATTACHMENT_METADATA_INVALID",
  "FILES_ATTACHMENT_NOT_FOUND",
  "FILES_ATTACHMENT_QUOTA_EXCEEDED",
  "FILES_ATTACHMENT_RETENTION_ELAPSED",
  "FILES_ATTACHMENT_TOO_LARGE",
  "FILES_BLOB_DESTRUCTION_FAILED",
  "FILES_ERASURE_PLAN_FOREIGN",
  "FILES_OBJECT_NOT_FOUND",
  "FILES_OBJECT_PRECONDITION_FAILED",
  "FILES_OBJECT_STORE_UNAVAILABLE",
  "FILES_PRESIGNED_GRANT_ELAPSED",
  "FILES_PRESIGN_WINDOW_INVALID",
  "FILES_REPOSITORY_UNAVAILABLE",
  "FILES_STORAGE_KEY_SCOPE_MISMATCH",
  "FORBIDDEN_SCOPE",
  "GOVERNANCE_ACTIVITY_UNREADABLE",
  "GOVERNANCE_AGENT_NOT_VISIBLE",
  "GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED",
  "GOVERNANCE_CRITERION_ALREADY_EXISTS",
  "GOVERNANCE_CRITERION_INACTIVE",
  "GOVERNANCE_CRITERION_NAME_INVALID",
  "GOVERNANCE_CRITERION_NOT_FOUND",
  "GOVERNANCE_CRITERION_PROMPT_INVALID",
  "GOVERNANCE_CRITERION_RUBRIC_INVALID",
  "GOVERNANCE_CRITERION_SCALE_INVALID",
  "GOVERNANCE_ERASURE_PLAN_FOREIGN",
  "GOVERNANCE_EVALS_DISABLED",
  "GOVERNANCE_EVALS_SCOPE_UNRESOLVED",
  "GOVERNANCE_EVAL_NOT_FOUND",
  "GOVERNANCE_EVAL_SELF_JUDGED",
  "GOVERNANCE_GOLDEN_SETS_SCOPE_UNRESOLVED",
  "GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS",
  "GOVERNANCE_GOLDEN_SET_INVALID",
  "GOVERNANCE_GOLDEN_SET_NOT_FOUND",
  "GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA",
  "GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS",
  "GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS",
  "GOVERNANCE_JUDGE_MODEL_INVALID",
  "GOVERNANCE_JUDGE_UNAVAILABLE",
  "GOVERNANCE_LEDGER_UNAVAILABLE",
  "GOVERNANCE_PAGE_REQUEST_INVALID",
  "GOVERNANCE_QUEUE_UNAVAILABLE",
  "GOVERNANCE_RATINGS_SCOPE_UNRESOLVED",
  "GOVERNANCE_RATING_ACTOR_FORBIDDEN",
  "GOVERNANCE_RATING_COMMENT_TOO_LONG",
  "GOVERNANCE_RATING_TARGET_NOT_FOUND",
  "GOVERNANCE_RATING_TARGET_UNREADABLE",
  "GOVERNANCE_RATING_VALUE_INVALID",
  "GOVERNANCE_SAFETY_ACTION_UNKNOWN",
  "GOVERNANCE_SAFETY_DETECTOR_UNKNOWN",
  "GOVERNANCE_SAFETY_RULE_MALFORMED",
  "GOVERNANCE_SAFETY_SCOPE_UNRESOLVED",
  "GOVERNANCE_SAFETY_SEVERITY_UNKNOWN",
  "GOVERNANCE_SCOPE_MISMATCH",
  "GOVERNANCE_TRANSCRIPT_NOT_FOUND",
  "GOVERNANCE_TRANSCRIPT_UNREADABLE",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_KEY_MALFORMED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_RECORD_ABSENT",
  "IDEMPOTENCY_RECORD_MALFORMED",
  "IDEMPOTENCY_REQUEST_IN_FLIGHT",
  "IDEMPOTENCY_REQUEST_MISMATCH",
  "IDEMPOTENCY_STORE_UNAVAILABLE",
  "IDEMPOTENCY_UNAVAILABLE",
  "IDENTITY_STORE_UNAVAILABLE",
  "IMPERSONATION_FORBIDDEN",
  "INVALID_ACCESS_KEY_MATERIAL",
  "INVALID_END_USER_FILTER",
  "INVALID_GRANT",
  "INVALID_KEY_RING",
  "INVALID_MFA_CODE",
  "INVALID_PURGE_REQUEST",
  "INVALID_REQUEST",
  "INVALID_RETENTION_REQUEST",
  "INVALID_SECRET_MATERIAL",
  "INVALID_SESSION_COOKIE",
  "INVITATION_CONSUMED",
  "INVITATION_EMAIL_MISMATCH",
  "INVITATION_INVALID",
  "JOBS_APPROVAL_ALREADY_RESOLVED",
  "JOBS_APPROVAL_EDIT_MISSING",
  "JOBS_APPROVAL_ELAPSED",
  "JOBS_APPROVAL_NOT_FOUND",
  "JOBS_APPROVAL_SUSPENSION_UNAVAILABLE",
  "JOBS_ERASURE_PLAN_FOREIGN",
  "JOBS_IDEMPOTENCY_RECORD_ABSENT",
  "JOBS_IDEMPOTENCY_RECORD_MALFORMED",
  "JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED",
  "JOBS_INVOCATION_TYPE_INVALID",
  "JOBS_JOB_ALREADY_EXISTS",
  "JOBS_JOB_DEFINITION_INVALID",
  "JOBS_JOB_KEY_INVALID",
  "JOBS_JOB_NOT_FOUND",
  "JOBS_REPOSITORY_UNAVAILABLE",
  "JOB_EXECUTION_FAILED",
  "JOB_NOT_AUTHORIZED",
  "JOB_NOT_FOUND_OR_INACTIVE",
  "JOB_NOT_REGISTERED",
  "JOB_RESULT_REJECTED",
  "JOB_SERVICE_UNAVAILABLE",
  "JOB_TIMEOUT",
  "LEGACY_ENVELOPE_UNREADABLE",
  "MCP_ENTITY_ENVIRONMENT_MISMATCH",
  "MCP_TOKEN_MINT_WHILE_IMPERSONATING",
  "MEMORY_AGENT_AMBIGUOUS",
  "MEMORY_AGENT_SCOPE_DENIED",
  "MEMORY_BULK_LIMIT_EXCEEDED",
  "MEMORY_CACHE_NAMESPACE_INVALID",
  "MEMORY_CACHE_TTL_INVALID",
  "MEMORY_CACHE_UNAVAILABLE",
  "MEMORY_EMBEDDING_UNAVAILABLE",
  "MEMORY_END_USER_CONTEXT_REQUIRED",
  "MEMORY_ENTITY_KEY_INVALID",
  "MEMORY_ENTITY_NOT_FOUND",
  "MEMORY_ENTITY_OWNERSHIP_CONFLICT",
  "MEMORY_EXTRACTION_ENVELOPE_INVALID",
  "MEMORY_EXTRACTION_JUDGE_UNAVAILABLE",
  "MEMORY_INVALID_CONFIDENCE",
  "MEMORY_INVALID_CONTENT",
  "MEMORY_INVALID_KIND",
  "MEMORY_INVALID_METADATA",
  "MEMORY_INVALID_SOURCE",
  "MEMORY_INVALID_VISIBILITY",
  "MEMORY_NOT_FOUND",
  "MEMORY_PROVENANCE_INCOMPLETE",
  "MEMORY_QUERY_INVALID",
  "MEMORY_RELATIONSHIP_ENDPOINTS_SPLIT",
  "MEMORY_RELATIONSHIP_INVALID",
  "MEMORY_REPOSITORY_UNAVAILABLE",
  "MEMORY_SCOPE_MISMATCH",
  "MEMORY_UNTRUSTED_SOURCE",
  "MFA_REQUIRED",
  "MISSING_PERMISSION",
  "OBSERVABILITY_AUDIT_ACTION_INVALID",
  "OBSERVABILITY_AUDIT_STATE_NOT_AN_OBJECT",
  "OBSERVABILITY_AUDIT_SUBJECT_INVALID",
  "OBSERVABILITY_DRAIN_BUDGET_INVALID",
  "OBSERVABILITY_ENVELOPE_MALFORMED",
  "OBSERVABILITY_ENVELOPE_VERSION_UNSUPPORTED",
  "OBSERVABILITY_ERASURE_PLAN_FOREIGN",
  "OBSERVABILITY_ERASURE_RESIDUE",
  "OBSERVABILITY_ERASURE_SUBJECT_UNADDRESSABLE",
  "OBSERVABILITY_ERASURE_UNVERIFIED",
  "OBSERVABILITY_PROJECTION_SCOPE_MISMATCH",
  "OBSERVABILITY_QUEUE_UNAVAILABLE",
  "OBSERVABILITY_REPOSITORY_UNAVAILABLE",
  "OBSERVABILITY_SINK_DISABLED",
  "OBSERVABILITY_SINK_MISCONFIGURED",
  "OBSERVABILITY_SINK_REJECTED_BATCH",
  "OBSERVABILITY_SINK_SCHEMA_MISSING",
  "OBSERVABILITY_SINK_UNREACHABLE",
  "OWNER_INVARIANT",
  "PRIVACY_ALIAS_INVALID",
  "PRIVACY_ERASURE_REGISTER_UNAVAILABLE",
  "PRIVACY_IDEMPOTENCY_KEY_CONFLICT",
  "PRIVACY_LEASE_HELD",
  "PRIVACY_LEGAL_HOLD_IN_FORCE",
  "PRIVACY_LEGAL_HOLD_REGISTER_UNAVAILABLE",
  "PRIVACY_OPERATION_NOT_FOUND",
  "PRIVACY_OPERATION_STORE_UNAVAILABLE",
  "PRIVACY_RECEIPT_WOULD_LEAK_SUBJECT",
  "PRIVACY_RETRY_BUDGET_EXHAUSTED",
  "PRIVACY_RETRY_NOT_PERMITTED",
  "PRIVACY_SUBJECT_DIRECTORY_UNAVAILABLE",
  "PRIVACY_SUBJECT_ERASED",
  "PRIVACY_SUBJECT_MISMATCH",
  "PRIVACY_SUBJECT_NOT_RESOLVED",
  "PRIVACY_TARGET_NOT_WIRED",
  "PRIVACY_TARGET_REJECTED",
  "PROVIDERS_CACHE_BUDGET_EXCEEDED",
  "PROVIDERS_CONFIGURATION_UNAVAILABLE",
  "PROVIDERS_CREDENTIAL_UNAVAILABLE",
  "PROVIDERS_GENERATION_ABORTED",
  "PROVIDERS_KEY_ALREADY_EXISTS",
  "PROVIDERS_KEY_METADATA_INVALID",
  "PROVIDERS_KEY_NOT_FOUND",
  "PROVIDERS_KEY_PINNED_BY_AGENTS",
  "PROVIDERS_MEDIA_TYPE_MISSING",
  "PROVIDERS_MESSAGE_NOT_REPRESENTABLE",
  "PROVIDERS_MODEL_KEY_INVALID",
  "PROVIDERS_MODEL_PRICING_UNAVAILABLE",
  "PROVIDERS_MODEL_RATE_INVALID",
  "PROVIDERS_MODEL_SESSION_EXPIRED",
  "PROVIDERS_MODEL_STRING_INVALID",
  "PROVIDERS_OUTPUT_SCHEMA_INVALID",
  "PROVIDERS_PASS_BUDGET_INVALID",
  "PROVIDERS_PRICE_REVISION_CONFLICT",
  "PROVIDERS_PROBE_CACHE_NOT_EVICTED",
  "PROVIDERS_PROMPT_CONTENT_EMPTY",
  "PROVIDERS_PROMPT_EMPTY",
  "PROVIDERS_PROVIDER_CREDENTIAL_UNAVAILABLE",
  "PROVIDERS_PROVIDER_REQUEST_FAILED",
  "PROVIDERS_RATE_CARD_INVALID",
  "PROVIDERS_REPOSITORY_UNAVAILABLE",
  "PROVIDERS_RETRY_POLICY_INVALID",
  "PROVIDERS_SCOPE_MISMATCH",
  "PROVIDERS_SERVICE_ACCOUNT_INVALID",
  "PROVIDERS_STEP_BUDGET_INVALID",
  "PROVIDERS_STRUCTURED_OUTPUT_INVALID",
  "PROVIDERS_TOKEN_USAGE_INVALID",
  "PROVIDERS_TOOL_CALL_DUPLICATED",
  "PROVIDERS_TOOL_EXECUTOR_FAILED",
  "PROVIDERS_TOOL_NAME_DUPLICATED",
  "PROVIDERS_TOOL_RESULT_UNMATCHED",
  "PROVIDERS_UNKNOWN_PROVIDER",
  "RATE_LIMITED",
  "RATE_LIMITER_UNAVAILABLE",
  "RETRY_POLICY_BASE_DELAY_INVALID",
  "RETRY_POLICY_CEILING_BELOW_BASE",
  "RETRY_POLICY_JITTER_FRACTION_INVALID",
  "RETRY_POLICY_MAX_SENDS_INVALID",
  "RETRY_POLICY_MULTIPLIER_INVALID",
  "SECRET_INPUT_NOT_WRITE_ONLY",
  "SECRET_VERSION_ALREADY_EXISTS",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "SKILLS_ENVIRONMENT_KEYS_MISSING",
  "SKILLS_ERASURE_PLAN_FOREIGN",
  "SKILLS_MANIFEST_FIELD_INVALID",
  "SKILLS_MANIFEST_FIELD_MISSING",
  "SKILLS_MANIFEST_FRONTMATTER_MISSING",
  "SKILLS_MANIFEST_ID_INVALID",
  "SKILLS_MANIFEST_YAML_INDENT",
  "SKILLS_MANIFEST_YAML_MISSING_COLON",
  "SKILLS_OFFICIAL_SKILL_IMMUTABLE",
  "SKILLS_REPOSITORY_UNAVAILABLE",
  "SKILLS_SANDBOX_REFUSED",
  "SKILLS_SANDBOX_UNAVAILABLE",
  "SKILLS_SKILL_NOT_FOUND",
  "SKILLS_SKILL_NOT_INSTALLED",
  "SKILLS_SOURCE_FETCH_FAILED",
  "SKILLS_SOURCE_PROTOCOL_UNSUPPORTED",
  "SKILLS_SOURCE_TOO_LARGE",
  "SKILLS_SOURCE_URL_INVALID",
  "STREAM_CREDENTIAL_EXPIRED",
  "STREAM_CURSOR_EXPIRED",
  "STREAM_CURSOR_SEQUENCE_INVALID",
  "STREAM_CURSOR_STREAM_ID_INVALID",
  "STREAM_CURSOR_UNREADABLE",
  "STREAM_CURSOR_VERSION_UNKNOWN",
  "STREAM_FRAME_FIELD_RESERVED",
  "STREAM_FRAME_TOO_LARGE",
  "STREAM_JOURNAL_UNAVAILABLE",
  "STREAM_NOT_FOUND",
  "STREAM_VERSION_ABSENT",
  "STREAM_VERSION_UNSUPPORTED",
  "TENANCY_ACCESS_KEY_GENERATION_SUPERSEDED",
  "TENANCY_ARCHIVED",
  "TENANCY_AUTHORIZATION_FORGED",
  "TENANCY_CROSS_TENANT_MEMBERSHIP",
  "TENANCY_ENVIRONMENT_FORBIDDEN",
  "TENANCY_INVALID_NAME",
  "TENANCY_INVALID_SLUG",
  "TENANCY_INVITATION_ALREADY_ACTIVE",
  "TENANCY_INVITATION_CONSUMED",
  "TENANCY_INVITATION_EMAIL_MISMATCH",
  "TENANCY_INVITATION_INVALID",
  "TENANCY_LAST_OWNER",
  "TENANCY_MEMBERSHIP_FORBIDDEN",
  "TENANCY_NOT_FOUND",
  "TENANCY_PROJECT_CREATE_FORBIDDEN",
  "TENANCY_SLUG_TAKEN",
  "TENANCY_UNKNOWN_OPERATOR",
  "TOKEN_REPLAYED",
  "TOOLS_APPROVAL_REQUIRED",
  "TOOLS_ARGUMENTS_INVALID",
  "TOOLS_CALL_SEQUENCE_CONFLICT",
  "TOOLS_CALL_TRANSITION_INVALID",
  "TOOLS_CREDENTIAL_UNAVAILABLE",
  "TOOLS_DECLARATION_INVALID",
  "TOOLS_DISPATCH_FAILED",
  "TOOLS_DISPATCH_RATE_LIMITED",
  "TOOLS_DUPLICATE_TOOL_NAME",
  "TOOLS_END_USER_REQUIRED",
  "TOOLS_ENTITY_NOT_DISPATCHABLE",
  "TOOLS_ENTITY_NOT_IN_SCOPE",
  "TOOLS_ENVIRONMENT_NOT_IN_SCOPE",
  "TOOLS_EXPOSURE_NOT_FOUND",
  "TOOLS_MCP_DISABLED",
  "TOOLS_MCP_TRANSPORT_INVALID",
  "TOOLS_MCP_TRANSPORT_UNIMPLEMENTED",
  "TOOLS_PERMISSION_BLOCKED",
  "TOOLS_POLICY_EFFECT_UNSUPPORTED",
  "TOOLS_POLICY_PATTERN_INVALID",
  "TOOLS_REPOSITORY_UNAVAILABLE",
  "TOOLS_RESIDUAL_TEMPLATE",
  "TOOLS_ROUTE_AMBIGUOUS",
  "TOOLS_ROUTE_NOT_IN_SCOPE",
  "TOOLS_SCOPE_MISMATCH",
  "TOOLS_TOOL_NOT_FOUND",
  "TRANSPORT_CONTEXT_UNAVAILABLE",
  "TRANSPORT_REQUEST_INVALID",
  "TRANSPORT_ROUTE_NOT_FOUND",
  "TRANSPORT_SHUTTING_DOWN",
  "TRANSPORT_UNHANDLED_FAULT",
  "UNAUTHENTICATED",
  "UNKNOWN_CLIENT",
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

/** The header M0.4 section 2 binds one-time-secret mints to. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export interface BearerCredentialResource {
  readonly "tokenId": string;
  readonly "label": string;
  readonly "permissions": readonly string[];
  readonly "principalId": string;
  readonly "tier": "scope" | "admin" | null;
  readonly "state": "active" | "revoked" | "expired";
  readonly "createdAt": string;
  readonly "expiresAt": string | null;
  readonly "lastUsedAt": string | null;
  readonly "revokedAt": string | null;
  readonly "revokedBy": string | null;
}

export interface CollectionEnvelope_BearerCredentialResource {
  readonly "data": readonly BearerCredentialResource[];
  readonly "page": PageBlock;
}

export interface CollectionEnvelope_EndUserResource {
  readonly "data": readonly EndUserResource[];
  readonly "page": PageBlock;
}

export interface CollectionEnvelope_OrganizationPolicyResource {
  readonly "data": readonly OrganizationPolicyResource[];
  readonly "page": PageBlock;
}

export interface CollectionEnvelope_OrganizationResource {
  readonly "data": readonly OrganizationResource[];
  readonly "page": PageBlock;
}

export interface CollectionEnvelope_ProjectResource {
  readonly "data": readonly ProjectResource[];
  readonly "page": PageBlock;
}

export interface CreateOrganizationBody {
  readonly "name": string;
  readonly "slug": string;
}

export interface CreateProjectBody {
  readonly "organizationId": string;
  readonly "name": string;
  readonly "slug": string;
  readonly "environmentName": string;
  readonly "environmentSlug": string;
}

export interface CreatedProjectResource_environment {
  readonly "id": string;
  readonly "slug": string;
  readonly "name": string;
  readonly "createdAt": string;
}

export interface CreatedProjectResource_membership {
  readonly "id": string;
  readonly "role": string;
}

export interface CreatedProjectResource {
  readonly "project": ProjectResource;
  readonly "environment": CreatedProjectResource_environment;
  readonly "membership": CreatedProjectResource_membership;
}

export interface DegradedNotice {
  readonly "service": string;
  readonly "fallback": string;
}

export interface EndUserIdentityResource {
  readonly "issuer": string;
  readonly "channel": string;
  readonly "subject": string;
  readonly "verifiedAt": string | null;
  readonly "disabledAt": string | null;
}

export interface EndUserResource {
  readonly "endUserId": string;
  readonly "displayName": string | null;
  readonly "disabledAt": string | null;
  readonly "createdAt": string;
  readonly "identities": readonly EndUserIdentityResource[];
}

export interface ErrorEnvelope {
  readonly "error": WireError;
}

export interface ExchangeSessionBody {
  readonly "token": string;
}

export interface ItemEnvelope_CreatedProjectResource {
  readonly "data": CreatedProjectResource;
  readonly "meta": ItemMeta;
}

export interface ItemEnvelope_MintedTokenResource {
  readonly "data": MintedTokenResource;
  readonly "meta": ItemMeta;
}

export interface ItemEnvelope_OperatorSessionResource {
  readonly "data": OperatorSessionResource;
  readonly "meta": ItemMeta;
}

export interface ItemEnvelope_OrganizationPolicyResource {
  readonly "data": OrganizationPolicyResource;
  readonly "meta": ItemMeta;
}

export interface ItemEnvelope_OrganizationResource {
  readonly "data": OrganizationResource;
  readonly "meta": ItemMeta;
}

export interface ItemEnvelope_PolicyDeletionResource {
  readonly "data": PolicyDeletionResource;
  readonly "meta": ItemMeta;
}

export interface ItemEnvelope_RevokedTokenResource {
  readonly "data": RevokedTokenResource;
  readonly "meta": ItemMeta;
}

export interface ItemMeta {
  readonly "contractVersion": string;
  readonly "degraded"?: DegradedNotice;
}

export interface MintEntityTokenBody {
  readonly "environmentId": string;
  readonly "label": string;
  readonly "scopes": readonly string[];
  readonly "mcpUserId": string | null;
  readonly "ttlSeconds": number | null;
}

export interface MintPlatformTokenBody {
  readonly "environmentId": string;
  readonly "name": string;
  readonly "permissions": readonly string[];
  readonly "tier": "scope" | "admin";
  readonly "ttlSeconds": number | null;
}

export interface MintedTokenResource {
  readonly "tokenId": string;
  readonly "token": string;
  readonly "label": string;
  readonly "permissions": readonly string[];
  readonly "tier": "scope" | "admin" | null;
  readonly "expiresAt": string;
  readonly "createdAt": string;
}

export interface OperatorSessionResource_impersonating {
  readonly "targetUserId": string;
}

export interface OperatorSessionResource {
  readonly "sessionId": string;
  readonly "actorUserId": string;
  readonly "effectiveUserId": string;
  readonly "email": string;
  readonly "expiresAt": string;
  readonly "mfaVerifiedAt": string | null;
  readonly "impersonating": OperatorSessionResource_impersonating;
}

export interface OrganizationPolicyResource {
  readonly "policyId": string;
  readonly "pattern": string;
  readonly "state": string;
  readonly "createdAt": string;
  readonly "updatedAt": string;
}

export interface OrganizationResource_membership {
  readonly "id": string;
  readonly "role": string;
  readonly "deactivatedAt": string | null;
}

export interface OrganizationResource {
  readonly "id": string;
  readonly "slug": string;
  readonly "name": string;
  readonly "archivedAt": string | null;
  readonly "createdAt": string;
  readonly "membership": OrganizationResource_membership;
}

export interface PageBlock {
  readonly "cursor": string | null;
  readonly "nextCursor": string | null;
  readonly "limit": number;
  readonly "hasMore": boolean;
  readonly "total"?: number;
}

export interface PolicyDeletionResource {
  readonly "policyId": string;
  readonly "deleted": boolean;
}

export interface ProjectResource {
  readonly "id": string;
  readonly "organizationId": string;
  readonly "slug": string;
  readonly "name": string;
  readonly "archivedAt": string | null;
  readonly "createdAt": string;
  readonly "through": string;
}

export interface RevokePlatformTokenBody {
  readonly "environmentId": string;
}

export interface RevokedTokenResource {
  readonly "tokenId": string;
  readonly "label": string;
  readonly "revokedAt": string;
  readonly "newlyRevoked": boolean;
  readonly "previousState": "active" | "revoked" | "expired";
  readonly "revokedBy": string | null;
}

export interface SetOrganizationPolicyBody {
  readonly "pattern": string;
  readonly "state": "auto_allow" | "require_approval" | "block";
}

export interface WireError_fields_item {
  readonly "field": string;
  readonly "code": string;
  readonly "message": string;
}

export interface WireError {
  readonly "code": WireErrorCode;
  readonly "title": string;
  readonly "body": string;
  readonly "errorId": string;
  readonly "traceRef": string;
  readonly "version": string;
  readonly "fields"?: readonly WireError_fields_item[];
  readonly "retryAfterSec"?: number;
}

/** How a caller must treat `Idempotency-Key` on one operation. */
export type V1IdempotencyClass = "required" | "accepted" | "exempt" | "not-applicable";

export interface V1Operation {
  readonly operationId: string;
  readonly method: string;
  /** The route template, `:param` segments included — the form the policy table states. */
  readonly template: string;
  readonly pathParameters: readonly string[];
  readonly successStatus: number;
  readonly idempotency: V1IdempotencyClass;
}

export const V1_OPERATIONS: readonly V1Operation[] = [
  {
    operationId: "delete__api_v1_bff_session",
    method: "DELETE",
    template: "/api/v1/bff/session",
    pathParameters: [],
    successStatus: 204,
    idempotency: "accepted",
  },
  {
    operationId: "post__api_v1_bff_session",
    method: "POST",
    template: "/api/v1/bff/session",
    pathParameters: [],
    successStatus: 200,
    idempotency: "accepted",
  },
  {
    operationId: "get__api_v1_environments_by_environmentId_end_users",
    method: "GET",
    template: "/api/v1/environments/:environmentId/end-users",
    pathParameters: ["environmentId"],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "get__api_v1_environments_by_environmentId_streams_by_streamId",
    method: "GET",
    template: "/api/v1/environments/:environmentId/streams/:streamId",
    pathParameters: ["environmentId", "streamId"],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "get__api_v1_identity_session",
    method: "GET",
    template: "/api/v1/identity/session",
    pathParameters: [],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "get__api_v1_organizations",
    method: "GET",
    template: "/api/v1/organizations",
    pathParameters: [],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "post__api_v1_organizations",
    method: "POST",
    template: "/api/v1/organizations",
    pathParameters: [],
    successStatus: 201,
    idempotency: "accepted",
  },
  {
    operationId: "get__api_v1_projects",
    method: "GET",
    template: "/api/v1/projects",
    pathParameters: [],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "post__api_v1_projects",
    method: "POST",
    template: "/api/v1/projects",
    pathParameters: [],
    successStatus: 201,
    idempotency: "accepted",
  },
  {
    operationId: "get__mcp_entity_by_entityId_tokens",
    method: "GET",
    template: "/mcp/entity/:entityId/tokens",
    pathParameters: ["entityId"],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "post__mcp_entity_by_entityId_tokens",
    method: "POST",
    template: "/mcp/entity/:entityId/tokens",
    pathParameters: ["entityId"],
    successStatus: 201,
    idempotency: "required",
  },
  {
    operationId: "delete__mcp_entity_by_entityId_tokens_by_tokenId",
    method: "DELETE",
    template: "/mcp/entity/:entityId/tokens/:tokenId",
    pathParameters: ["entityId", "tokenId"],
    successStatus: 200,
    idempotency: "exempt",
  },
  {
    operationId: "get__mcp_platform_environments_by_environmentId_policies",
    method: "GET",
    template: "/mcp/platform/environments/:environmentId/policies",
    pathParameters: ["environmentId"],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "put__mcp_platform_environments_by_environmentId_policies",
    method: "PUT",
    template: "/mcp/platform/environments/:environmentId/policies",
    pathParameters: ["environmentId"],
    successStatus: 200,
    idempotency: "accepted",
  },
  {
    operationId: "delete__mcp_platform_environments_by_environmentId_policies_by_policyId",
    method: "DELETE",
    template: "/mcp/platform/environments/:environmentId/policies/:policyId",
    pathParameters: ["environmentId", "policyId"],
    successStatus: 200,
    idempotency: "accepted",
  },
  {
    operationId: "get__mcp_platform_tokens",
    method: "GET",
    template: "/mcp/platform/tokens",
    pathParameters: [],
    successStatus: 200,
    idempotency: "not-applicable",
  },
  {
    operationId: "post__mcp_platform_tokens",
    method: "POST",
    template: "/mcp/platform/tokens",
    pathParameters: [],
    successStatus: 201,
    idempotency: "required",
  },
  {
    operationId: "post__mcp_platform_tokens_by_id_revoke",
    method: "POST",
    template: "/mcp/platform/tokens/:id/revoke",
    pathParameters: ["id"],
    successStatus: 200,
    idempotency: "exempt",
  },
];

/**
 * What a generated method hands the transport.
 *
 * A REQUEST, NOT A RESPONSE. The generated layer decides the method, the path,
 * the body and whether this operation is bound to an `Idempotency-Key`; the
 * hand-written transport decides auth, retry and how a refusal becomes an error.
 * Splitting them there is what lets the whole request be asserted in a test with
 * no server, in both languages, against one fixture.
 */
export interface V1Request {
  readonly operation: V1Operation;
  readonly path: string;
  readonly body: unknown;
  readonly query: Readonly<Record<string, string>> | undefined;
}

export interface V1Transport {
  send<T>(request: V1Request): Promise<T>;
}

const BY_ID = new Map(V1_OPERATIONS.map((operation) => [operation.operationId, operation]));

function operation(operationId: string): V1Operation {
  const found = BY_ID.get(operationId);
  if (found === undefined) throw new Error(`unknown V1 operation ${operationId}`);
  return found;
}

/**
 * Substitute path parameters, refusing an empty one.
 *
 * An empty segment silently changes which route the server matches — a mint
 * addressed at `/mcp/entity//tokens` is not that entity's mint — so it is a
 * refusal here rather than a 404 nobody can explain.
 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`V1: path parameter ${name} is required and must not be empty`);
    }
    return encodeURIComponent(value);
  });
}

export class BffSessionV1Api {
  constructor(private readonly transport: V1Transport) {}

  /** DELETE /api/v1/bff/session */
  async signOut(): Promise<void> {
    return this.transport.send<void>({
      operation: operation("delete__api_v1_bff_session"),
      path: "/api/v1/bff/session",
      body: undefined,
      query: undefined,
    });
  }

  /** POST /api/v1/bff/session */
  async exchange(body: ExchangeSessionBody): Promise<ItemEnvelope_OperatorSessionResource> {
    return this.transport.send<ItemEnvelope_OperatorSessionResource>({
      operation: operation("post__api_v1_bff_session"),
      path: "/api/v1/bff/session",
      body: body,
      query: undefined,
    });
  }

}

export class EnvironmentEndUsersV1Api {
  constructor(private readonly transport: V1Transport) {}

  /**
   * GET /api/v1/environments/:environmentId/end-users
   *
   * THE QUERY STRING IS NOT TYPED, AND THE DOCUMENT SAYS WHY:
   * The @Query parameter is typed EndUserQuery, the shape AFTER endUserQueryValidator has decoded ?cursor= into an offset. It declares `offset`, which no caller sends, and omits `cursor` and `limit`, which every caller does. Publishing it would describe a query string this route does not accept. Deriving the real one needs a declared wire-query DTO that the validator consumes; until then this route's query parameters are undocumented, not guessed.
   */
  async list(environmentId: string, query?: Readonly<Record<string, string>>): Promise<CollectionEnvelope_EndUserResource> {
    return this.transport.send<CollectionEnvelope_EndUserResource>({
      operation: operation("get__api_v1_environments_by_environmentId_end_users"),
      path: fill("/api/v1/environments/:environmentId/end-users", { environmentId }),
      body: undefined,
      query: query,
    });
  }

}

export class EnvironmentStreamsV1Api {
  constructor(private readonly transport: V1Transport) {}

  /** GET /api/v1/environments/:environmentId/streams/:streamId */
  async read(environmentId: string, streamId: string): Promise<void> {
    return this.transport.send<void>({
      operation: operation("get__api_v1_environments_by_environmentId_streams_by_streamId"),
      path: fill("/api/v1/environments/:environmentId/streams/:streamId", { environmentId, streamId }),
      body: undefined,
      query: undefined,
    });
  }

}

export class IdentitySessionV1Api {
  constructor(private readonly transport: V1Transport) {}

  /** GET /api/v1/identity/session */
  async session(): Promise<ItemEnvelope_OperatorSessionResource> {
    return this.transport.send<ItemEnvelope_OperatorSessionResource>({
      operation: operation("get__api_v1_identity_session"),
      path: "/api/v1/identity/session",
      body: undefined,
      query: undefined,
    });
  }

}

export class OrganizationsV1Api {
  constructor(private readonly transport: V1Transport) {}

  /** GET /api/v1/organizations */
  async list(): Promise<CollectionEnvelope_OrganizationResource> {
    return this.transport.send<CollectionEnvelope_OrganizationResource>({
      operation: operation("get__api_v1_organizations"),
      path: "/api/v1/organizations",
      body: undefined,
      query: undefined,
    });
  }

  /** POST /api/v1/organizations */
  async create(body: CreateOrganizationBody): Promise<ItemEnvelope_OrganizationResource> {
    return this.transport.send<ItemEnvelope_OrganizationResource>({
      operation: operation("post__api_v1_organizations"),
      path: "/api/v1/organizations",
      body: body,
      query: undefined,
    });
  }

}

export class ProjectsV1Api {
  constructor(private readonly transport: V1Transport) {}

  /** GET /api/v1/projects */
  async list(): Promise<CollectionEnvelope_ProjectResource> {
    return this.transport.send<CollectionEnvelope_ProjectResource>({
      operation: operation("get__api_v1_projects"),
      path: "/api/v1/projects",
      body: undefined,
      query: undefined,
    });
  }

  /** POST /api/v1/projects */
  async create(body: CreateProjectBody): Promise<ItemEnvelope_CreatedProjectResource> {
    return this.transport.send<ItemEnvelope_CreatedProjectResource>({
      operation: operation("post__api_v1_projects"),
      path: "/api/v1/projects",
      body: body,
      query: undefined,
    });
  }

}

export class McpEntityTokensV1Api {
  constructor(private readonly transport: V1Transport) {}

  /**
   * GET /mcp/entity/:entityId/tokens
   *
   * THE QUERY STRING IS NOT TYPED, AND THE DOCUMENT SAYS WHY:
   * The same TokenListQuery post-parse shape as the platform listing, and the same required `environmentId`. Listed separately rather than folded in, so withdrawing one route does not silently withdraw another's declared gap.
   */
  async list(entityId: string, query?: Readonly<Record<string, string>>): Promise<CollectionEnvelope_BearerCredentialResource> {
    return this.transport.send<CollectionEnvelope_BearerCredentialResource>({
      operation: operation("get__mcp_entity_by_entityId_tokens"),
      path: fill("/mcp/entity/:entityId/tokens", { entityId }),
      body: undefined,
      query: query,
    });
  }

  /** POST /mcp/entity/:entityId/tokens */
  async mint(entityId: string, body: MintEntityTokenBody): Promise<ItemEnvelope_MintedTokenResource> {
    return this.transport.send<ItemEnvelope_MintedTokenResource>({
      operation: operation("post__mcp_entity_by_entityId_tokens"),
      path: fill("/mcp/entity/:entityId/tokens", { entityId }),
      body: body,
      query: undefined,
    });
  }

  /**
   * DELETE /mcp/entity/:entityId/tokens/:tokenId
   *
   * THE QUERY STRING IS NOT TYPED, AND THE DOCUMENT SAYS WHY:
   * The @Query parameter carries only `environmentId`, so unlike the two listings its POST-PARSE shape and its WIRE shape are identical and it could be derived today. It is declared anyway because this derivation has no path that emits a @Query type at all — the branch that would is the one that raises — so exempting it would mean teaching the derivation a wire-DTO rule for one route and leaving three. When that rule lands, THIS is the entry to delete first: it is the only one whose type is already the truth.
   */
  async revoke(entityId: string, tokenId: string, query?: Readonly<Record<string, string>>): Promise<ItemEnvelope_RevokedTokenResource> {
    return this.transport.send<ItemEnvelope_RevokedTokenResource>({
      operation: operation("delete__mcp_entity_by_entityId_tokens_by_tokenId"),
      path: fill("/mcp/entity/:entityId/tokens/:tokenId", { entityId, tokenId }),
      body: undefined,
      query: query,
    });
  }

}

export class McpOrganizationPoliciesV1Api {
  constructor(private readonly transport: V1Transport) {}

  /** GET /mcp/platform/environments/:environmentId/policies */
  async list(environmentId: string): Promise<CollectionEnvelope_OrganizationPolicyResource> {
    return this.transport.send<CollectionEnvelope_OrganizationPolicyResource>({
      operation: operation("get__mcp_platform_environments_by_environmentId_policies"),
      path: fill("/mcp/platform/environments/:environmentId/policies", { environmentId }),
      body: undefined,
      query: undefined,
    });
  }

  /** PUT /mcp/platform/environments/:environmentId/policies */
  async set(environmentId: string, body: SetOrganizationPolicyBody): Promise<ItemEnvelope_OrganizationPolicyResource> {
    return this.transport.send<ItemEnvelope_OrganizationPolicyResource>({
      operation: operation("put__mcp_platform_environments_by_environmentId_policies"),
      path: fill("/mcp/platform/environments/:environmentId/policies", { environmentId }),
      body: body,
      query: undefined,
    });
  }

  /** DELETE /mcp/platform/environments/:environmentId/policies/:policyId */
  async remove(environmentId: string, policyId: string): Promise<ItemEnvelope_PolicyDeletionResource> {
    return this.transport.send<ItemEnvelope_PolicyDeletionResource>({
      operation: operation("delete__mcp_platform_environments_by_environmentId_policies_by_policyId"),
      path: fill("/mcp/platform/environments/:environmentId/policies/:policyId", { environmentId, policyId }),
      body: undefined,
      query: undefined,
    });
  }

}

export class McpPlatformTokensV1Api {
  constructor(private readonly transport: V1Transport) {}

  /**
   * GET /mcp/platform/tokens
   *
   * THE QUERY STRING IS NOT TYPED, AND THE DOCUMENT SAYS WHY:
   * The @Query parameter is typed TokenListQuery, the shape AFTER tokenListQueryValidator has decoded ?cursor= into an offset — the same post-parse mismatch as the end-user listing: it declares `offset`, which no caller sends, and omits `cursor` and `limit`, which every caller does. It ALSO carries `environmentId`, which callers do send and which is REQUIRED, so this route's undocumented parameters include one without which it cannot be called. Publishing TokenListQuery would still describe a query string the route does not accept.
   */
  async list(query?: Readonly<Record<string, string>>): Promise<CollectionEnvelope_BearerCredentialResource> {
    return this.transport.send<CollectionEnvelope_BearerCredentialResource>({
      operation: operation("get__mcp_platform_tokens"),
      path: "/mcp/platform/tokens",
      body: undefined,
      query: query,
    });
  }

  /** POST /mcp/platform/tokens */
  async mint(body: MintPlatformTokenBody): Promise<ItemEnvelope_MintedTokenResource> {
    return this.transport.send<ItemEnvelope_MintedTokenResource>({
      operation: operation("post__mcp_platform_tokens"),
      path: "/mcp/platform/tokens",
      body: body,
      query: undefined,
    });
  }

  /** POST /mcp/platform/tokens/:id/revoke */
  async revoke(id: string, body: RevokePlatformTokenBody): Promise<ItemEnvelope_RevokedTokenResource> {
    return this.transport.send<ItemEnvelope_RevokedTokenResource>({
      operation: operation("post__mcp_platform_tokens_by_id_revoke"),
      path: fill("/mcp/platform/tokens/:id/revoke", { id }),
      body: body,
      query: undefined,
    });
  }

}

/** Every generated V1 namespace, attached to one transport. */
export class V1Api {
  readonly bffSession: BffSessionV1Api;
  readonly environmentEndUsers: EnvironmentEndUsersV1Api;
  readonly environmentStreams: EnvironmentStreamsV1Api;
  readonly identitySession: IdentitySessionV1Api;
  readonly organizations: OrganizationsV1Api;
  readonly projects: ProjectsV1Api;
  readonly mcpEntityTokens: McpEntityTokensV1Api;
  readonly mcpOrganizationPolicies: McpOrganizationPoliciesV1Api;
  readonly mcpPlatformTokens: McpPlatformTokensV1Api;

  constructor(transport: V1Transport) {
    this.bffSession = new BffSessionV1Api(transport);
    this.environmentEndUsers = new EnvironmentEndUsersV1Api(transport);
    this.environmentStreams = new EnvironmentStreamsV1Api(transport);
    this.identitySession = new IdentitySessionV1Api(transport);
    this.organizations = new OrganizationsV1Api(transport);
    this.projects = new ProjectsV1Api(transport);
    this.mcpEntityTokens = new McpEntityTokensV1Api(transport);
    this.mcpOrganizationPolicies = new McpOrganizationPoliciesV1Api(transport);
    this.mcpPlatformTokens = new McpPlatformTokensV1Api(transport);
  }
}
