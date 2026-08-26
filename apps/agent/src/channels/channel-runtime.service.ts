import {
  Injectable,
  Logger,
  Inject,
  Optional,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { TurnDispatchService } from "../agent-runtime/turn-dispatch.service";
import { env } from "../shared/env";
import type { RequestScope } from "../auth/scope.guard";
import {
  buildAssistantPrompts,
  setAssistantStatus,
  setAssistantSuggestedPrompts,
  setAssistantTitle,
} from "./slack-assistant.api";
// Connect v3 (Phase C) — hosted account linking. The link/unlink START of the
// hosted SIWS flow lives in the OTHER slice's controller; this service CONSUMES
// it via constructor DI. Injected @Optional() (see constructor) so that until
// that slice lands — or in a focused test module that omits it — the service
// degrades to `linking:none` behavior (no connect URLs, no gate) instead of
// failing to construct.
import { ChannelLinkService } from "./channel-link.controller";
import { ChannelPersistenceService } from "./channel-persistence.service";

// ═══════════════════════════════════════════════════════════════════════════
// Chat SDK (v4.34) — RUNTIME + BRIDGE slice.
//
// These packages are declared in apps/agent/package.json + pnpm-lock.yaml but
// were NOT installed into node_modules at author time (local `pnpm install`
// OOMs this machine). Every SDK touch-point is therefore isolated into small,
// clearly-marked functions in THIS file so the first real build only has to
// adjust these call sites — never the bridge logic. See the "Chat-SDK API
// assumptions" list in the slice report for the exact contract each call
// relies on.
// ═══════════════════════════════════════════════════════════════════════════
// The chat family is ESM-ONLY: its exports map defines only the "import"
// condition (no "require"/"default"), so CJS `require()` — including Node 22's
// require(esm) — throws ERR_PACKAGE_PATH_NOT_EXPORTED (took the agent down on
// first deploy; tsc can't catch it because typings resolve via "types").
// The ONLY loader that works from this CJS bundle is a REAL dynamic import();
// `new Function` shields it from tsc(module=commonjs) transpiling it into the
// very require() that fails.
const dynamicImport = new Function("s", "return import(s)") as (
  s: string,
) => Promise<any>;

interface ChatSdk {
  Chat: any;
  createSlackAdapter: any;
  createTelegramAdapter: any;
  createWhatsAppAdapter: any;
  createDiscordAdapter: any;
  createPostgresState: any;
}

let sdkPromise: Promise<ChatSdk> | null = null;
/** Memoized ESM loader; resets on failure so a transient error can retry. */
function loadChatSdk(): Promise<ChatSdk> {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      dynamicImport("chat"),
      dynamicImport("@chat-adapter/slack"),
      dynamicImport("@chat-adapter/telegram"),
      dynamicImport("@chat-adapter/whatsapp"),
      dynamicImport("@chat-adapter/discord"),
      dynamicImport("@chat-adapter/state-pg"),
    ])
      .then(([chat, slack, telegram, whatsapp, discord, statePg]) => ({
        Chat: (chat as any).Chat,
        createSlackAdapter: (slack as any).createSlackAdapter,
        createTelegramAdapter: (telegram as any).createTelegramAdapter,
        createWhatsAppAdapter: (whatsapp as any).createWhatsAppAdapter,
        createDiscordAdapter: (discord as any).createDiscordAdapter,
        createPostgresState: (statePg as any).createPostgresState,
      }))
      .catch((e) => {
        sdkPromise = null;
        throw e;
      });
  }
  return sdkPromise;
}

/**
 * The slice of a PlatosChannelConnection row the bridge needs at message time.
 * Explicitly does NOT carry `credentials` — decrypted creds live ONLY inside
 * the cached Chat instance's adapter, are never returned, never logged.
 */
interface ConnectionContext {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  environment: any;
  entityPk: string | null;
  provider: string;
  /** Default agent (used when no routing rule matches). */
  agentId: string;
  /** Ordered routing rule list (raw JSON) or null. */
  agentRouting: unknown;
  /** Non-secret provider extras (slack team_id, whatsapp phoneNumberId…). */
  config: Record<string, unknown> | null;
}

interface CachedBot {
  bot: any;
  provider: string;
  credentialRevision: string;
  generation: number;
  builtAt: number;
  /** Discord-only: tear down the long-lived Gateway WebSocket on evict. */
  gatewayStop?: () => void | Promise<void>;
}

interface BuildingBot {
  generation: number;
  promise: Promise<CachedBot>;
}

export interface ChannelAppEventContext {
  eventId: string;
  abortSignal: AbortSignal;
  persistedTurn?: { id: string; threadId: string; outputText: string | null } | null;
  onTurnCompleted: (turnId: string) => Promise<boolean>;
  onDeliveryCompleted: () => Promise<boolean>;
}

export class ChannelDeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ChannelDeliveryError";
  }
}

/**
 * Connect v3 (channel APPS tier) — a per-installation decrypted bot-token
 * memo. The app tier does NOT build a Chat SDK instance (see handleAppEvent
 * for why v1 is a direct bridge + direct fetch), so unlike the v2 connection
 * cache there is nothing expensive to hold here — just the decrypted bot token
 * for a workspace, so a busy install doesn't re-decrypt on every message. Keyed
 * `app:<appId>:<team>`; evicted by invalidateApp on credential/reinstall.
 */
interface CachedAppCreds {
  /**
   * Revision of the installation's referenced Credential. A re-install or
   * token refresh changes the revision and bypasses the TTL immediately.
   */
  credentialRevision: string;
  botToken: string;
  builtAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE routing helpers (contract-shaped, no I/O — safe to share with the
// management slice's channel-routing.ts once it lands; kept here to avoid a
// build-time coupling to a file that does not exist yet).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the platform channel/group/guild-channel id from a Chat SDK thread
 * id. Thread ids look like:
 *   slack:C123ABC:1699.123     → "C123ABC"
 *   telegram:123456789         → "123456789"
 *   discord:987654321:111.222  → "987654321"
 *   whatsapp:15551234567       → "15551234567"
 * i.e. the SECOND colon-delimited segment (the first is the provider).
 */
export function extractPlatformChannelId(threadId: string): string | null {
  if (typeof threadId !== "string") return null;
  const parts = threadId.split(":");
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

/**
 * PURE — resolve which agent an inbound message routes to. First matching
 * rule in `connection.agentRouting` wins; otherwise the connection default.
 * Never throws on malformed rules (defensive skip). Only used on FIRST contact
 * for a channel-thread — the result is then pinned on PlatosChannelThread.
 */
export function resolveAgentForMessage(
  connection: { agentId: string; agentRouting?: unknown },
  input: { platformChannelId: string | null; text: string },
): string {
  const rules = Array.isArray(connection.agentRouting)
    ? (connection.agentRouting as unknown[])
    : [];
  const text = typeof input.text === "string" ? input.text.replace(/^\s+/, "") : "";
  const lower = text.toLowerCase();
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const rule = raw as { match?: any; agentId?: unknown };
    const ruleAgentId = rule.agentId;
    const match = rule.match;
    if (typeof ruleAgentId !== "string" || !ruleAgentId) continue;
    if (!match || typeof match !== "object") continue;
    if (match.type === "channel") {
      const id = match.id;
      if (typeof id === "string" && id && input.platformChannelId === id) {
        return ruleAgentId;
      }
    } else if (match.type === "prefix") {
      const value = match.value;
      if (typeof value === "string" && value) {
        const v = value.toLowerCase();
        // "ada" matches "ada: ..." or "@ada ..." (case-insensitive).
        if (lower.startsWith(`${v}:`) || lower.startsWith(`@${v}`)) {
          return ruleAgentId;
        }
      }
    }
  }
  return connection.agentId;
}

/**
 * ChannelRuntimeService — the per-connection Chat SDK runtime + the Platos
 * bridge.
 *
 * ONE PlatosChannelConnection → ONE cached multi-tenant `Chat` instance (NOT
 * the chat-sdk singleton pattern). Each instance is built with the connection's
 * OWN decrypted credentials and a Postgres state store key-prefixed by
 * connectionId so two connections never share adapter state.
 *
 * The bridge (onNewMention / onSubscribedMessage / onDirectMessage) resolves a
 * Platos scope + agent + thread, then runs a detached Platos turn and posts the
 * reply back through the SDK.
 */
@Injectable()
export class ChannelRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelRuntimeService.name);

  /** connectionId → cached Chat instance. Evicted on update/rotate + TTL. */
  private readonly cache = new Map<string, CachedBot>();
  /** connectionId → in-flight build (async build ⇒ dedupe concurrent hits). */
  private readonly building = new Map<string, BuildingBot>();
  /** Monotonic process-local fence advanced by every invalidate, cached or not. */
  private readonly generations = new Map<string, number>();
  /**
   * Connect v3 — `app:<appId>:<team>` → decrypted bot token. Evicted by
   * invalidateApp on app-credential edits + workspace re-install + revoke.
   */
  private readonly appCache = new Map<string, CachedAppCreds>();
  private readonly TTL_MS = 10 * 60 * 1000; // 10 min
  /**
   * Connect v3 (Phase D) token rotation — refresh a rotating installation's bot
   * token when it is within this window of expiry (or already past). Slack
   * rotating tokens live 43200s (12h); 120s of headroom refreshes ahead of any
   * plausible clock skew / in-flight turn without churning.
   */
  private static readonly TOKEN_REFRESH_SKEW_MS = 120 * 1000; // 120s
  /**
   * Connect v3 (Phase C) — POSITIVE account-link memo: `installationId:slackHandle`
   * → expiry epoch-ms. A `linking:required` app checks per message whether the
   * author's slack person has a verified email link; a hit is cached for 10 min
   * so the two-query lookup doesn't run on every turn. NEGATIVES are never cached
   * (a user who links mid-conversation is unblocked on their very next message).
   */
  private readonly linkStatusCache = new Map<string, number>();
  /** Discord keep-warm sweep cadence (see onModuleInit). */
  private readonly DISCORD_WARM_INTERVAL_MS = 60 * 1000;
  private discordWarmTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly persistence: ChannelPersistenceService,
    // The durable-vs-direct chokepoint. Both channel turn call-sites route
    // through collectTurn so a durable Walle/Slack agent now drives a Trigger
    // SESSION (the ONE durable mechanism — the SAME session envelope the
    // dashboard demo uses) and the channel posts the awaited final text
    // (accumulated off the session's durable .out) back — the invariant holds on
    // the channel path too. The Slack post-back stays a channel-only TAIL,
    // downstream of the decision. (This replaced the direct
    // AgentTaskService.executeNonStreamingTurn call both call-sites used to
    // make — the channel no longer touches the runner directly, so
    // AgentTaskService is no longer injected here.)
    private readonly dispatch: TurnDispatchService,
    // Connect v3 (Phase C) — owned by the link-controller slice. @Optional so its
    // absence degrades cleanly to `linking:none` (no connect URLs surfaced).
    @Optional()
    @Inject(ChannelLinkService)
    private readonly channelLinkService?: ChannelLinkService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Lifecycle — Discord Gateway warm-up
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Discord regular (non-interaction) messages arrive ONLY over the
   * long-lived Gateway WebSocket — no webhook hit ever initiates the lazy
   * getOrCreateBot build for them. So after every boot the bots for enabled
   * discord connections must be warmed EAGERLY, and kept warm on an interval
   * (webhook-driven TTL refresh never happens for a gateway-only
   * connection). The sweep also picks up discord connections created/enabled
   * after boot and tears down gateways whose row was disabled/deleted —
   * gateway traffic bypasses the inbound controller's per-request `enabled`
   * re-check entirely. Guarded: zero discord connections starts nothing.
   */
  async onModuleInit(): Promise<void> {
    if (this.destroyed) return;
    await this.warmDiscordConnections();
    if (this.destroyed) return;
    this.discordWarmTimer = setInterval(() => {
      void this.warmDiscordConnections();
    }, this.DISCORD_WARM_INTERVAL_MS);
    // Never keep the process alive just for the sweep.
    (this.discordWarmTimer as any)?.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.discordWarmTimer) clearInterval(this.discordWarmTimer);
    this.discordWarmTimer = null;
    // Any asynchronous build that completes after shutdown is stale and must
    // self-stop rather than publishing a fresh gateway into a dying module.
    this.building.clear();
    // Tear down every cached bot (esp. Discord gateway sockets) on shutdown.
    for (const [id, cached] of this.cache) {
      this.cache.delete(id);
      this.stopCached(cached);
    }
    // Connect v3 — drop decrypted app tokens on shutdown (no sockets to close).
    this.appCache.clear();
  }

  /** Ensure a live bot per enabled discord connection; evict dead ones. */
  private async warmDiscordConnections(): Promise<void> {
    if (this.destroyed) return;
    let rows: any[];
    try {
      rows = await this.persistence.listEnabledConnections("discord");
    } catch {
      return; // DB hiccup — the next sweep retries
    }
    if (this.destroyed) return;
    const liveIds = new Set(rows.map((r: any) => String(r.id)));
    // Disabled/deleted discord connections must lose their gateway NOW —
    // no webhook path will ever re-check them.
    for (const [id, cached] of this.cache) {
      if (cached.provider === "discord" && !liveIds.has(id)) {
        this.invalidate(id);
      }
    }
    for (const row of rows) {
      if (this.destroyed) return;
      try {
        // No-op when fresh; rebuilds (with fresh creds/config) on TTL expiry.
        await this.getOrCreateBot(row);
      } catch {
        // Per-connection isolation — one broken connection (e.g. undecryptable
        // credentials) must not block the rest or crash bootstrap.
        this.logger.error(
          `[channels] discord warm-up failed connection=${row.id}`,
        );
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Return the cached Chat instance for a connection, building (and caching)
   * one if absent or expired. The caller (inbound controller) has already
   * loaded + auth-checked the row (webhookSecret timing-safe compare); we take
   * the row directly to avoid a second fetch + re-decrypt.
   */
  async getOrCreateBot(
    connection: any,
  ): Promise<{ bot: any; provider: string }> {
    const connectionId = String(connection?.id ?? connection ?? "");
    if (this.destroyed) throw new Error("channel runtime destroyed");
    const generation = this.generations.get(connectionId) ?? 0;
    const canonical = await this.persistence.loadConnection(connectionId);
    if (this.destroyed) throw new Error("channel runtime destroyed");
    if ((this.generations.get(connectionId) ?? 0) !== generation) {
      throw new Error("channel bot build invalidated");
    }
    if (!canonical || canonical.enabled !== true) {
      throw new Error("channel connection unavailable");
    }
    connection = canonical;
    const existing = this.cache.get(connectionId);
    if (
      existing &&
      existing.generation === generation &&
      existing.credentialRevision === connection.credentialRevision &&
      Date.now() - existing.builtAt < this.TTL_MS
    ) {
      return { bot: existing.bot, provider: existing.provider };
    }
    // buildBot is ASYNC (ESM dynamic import) — without an in-flight memo two
    // concurrent webhooks would both build, and the loser's Discord gateway
    // would leak as a live duplicate-processing socket.
    const inFlight = this.building.get(connectionId);
    if (inFlight?.generation === generation) {
      const built = await inFlight.promise;
      if (this.destroyed || (this.generations.get(connectionId) ?? 0) !== generation) {
        throw new Error("channel bot build invalidated");
      }
      return { bot: built.bot, provider: built.provider };
    }
    if (existing) {
      // Expired — tear the old one down (esp. Discord gateway) before rebuild.
      this.cache.delete(connectionId);
      this.stopCached(existing);
    }
    const entry = {} as BuildingBot;
    const promise = this.buildBot(connection, generation)
      .then((built) => {
        built.generation = generation;
        if (
          this.destroyed ||
          (this.generations.get(connectionId) ?? 0) !== generation ||
          this.building.get(connectionId) !== entry
        ) {
          this.stopCached(built);
          throw new Error("channel bot build invalidated");
        }
        this.cache.set(connectionId, built);
        if (this.building.get(connectionId) === entry) this.building.delete(connectionId);
        this.logger.log(
          `[channels] built bot connection=${connectionId} provider=${built.provider}`,
        );
        return built;
      })
      .catch((e) => {
        if (this.building.get(connectionId) === entry) this.building.delete(connectionId);
        throw e;
      });
    entry.generation = generation;
    entry.promise = promise;
    this.building.set(connectionId, entry);
    const built = await promise;
    if (this.destroyed || (this.generations.get(connectionId) ?? 0) !== generation) {
      throw new Error("channel bot build invalidated");
    }
    return { bot: built.bot, provider: built.provider };
  }

  /**
   * Evict a connection's cached Chat instance. Called on credential/secret
   * rotation or config update so the next inbound rebuilds with fresh state.
   * Also tears down the Discord gateway socket if one is running. Idempotent.
   */
  invalidate(connectionId: string): void {
    this.generations.set(
      connectionId,
      (this.generations.get(connectionId) ?? 0) + 1,
    );
    const cached = this.cache.get(connectionId);
    if (cached) {
      this.cache.delete(connectionId);
      this.stopCached(cached);
      this.logger.log(`[channels] invalidated bot cache connection=${connectionId}`);
    }
    // A discord connection has no webhook traffic to lazily rebuild its
    // gateway — re-warm promptly (still enabled → fresh bot; disabled/deleted
    // → no-op). Fire-and-forget; the 60s sweep is the backstop.
    if (!this.destroyed && cached?.provider === "discord" && this.discordWarmTimer) {
      void this.warmDiscordConnections();
    }
  }

  /**
   * Connect v3 — evict the cached decrypted bot token(s) for a channel APP.
   * Mirrors invalidate() for the v2 connection cache: called after the app's
   * credentials change (management PATCH/DELETE), after a workspace re-installs
   * (OAuth callback upserts a fresh botToken on the same installation row), and
   * after an installation is revoked (uninstall / tokens_revoked). Without it
   * a rotated bot token keeps posting from memory for up to the 10-min TTL.
   * One app fans out to many workspace installations, so every cache entry
   * under the `app:<appId>:` prefix is dropped. Idempotent + best-effort.
   */
  invalidateApp(appId: string): void {
    if (!appId) return;
    const prefix = `app:${appId}:`;
    const doomed: string[] = [];
    for (const key of this.appCache.keys()) {
      if (key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) this.appCache.delete(key);
    if (doomed.length > 0) {
      this.logger.log(
        `[channel-apps] invalidated ${doomed.length} cached token(s) app=${appId}`,
      );
    }
  }

  /** Drop positive account-link assertions after provider revocation. */
  invalidateIdentityLinks(): void {
    this.linkStatusCache.clear();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Chat SDK construction (ISOLATED — adjust here after first real build)
  // ───────────────────────────────────────────────────────────────────────

  private async buildBot(connection: any, generation = 0): Promise<CachedBot> {
    this.assertBuildActive(String(connection.id), generation);
    const sdk = await loadChatSdk();
    this.assertBuildActive(String(connection.id), generation);
    const provider = String(connection.provider);
    const creds = this.decryptCredentials(connection);
    const config = this.isPlainObject(connection.config) ? connection.config : {};
    const adapter = this.buildAdapter(sdk, provider, creds, config);
    this.assertBuildActive(String(connection.id), generation);

    const bot = new sdk.Chat({
      userName: "platos",
      adapters: { [provider]: adapter },
      state: sdk.createPostgresState({
        url: env.DATABASE_URL,
        keyPrefix: `chat:${connection.id}`,
      }),
      onLockConflict: "drop",
    });

    const connCtx: ConnectionContext = {
      id: String(connection.id),
      organizationId: String(connection.organizationId),
      projectId: String(connection.projectId),
      environmentId: String(connection.environmentId),
      environment: connection.environment,
      entityPk: connection.entityPk ?? null,
      provider,
      agentId: String(connection.agentId),
      agentRouting: connection.agentRouting ?? null,
      config: this.isPlainObject(connection.config) ? connection.config : null,
    };

    this.registerHandlers(bot, connCtx);
    this.assertBuildActive(String(connection.id), generation);

    let gatewayStop: (() => void | Promise<void>) | undefined;
    if (provider === "discord") {
      // Regular (non-mention) Discord messages arrive over a long-lived
      // Gateway WebSocket, not the webhook. This is a persistent Nest process,
      // so start the listener. Guarded so a non-Discord connection starts
      // nothing (buildBot only reaches here for a discord provider).
      gatewayStop = this.startDiscordGateway(bot) || undefined;
    }

    return {
      bot,
      provider,
      credentialRevision: String(connection.credentialRevision ?? "none"),
      generation: 0,
      builtAt: Date.now(),
      gatewayStop,
    };
  }

  private assertBuildActive(connectionId: string, generation: number): void {
    if (this.destroyed || (this.generations.get(connectionId) ?? 0) !== generation) {
      throw new Error("channel bot build invalidated");
    }
  }

  /** Build the provider adapter from DECRYPTED creds + public config. */
  private buildAdapter(
    sdk: ChatSdk,
    provider: string,
    creds: Record<string, unknown>,
    config: Record<string, unknown>,
  ): any {
    // Adapter options = public config (team_id, phoneNumberId, verifyToken…)
    // overlaid with the decrypted secrets (signingSecret, botToken, appSecret,
    // publicKey, secretToken…). Secrets win on key collision. NEVER env vars.
    const opts = { ...config, ...creds };
    switch (provider) {
      case "slack":
        return sdk.createSlackAdapter(opts as any);
      case "telegram":
        return sdk.createTelegramAdapter(opts as any);
      case "whatsapp":
        return sdk.createWhatsAppAdapter(opts as any);
      case "discord":
        return sdk.createDiscordAdapter(opts as any);
      default:
        throw new Error(`unsupported channel provider: ${provider}`);
    }
  }

  /**
   * Start the Discord Gateway listener. The exact start/stop surface is
   * finalized at the first real build against the installed
   * @chat-adapter/discord dist; probe the known shapes defensively so absence
   * of the method degrades to "webhook-only" rather than crashing the process.
   * Returns a stop() thunk (or undefined) for eviction-time teardown.
   */
  private startDiscordGateway(bot: any): (() => void | Promise<void>) | undefined {
    try {
      const anyBot = bot as any;
      if (typeof anyBot.startGateway === "function") {
        const handle = anyBot.startGateway();
        return () => {
          try {
            if (handle && typeof handle.stop === "function") handle.stop();
            else if (typeof anyBot.stopGateway === "function") anyBot.stopGateway();
          } catch {
            /* best-effort */
          }
        };
      }
      if (anyBot.gateway && typeof anyBot.gateway.start === "function") {
        anyBot.gateway.start();
        return () => {
          try {
            anyBot.gateway.stop?.();
          } catch {
            /* best-effort */
          }
        };
      }
      if (typeof anyBot.listen === "function") {
        const handle = anyBot.listen();
        return () => {
          try {
            handle?.stop?.();
          } catch {
            /* best-effort */
          }
        };
      }
      this.logger.warn(
        "[channels] discord gateway start method not found on Chat instance — regular messages will not stream until the adapter API is wired",
      );
      return undefined;
    } catch {
      this.logger.error("[channels] discord gateway start failed");
      return undefined;
    }
  }

  private registerHandlers(bot: any, connCtx: ConnectionContext): void {
    // onNewMention: subscribe FIRST so follow-up messages in this thread route
    // through onSubscribedMessage, then handle the mention itself.
    bot.onNewMention(async (thread: any, message: any) => {
      try {
        await thread.subscribe();
      } catch {
        /* subscribe best-effort — still handle this message */
      }
      await this.handleInbound(connCtx, bot, thread, message);
    });

    bot.onSubscribedMessage(async (thread: any, message: any) => {
      await this.handleInbound(connCtx, bot, thread, message);
    });

    bot.onDirectMessage(async (thread: any, message: any) => {
      await this.handleInbound(connCtx, bot, thread, message);
    });
  }

  private stopCached(cached: CachedBot): void {
    try {
      cached.gatewayStop?.();
    } catch {
      /* best-effort */
    }
    try {
      (cached.bot as any)?.close?.();
    } catch {
      /* best-effort */
    }
    try {
      (cached.bot as any)?.stop?.();
    } catch {
      /* best-effort */
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // BRIDGE — inbound message → Platos turn → reply
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Conversation identity for a channel-native thread. Group channel-threads
   * (Slack channels, Discord guild channels, Telegram groups) have MANY human
   * authors, but PlatosAgentThread ownership (`getThread`'s
   * userId/createdByUserId OR-filter) is single-user — if turns ran under the
   * per-AUTHOR userId, only the first author could ever resolve the pinned
   * thread and every other participant would silently mint a fresh,
   * memoryless Platos thread per message. All turns on a channel-thread
   * therefore run under this DETERMINISTIC per-thread service userId; the
   * real author's identity still flows through `scope.userIdentities` →
   * `resolveEndUser` (link-not-merge), so identity linkage stays truthful.
   */
  private channelConversationUserId(
    connectionId: string,
    threadKey: string,
  ): string {
    return `channel:${connectionId}:${threadKey}`;
  }

  private async handleInbound(
    connCtx: ConnectionContext,
    bot: any,
    thread: any,
    message: any,
  ): Promise<void> {
    const connectionId = connCtx.id;
    const provider = connCtx.provider;

    // Never react to bot-authored messages (our own replies, other bots) — a
    // hard stop against reply loops.
    if (message?.author?.isBot === true) return;

    const threadKey = typeof thread?.id === "string" ? thread.id : "";
    const authorUserId = String(message?.author?.userId ?? "");
    if (!threadKey || !authorUserId) {
      this.logger.warn(
        `[channels] inbound skipped (missing thread/author) connection=${connectionId} provider=${provider}`,
      );
      return;
    }

    this.logger.log(
      `[channels] inbound-message connection=${connectionId} provider=${provider}`,
    );

    // Typing indicator (best-effort, where the provider supports it).
    try {
      await thread.startTyping?.();
    } catch {
      /* best-effort */
    }

    // ── Identity + scope ──────────────────────────────────────────────────
    // The signature verification already ran inside the adapter's webhook
    // handler, so this handle is provider-verified.
    //
    // Slack user ids (U…/W…) are only unique PER WORKSPACE — two connections
    // to different workspaces in one environment could otherwise merge two
    // distinct humans into one end-user (the scope-tuple-≠-user-boundary
    // archetype, accidental variant). Qualify the handle with the team id
    // when the raw event carries one; other providers' ids are globally
    // unique within the provider.
    const slackTeam =
      provider === "slack"
        ? String(
            (message?.raw as any)?.team ??
              (message?.raw as any)?.team_id ??
              (connCtx.config as any)?.team_id ??
              "",
          )
        : "";
    const identityHandle = slackTeam ? `${slackTeam}:${authorUserId}` : authorUserId;
    const claims = [{ channel: provider, handle: identityHandle, verified: true }];
    const authorScope: RequestScope = {
      organizationId: connCtx.organizationId,
      projectId: connCtx.projectId,
      environmentId: connCtx.environmentId,
      userId: `${provider}:${identityHandle}`,
      entityId: connCtx.entityPk ?? undefined,
      userIdentities: claims,
    };
    // Conversation identity is PER-CHANNEL-THREAD, not per-author (see
    // channelConversationUserId) — this is what lets user B resolve the
    // thread user A's first message created. The author's claims stay on the
    // scope so per-turn endUser resolution remains per-author-truthful.
    const conversationScope: RequestScope = {
      ...authorScope,
      userId: this.channelConversationUserId(connectionId, threadKey),
    };

    // ── Resolve or create the (pinned) agent + Platos thread ──────────────
    let agentId: string;
    let platosThreadId: string;
    try {
      const resolved = await this.resolveThreadBinding(
        connCtx,
        authorScope,
        conversationScope,
        threadKey,
        typeof message?.text === "string" ? message.text : "",
      );
      agentId = resolved.agentId;
      platosThreadId = resolved.platosThreadId;
      conversationScope.userId = resolved.endUserId;
    } catch {
      this.logger.error(
        `[channels] thread-binding failed connection=${connectionId} provider=${provider}`,
      );
      try {
        await thread.post(
          "Sorry — I couldn't start that conversation just now. Please try again.",
        );
      } catch {
        /* best-effort */
      }
      return;
    }

    // ── Detached Platos turn ──────────────────────────────────────────────
    // The webhook has already ACKed (waitUntil). Run the turn off the response
    // path so a slow LLM never blocks the < 3s webhook contract.
    //
    // `threadId` is NOT a declared RequestScope field — the assertion mirrors
    // internalDurableTurn's `body.scope as any` (spans.service reads the
    // extra key for trace attribution; a plain typed literal is a TS2353).
    const turnScope = {
      ...conversationScope,
      agentId,
      threadId: platosThreadId,
      sessionId: platosThreadId,
    } as RequestScope;
    const userText = typeof message?.text === "string" ? message.text : "";
    // Capture the SDK thread id NOW — the detached closure below outlives the
    // handler (and its per-thread state lock), so delivery must go through
    // the out-of-handler path `bot.thread(threadId).post(...)`, never the
    // handler-scoped `thread` object.
    const chatThreadId = threadKey;
    void (async () => {
      try {
        // Route through the dispatch chokepoint (collected-result mode). A
        // DIRECT agent runs in-process exactly as before; a DURABLE agent now
        // drives a Trigger SESSION and we return the reply accumulated off its
        // durable .out. Fail-open: a session unavailable pre-commit falls back
        // to the in-process turn (never a dropped turn). The Slack post-back
        // below is a channel-only TAIL, downstream of this decision.
        const result = await this.dispatch.collectTurn(agentId, {
          scope: turnScope,
          message: userText,
          threadId: platosThreadId,
        });
        if (result?.threadId && result.threadId !== platosThreadId) {
          // Should be impossible now that the conversation userId is
          // per-channel-thread — surface loudly if it ever regresses.
          this.logger.warn(
            `[channels] turn thread diverged from pinned mapping connection=${connectionId} provider=${provider} pinned=${platosThreadId} got=${result.threadId}`,
          );
        }
        const reply = (result?.text ?? "").trim();
        if (reply) {
          await this.postOutOfHandler(bot, chatThreadId, reply);
        }
      } catch {
        this.logger.error(
          `[channels] turn failed connection=${connectionId} provider=${provider}`,
        );
        try {
          await this.postOutOfHandler(
            bot,
            chatThreadId,
            "Sorry — something went wrong on my end. Please try again in a moment.",
          );
        } catch {
          /* best-effort */
        }
      }
    })();
  }

  /**
   * Deliver a message OUTSIDE the SDK handler's lifetime. The handler-scoped
   * `thread` object is only valid while the handler (and the per-thread state
   * lock, `onLockConflict: 'drop'`) is live; the detached turn finishes long
   * after the webhook handler returned, so it must use the SDK's
   * out-of-handler delivery surface `bot.thread(threadId).post(...)`.
   */
  private async postOutOfHandler(
    bot: any,
    chatThreadId: string,
    text: string,
  ): Promise<void> {
    await bot.thread(chatThreadId).post(text);
  }

  /**
   * Look up (or create) the PlatosChannelThread mapping for this channel-native
   * conversation. On first contact the agent is resolved via the connection's
   * routing rules and PINNED onto the row; every later message reuses it.
   *
   * `conversationScope` (per-channel-thread service userId) OWNS the Platos
   * thread — so every participant in a shared channel resolves the same
   * thread. `authorScope` (real per-author userId + verified claims) is used
   * only for endUser linkage, keeping identity attribution truthful.
   */
  private async resolveThreadBinding(
    connCtx: ConnectionContext,
    authorScope: RequestScope,
    conversationScope: RequestScope,
    threadKey: string,
    text: string,
  ): Promise<{ agentId: string; platosThreadId: string; endUserId: string }> {
    // First contact — resolve the agent from routing rules.
    const platformChannelId = extractPlatformChannelId(threadKey);
    const agentId = resolveAgentForMessage(
      { agentId: connCtx.agentId, agentRouting: connCtx.agentRouting },
      { platformChannelId, text },
    );

    // IDENTITY-CORE §C (G1 + G6) — compute the single-end-user gate from the
    // platform channel id. SLACK: a DM channel id begins with "D" (matches the
    // assistant-thread predicate below at `parsed.channel.startsWith("D")`);
    // group DMs ("G"/mpim) and channels ("C") are multi-human ⇒ false. Any
    // NON-SLACK provider on this v1 path has NO DM predicate and a "D"-prefix
    // test is meaningless for its channel-id scheme, so we FAIL CLOSED (false)
    // until a per-provider predicate lands: a false-negative only withholds
    // per-user Composio, while a false-positive would be a cross-user execution
    // bug. Passed through to createThread's `singleEndUser` so a shared thread's
    // `resolveOriginEndUserId` returns null (fails closed) instead of running
    // Composio as the first author.
    const isDmOrAssistant =
      connCtx.provider === "slack"
        ? platformChannelId?.startsWith("D") === true
        : false;

    const qualifiedSubject = String(authorScope.userId).replace(/^[^:]+:/, "");
    const subjectParts = qualifiedSubject.split(":");
    const realm =
      connCtx.provider === "slack" && subjectParts.length > 1
        ? subjectParts[0]
        : String((connCtx.config as any)?.team_id ?? "global");
    const bound = await this.persistence.resolveConnectionThread({
      connection: connCtx,
      provider: connCtx.provider,
      realm,
      authorSubject: subjectParts.pop() ?? "",
      channelThreadKey: threadKey,
      agentId,
      singleEndUser: isDmOrAssistant,
    });
    return {
      agentId: bound.agentId,
      platosThreadId: bound.threadId,
      endUserId: bound.endUserId,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // CONNECT v3 — channel APP bridge (marketplace / OAuth-installed apps)
  //
  // The v2 tier (above) is ONE customer-owned connection → ONE cached Chat
  // instance. The v3 APP tier is ONE platform/org-owned app OAuth-installed
  // into N external workspaces (PlatosChannelInstallation rows), each talking
  // to the app owner's agent. Its inbound URL (`/api/v1/channels/apps/:appId/
  // events`) verifies the Slack signature + parses + dedupes at the controller,
  // then hands the already-parsed envelope here.
  //
  // DELIBERATE v1 SHAPE: unlike the v2 bridge we do NOT build a Chat SDK
  // instance for the app tier. The SDK owns webhook parsing (already done at
  // the controller) and thread delivery — but the contract's "SIMPLEST CORRECT
  // v1 … keep it dependency-light" mandate lands on a direct bridge: reuse the
  // pure routing/identity/thread-pinning helpers, run the turn, and reply with
  // a bare Slack Web API `chat.postMessage` over global fetch. No adapter, no
  // Postgres adapter-state, no ESM SDK load on this path. When Phase B adds the
  // AI-Apps streaming surface, a cached Chat instance can slot in behind the
  // same getFreshBotToken/invalidateApp seam.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Conversation identity for a channel-APP thread — the app-tier twin of
   * channelConversationUserId. Deterministic per (installation, thread) so
   * every participant in a shared Slack thread resolves the SAME Platos thread
   * (single-user PlatosAgentThread ownership); the real author's verified
   * identity still flows through the author scope's claims for endUser linkage.
   */
  private appConversationUserId(
    installationId: string,
    channelThreadKey: string,
  ): string {
    return `channel-app:${installationId}:${channelThreadKey}`;
  }

  /**
   * Fire-and-forget telemetry stamp for the operator status surface — records
   * the moment a real inbound message was admitted for this install. Strictly
   * ADDITIVE: never awaited, never on a control-flow branch, and swallows every
   * error, so hosted-OAuth event routing / reply behaviour is unchanged whether
   * the write succeeds, fails, or the column is absent on an un-migrated DB.
   */
  private stampInstallationLastEvent(installationId: string): void {
    if (!installationId) return;
    try {
      this.persistence
        .stampInstallationLastEvent(installationId)
        .catch(() => undefined);
    } catch {
      // Telemetry only — a stamp failure must never disturb the turn.
    }
  }

  /**
   * Handle ONE already-verified, durably admitted Slack event for an installed
   * app. Called by the leased inbox worker after ACK, so this may run the full
   * turn inline — there is no < 3s budget and no SDK per-thread
   * lock to escape (the v2 bridge's out-of-handler dance does not apply).
   *
   * `app` + `installation` are the freshly-loaded rows the controller routed
   * to (envelope team_id/enterprise_id → active installation); `envelope` is
   * the parsed Slack `event_callback` body. Scope for the turn is the app
   * OWNER's (org/project/env) — installations are external workspaces talking
   * to the owner's agent, never their own scope.
   */
  async handleAppEvent(
    app: any,
    installation: any,
    envelope: any,
    context?: ChannelAppEventContext,
  ): Promise<void> {
    this.assertEventActive(context);
    const appId = String(app?.id ?? "");
    const installationId = String(installation?.id ?? "");
    if (!appId || !installationId) return;
    const canonicalInstallation = await this.persistence.loadInstallation(
      installationId,
      appId,
    );
    this.assertEventActive(context);
    if (!canonicalInstallation) return;
    installation = canonicalInstallation;
    app = canonicalInstallation.app;
    // v1 apps are Slack-only; ignore anything else defensively.
    if (String(app?.provider ?? "slack") !== "slack") return;
    // Revoked installs never process events (the controller already routes
    // only to active installs — this is defence-in-depth).
    if (installation?.status && installation.status !== "active") return;

    // Never react to bot-authored messages (our own replies, other bots) —
    // the hard stop against reply loops, mirroring the v2 bridge. Assistant
    // threads echo the bot's OWN posts back as message.im events; those carry
    // `bot_id` (this guard) AND a `bot_message` subtype (parseSlackAppEvent
    // drops any subtype) AND user==botUserId (the self-echo check below), so
    // the reply loop is closed by three independent guards on the message path.
    const event = envelope?.event;
    if (event?.bot_id) return;

    // ── "Agents & AI Apps" surface events (Phase B) ───────────────────────
    // The events controller admits these on the SAME per-app events URL; they
    // are NOT message events, so parseSlackAppEvent would drop them — branch
    // here first. Both are best-effort decoration; neither runs a turn.
    const eventType = typeof event?.type === "string" ? event.type : "";
    if (eventType === "assistant_thread_started") {
      await this.handleAssistantThreadStarted(app, installation, event);
      await this.markEventDelivery(context);
      return;
    }
    if (eventType === "assistant_thread_context_changed") {
      // v1 stores no per-thread context (it is informational; the thread row is
      // already pinned). Debug-log only — no persistent update.
      this.logger.debug(
        `[channel-apps] assistant_thread_context_changed app=${appId} installation=${installationId}`,
      );
      return;
    }

    const parsed = this.parseSlackAppEvent(envelope);
    if (!parsed) return;
    // Our own bot's echo (the app posting into a channel it's a member of).
    if (installation.botUserId && parsed.user === String(installation.botUserId)) {
      return;
    }

    // Resolve the reply token UP FRONT — no point running a turn we cannot
    // deliver. Fail-closed: an undecryptable token skips the event entirely.
    // getFreshBotToken also ROTATES the token when this is a rotating install
    // (Phase D) within 120s of expiry, under a fleet-wide single-refresh lock.
    let botToken: string;
    try {
      botToken = await this.getFreshBotToken(installation, app);
      this.assertEventActive(context);
    } catch (error) {
      this.logger.error(
        `[channel-apps] bot token unavailable app=${appId} installation=${installationId}`,
      );
      throw error;
    }

    // Default agent: installation override → app default. Both null ⇒ the app
    // has no agent bound yet ⇒ nothing to answer with.
    const defaultAgentId =
      (typeof installation.agentId === "string" && installation.agentId) ||
      (typeof app.defaultAgentId === "string" && app.defaultAgentId) ||
      "";
    if (!defaultAgentId) {
      this.logger.warn(
        `[channel-apps] no agent bound app=${appId} installation=${installationId}`,
      );
      return;
    }
    // Per-install routing override wins over the app-level table.
    const agentRouting = installation.agentRouting ?? app.agentRouting ?? null;

    // Additive telemetry for the operator status surface — never awaited, never
    // gates anything below (see stampInstallationLastEvent).
    this.stampInstallationLastEvent(installationId);

    this.logger.log(
      `[channel-apps] inbound app=${appId} installation=${installationId}`,
    );

    // ── Identity + scope (app OWNER's scope) ──────────────────────────────
    // Slack user ids are unique only PER WORKSPACE, so qualify with the team
    // (or enterprise) id — the same cross-workspace-merge guard as the v2
    // bridge. installationId already isolates the workspace for thread pinning;
    // the qualified handle keeps the canonical PlatosEndUser truthful.
    const team = String(installation.teamId ?? installation.enterpriseId ?? "");
    const handle = team ? `${team}:${parsed.user}` : parsed.user;
    const claims = [{ channel: "slack", handle, verified: true }];
    const authorScope: RequestScope = {
      organizationId: String(app.organizationId),
      projectId: String(app.projectId),
      environmentId: String(app.environmentId),
      userId: `slack:${handle}`,
      userIdentities: claims,
    };
    const conversationScope: RequestScope = {
      ...authorScope,
      userId: this.appConversationUserId(installationId, parsed.channelThreadKey),
    };

    // ── Connect v3 (Phase C) — account-linking commands + policy gate ─────
    // BEFORE any turn work: link/connect/unlink commands bypass the LLM, and a
    // `linking:required` app withholds the turn for an unlinked author (posting
    // the connect URL instead). Placed ahead of thread binding so a blocked /
    // command message never mints a Platos thread or resolves an end-user. A
    // `linking:none` app returns `proceed=true` immediately (zero behavior
    // change). `isAssistantThread` is computed here (the same predicate the
    // reply path uses) so a handled message can clear the assistant status.
    const isAssistantThread =
      parsed.channel.startsWith("D") && !!parsed.replyThreadTs;
    // Originating WORKSPACE team id ("T…") off the signature-verified envelope
    // (same derivation as the events controller). Needed by the SIWS callback's
    // identity match: for an Enterprise Grid ORG-LEVEL install `team` is the
    // "E…" enterprise id, but openid.connect.userInfo always returns the
    // user's workspace id — matching against `team` there can never succeed.
    const eventTeamId = String(
      envelope?.team_id ?? envelope?.authorizations?.[0]?.team_id ?? "",
    );
    const proceed = await this.applyLinkingGate(app, installation, botToken, {
      team,
      eventTeamId,
      slackUserId: parsed.user,
      slackHandle: handle,
      text: parsed.text,
      replyChannel: parsed.channel,
      replyThreadTs: parsed.replyThreadTs,
      isAssistantThread,
    }, context);
    this.assertEventActive(context);
    if (!proceed) {
      await this.markEventDelivery(context);
      return;
    }

    // ── Resolve or create the (pinned) agent + Platos thread ──────────────
    let agentId: string;
    let platosThreadId: string;
    try {
      const resolved = await this.resolveAppThreadBinding(
        installationId,
        defaultAgentId,
        agentRouting,
        authorScope,
        conversationScope,
        parsed.channelThreadKey,
        parsed.text,
      );
      this.assertEventActive(context);
      agentId = resolved.agentId;
      platosThreadId = resolved.platosThreadId;
      conversationScope.userId = resolved.endUserId;
    } catch (error) {
      this.logger.error(
        `[channel-apps] thread-binding failed app=${appId} installation=${installationId}`,
      );
      throw error;
    }

    // ── Assistant-surface "is thinking…" status (best-effort) ─────────────
    // A message.im WITHIN an assistant thread has a thread_ts (parsed into
    // replyThreadTs) and a DM channel (starts with "D"). Set the ephemeral
    // status before the turn; the reply's chat.postMessage clears it
    // automatically. A plain DM (no thread_ts) is NOT an assistant thread and
    // keeps its existing behavior (no status). Never fails the turn.
    // (`isAssistantThread` was computed above for the linking gate.)
    if (isAssistantThread) {
      try {
        await setAssistantStatus(
          botToken,
          parsed.channel,
          parsed.replyThreadTs as string,
          "is thinking…",
        );
      } catch {
        /* best-effort — never blocks the turn */
      }
    }

    // ── Turn → reply (already detached by the controller) ─────────────────
    const turnScope = {
      ...conversationScope,
      agentId,
      threadId: platosThreadId,
      sessionId: platosThreadId,
    } as RequestScope;
    try {
      // Route through the dispatch chokepoint (collected-result mode). A
      // DURABLE app-tier (Walle white-label) agent now drives a Trigger SESSION
      // (the ONE durable mechanism) and we return the reply accumulated off its
      // durable .out; a DIRECT agent runs in-process as before. Fail-open on a
      // session unavailable pre-commit → in-process (never a dropped turn). The
      // chat.postMessage post-back below is a channel-only TAIL, downstream of
      // the decision.
      const result = context?.persistedTurn
        ? {
            text: context.persistedTurn.outputText ?? "",
            threadId: context.persistedTurn.threadId,
            messageId: context.persistedTurn.id,
          }
        : await this.dispatch.collectTurn(agentId, {
            scope: turnScope,
            message: parsed.text,
            threadId: platosThreadId,
            ...(context ? { idempotencyKey: `channel-event:${appId}:${context.eventId}` } : {}),
            ...(context ? { abortSignal: context.abortSignal } : {}),
          });
      this.assertEventActive(context);
      if (context && !context.persistedTurn) {
        if (!result.messageId) throw new Error("channel event turn was not durably persisted");
        if (!(await context.onTurnCompleted(result.messageId))) {
          throw new Error("channel event lease lost");
        }
        this.assertEventActive(context);
      }
      if (result?.threadId && result.threadId !== platosThreadId) {
        this.logger.warn(
          `[channel-apps] turn thread diverged app=${appId} installation=${installationId} pinned=${platosThreadId} got=${result.threadId}`,
        );
      }
      const reply = (result?.text ?? "").trim();
      if (reply) {
        await this.postSlackMessage(
          botToken,
          parsed.channel,
          parsed.replyThreadTs,
          reply,
          context ? this.slackClientMessageId(appId, context.eventId) : undefined,
          context?.abortSignal,
        );
      } else if (isAssistantThread) {
        // Empty/tool-only turn: nothing gets posted, so the "is thinking…"
        // status would stick forever (Slack only clears it when the app posts
        // or explicitly clears it). An empty status string clears it.
        try {
          await setAssistantStatus(
            botToken,
            parsed.channel,
            parsed.replyThreadTs as string,
            "",
          );
        } catch {
          /* best-effort */
        }
      }
      await this.markEventDelivery(context);
    } catch (error) {
      this.logger.error(
        `[channel-apps] turn failed app=${appId} installation=${installationId}`,
      );
      throw error;
    }
  }

  private assertEventActive(context?: ChannelAppEventContext): void {
    if (context?.abortSignal.aborted) throw new Error("channel event lease lost");
  }

  private async markEventDelivery(context?: ChannelAppEventContext): Promise<void> {
    if (!context) return;
    this.assertEventActive(context);
    if (!(await context.onDeliveryCompleted())) throw new Error("channel event lease lost");
    this.assertEventActive(context);
  }

  private slackClientMessageId(appId: string, eventId: string): string {
    const bytes = crypto.createHash("sha256").update(`channel-event:${appId}:${eventId}`).digest();
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Handle an `assistant_thread_started` event for the "Agents & AI Apps"
   * surface. DETACHED, best-effort decoration — it runs NO turn:
   *   (a) PIN a PlatosChannelAppThread row for this (installation, thread) NOW
   *       — keyed `slack:<D-channel>:<thread_ts>`, IDENTICAL to the key the
   *       first user message.im computes — so the first message reuses the same
   *       Platos thread + agent instead of racing a fresh one.
   *   (b) setSuggestedPrompts — up to 4 prompts derived from the bound agent's
   *       description (generic defaults today; see buildAssistantPrompts) under
   *       the heading "Ask <agent name>".
   *   (c) setTitle — the agent's display name.
   * Routing note: an assistant thread is a 1:1 DM split view with no message
   * text and no channel to route on, so the pinned agent is the default
   * (install override → app default); text-prefix / channel routing rules do
   * not apply to this surface. Context (team/channel the user navigated from)
   * is informational; v1 persists none (no schema change) — see the
   * assistant_thread_context_changed debug-only branch in handleAppEvent.
   */
  private async handleAssistantThreadStarted(
    app: any,
    installation: any,
    event: any,
  ): Promise<void> {
    const appId = String(app?.id ?? "");
    const installationId = String(installation?.id ?? "");
    const parsed = this.parseAssistantThreadEvent(event);
    if (!parsed) return;
    // Defensive self-skip (the opener is a human, never our bot).
    if (installation.botUserId && parsed.user === String(installation.botUserId)) {
      return;
    }

    // Need the bot token to decorate the thread; fail-closed on decrypt.
    // getFreshBotToken rotates a Phase-D rotating token near expiry (single
    // durably claimed refresh) before we use it on the assistant surface.
    let botToken: string;
    try {
      botToken = await this.getFreshBotToken(installation, app);
    } catch (error) {
      this.logger.error(
        `[channel-apps] bot token unavailable (assistant_thread_started) app=${appId} installation=${installationId}`,
      );
      throw error;
    }

    // Default agent: install override → app default. None ⇒ nothing to bind.
    const defaultAgentId =
      (typeof installation.agentId === "string" && installation.agentId) ||
      (typeof app.defaultAgentId === "string" && app.defaultAgentId) ||
      "";
    if (!defaultAgentId) {
      this.logger.warn(
        `[channel-apps] no agent bound (assistant_thread_started) app=${appId} installation=${installationId}`,
      );
      return;
    }
    const agentRouting = installation.agentRouting ?? app.agentRouting ?? null;

    this.logger.log(
      `[channel-apps] assistant_thread_started app=${appId} installation=${installationId}`,
    );

    // ── Identity + scope (app OWNER's scope), mirroring the message path ───
    const team = String(installation.teamId ?? installation.enterpriseId ?? "");
    const handle = team ? `${team}:${parsed.user}` : parsed.user;
    const claims = [{ channel: "slack", handle, verified: true }];
    const authorScope: RequestScope = {
      organizationId: String(app.organizationId),
      projectId: String(app.projectId),
      environmentId: String(app.environmentId),
      userId: `slack:${handle}`,
      userIdentities: claims,
    };
    const conversationScope: RequestScope = {
      ...authorScope,
      userId: this.appConversationUserId(installationId, parsed.channelThreadKey),
    };

    // (a) PIN the thread row NOW (empty text ⇒ default agent) so the first user
    //     message reuses it. Best-effort — a failure just means the first
    //     message creates the row instead; still decorate with the default agent.
    let agentId = defaultAgentId;
    try {
      const resolved = await this.resolveAppThreadBinding(
        installationId,
        defaultAgentId,
        agentRouting,
        authorScope,
        conversationScope,
        parsed.channelThreadKey,
        "",
      );
      agentId = resolved.agentId;
    } catch {
      this.logger.error(
        `[channel-apps] thread pin failed (assistant_thread_started) app=${appId} installation=${installationId}`,
      );
    }

    // Load the pinned agent's display fields (name always; displayName /
    // description are read defensively — not modeled in the current schema).
    const agent = await this.loadAgentDisplay(app, agentId);
    const name = (agent?.name && agent.name.trim()) || "the assistant";
    const displayName =
      (typeof agent?.displayName === "string" && agent.displayName.trim()) || name;
    const description =
      typeof agent?.description === "string" ? agent.description : null;

    // (b) suggested prompts + (c) title — both best-effort, never throw.
    try {
      await setAssistantSuggestedPrompts(
        botToken,
        parsed.channel,
        parsed.threadTs,
        buildAssistantPrompts(description),
        `Ask ${name}`,
      );
    } catch {
      /* best-effort */
    }
    try {
      await setAssistantTitle(
        botToken,
        parsed.channel,
        parsed.threadTs,
        displayName,
      );
    } catch {
      /* best-effort */
    }
  }

  /**
   * Extract the coordinates of an assistant-thread event
   * (`assistant_thread_started` / `assistant_thread_context_changed`), or null
   * to skip. Shape:
   *   event.assistant_thread = { user_id: "U…", channel_id: "D…", thread_ts, context? }
   * `channelThreadKey` is `slack:<channel_id>:<thread_ts>` — IDENTICAL to the
   * key parseSlackAppEvent computes for the first threaded message.im, so the
   * pinned row is reused.
   */
  private parseAssistantThreadEvent(event: any): {
    channel: string;
    user: string;
    threadTs: string;
    channelThreadKey: string;
  } | null {
    const at = event?.assistant_thread;
    if (!at || typeof at !== "object") return null;
    const channel = typeof at.channel_id === "string" ? at.channel_id : "";
    const user = typeof at.user_id === "string" ? at.user_id : "";
    const threadTs = typeof at.thread_ts === "string" ? at.thread_ts : "";
    if (!channel || !user || !threadTs) return null;
    return {
      channel,
      user,
      threadTs,
      channelThreadKey: `slack:${channel}:${threadTs}`,
    };
  }

  /**
   * Load the bound agent's display fields for assistant-thread decoration.
   * Scope-pinned to the app owner. `name` is the only field guaranteed by the
   * current schema; `displayName` / `description` are read defensively (absent
   * today — Phase B is schema-free) via a no-`select` fetch so the query cannot
   * throw an "unknown field" error and the fields light up automatically if a
   * future migration adds them.
   */
  private async loadAgentDisplay(
    app: any,
    agentId: string,
  ): Promise<{
    name?: string;
    displayName?: string;
    description?: string;
  } | null> {
    if (!agentId) return null;
    try {
      const row = await this.prisma.agent.findFirst({
        where: {
          id: agentId,
          projectId: String(app.projectId),
          bindings: {
            some: {
              environmentId: String(app.environmentId),
              environment: {
                project: {
                  id: String(app.projectId),
                  organizationId: String(app.organizationId),
                },
              },
            },
          },
        },
      });
      return (row as any) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Extract the answerable slice of a Slack `event_callback`, or null to skip.
   *
   * v1 handles exactly two surfaces: `app_mention` (bot @-mentioned in a
   * channel) and `message` with `channel_type === "im"` (a DM to the bot).
   * Plain user messages carry NO `subtype` — anything with one (edits,
   * deletes, joins, `bot_message`, …) is skipped. Threading:
   *   • already-threaded (`thread_ts`)  → pin + reply on that root;
   *   • DM, un-threaded                 → one Platos thread per DM channel,
   *                                        reply at top level (linear DM UX);
   *   • channel mention, un-threaded    → start a thread rooted at this ts.
   * The `channelThreadKey` is shaped `slack:<channel>[:<root_ts>]` so the
   * shared extractPlatformChannelId helper yields the channel id for
   * "channel"-type routing rules.
   */
  private parseSlackAppEvent(envelope: any): {
    channel: string;
    user: string;
    text: string;
    channelThreadKey: string;
    replyThreadTs?: string;
  } | null {
    const event = envelope?.event;
    if (!event || typeof event !== "object") return null;
    const type = String(event.type ?? "");
    const channelType = String(event.channel_type ?? "");
    const isMention = type === "app_mention";
    const isDm = type === "message" && channelType === "im";
    if (!isMention && !isDm) return null;
    // Only plain, first-class user messages — no edits/deletes/system subtypes.
    if (event.subtype != null) return null;

    const channel = typeof event.channel === "string" ? event.channel : "";
    const user = typeof event.user === "string" ? event.user : "";
    const text = typeof event.text === "string" ? event.text : "";
    const ts = typeof event.ts === "string" ? event.ts : "";
    if (!channel || !user || !ts) return null;
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : "";

    let channelThreadKey: string;
    let replyThreadTs: string | undefined;
    if (threadTs) {
      channelThreadKey = `slack:${channel}:${threadTs}`;
      replyThreadTs = threadTs;
    } else if (isDm) {
      channelThreadKey = `slack:${channel}`;
      replyThreadTs = undefined;
    } else {
      channelThreadKey = `slack:${channel}:${ts}`;
      replyThreadTs = ts;
    }
    return { channel, user, text, channelThreadKey, replyThreadTs };
  }

  /**
   * App-tier twin of resolveThreadBinding over PlatosChannelAppThread (unique
   * on installationId + channelThreadKey). On first contact the agent is
   * resolved from the (install-override-or-app) routing table + PINNED on the
   * row; later messages reuse it. Owned by the per-thread conversation userId
   * so every participant resolves the same Platos thread; the real author's
   * scope drives endUser linkage only.
   */
  private async resolveAppThreadBinding(
    installationId: string,
    defaultAgentId: string,
    agentRouting: unknown,
    authorScope: RequestScope,
    conversationScope: RequestScope,
    channelThreadKey: string,
    text: string,
  ): Promise<{ agentId: string; platosThreadId: string; endUserId: string }> {
    // First contact — resolve the agent from the routing rules.
    const platformChannelId = extractPlatformChannelId(channelThreadKey);
    const agentId = resolveAgentForMessage(
      { agentId: defaultAgentId, agentRouting },
      { platformChannelId, text },
    );

    // IDENTITY-CORE §C (G1) — single-end-user gate. Channel-apps are Slack-only
    // (handleAppEvent short-circuits any non-slack provider), so the Slack DM
    // predicate applies directly: a DM channel id begins with "D"; group DMs
    // ("G"/mpim) and channels ("C") are multi-human ⇒ false. Passed through to
    // createThread's `singleEndUser` so a shared thread fails closed for
    // `{{endUserId}}`.
    const isDmOrAssistant = platformChannelId?.startsWith("D") === true;

    const installation = await this.persistence.loadInstallation(installationId);
    if (!installation) throw new Error("installation unavailable");
    const realm = String(installation.teamId ?? installation.enterpriseId ?? "");
    const bound = await this.persistence.resolveAppThread({
      app: installation.app,
      installation,
      realm,
      authorSubject: String(authorScope.userId).replace(/^slack:/, "").split(":").pop() ?? "",
      channelThreadKey,
      agentId,
      singleEndUser: isDmOrAssistant,
    });
    return {
      agentId: bound.agentId,
      platosThreadId: bound.threadId,
      endUserId: bound.endUserId,
    };
  }

  /**
   * Bot token for an installation, ROTATION-fresh (Phase D). THE single entry
   * point every bot-token read must go through — handleAppEvent and
   * handleAssistantThreadStarted both route here (and this method is `public`
   * so a future caller such as the account-link confirmation DM can reuse the
   * same locked-refresh seam instead of decrypting a possibly-expired token).
   *
   * NON-ROTATING installs (the default; no `tokenExpiresAt` recorded) short
   * circuit to the plain decrypted token — ZERO behavior change, zero extra I/O.
   * The runtime signal for "this install rotates" is the per-installation
   * `tokenExpiresAt` (populated by the OAuth callback only when Slack returns
   * `expires_in`), NOT the app-level `PlatosChannelApp.tokenRotation` flag:
   * `tokenExpiresAt` reflects the ACTUAL grant Slack issued, so it is the
   * strictly-more-precise place to key the runtime decision (the app flag gates
   * the manifest/OAuth side; a grant that carries an expiry must be refreshed
   * regardless of the flag, and one that carries none cannot be).
   *
   * ORG-INSTALL (Enterprise Grid) NOTE: `installation` here has already been
   * resolved by the events controller's findActiveInstallation (which applies
   * the teamId:null→enterpriseId Grid fallback), so refresh keys off the
   * resolved row's `id` for the durable compare-and-set — there is no
   * (teamId/enterpriseId) re-routing on this path to drift from the controller's
   * convention. See the ORG-INSTALL invariant block in
   * channel-app-events.controller.ts.
   *
   * Fail-closed on decrypt or rotation failure. A Slack grant returned from a
   * refresh is never usable until its Credential update and durable refresh
   * state transition commit together.
   */
  async getFreshBotToken(installation: any, app: any): Promise<string> {
    // Current decrypted token — also the ONLY path for non-rotating installs.
    // Throws (fail-closed) when the stored token is entirely unusable.
    const current = this.getAppBotToken(app, installation);

    if (installation.tokenRefreshState === "REPAIR_REQUIRED") {
      throw new Error("channel installation token repair required");
    }
    if (installation.tokenRefreshState === "REFRESHING") {
      throw new Error("channel installation token refresh incomplete");
    }

    // No expiry recorded ⇒ not a rotating install ⇒ current token is authoritative.
    const expMs = this.expiryMs(installation.tokenExpiresAt);
    if (!expMs) return current;
    // Comfortably before the refresh window ⇒ current token is still good.
    if (Date.now() < expMs - ChannelRuntimeService.TOKEN_REFRESH_SKEW_MS) {
      return current;
    }
    // Within 120s of expiry (or past) ⇒ rotate under a fleet-wide durable claim
    // (refresh tokens are SINGLE-USE; a concurrent double-refresh orphans one).
    return this.rotateBotToken(installation, app);
  }

  /**
   * Rotate under a durable compare-and-set on ChannelInstallation. Redis is
   * deliberately not authoritative: an unavailable cache must never permit
   * two consumers of Slack's single-use refresh grant.
   */
  private async rotateBotToken(
    installation: any,
    app: any,
  ): Promise<string> {
    const installationId = String(installation?.id ?? "");
    const appId = String(app?.id ?? "");
    if (!installationId || !appId) throw new Error("installation unavailable");
    const expected = this.refreshExpectation(installation);
    const claimId = crypto.randomUUID();
    const claimed = await this.persistence.beginInstallationRefresh(
      installationId,
      appId,
      claimId,
      expected,
    );
    if (!claimed) return this.awaitRotatedToken(installation, app);
    return this.performRefresh(claimed, claimed.app, claimId, expected);
  }

  /**
   * LOSER path: poll the durable refresh claim (bounded ≈3s) and adopt only a fully
   * committed replacement. An incomplete or repair-required refresh fails
   * closed so the durable event worker can retry later.
   */
  private async awaitRotatedToken(
    installation: any,
    app: any,
  ): Promise<string> {
    const installationId = String(installation?.id ?? "");
    for (let i = 0; i < 10; i++) {
      await this.sleep(300);
      const row = await this.reloadInstallation(installationId);
      if (!row) continue;
      if (row.tokenRefreshState === "REPAIR_REQUIRED") {
        throw new Error("channel installation token repair required");
      }
      if (row.tokenRefreshState === "IDLE") {
        const rowExp = this.expiryMs(row.tokenExpiresAt);
        if (
          rowExp &&
          Date.now() < rowExp - ChannelRuntimeService.TOKEN_REFRESH_SKEW_MS
        ) {
          const token = this.adoptRefreshedRow(installation, app, row);
          if (token) return token;
        }
      }
    }
    throw new Error("channel installation token refresh incomplete");
  }

  /**
   * Perform the Slack token refresh and atomically persist the rotated grant.
   * NEVER mutates or primes caches before the durable commit. If commit fails,
   * a second transaction tries to retain the returned grant while marking
   * the installation REPAIR_REQUIRED; the token is still not published.
   *
   *   POST https://slack.com/api/oauth.v2.access
   *   form: grant_type=refresh_token, refresh_token, client_id, client_secret
   *   → { ok, access_token (xoxe.…), refresh_token (xoxe-1-…), expires_in 43200 }
   */
  private async performRefresh(
    installation: any,
    app: any,
    claimId: string,
    expected: {
      tokenGeneration: number;
      credentialId: string;
      credentialRevision: string;
    },
  ): Promise<string> {
    const installationId = String(installation?.id ?? "");
    const appId = String(app?.id ?? "");
    const refreshToken = this.optionalSecretString(installation.refreshToken);
    if (!refreshToken) {
      // Rotation is on (expiry set) but no usable refresh token to rotate with.
      this.logger.warn(
        `[channel-apps] token near expiry but no refresh token installation=${installationId}`,
      );
      await this.markRefreshRepair(installationId, appId, claimId, expected, "REFRESH_TOKEN_MISSING");
      throw new Error("channel installation token repair required");
    }
    const clientId = typeof app?.clientId === "string" ? app.clientId : "";
    const clientSecret = this.optionalSecretString(app?.clientSecret);
    if (!clientId || !clientSecret) {
      this.logger.error(
        `[channel-apps] token refresh blocked — app credentials unavailable installation=${installationId}`,
      );
      await this.markRefreshRepair(installationId, appId, claimId, expected, "APP_CREDENTIALS_MISSING");
      throw new Error("channel installation token repair required");
    }

    let json: any = null;
    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
      const res = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      json = await res.json();
    } catch {
      this.logger.error(
        `[channel-apps] token refresh request failed installation=${installationId}`,
      );
      await this.markRefreshRepair(installationId, appId, claimId, expected, "SLACK_REFRESH_UNKNOWN");
      throw new Error("channel installation token repair required");
    }
    if (
      !json?.ok ||
      typeof json.access_token !== "string" ||
      !json.access_token
    ) {
      // Only the Slack error code — never a token/secret.
      this.logger.error(
        `[channel-apps] token refresh rejected installation=${installationId} error=${json?.error ?? "unknown"}`,
      );
      await this.markRefreshRepair(installationId, appId, claimId, expected, "SLACK_REFRESH_REJECTED");
      throw new Error("channel installation token repair required");
    }

    const newBotToken = json.access_token as string;
    // Slack MAY roll the refresh token too; keep the old one if it doesn't.
    const newRefreshToken =
      typeof json.refresh_token === "string" && json.refresh_token
        ? json.refresh_token
        : refreshToken;
    const newExpiresAt =
      typeof json.expires_in === "number" && json.expires_in > 0
        ? new Date(Date.now() + json.expires_in * 1000)
        : null;

    let rotated: any;
    try {
      rotated = await this.persistence.finalizeInstallationRefresh(
        installationId,
        appId,
        claimId,
        expected,
        {
          botToken: newBotToken,
          refreshToken: newRefreshToken,
          tokenExpiresAt: newExpiresAt,
        },
      );
      if (!rotated) {
        return this.awaitRotatedToken(installation, app);
      }
    } catch {
      this.logger.error(
        `[channel-apps] token refresh persist failed installation=${installationId}`,
      );
      const preserved = await this.persistence.preserveInstallationRefreshGrantForRepair(
        installationId,
        appId,
        claimId,
        expected,
        {
          botToken: newBotToken,
          refreshToken: newRefreshToken,
          tokenExpiresAt: newExpiresAt,
        },
        "REFRESH_COMMIT_FAILED",
      );
      if (!preserved) {
        await this.markRefreshRepair(
          installationId,
          appId,
          claimId,
          expected,
          "REFRESH_COMMIT_FAILED",
        );
      }
      throw new Error("channel installation token repair required");
    }

    const committedToken = this.adoptRefreshedRow(installation, app, rotated);
    if (!committedToken) throw new Error("committed channel token unavailable");

    this.logger.log(
      `[channel-apps] bot token refreshed installation=${installationId}`,
    );
    return committedToken;
  }

  private async markRefreshRepair(
    installationId: string,
    appId: string,
    claimId: string,
    expected: {
      tokenGeneration: number;
      credentialId: string;
      credentialRevision: string;
    },
    repairCode: string,
  ): Promise<void> {
    try {
      await this.persistence.markInstallationRefreshRepairRequired(
        installationId,
        appId,
        claimId,
        expected,
        repairCode,
      );
    } catch {
      // The REFRESHING row itself is already a durable fail-closed restart fence.
    }
  }

  private refreshExpectation(installation: any): {
    tokenGeneration: number;
    credentialId: string;
    credentialRevision: string;
  } {
    const tokenGeneration = Number(installation?.tokenGeneration);
    const credentialId = String(installation?.credentialId ?? "");
    const credentialRevision = String(installation?.credentialRevision ?? "");
    if (!Number.isSafeInteger(tokenGeneration) || tokenGeneration < 1 || !credentialId || !credentialRevision) {
      throw new Error("installation refresh generation unavailable");
    }
    return { tokenGeneration, credentialId, credentialRevision };
  }

  /**
   * Adopt a freshly-reloaded installation row's token onto the caller's
   * in-memory `installation` + the decrypted-token cache, returning the
   * decrypted token (or null if the row's token can't be decrypted). Used by
   * the loser's post-wait re-read so a peer's
   * rotation is picked up WITHOUT a second Slack call.
   */
  private adoptRefreshedRow(
    installation: any,
    app: any,
    row: any,
  ): string | null {
    const token = this.optionalSecretString(row?.botToken);
    if (!token) return null;
    installation.botToken = row.botToken;
    if (typeof row.refreshToken === "string") {
      installation.refreshToken = row.refreshToken;
    }
    if (row.tokenExpiresAt) installation.tokenExpiresAt = row.tokenExpiresAt;
    installation.credentialRevision = row.credentialRevision;
    this.cacheAppToken(app, installation, token);
    return token;
  }

  private async reloadInstallation(installationId: string): Promise<any | null> {
    try {
      return await this.persistence.loadInstallation(installationId);
    } catch {
      return null;
    }
  }

  /** Epoch-ms of a stored expiry (Date | string | null) or 0 when absent/invalid. */
  private expiryMs(v: unknown): number {
    if (!v) return 0;
    const t = v instanceof Date ? v.getTime() : new Date(v as any).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Canonical decrypted-token cache key for an installation:
   * `app:<appId>:<teamId|enterpriseId|id>`. The team component follows the same
   * `teamId ?? enterpriseId` handle convention used everywhere (an org-install
   * has teamId null ⇒ keyed by enterpriseId); `id` is the final defensive
   * fallback. See the ORG-INSTALL invariant in channel-app-events.controller.ts.
   */
  private appCacheKey(app: any, installation: any): string {
    const team = String(
      installation.teamId ?? installation.enterpriseId ?? installation.id ?? "",
    );
    return `app:${String(app.id)}:${team}`;
  }

  /** Prime the decrypted-token cache under the canonical key. */
  private cacheAppToken(
    app: any,
    installation: any,
    botToken: string,
  ): void {
    this.appCache.set(this.appCacheKey(app, installation), {
      credentialRevision: String(installation.credentialRevision ?? "none"),
      botToken,
      builtAt: Date.now(),
    });
  }

  /**
   * Decrypted bot token for an installation, memoized per `app:<appId>:<team>`
   * with the same 10-min TTL as the connection cache. Fail-closed: an
   * undecryptable/absent token THROWS (the caller then skips the event) rather
   * than posting with an empty Authorization header.
   *
   * This is the raw decrypt+cache PRIMITIVE — it does NOT rotate. Callers that
   * need a rotation-fresh token go through getFreshBotToken, which wraps this.
   */
  private getAppBotToken(app: any, installation: any): string {
    const key = this.appCacheKey(app, installation);
    const credentialRevision = String(
      installation.credentialRevision ?? "none",
    );
    const cached = this.appCache.get(key);
    // Reuse only when both the encrypted source AND the TTL still hold — a
    // re-install rotates the source and forces a fresh decrypt on the spot.
    if (
      cached &&
      cached.credentialRevision === credentialRevision &&
      Date.now() - cached.builtAt < this.TTL_MS
    ) {
      return cached.botToken;
    }
    const botToken = this.optionalSecretString(installation.botToken);
    if (!botToken) throw new Error("channel-app bot token unavailable");
    this.cacheAppToken(app, installation, botToken);
    return botToken;
  }

  /**
   * Post a reply through the Slack Web API. Direct fetch (NOT the Chat SDK) to
   * keep the app-events path dependency-light. 10s timeout; the bot token +
   * message text are NEVER logged — only the Slack error code on failure.
   *
   * chat.postMessage — https://api.slack.com/methods/chat.postMessage
   *   POST https://slack.com/api/chat.postMessage
   *   Authorization: Bearer <botToken>
   *   Content-Type: application/json; charset=utf-8
   *   body: { channel, text, thread_ts? }
   */
  private async postSlackMessage(
    botToken: string,
    channel: string,
    threadTs: string | undefined,
    text: string,
    clientMessageId?: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;
    if (clientMessageId) body.client_msg_id = clientMessageId;
    let res: Response;
    try {
      res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        signal: abortSignal
          ? AbortSignal.any([abortSignal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
    } catch {
      this.logger.error(
        `[channel-apps] chat.postMessage request failed channel=${channel}`,
      );
      throw new ChannelDeliveryError("SLACK_REQUEST_FAILED", true);
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON response — treat as failure below */
    }
    if (!res.ok || !json?.ok) {
      const providerCode = typeof json?.error === "string" ? json.error : `HTTP_${res.status}`;
      // Recovery after "Slack accepted, worker crashed before delivery stage"
      // intentionally reuses client_msg_id. Slack's duplicate response proves
      // the original delivery exists, so this retry may durably complete.
      if (clientMessageId && providerCode === "duplicate_message") return;
      const permanentCodes = new Set([
        "invalid_auth",
        "account_inactive",
        "token_revoked",
        "missing_scope",
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "msg_too_long",
        "no_text",
        "restricted_action",
      ]);
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        !permanentCodes.has(providerCode);
      this.logger.error(
        `[channel-apps] chat.postMessage rejected channel=${channel} error=${providerCode}`,
      );
      throw new ChannelDeliveryError(
        retryable ? "SLACK_DELIVERY_RETRYABLE" : "SLACK_DELIVERY_REJECTED",
        retryable,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // CONNECT v3 (Phase C) — hosted account linking (bridge side)
  //
  // Three modes on PlatosChannelApp.linking:
  //   none     — passthrough; not even the commands intercept (zero change).
  //   optional — link/connect/unlink commands work; a turn is NEVER withheld.
  //   required — commands work AND an unlinked author's turn is withheld until
  //              they complete Sign in with Slack (a verified email identity on
  //              the same canonical person). The hosted flow itself (nonce mint,
  //              SIWS redirect, OIDC callback, identity attach) lives in the
  //              link-controller slice; here we only START it and READ its
  //              result off PlatosEndUserIdentity.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Linking commands + policy gate, run BEFORE the turn. Returns `true` when the
   * caller should proceed to run the normal agent turn, or `false` when this
   * message was fully handled here (a link/connect/unlink command, or a withheld
   * turn under `linking:required`).
   *
   * Command matching is a case-insensitive EXACT match on the trimmed text, so
   * it fires for bare DM / assistant-thread text ("link") but NOT for a channel
   * app_mention (whose text carries the `<@BOT>` prefix) — matching the "DM +
   * assistant threads" contract without a surface special-case.
   */
  private async applyLinkingGate(
    app: any,
    installation: any,
    botToken: string,
    ctx: {
      team: string;
      /** Originating workspace team id ("T…") from the event envelope (may be ""). */
      eventTeamId?: string;
      slackUserId: string;
      /** `team:slackUserId` — the slack channel identity handle. */
      slackHandle: string;
      text: string;
      replyChannel: string;
      replyThreadTs?: string;
      isAssistantThread: boolean;
    },
    eventContext?: ChannelAppEventContext,
  ): Promise<boolean> {
    // The hosted flow itself is owned by the link-controller slice (injected
    // @Optional). If it isn't wired, the ENTIRE feature degrades to `none`
    // (zero behavior change) — including the commands, which would otherwise
    // surface a dead "not available" reply or a half-working unlink. This is
    // the mandated "absence degrades to linking:none behavior" contract.
    if (!this.channelLinkService) return true;

    const linking = typeof app?.linking === "string" ? app.linking : "none";
    // `none` (default) — zero behavior change: no command interception, no gate.
    if (linking !== "optional" && linking !== "required") return true;

    const command = ctx.text.trim().toLowerCase();

    // ── Commands (bypass the LLM entirely) — active in optional + required ──
    if (command === "link" || command === "connect") {
      const url = await this.linkStartUrl(app, installation, ctx);
      await this.postSlackMessage(
        botToken,
        ctx.replyChannel,
        ctx.replyThreadTs,
        url
          ? `🔗 Connect your account: ${url}`
          : "Account linking isn't available right now. Please try again later.",
        eventContext ? this.slackClientMessageId(String(app.id), eventContext.eventId) : undefined,
        eventContext?.abortSignal,
      );
      if (ctx.isAssistantThread) await this.clearAssistantStatus(botToken, ctx);
      return false;
    }
    if (command === "unlink") {
      const removed = await this.unlinkEmailIdentities(
        app,
        installation,
        ctx.slackHandle,
      );
      // Drop the positive memo so a `required` app re-gates on the next message.
      this.linkStatusCache.delete(this.linkCacheKey(installation, ctx.slackHandle));
      await this.postSlackMessage(
        botToken,
        ctx.replyChannel,
        ctx.replyThreadTs,
        removed > 0
          ? `✅ Unlinked — removed ${removed} linked email ${removed === 1 ? "identity" : "identities"}.`
          : "You don't have a linked account to remove.",
        eventContext ? this.slackClientMessageId(String(app.id), eventContext.eventId) : undefined,
        eventContext?.abortSignal,
      );
      if (ctx.isAssistantThread) await this.clearAssistantStatus(botToken, ctx);
      return false;
    }

    // ── Policy gate — only `required` withholds a turn ─────────────────────
    if (linking !== "required") return true; // optional never blocks

    const linked = await this.isSlackUserLinked(
      app,
      installation,
      ctx.slackHandle,
    );
    if (linked) return true;

    const url = await this.linkStartUrl(app, installation, ctx);
    await this.postSlackMessage(
      botToken,
      ctx.replyChannel,
      ctx.replyThreadTs,
      url
        ? `🔗 Connect your account to continue: ${url}`
        : "This assistant requires a linked account, but linking isn't available right now. Please try again later.",
      eventContext ? this.slackClientMessageId(String(app.id), eventContext.eventId) : undefined,
      eventContext?.abortSignal,
    );
    if (ctx.isAssistantThread) await this.clearAssistantStatus(botToken, ctx);
    return false;
  }

  /** Positive-link memo cache key. `team:slackUserId` already encodes the user. */
  private linkCacheKey(installation: any, slackHandle: string): string {
    return `${String(installation?.id ?? "")}:${slackHandle}`;
  }

  /**
   * Start the hosted link flow via the OTHER slice's ChannelLinkService and
   * return its connect URL, or null when the service is absent (feature not yet
   * wired) or the call fails. Best-effort — never throws to the caller.
   */
  private async linkStartUrl(
    app: any,
    installation: any,
    ctx: {
      team: string;
      eventTeamId?: string;
      slackUserId: string;
      replyChannel: string;
      replyThreadTs?: string;
    },
  ): Promise<string | null> {
    if (!this.channelLinkService) return null;
    try {
      // NOTE: the live ChannelLinkService.linkStart takes `{teamId, slackUserId,
      // channel, threadTs}` (it maps channel→replyChannel / threadTs→replyThreadTs
      // into its Redis nonce payload internally). The task brief named the last
      // two `replyChannel`/`replyThreadTs`, but the merged controller is the
      // ground truth and TypeScript enforces its shape — so pass channel/threadTs.
      const url = await this.channelLinkService.linkStart(app, installation, {
        teamId: ctx.team,
        slackUserId: ctx.slackUserId,
        channel: ctx.replyChannel,
        threadTs: ctx.replyThreadTs,
        // Workspace "T…" id off the event envelope — lets the SIWS callback
        // match userInfo's team_id for Enterprise Grid org-level installs
        // (where ctx.team is the "E…" enterprise id and could never match).
        eventTeamId: ctx.eventTeamId || null,
      });
      return typeof url === "string" && url ? url : null;
    } catch {
      this.logger.error(
        `[channel-apps] linkStart failed app=${String(app?.id ?? "")}`,
      );
      return null;
    }
  }

  /**
   * True when the slack person (`team:slackUserId`) resolves to a canonical
   * PlatosEndUser who ALSO carries a verified email-channel identity — i.e. they
   * completed Sign in with Slack. Two scoped queries: slack handle row →
   * platosEndUserId → any verified email row on that person. Positive results
   * are memoized 10 min per (installation, slackHandle); negatives are not.
   *
   * FAIL CLOSED: on a DB error we return false (treat as unlinked). For a
   * `required` gate the correct posture is "no positive confirmation ⇒ no turn"
   * — surfacing the connect URL on a transient blip is safer than admitting an
   * unverified user, and the turn would very likely fail on the same blip anyway.
   */
  private async isSlackUserLinked(
    app: any,
    installation: any,
    slackHandle: string,
  ): Promise<boolean> {
    const key = this.linkCacheKey(installation, slackHandle);
    const now = Date.now();
    const memo = this.linkStatusCache.get(key);
    if (memo && memo > now) return true;
    if (memo && memo <= now) this.linkStatusCache.delete(key); // prune stale

    try {
      const realm = String(
        installation.teamId ?? installation.enterpriseId ?? "",
      );
      const slackUserId = slackHandle.split(":").pop() ?? "";
      const linked = await this.persistence.isSlackUserLinked(
        app,
        realm,
        slackUserId,
      );
      if (linked) {
        this.linkStatusCache.set(key, now + this.TTL_MS);
        return true;
      }
      return false;
    } catch {
      this.logger.error("[channel-apps] link-status lookup failed");
      return false; // fail closed — see docstring
    }
  }

  /**
   * `unlink` command (safe v1): delete the email-channel identity rows attached
   * to the canonical person behind this slack handle. We deliberately do NOT
   * delete the slack identity or the person, and we do NOT distinguish
   * SIWS-created email rows from any other email identity on that person — the
   * only email identities that ever land on a channel-app person are the ones
   * this hosted flow attaches, so deleting all of them is both the simplest and
   * the correct v1 behavior. Returns the number of rows removed. Scoped to the
   * app owner; best-effort (never throws).
   */
  private async unlinkEmailIdentities(
    app: any,
    installation: any,
    slackHandle: string,
  ): Promise<number> {
    try {
      const realm = String(
        installation.teamId ?? installation.enterpriseId ?? "",
      );
      const slackUserId = slackHandle.split(":").pop() ?? "";
      const count = await this.persistence.unlinkSlackUserEmails(
        app,
        realm,
        slackUserId,
      );
      this.logger.log(
        `[channel-apps] unlink removed ${count} email identity row(s)`,
      );
      return count;
    } catch {
      this.logger.error("[channel-apps] unlink failed");
      return 0;
    }
  }

  /** Best-effort: clear a lingering assistant-thread status (empty string). */
  private async clearAssistantStatus(
    botToken: string,
    ctx: { replyChannel: string; replyThreadTs?: string },
  ): Promise<void> {
    if (!ctx.replyThreadTs) return;
    try {
      await setAssistantStatus(botToken, ctx.replyChannel, ctx.replyThreadTs, "");
    } catch {
      /* best-effort */
    }
  }

  private optionalSecretString(stored: unknown): string | null {
    return typeof stored === "string" && stored ? stored : null;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Decrypt the stored credentials envelope → plain object.
   *
   * FAIL CLOSED: when credentials ARE stored but cannot be decrypted into a
   * usable secret object, this THROWS instead of returning `{}` — building an
   * adapter with no secret material would silently disable provider signature
   * verification (auth layer 2) while inbound turns still stamp identity
   * claims `verified: true`. Note `decryptJsonField` does not throw on a key
   * mismatch — it returns its `{ __platos_enc: 1, error: … }` envelope, which
   * IS a plain object, so the marker must be detected explicitly. The throw
   * propagates out of buildBot → the inbound controller maps it to a 500
   * `channel_unavailable`.
   *
   * A connection with NO stored credentials still yields `{}` (the adapter
   * ctor is then responsible for rejecting missing secret material).
   */
  private decryptCredentials(row: any): Record<string, unknown> {
    if (!row?.credentials) return {};
    const decrypted: unknown = row.credentials;
    if (
      !this.isPlainObject(decrypted) ||
      (decrypted as Record<string, unknown>)["__platos_enc"] !== undefined ||
      Object.keys(decrypted).length === 0
    ) {
      // Encrypted-envelope error object, non-object, or empty — unusable.
      this.logger.error(
        `[channels] credential decrypt yielded no usable secrets connection=${row.id}`,
      );
      throw new Error("channel credentials unavailable");
    }
    return decrypted;
  }

  private isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }
}
