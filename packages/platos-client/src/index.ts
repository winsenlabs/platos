/**
 * @platos/client — official JavaScript / TypeScript SDK for Platos
 * (Apache 2.0 open-source agent runtime).
 *
 * Surface (Theme I.1 – I.3, extending PPR-34 MVP):
 *   - `PlatosClient` — construction with session-token OR direct-header auth.
 *   - `client.agents.list / get / listVersions`
 *   - `client.threads.create / list / get / messages / artifacts / send`
 *     (send = async-iterable Socket.IO stream with hardened reconnect/buffer)
 *   - `client.bgo.tasks / runs / schedules / batches` — unified durable
 *     background-operation ops via the agent's meta-tool shim (Theme BGO,
 *     formerly `client.trigger.*`; the old namespace is kept as a
 *     deprecated alias for one release — see docs/BGO_RENAME.md).
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
  errorFromResponse,
  isRetryableError,
} from "./errors.js";

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

export type {
  TriggerTaskCatalogEntry,
  TriggerRunSummary,
  TriggerScheduleSummary,
  TriggerTaskOptions,
  TriggerHandle,
} from "./apis/trigger.js";

import { PlatosClient } from "./client.js";
export default PlatosClient;
