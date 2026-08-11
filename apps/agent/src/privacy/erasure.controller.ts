import { Controller, Post, Get, Param, Body, Req, Res, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { ErasureService, ERASURE_POLICY_VERSION } from "./erasure.service";

/**
 * Hard-erasure API.
 *
 * Authenticated by `X-Platos-Admin-Token` ONLY. Deliberately not reachable with
 * an ordinary Platos session token: this endpoint destroys data irreversibly
 * across four stores, and a session token is exactly the credential most likely
 * to be sitting in a browser somewhere.
 *
 * The routes live under /api/v1/agent/admin/privacy/* so ScopeGuard's admin
 * allow-list can gate them the same way the cost-catalog ingest is gated —
 * cross-scope by design, because a subject spans scopes and the caller has no
 * single scope context to present.
 */
@Controller("api/v1/agent/admin/privacy")
export class ErasureController {
  private readonly logger = new Logger(ErasureController.name);

  constructor(private readonly erasure: ErasureService) {}

  /**
   * Timing-safe admin check. Compared on raw bytes with a length guard, because
   * a plain `===` on a secret leaks its length and prefix to a patient caller.
   */
  private authorized(req: Request): boolean {
    const expected = process.env.PLATOS_ADMIN_TOKEN;
    const provided = req.headers["x-platos-admin-token"];
    if (!expected || typeof provided !== "string") return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try { return timingSafeEqual(a, b); } catch { return false; }
  }

  private deny(res: Response) {
    // No detail: distinguishing "wrong token" from "no token" helps an attacker
    // and helps nobody else.
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  /** Content-free discovery. Counts and scope ids only, never content. */
  @Get("subjects/:externalUserId/inventory")
  async inventory(
    @Req() req: Request, @Res() res: Response,
    @Param("externalUserId") externalUserId: string,
  ) {
    if (!this.authorized(req)) return this.deny(res);
    const organizationId = String(req.query.organizationId ?? "");
    if (!organizationId) {
      return res.status(400).json({ error: "organizationId query param is required" });
    }
    const subject = await this.erasure.discoverSubject(externalUserId, organizationId);
    const inventory = await this.erasure.inventory(subject);
    return res.json({
      resolvedEndUsers: subject.platosEndUserIds.length,
      resolvedLegacyIds: subject.legacyUserIds.length,
      scopes: subject.scopes,
      inventory,
      policyVersion: ERASURE_POLICY_VERSION,
    });
  }

  /**
   * Request an erasure. Idempotent on `idempotencyKey` — a repeat returns the
   * existing operation rather than starting a competing purge.
   */
  @Post("erasures")
  async create(
    @Req() req: Request, @Res() res: Response,
    @Body() body: {
      externalUserId?: string;
      organizationId?: string;
      idempotencyKey?: string;
      legalHoldPolicyId?: string | null;
    },
  ) {
    if (!this.authorized(req)) return this.deny(res);
    const { externalUserId, organizationId, idempotencyKey } = body ?? {};
    if (!externalUserId || !organizationId || !idempotencyKey) {
      return res.status(400).json({
        error: "externalUserId, organizationId and idempotencyKey are required",
      });
    }
    const receipt = await this.erasure.requestErasure({
      externalUserId, organizationId, idempotencyKey,
      legalHoldPolicyId: body.legalHoldPolicyId ?? null,
    });
    // 200 rather than 201 on a repeat: the caller did not create anything.
    return res.status(receipt.attempts > 1 ? 200 : 201).json(receipt);
  }

  @Get("erasures/:operationId")
  async get(
    @Req() req: Request, @Res() res: Response,
    @Param("operationId") operationId: string,
  ) {
    if (!this.authorized(req)) return this.deny(res);
    const receipt = await this.erasure.getErasure(operationId);
    if (!receipt) return res.status(404).json({ error: "NOT_FOUND" });
    return res.json(receipt);
  }

  /** Retry re-runs only the stores that did not settle. */
  @Post("erasures/:operationId/retry")
  async retry(
    @Req() req: Request, @Res() res: Response,
    @Param("operationId") operationId: string,
    @Body() body: { externalUserId?: string },
  ) {
    if (!this.authorized(req)) return this.deny(res);
    if (!body?.externalUserId) {
      // Re-discovery needs the subject id: by the time Postgres has run, the
      // canonical row is gone and the operation cannot find the person again
      // from its own record.
      return res.status(400).json({ error: "externalUserId is required to re-resolve the subject" });
    }
    const receipt = await this.erasure.retryErasureById(operationId, body.externalUserId);
    if (!receipt) return res.status(404).json({ error: "NOT_FOUND" });
    if (receipt.status === "blocked_legal_hold") {
      return res.status(409).json(receipt);
    }
    return res.json(receipt);
  }
}
