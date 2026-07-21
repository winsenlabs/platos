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
