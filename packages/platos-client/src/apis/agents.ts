/**
 * @platosdev/client — agents API. Theme I.1.
 */

import type { PlatosClient } from "../client.js";
import { PlatosNotFoundError } from "../errors.js";
import type { PlatosAgent, PlatosScope } from "../types.js";

export class AgentsApi {
  constructor(private readonly client: PlatosClient) {}

  /**
   * List agents visible within the caller's scope. The server enforces
   * scope filtering on every query — a token from env=dev cannot see
   * env=prod agents even if it asks nicely.
   */
  async list(scope?: PlatosScope): Promise<PlatosAgent[]> {
    const res = await this.client._fetch<{ agents: PlatosAgent[] }>(
      "/api/v1/agent/agents",
      { method: "GET" },
      scope,
    );
    return res?.agents ?? [];
  }

  async get(agentId: string, scope?: PlatosScope): Promise<PlatosAgent | null> {
    try {
      return await this.client._fetch<PlatosAgent>(
        `/api/v1/agent/agents/${encodeURIComponent(agentId)}`,
        { method: "GET" },
        scope,
      );
    } catch (err) {
      if (err instanceof PlatosNotFoundError) return null;
      throw err;
    }
  }

  /** List prior versions for an agent (G.4 support). */
  async listVersions(agentId: string, scope?: PlatosScope): Promise<unknown[]> {
    const res = await this.client._fetch<{ versions: unknown[] }>(
      `/api/v1/agent/agents/${encodeURIComponent(agentId)}/versions`,
      { method: "GET" },
      scope,
    );
    return res?.versions ?? [];
  }
}
