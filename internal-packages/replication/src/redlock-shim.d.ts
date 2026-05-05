/**
 * Ambient declaration for `redlock@5.0.0-beta.2`.
 *
 * The published package ships its real types at `dist/index.d.ts` but its
 * `exports` map is missing the `"types"` condition under `.`. Under
 * `moduleResolution: Node16`, TS won't resolve types without that
 * condition. The repo carries a pnpm patch (`patches/redlock@5.0.0-beta.2.patch`)
 * that adds the `"types"` key — but `turbo prune --docker` strips
 * `pnpm.patchedDependencies` from the pruned root `package.json`, so the
 * patch silently doesn't apply inside the webapp Docker build. Cue
 * TS7016 "Could not find a declaration file for module 'redlock'" at
 * client.ts:5.
 *
 * Rather than fight turbo prune (the patch flow is one of several it
 * doesn't preserve cleanly), this ambient declaration covers the surface
 * `client.ts` actually uses. Locally — where the patch IS applied — TS
 * picks the real types from the package over the ambient ones; this
 * file is silently ignored. In Docker, this file is the type source.
 */
declare module "redlock" {
  import type { Redis as IORedisClient, Cluster as IORedisCluster } from "ioredis";
  import { EventEmitter } from "events";

  type Client = IORedisClient | IORedisCluster;

  export interface Settings {
    readonly driftFactor: number;
    readonly retryCount: number;
    readonly retryDelay: number;
    readonly retryJitter: number;
    readonly automaticExtensionThreshold: number;
  }

  export class ResourceLockedError extends Error {
    readonly message: string;
    constructor(message: string);
  }

  export class ExecutionError extends Error {
    readonly message: string;
    readonly attempts: ReadonlyArray<Promise<unknown>>;
    constructor(message: string, attempts: ReadonlyArray<Promise<unknown>>);
  }

  export class Lock {
    readonly redlock: Redlock;
    readonly resources: string[];
    readonly value: string;
    readonly attempts: ReadonlyArray<Promise<unknown>>;
    expiration: number;
    release(): Promise<unknown>;
    extend(duration: number): Promise<Lock>;
  }

  export default class Redlock extends EventEmitter {
    constructor(clients: Iterable<Client>, settings?: Partial<Settings>);
    readonly clients: Set<Client>;
    readonly settings: Settings;
    acquire(resources: string[], duration: number, settings?: Partial<Settings>): Promise<Lock>;
    release(lock: Lock): Promise<unknown>;
    using<T>(
      resources: string[],
      duration: number,
      settingsOrRoutine: Partial<Settings> | ((signal: { aborted: boolean; error?: Error }) => Promise<T>),
      routine?: (signal: { aborted: boolean; error?: Error }) => Promise<T>,
    ): Promise<T>;
  }
}
