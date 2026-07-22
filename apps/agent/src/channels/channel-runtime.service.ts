import {
  Injectable,
  Logger,
  Inject,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { ConversationService } from "../memory/conversation.service";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import { env } from "../shared/env";
import type { RequestScope } from "../auth/scope.guard";

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
  builtAt: number;
  /** Discord-only: tear down the long-lived Gateway WebSocket on evict. */
  gatewayStop?: () => void | Promise<void>;
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
   * The ENCRYPTED botToken source string this entry was derived from. Used as
   * a self-invalidation key: when a workspace re-installs (OAuth callback
   * upserts a fresh encrypted botToken on the same installation row), the next
   * event sees a different `enc` and re-decrypts WITHOUT waiting for the TTL or
   * an explicit invalidateApp — the events runtime always passes the fresh row.
   */
  enc: string;
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
  private readonly building = new Map<string, Promise<CachedBot>>();
  /**
   * Connect v3 — `app:<appId>:<team>` → decrypted bot token. Evicted by
   * invalidateApp on app-credential edits + workspace re-install + revoke.
   */
  private readonly appCache = new Map<string, CachedAppCreds>();
  private readonly TTL_MS = 10 * 60 * 1000; // 10 min
  /** Discord keep-warm sweep cadence (see onModuleInit). */
  private readonly DISCORD_WARM_INTERVAL_MS = 60 * 1000;
  private discordWarmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly messageCrypto: MessageCryptoService,
    private readonly conversationService: ConversationService,
    private readonly agentTaskService: AgentTaskService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Lifecycle — Discord Gateway warm-up
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Discord regular (non-interaction) messages arrive ONLY over the
   * long-lived Gateway WebSocket — no webhook hit ever triggers the lazy
   * getOrCreateBot build for them. So after every boot the bots for enabled
   * discord connections must be warmed EAGERLY, and kept warm on an interval
   * (webhook-driven TTL refresh never happens for a gateway-only
   * connection). The sweep also picks up discord connections created/enabled
   * after boot and tears down gateways whose row was disabled/deleted —
   * gateway traffic bypasses the inbound controller's per-request `enabled`
   * re-check entirely. Guarded: zero discord connections starts nothing.
   */
  async onModuleInit(): Promise<void> {
    await this.warmDiscordConnections();
    this.discordWarmTimer = setInterval(() => {
      void this.warmDiscordConnections();
    }, this.DISCORD_WARM_INTERVAL_MS);
    // Never keep the process alive just for the sweep.
    (this.discordWarmTimer as any)?.unref?.();
  }

  onModuleDestroy(): void {
    if (this.discordWarmTimer) clearInterval(this.discordWarmTimer);
    this.discordWarmTimer = null;
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
    let rows: any[];
    try {
      rows = await this.prisma.platosChannelConnection.findMany({
        where: { provider: "discord", enabled: true },
      });
    } catch {
      return; // DB hiccup — the next sweep retries
    }
    const liveIds = new Set(rows.map((r: any) => String(r.id)));
    // Disabled/deleted discord connections must lose their gateway NOW —
    // no webhook path will ever re-check them.
    for (const [id, cached] of this.cache) {
      if (cached.provider === "discord" && !liveIds.has(id)) {
        this.invalidate(id);
      }
    }
    for (const row of rows) {
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
    const connectionId = String(connection.id);
    const existing = this.cache.get(connectionId);
    if (existing && Date.now() - existing.builtAt < this.TTL_MS) {
      return { bot: existing.bot, provider: existing.provider };
    }
    // buildBot is ASYNC (ESM dynamic import) — without an in-flight memo two
    // concurrent webhooks would both build, and the loser's Discord gateway
    // would leak as a live duplicate-processing socket.
    const inFlight = this.building.get(connectionId);
    if (inFlight) {
      const built = await inFlight;
      return { bot: built.bot, provider: built.provider };
    }
    if (existing) {
      // Expired — tear the old one down (esp. Discord gateway) before rebuild.
      this.cache.delete(connectionId);
      this.stopCached(existing);
    }
    const promise = this.buildBot(connection)
      .then((built) => {
        this.cache.set(connectionId, built);
        this.building.delete(connectionId);
        this.logger.log(
          `[channels] built bot connection=${connectionId} provider=${built.provider}`,
        );
        return built;
      })
      .catch((e) => {
        this.building.delete(connectionId);
        throw e;
      });
    this.building.set(connectionId, promise);
    const built = await promise;
    return { bot: built.bot, provider: built.provider };
  }

  /**
   * Evict a connection's cached Chat instance. Called on credential/secret
   * rotation or config update so the next inbound rebuilds with fresh state.
   * Also tears down the Discord gateway socket if one is running. Idempotent.
   */
  invalidate(connectionId: string): void {
    const cached = this.cache.get(connectionId);
    if (!cached) return;
    this.cache.delete(connectionId);
    this.stopCached(cached);
    this.logger.log(`[channels] invalidated bot cache connection=${connectionId}`);
    // A discord connection has no webhook traffic to lazily rebuild its
    // gateway — re-warm promptly (still enabled → fresh bot; disabled/deleted
    // → no-op). Fire-and-forget; the 60s sweep is the backstop.
    if (cached.provider === "discord" && this.discordWarmTimer) {
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

  // ───────────────────────────────────────────────────────────────────────
  // Chat SDK construction (ISOLATED — adjust here after first real build)
  // ───────────────────────────────────────────────────────────────────────

  private async buildBot(connection: any): Promise<CachedBot> {
    const sdk = await loadChatSdk();
    const provider = String(connection.provider);
    const creds = this.decryptCredentials(connection);
    const config = this.isPlainObject(connection.config) ? connection.config : {};
    const adapter = this.buildAdapter(sdk, provider, creds, config);

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
      entityPk: connection.entityPk ?? null,
      provider,
      agentId: String(connection.agentId),
      agentRouting: connection.agentRouting ?? null,
      config: this.isPlainObject(connection.config) ? connection.config : null,
    };

    this.registerHandlers(bot, connCtx);

    let gatewayStop: (() => void | Promise<void>) | undefined;
    if (provider === "discord") {
      // Regular (non-mention) Discord messages arrive over a long-lived
      // Gateway WebSocket, not the webhook. This is a persistent Nest process,
      // so start the listener. Guarded so a non-Discord connection starts
      // nothing (buildBot only reaches here for a discord provider).
      gatewayStop = this.startDiscordGateway(bot) || undefined;
    }

    return { bot, provider, builtAt: Date.now(), gatewayStop };
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
    } as RequestScope;
    const userText = typeof message?.text === "string" ? message.text : "";
    // Capture the SDK thread id NOW — the detached closure below outlives the
    // handler (and its per-thread state lock), so delivery must go through
    // the out-of-handler path `bot.thread(threadId).post(...)`, never the
    // handler-scoped `thread` object.
    const chatThreadId = threadKey;
    void (async () => {
      try {
        const result = await this.agentTaskService.executeNonStreamingTurn(
          userText,
          turnScope,
          { agentId, threadId: platosThreadId },
        );
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
  ): Promise<{ agentId: string; platosThreadId: string }> {
    const connectionId = connCtx.id;

    const existing = await this.prisma.platosChannelThread.findUnique({
      where: {
        connectionId_channelThreadKey: {
          connectionId,
          channelThreadKey: threadKey,
        },
      },
    });
    if (existing) {
      return {
        // Pinned agent (fall back to connection default for legacy null rows).
        agentId: existing.agentId ?? connCtx.agentId,
        platosThreadId: existing.platosThreadId,
      };
    }

    // First contact — resolve the agent from routing rules.
    const platformChannelId = extractPlatformChannelId(threadKey);
    const agentId = resolveAgentForMessage(
      { agentId: connCtx.agentId, agentRouting: connCtx.agentRouting },
      { platformChannelId, text },
    );

    // Create the Platos thread bound to the resolved agent. Owned by the
    // per-channel-thread conversation userId (NOT the author) so later
    // participants can resolve it through getThread's ownership filter.
    const platosThread = await this.conversationService.getOrCreateThread(
      { ...conversationScope, agentId },
      agentId,
      undefined,
    );
    const platosThreadId = platosThread.id;

    // Best-effort link to a canonical PlatosEndUser (link-not-merge) — uses
    // the REAL author scope so the person record reflects the first author.
    let platosEndUserId: string | null = null;
    try {
      platosEndUserId = await this.conversationService.resolveEndUser(
        authorScope,
        {},
      );
    } catch {
      platosEndUserId = null;
    }

    // Upsert is race-safe on the (connectionId, channelThreadKey) unique: if a
    // concurrent inbound already created the row, we read back ITS pinned agent
    // + thread and let this call's freshly-created Platos thread be orphaned
    // (rare; acceptable for v1 — the conversation never splits).
    const row = await this.prisma.platosChannelThread.upsert({
      where: {
        connectionId_channelThreadKey: {
          connectionId,
          channelThreadKey: threadKey,
        },
      },
      create: {
        connectionId,
        channelThreadKey: threadKey,
        platosThreadId,
        platosEndUserId,
        agentId,
      },
      update: {},
    });

    return {
      agentId: row.agentId ?? agentId,
      platosThreadId: row.platosThreadId,
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
  // same getAppBotToken/invalidateApp seam.
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
   * Handle ONE already-verified Slack event for an installed app. Called
   * DETACHED by the events controller (after its fast 200 ACK), so this may
   * run the full turn inline — there is no < 3s budget and no SDK per-thread
   * lock to escape (the v2 bridge's out-of-handler dance does not apply).
   *
   * `app` + `installation` are the freshly-loaded rows the controller routed
   * to (envelope team_id/enterprise_id → active installation); `envelope` is
   * the parsed Slack `event_callback` body. Scope for the turn is the app
   * OWNER's (org/project/env) — installations are external workspaces talking
   * to the owner's agent, never their own scope.
   */
  async handleAppEvent(app: any, installation: any, envelope: any): Promise<void> {
    const appId = String(app?.id ?? "");
    const installationId = String(installation?.id ?? "");
    if (!appId || !installationId) return;
    // v1 apps are Slack-only; ignore anything else defensively.
    if (String(app?.provider ?? "slack") !== "slack") return;
    // Revoked installs never process events (the controller already routes
    // only to active installs — this is defence-in-depth).
    if (installation?.status && installation.status !== "active") return;

    // Never react to bot-authored messages (our own replies, other bots) —
    // the hard stop against reply loops, mirroring the v2 bridge.
    const event = envelope?.event;
    if (event?.bot_id) return;

    const parsed = this.parseSlackAppEvent(envelope);
    if (!parsed) return;
    // Our own bot's echo (the app posting into a channel it's a member of).
    if (installation.botUserId && parsed.user === String(installation.botUserId)) {
      return;
    }

    // Resolve the reply token UP FRONT — no point running a turn we cannot
    // deliver. Fail-closed: an undecryptable token skips the event entirely.
    let botToken: string;
    try {
      botToken = this.getAppBotToken(app, installation);
    } catch {
      this.logger.error(
        `[channel-apps] bot token unavailable app=${appId} installation=${installationId}`,
      );
      return;
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
      agentId = resolved.agentId;
      platosThreadId = resolved.platosThreadId;
    } catch {
      this.logger.error(
        `[channel-apps] thread-binding failed app=${appId} installation=${installationId}`,
      );
      return;
    }

    // ── Turn → reply (already detached by the controller) ─────────────────
    const turnScope = {
      ...conversationScope,
      agentId,
      threadId: platosThreadId,
    } as RequestScope;
    try {
      const result = await this.agentTaskService.executeNonStreamingTurn(
        parsed.text,
        turnScope,
        { agentId, threadId: platosThreadId },
      );
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
        );
      }
    } catch {
      this.logger.error(
        `[channel-apps] turn failed app=${appId} installation=${installationId}`,
      );
      try {
        await this.postSlackMessage(
          botToken,
          parsed.channel,
          parsed.replyThreadTs,
          "Sorry — something went wrong on my end. Please try again in a moment.",
        );
      } catch {
        /* best-effort */
      }
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
  ): Promise<{ agentId: string; platosThreadId: string }> {
    const existing = await this.prisma.platosChannelAppThread.findUnique({
      where: {
        installationId_channelThreadKey: { installationId, channelThreadKey },
      },
    });
    if (existing) {
      return {
        agentId: existing.agentId ?? defaultAgentId,
        platosThreadId: existing.platosThreadId,
      };
    }

    // First contact — resolve the agent from the routing rules.
    const platformChannelId = extractPlatformChannelId(channelThreadKey);
    const agentId = resolveAgentForMessage(
      { agentId: defaultAgentId, agentRouting },
      { platformChannelId, text },
    );

    const platosThread = await this.conversationService.getOrCreateThread(
      { ...conversationScope, agentId },
      agentId,
      undefined,
    );
    const platosThreadId = platosThread.id;

    // Best-effort canonical PlatosEndUser link (link-not-merge) off the REAL
    // author scope so the person record reflects the first author.
    let platosEndUserId: string | null = null;
    try {
      platosEndUserId = await this.conversationService.resolveEndUser(
        authorScope,
        {},
      );
    } catch {
      platosEndUserId = null;
    }

    // Race-safe on the (installationId, channelThreadKey) unique — a concurrent
    // inbound that already created the row wins; this call's fresh Platos thread
    // is orphaned (rare; acceptable for v1 — the conversation never splits).
    const row = await this.prisma.platosChannelAppThread.upsert({
      where: {
        installationId_channelThreadKey: { installationId, channelThreadKey },
      },
      create: {
        installationId,
        channelThreadKey,
        platosThreadId,
        platosEndUserId,
        agentId,
      },
      update: {},
    });

    return {
      agentId: row.agentId ?? agentId,
      platosThreadId: row.platosThreadId,
    };
  }

  /**
   * Decrypted bot token for an installation, memoized per `app:<appId>:<team>`
   * with the same 10-min TTL as the connection cache. Fail-closed: an
   * undecryptable/absent token THROWS (the caller then skips the event) rather
   * than posting with an empty Authorization header.
   */
  private getAppBotToken(app: any, installation: any): string {
    const team = String(
      installation.teamId ?? installation.enterpriseId ?? installation.id ?? "",
    );
    const key = `app:${String(app.id)}:${team}`;
    const encSource = typeof installation.botToken === "string" ? installation.botToken : "";
    const cached = this.appCache.get(key);
    // Reuse only when both the encrypted source AND the TTL still hold — a
    // re-install rotates the source and forces a fresh decrypt on the spot.
    if (cached && cached.enc === encSource && Date.now() - cached.builtAt < this.TTL_MS) {
      return cached.botToken;
    }
    const botToken = this.decryptSecretField(installation.botToken);
    if (!botToken) throw new Error("channel-app bot token unavailable");
    this.appCache.set(key, { enc: encSource, botToken, builtAt: Date.now() });
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
  ): Promise<void> {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;
    let res: Response;
    try {
      res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.logger.error(
        `[channel-apps] chat.postMessage request failed channel=${channel}`,
      );
      return;
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON response — treat as failure below */
    }
    if (!json?.ok) {
      this.logger.error(
        `[channel-apps] chat.postMessage rejected channel=${channel} error=${json?.error ?? res.status}`,
      );
    }
  }

  /**
   * Decrypt a single ENCRYPTED-envelope string column (the app tier stores each
   * secret — botToken / signingSecret / clientSecret — as its own
   * `JSON.stringify(encryptJsonField(plain))`, unlike the v2 connection which
   * wraps ALL creds in one object). Returns the plaintext or null when the
   * value is absent, unparseable, or the decrypt key is missing (the crypto
   * service returns its `{ __platos_enc, error }` marker → not a string → null).
   */
  private decryptSecretField(stored: unknown): string | null {
    if (typeof stored !== "string" || !stored) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return null;
    }
    const dec = this.messageCrypto.decryptJsonField(parsed);
    return typeof dec === "string" && dec ? dec : null;
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
    let decrypted: unknown;
    try {
      const parsed = JSON.parse(String(row.credentials));
      decrypted = this.messageCrypto.decryptJsonField(parsed);
    } catch {
      this.logger.error(
        `[channels] credential decrypt failed connection=${row.id}`,
      );
      throw new Error("channel credentials unavailable");
    }
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
