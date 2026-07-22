import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Logger,
  Inject,
} from "@nestjs/common";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";

/**
 * Express request augmented with the raw body Buffer. `main.ts` boots the app
 * with `rawBody: true`, so `useBodyParser` stashes the exact received bytes
 * here — the adapters HMAC these, not the JSON-parsed body.
 */
type RawBodyExpressRequest = ExpressRequest & { rawBody?: Buffer };
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { ChannelRuntimeService } from "./channel-runtime.service";

/**
 * Inbound webhook doorway for messaging channels (Slack / Telegram / WhatsApp /
 * Discord). One route, two methods:
 *
 *   POST /api/v1/channels/inbound/:connectionId/:webhookSecret
 *   GET  /api/v1/channels/inbound/:connectionId/:webhookSecret
 *     (GET is only used by WhatsApp's hub.challenge verification handshake —
 *      it carries no body and is passed straight through to the adapter.)
 *
 * TWO-FACTOR AUTH (ScopeGuard allowlists the prefix; auth happens here):
 *   Layer 1 — load the connection by id (must be enabled) + timing-safe compare
 *             the URL :webhookSecret against the stored secret. 404 on ANY
 *             mismatch (never reveal which factor failed).
 *   Layer 2 — the Chat SDK adapter verifies the provider signature (Slack HMAC
 *             / WhatsApp X-Hub-Signature-256 / Discord Ed25519 / Telegram
 *             secret_token) using the DECRYPTED connection credentials inside
 *             the cached Chat instance.
 *
 * RAW BODY: adapters HMAC the exact received bytes, so the route reads
 * `req.rawBody` (enabled app-wide by `rawBody: true` in main.ts) rather than
 * the JSON-parsed `req.body`.
 *
 * ACK FAST (< 3s): `bot.webhooks[provider]` is called with a `waitUntil` that
 * detaches the Platos turn — the webhook Response returns immediately; the turn
 * runs in the background and posts its reply through the SDK.
 *
 * Logging: connectionId + provider + event kind ONLY. Never message text,
 * handles, or credentials.
 */
@Controller()
export class ChannelsInboundController {
  private readonly logger = new Logger(ChannelsInboundController.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly runtime: ChannelRuntimeService,
  ) {}

  @Post("api/v1/channels/inbound/:connectionId/:webhookSecret")
  async inboundPost(
    @Req() req: RawBodyExpressRequest,
    @Res() res: ExpressResponse,
    @Param("connectionId") connectionId: string,
    @Param("webhookSecret") webhookSecret: string,
  ): Promise<void> {
    await this.handle(req, res, connectionId, webhookSecret);
  }

  @Get("api/v1/channels/inbound/:connectionId/:webhookSecret")
  async inboundGet(
    @Req() req: RawBodyExpressRequest,
    @Res() res: ExpressResponse,
    @Param("connectionId") connectionId: string,
    @Param("webhookSecret") webhookSecret: string,
  ): Promise<void> {
    await this.handle(req, res, connectionId, webhookSecret);
  }

  private async handle(
    req: RawBodyExpressRequest,
    res: ExpressResponse,
    connectionId: string,
    webhookSecret: string,
  ): Promise<void> {
    // ── Auth layer 1 — connection + webhookSecret (timing-safe) ───────────
    const connection = await this.loadAndAuth(connectionId, webhookSecret);
    if (!connection) {
      // Opaque 404 — never reveal whether the id, secret, or enabled flag
      // was the miss.
      res.status(404).json({ error: "not_found" });
      return;
    }

    // ── Slack URL-verification fast path ──────────────────────────────────
    // Slack's setup handshake POSTs { type: "url_verification", challenge }
    // and expects the challenge echoed within ~3s. It must NOT depend on the
    // full Chat-instance build: the adapter's initialize() calls auth.test
    // with the bot token, and during first-time setup the token often does
    // not exist yet (the manifest needs THIS URL before the app is even
    // installed — a circular dependency we must absorb). The 256-bit
    // webhookSecret in the path already authenticates the caller, so echoing
    // the challenge without a signature check is safe — verification only
    // proves URL ownership, it grants nothing.
    if (String(connection.provider) === "slack") {
      try {
        const parsed = JSON.parse((req.rawBody ?? Buffer.from("")).toString("utf8"));
        if (parsed?.type === "url_verification" && typeof parsed.challenge === "string") {
          this.logger.log(
            `[channels] slack url_verification fast-ack connection=${connectionId}`,
          );
          res.status(200).json({ challenge: parsed.challenge });
          return;
        }
      } catch {
        /* not JSON / not the handshake — fall through to the adapter */
      }
    }

    // Cached, per-connection Chat instance (auth layer 2 lives inside it).
    let bot: any;
    let provider: string;
    try {
      ({ bot, provider } = await this.runtime.getOrCreateBot(connection));
    } catch {
      this.logger.error(
        `[channels] bot build failed connection=${connectionId} provider=${connection.provider}`,
      );
      res.status(500).json({ error: "channel_unavailable" });
      return;
    }

    // ── Node req → Web Request (exact bytes) → adapter → Web Response ──────
    const webReq = this.toWebRequest(req);
    let webRes: Response;
    try {
      const handler = bot?.webhooks?.[provider];
      if (typeof handler !== "function") {
        this.logger.error(
          `[channels] no webhook handler for provider connection=${connectionId} provider=${provider}`,
        );
        res.status(500).json({ error: "channel_unavailable" });
        return;
      }
      webRes = await handler.call(bot.webhooks, webReq, {
        // Detach background work (the Platos turn) from the ACK so the webhook
        // responds in well under 3s.
        waitUntil: (p: Promise<unknown>) => {
          void Promise.resolve(p).catch(() => {
            /* swallow — never surface turn errors to the webhook response */
          });
        },
      });
    } catch {
      // Signature-verification failure or handler crash. The adapter typically
      // returns a 401 Response rather than throwing; a throw here is unexpected.
      this.logger.error(
        `[channels] webhook handler threw connection=${connectionId} provider=${provider}`,
      );
      res.status(500).json({ error: "channel_error" });
      return;
    }

    this.logger.log(
      `[channels] inbound-ack connection=${connectionId} provider=${provider} method=${req.method} status=${webRes?.status ?? 200}`,
    );
    await this.sendWebResponse(res, webRes);
  }

  /**
   * Auth layer 1: load the connection, require enabled, and timing-safe compare
   * the presented webhookSecret. Returns the row on full success, else null.
   */
  private async loadAndAuth(
    connectionId: string,
    webhookSecret: string,
  ): Promise<any | null> {
    if (!connectionId || !webhookSecret) return null;
    let row: any;
    try {
      row = await this.prisma.platosChannelConnection.findUnique({
        where: { id: connectionId },
      });
    } catch {
      return null;
    }
    if (!row || row.enabled !== true) return null;
    if (typeof row.webhookSecret !== "string" || !row.webhookSecret) return null;
    if (!this.timingSafeEqual(webhookSecret, row.webhookSecret)) return null;
    return row;
  }

  /** Constant-time string compare (guards the webhookSecret against a timing oracle). */
  private timingSafeEqual(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // Length inequality is revealed by the early return, but the secret is a
    // fixed 64-char hex string so length is not itself sensitive; content is
    // always compared in constant time.
    if (ab.length !== bb.length) return false;
    try {
      return crypto.timingSafeEqual(ab, bb);
    } catch {
      return false;
    }
  }

  /** Convert a Node/Express request into a WHATWG Request preserving raw bytes. */
  private toWebRequest(req: RawBodyExpressRequest): Request {
    const method = String(req.method || "GET").toUpperCase();

    const proto =
      this.firstHeader(req.headers["x-forwarded-proto"]) ||
      (req.protocol as string) ||
      "https";
    const host =
      this.firstHeader(req.headers["x-forwarded-host"]) ||
      (req.headers.host as string) ||
      "localhost";
    const path = req.originalUrl || req.url || "/";
    const url = `${proto}://${host}${path}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, String(v));
      } else {
        headers.set(key, String(value));
      }
    }

    const hasBody = method !== "GET" && method !== "HEAD";
    const raw = (req as any).rawBody as Buffer | undefined;
    const body =
      hasBody && raw && raw.length > 0 ? new Uint8Array(raw) : undefined;

    return new Request(url, { method, headers, body });
  }

  /** Stream a WHATWG Response back through the Express response. */
  private async sendWebResponse(
    res: ExpressResponse,
    webRes: Response | undefined,
  ): Promise<void> {
    if (!webRes) {
      res.status(200).end();
      return;
    }
    res.status(webRes.status || 200);
    webRes.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      // Let Express recompute framing headers to avoid a length/encoding
      // mismatch on the buffered body.
      if (lk === "content-length" || lk === "transfer-encoding") return;
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  }

  private firstHeader(v: string | string[] | undefined): string | undefined {
    if (v == null) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" ? s.split(",")[0].trim() : undefined;
  }
}
