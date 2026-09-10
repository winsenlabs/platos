/**
 * @platosdev/client — official JavaScript / TypeScript SDK for Platos
 * (Apache 2.0 open-source agent runtime).
 *
 * Surface (Theme I.1 – I.3, extending PPR-34 MVP):
 *   - `PlatosClient` — construction with session-token OR direct-header auth.
 *   - `client.agents.list / get / listVersions`
 *   - `client.threads.create / list / get / messages / artifacts / send`
 *     (send = async-iterable Socket.IO stream with hardened reconnect/buffer)
 *   - `client.messages.rate / unrate / getForMessage` — thumbs up/down votes
 *     on assistant messages (uses the server messageId from the
 *     `message_persisted` stream event)
 *   - `client.jobs` — Platos-owned asynchronous background work.
 *   - Error hierarchy (`PlatosAuthError`, `PlatosRateLimitError`, …) +
 *     configurable retry + `onTokenRefresh` hook.
 *
 * Auth modes (SPEC §10.2):
 *   - `sessionToken` — session-token JWT (MODE 2 — external callers). This
 *     is what consumer apps ship. The session token already carries the
 *     scope tuple so `scope` on each call is optional.
 *   - `apiKey`       — direct-header mode (MODE 1 — trusted internal use
 *     only). Ships `X-Platos-*` headers; the caller MUST provide the scope.
 */

export { PlatosClient } from "./client.js";
export {
  PlatosError,
  PlatosAuthError,
  PlatosNotFoundError,
  PlatosValidationError,
  PlatosRateLimitError,
  PlatosServerError,
  PlatosNetworkError,
  PlatosRefusal,
  errorFromResponse,
  isRetryableError,
  readWireError,
} from "./errors.js";
export type { PlatosWireErrorDetail } from "./errors.js";

// WIN-270 (M4.4) — THE V1 SURFACE. `./generated/v1.js` is emitted by
// `pnpm generate:sdk-v1` from the V1 OpenAPI document, the operation manifest
// and core-api's idempotency policy; `./v1-transport.js` is the hand-written
// auth/retry half. Re-exported here so a consumer reaches the V1 routes without
// importing a path that says "generated" — the generation is this repository's
// business, not the caller's.
export {
  V1Api,
  V1_OPERATIONS,
  WIRE_ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
} from "./generated/v1.js";
export type {
  V1IdempotencyClass,
  V1Operation,
  V1Request,
  V1Transport,
  WireError,
  WireErrorCode,
  ErrorEnvelope,
  CreateOrganizationBody,
  CreateProjectBody,
  ExchangeSessionBody,
  MintEntityTokenBody,
  MintPlatformTokenBody,
  MintedTokenResource,
  OperatorSessionResource,
  OrganizationResource,
  ProjectResource,
  EndUserResource,
} from "./generated/v1.js";
export {
  V1HttpTransport,
  createV1Client,
  IDEMPOTENCY_REPLAYED_HEADER,
} from "./v1-transport.js";
export type { V1ClientOptions, IdempotencyKeyFactory } from "./v1-transport.js";

export type {
  PlatosScope,
  PlatosAgent,
  PlatosThread,
  PlatosMessage,
  PlatosArtifact,
  PlatosStreamEvent,
  PlatosClientOptions,
  PlatosRetryOptions,
  PlatosTokenRefreshFn,
  SendMessageOptions,
} from "./types.js";

export { JobsApi } from "./apis/jobs.js";
export type {
  PlatosJob,
  JobStatus,
  ListJobsQuery,
  CreateJobInput,
  UpdateJobInput,
  DeleteJobResult,
  DispatchJobResult,
} from "./apis/jobs.js";

export type {
  PlatosTool,
  PlatosToolHealth,
  PlatosToolMatrixRow,
  PlatosToolStats,
  PlatosToolListOptions,
  PlatosToolSearchOptions,
  PlatosToolTestResult,
} from "./apis/tools.js";

export type {
  PlatosRatingDirection,
  PlatosMessageRating,
  PlatosMessageRatingState,
} from "./apis/messages.js";

import { PlatosClient } from "./client.js";
export default PlatosClient;
