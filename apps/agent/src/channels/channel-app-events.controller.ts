import {
  Controller,
  Post,
  Param,
  Req,
  Res,
  Logger,
  Inject,
} from "@nestjs/common";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { ChannelRuntimeService } from "./channel-runtime.service";

/**
 * Express request augmented with the raw body Buffer. `main.ts` boots the app
 * with `rawBody: true`, so `useBodyParser` stashes the exact received bytes
 * here — we HMAC these for the Slack signature, not the JSON-parsed body.
 */
type RawBodyExpressRequest = ExpressRequest & { rawBody?: Buffer };

/**
 * Connect v3 — the ONE Slack Events API request URL per marketplace app.
 *
 *   POST /api/v1/channels/apps/:appId/events
 *
 * PUBLIC surface (ScopeGuard allowlists the `/api/v1/channels/apps/` prefix —
 * see scope.guard.ts). The caller is Slack, not a Platos user, so there is no
 * per-scope session. Auth is IN this controller, over the RAW body:
 *
 *   Slack signature v2 — `x-slack-signature` must equal
 *     'v0=' + HMAC-SHA256(signingSecret, 'v0:' + <x-slack-request-timestamp>
 *     + ':' + rawBody), compared timing-safely, with a stale-timestamp reject
 *     (> 300s). The signing secret is the app's DECRYPTED `signingSecret`.
 *
 * ORDER (Slack's < 3s ack budget):
 *   load app → verify signature → url_verification fast-ack → event_id dedupe
 *   → (lifecycle inline) → ACK 200 → DETACHED route to installation + runtime.
 *
 * DEDUPE: `SET chanapp:evt:<event_id> NX EX 900`. Slack retries 3× (immediate
 * / +1m / +5m); a slow-but-successful handler gets retried, so a duplicate
 * event_id returns 200 immediately — plus `x-slack-no-retry: 1` when the hit
 * carries `x-slack-retry-num` (suppress further retries of an event we own).
 *
 * UNINSTALL hygiene: `app_uninstalled` + `tokens_revoked` are handled INLINE
 * (before the detach) — mark the installation revoked (SOFT; never hard-delete).
 * Their order is NOT guaranteed (known Slack quirk) so the handler is idempotent
 * (status=active → revoked once; a second event updates nothing).
 *
 * Logging: appId + event kind ONLY. Never message text, tokens, or secrets.
 */
@Controller()
export class ChannelAppEventsController {
  private readonly logger = new Logger(ChannelAppEventsController.name);

  private static readonly MAX_SKEW_SECONDS = 300;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly messageCrypto: MessageCryptoService,
    private readonly runtime: ChannelRuntimeService,
  ) {}

  @Post("api/v1/channels/apps/:appId/events")
  async events(
    @Req() req: RawBodyExpressRequest,
    @Res() res: ExpressResponse,
    @Param("appId") appId: string,
  ): Promise<void> {
    // ── Load app ──────────────────────────────────────────────────────────
    const app = await this.loadApp(appId);
    if (!app) {
      // Opaque 404 — do not reveal whether the app id exists.
      res.status(404).json({ error: "not_found" });
      return;
    }

    // ── Verify the Slack v0 signature over the RAW body ───────────────────
    let signingSecret: string;
    try {
      signingSecret = this.decryptSecretString(app.signingSecret);
    } catch {
      this.logger.error(`[chanapp] signing_secret decrypt failed app=${appId}`);
      res.status(500).json({ error: "app_unavailable" });
      return;
    }

    const rawBody = req.rawBody ?? Buffer.from("");
    const timestamp = this.firstHeader(req.headers["x-slack-request-timestamp"]);
    const signature = this.firstHeader(req.headers["x-slack-signature"]);
    if (!this.verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
      this.logger.warn(`[chanapp] slack signature rejected app=${appId}`);
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    // Body is now provider-verified — parse the exact bytes we HMAC'd.
    let envelope: any;
    try {
      envelope = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    // ── url_verification fast-ack ─────────────────────────────────────────
    if (
      envelope?.type === "url_verification" &&
      typeof envelope.challenge === "string"
    ) {
      this.logger.log(`[chanapp] slack url_verification fast-ack app=${appId}`);
      res.status(200).json({ challenge: envelope.challenge });
      return;
    }

    // ── event_id dedupe (Slack retries a slow-but-successful handler) ─────
    const eventId =
      typeof envelope?.event_id === "string" ? envelope.event_id : null;
    const isRetry = this.firstHeader(req.headers["x-slack-retry-num"]) != null;
    if (eventId) {
      let acquired: string | null = null;
      try {
        acquired = await this.redis.set(
          `chanapp:evt:${eventId}`,
          "1",
          "EX",
          900,
          "NX",
        );
      } catch {
        // Redis blip — fall through and process rather than drop the event.
        acquired = "OK";
      }
      if (!acquired) {
        // Already handled (or in-flight) — ack and, on a retry, tell Slack to
        // stop retrying an event we own.
        if (isRetry) res.setHeader("x-slack-no-retry", "1");
        res.status(200).json({ ok: true });
        return;
      }
    }

    // ── Routing coordinates from the envelope ─────────────────────────────
    const teamId =
      envelope?.team_id ??
      envelope?.team?.id ??
      envelope?.authorizations?.[0]?.team_id ??
      null;
    const enterpriseId =
      envelope?.enterprise_id ??
      envelope?.enterprise?.id ??
      envelope?.authorizations?.[0]?.enterprise_id ??
      null;

    // ── Lifecycle (uninstall/revoke) handled INLINE, before the detach ────
    const innerType =
      envelope?.type === "event_callback" ? envelope?.event?.type : null;
    if (innerType === "app_uninstalled" || innerType === "tokens_revoked") {
      try {
        await this.revokeInstallations(String(app.id), teamId, enterpriseId);
        this.logger.log(
          `[chanapp] lifecycle ${innerType} app=${appId} — installation revoked`,
        );
      } catch {
        this.logger.error(
          `[chanapp] lifecycle ${innerType} revoke failed app=${appId}`,
        );
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ── ACK fast, then route + run the turn DETACHED ──────────────────────
    res.status(200).json({ ok: true });
    void (async () => {
      try {
        const installation = await this.findActiveInstallation(
          String(app.id),
          teamId,
          enterpriseId,
        );
        if (!installation) {
          this.logger.warn(
            `[chanapp] no active installation for event app=${appId}`,
          );
          return;
        }
        await this.runtime.handleAppEvent(app, installation, envelope);
      } catch {
        this.logger.error(`[chanapp] app event handling failed app=${appId}`);
      }
    })();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Installation lookup / lifecycle
  // ───────────────────────────────────────────────────────────────────────

  private async findActiveInstallation(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null,
  ): Promise<any | null> {
    // Nullable discriminators compile to `IS NULL`; scope by status so a
    // revoked workspace can't resurrect a turn.
    const exact = await this.prisma.platosChannelInstallation.findFirst({
      where: { appId, teamId, enterpriseId, status: "active" },
    });
    if (exact) return exact;
    // Enterprise Grid org-install fallback: an org-install grant comes back
    // from oauth.v2.access with team:null, so its row has teamId=NULL — but
    // event envelopes always carry the ORIGINATING workspace's team_id, so
    // the exact tuple above can never hit the org row. When the exact lookup
    // misses inside a Grid (enterpriseId present, workspace-level teamId
    // present), fall back to the org-install row.
    if (enterpriseId != null && teamId != null) {
      return this.prisma.platosChannelInstallation.findFirst({
        where: {
          appId,
          teamId: null,
          enterpriseId,
          isEnterpriseInstall: true,
          status: "active",
        },
      });
    }
    return null;
  }

  /**
   * SOFT-revoke every active installation for this (app, team, enterprise).
   * Idempotent: filtering on `status: "active"` means the second of the two
   * (unordered) lifecycle events updates zero rows, so `revokedAt` is stamped
   * once by whichever event arrives first. Never hard-deletes.
   */
  private async revokeInstallations(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null,
  ): Promise<void> {
    const revokedAt = new Date();
    const { count } = await this.prisma.platosChannelInstallation.updateMany({
      where: { appId, teamId, enterpriseId, status: "active" },
      data: { status: "revoked", revokedAt },
    });
    // Grid org-install fallback — same tuple mismatch as
    // findActiveInstallation: the org-install row has teamId=NULL but the
    // lifecycle envelope carries the originating workspace's team_id, so the
    // exact update above touches zero rows and the encrypted bot token would
    // stay "active" forever. Only when the exact tuple revoked nothing do we
    // revoke the org row. (Phase A has no per-workspace grid rows, so a
    // workspace-level removal inside a still-org-installed grid revokes the
    // org install — fail toward revoking a live token rather than leaking one.)
    if (count === 0 && enterpriseId != null && teamId != null) {
      await this.prisma.platosChannelInstallation.updateMany({
        where: {
          appId,
          teamId: null,
          enterpriseId,
          isEnterpriseInstall: true,
          status: "active",
        },
        data: { status: "revoked", revokedAt },
      });
    }
  }

  private async loadApp(appId: string): Promise<any | null> {
    if (!appId) return null;
    try {
      return await this.prisma.platosChannelApp.findUnique({
        where: { id: appId },
      });
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Slack signature verification
  // ───────────────────────────────────────────────────────────────────────

  /**
   * `x-slack-signature` = 'v0=' + HMAC-SHA256(signingSecret,
   * 'v0:' + <x-slack-request-timestamp> + ':' + rawBody). HMAC over the exact
   * bytes (not a re-encoded string), timing-safe compare, stale-timestamp
   * reject (> 300s) to blunt replay.
   */
  private verifySlackSignature(
    signingSecret: string,
    rawBody: Buffer,
    timestamp: string | undefined,
    signature: string | undefined,
  ): boolean {
    if (!signingSecret || !timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Date.now() / 1000;
    if (Math.abs(nowSec - ts) > ChannelAppEventsController.MAX_SKEW_SECONDS) {
      return false;
    }
    let expected: string;
    try {
      const hmac = crypto.createHmac("sha256", signingSecret);
      hmac.update(`v0:${timestamp}:`, "utf8");
      hmac.update(rawBody); // exact received bytes
      expected = `v0=${hmac.digest("hex")}`;
    } catch {
      return false;
    }
    return this.timingSafeEqual(expected, signature);
  }

  /** Constant-time string compare (guards the signature against a timing oracle). */
  private timingSafeEqual(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    try {
      return crypto.timingSafeEqual(ab, bb);
    } catch {
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Decrypt the stored secret envelope → plain string. Mirrors
   * channel-runtime.service.ts decryptCredentials but for a scalar string
   * field. FAIL CLOSED: on a key mismatch decryptJsonField returns its
   * {__platos_enc,error} envelope (an object), so anything non-string throws
   * rather than verifying against a broken secret. Duplicated (not shared)
   * to keep this slice from touching a file outside its scope.
   */
  private decryptSecretString(stored: unknown): string {
    const parsed = JSON.parse(String(stored));
    const decrypted = this.messageCrypto.decryptJsonField(parsed);
    if (typeof decrypted !== "string" || !decrypted) {
      throw new Error("secret unavailable");
    }
    return decrypted;
  }

  private firstHeader(v: string | string[] | undefined): string | undefined {
    if (v == null) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" ? s : undefined;
  }
}
