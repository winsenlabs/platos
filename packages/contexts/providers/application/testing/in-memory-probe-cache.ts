// An in-memory `ProviderProbeCache`.
//
// It holds an expiry per entry and honours it, so a test that advances the clock
// past a window sees the same miss production would. It deliberately does NOT
// apply a TTL of its own: the port's contract says freshness policy lives in
// `domain/health.ts`, and a double that quietly enforced one would hide a use
// case that forgot to.
//
// It counts reads and writes, which is how a test asserts the thing that matters
// most about a cache — that the second call did not reach the provider.

import { err, ok, type Result } from "@platos/kernel";

import { repositoryUnavailable, type ProviderHealthReport, type ProviderId } from "../../domain/index.js";
import type { ProviderProbeCache } from "../ports/index.js";

interface Entry<Value> {
  readonly value: Value;
  readonly expiresAt: Date;
}

export class InMemoryProviderProbeCache implements ProviderProbeCache {
  private readonly health = new Map<string, Entry<ProviderHealthReport>>();
  private readonly modelLists = new Map<string, Entry<readonly string[]>>();

  readonly forgotten: ProviderId[] = [];
  healthReads = 0;
  healthWrites = 0;
  modelListReads = 0;
  modelListWrites = 0;

  /** When set, every write fails — the "cache is unreachable" case. */
  writesFail = false;

  constructor(private readonly now: () => Date) {}

  private live<Value>(entry: Entry<Value> | undefined): Value | null {
    if (entry === undefined) return null;
    // Expiry is exclusive, matching `domain/health.ts`: an entry is gone AT its
    // instant, not after it.
    return this.now().getTime() < entry.expiresAt.getTime() ? entry.value : null;
  }

  async readHealth(key: string): Promise<Result<ProviderHealthReport | null>> {
    this.healthReads += 1;
    return ok(this.live(this.health.get(key)));
  }

  async writeHealth(key: string, report: ProviderHealthReport, expiresAt: Date): Promise<Result<void>> {
    this.healthWrites += 1;
    if (this.writesFail) return err(repositoryUnavailable("in-memory cache refuses writes"));
    this.health.set(key, { value: report, expiresAt });
    return ok(undefined);
  }

  async readModelList(key: string): Promise<Result<readonly string[] | null>> {
    this.modelListReads += 1;
    return ok(this.live(this.modelLists.get(key)));
  }

  async writeModelList(key: string, models: readonly string[], expiresAt: Date): Promise<Result<void>> {
    this.modelListWrites += 1;
    if (this.writesFail) return err(repositoryUnavailable("in-memory cache refuses writes"));
    this.modelLists.set(key, { value: models, expiresAt });
    return ok(undefined);
  }

  async forgetProvider(provider: ProviderId): Promise<Result<void>> {
    this.forgotten.push(provider);
    for (const map of [this.health, this.modelLists]) {
      for (const key of [...map.keys()]) {
        if (key.includes(`/${provider}/`)) map.delete(key);
      }
    }
    return ok(undefined);
  }
}
