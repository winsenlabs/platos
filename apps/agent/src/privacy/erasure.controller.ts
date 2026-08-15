import { Controller, Post, Get, Param, Body, Req, Res, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ErasureIdempotencyConflictError,
  ErasureService,
  ERASURE_POLICY_VERSION,
} from "./erasure.service";
import { PlatosMCPTokenService, type VerifiedToken } from "../mcp-platform/token.service";

/**
 * Hard-erasure API.
 *
 * Authenticated only by an admin-tier `plt_mcp_` control-plane credential.
 * Static deployment secrets are deliberately not accepted for irreversible
 * data destruction.
 *
 * The routes live under /api/v1/agent/admin/privacy/* so ScopeGuard's admin
 * allow-list can let the self-authenticating controller receive them. The
 * verified credential is organization-bound; subject discovery may span every
 * project/environment inside that organization.
 */
@Controller("api/v1/agent/admin/privacy")
export class ErasureController {
  private readonly logger = new Logger(ErasureController.name);

  constructor(
    private readonly erasure: ErasureService,
    private readonly credentials: PlatosMCPTokenService
  ) {}

  /** Verify the request's organization-bound admin control-plane credential. */
  private async authorized(req: Request): Promise<VerifiedToken | null> {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
    const verified = await this.credentials.verify(authorization.slice("Bearer ".length).trim());
    return verified?.tier === "admin" ? verified : null;
  }

  private deny(res: Response) {
    // No detail: distinguishing "wrong token" from "no token" helps an attacker
    // and helps nobody else.
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  /** Content-free discovery. Counts and scope ids only, never content. */
  @Get("subjects/:externalUserId/inventory")
  async inventory(
    @Req() req: Request,
    @Res() res: Response,
    @Param("externalUserId") externalUserId: string
  ) {
    const organizationId = String(req.query.organizationId ?? "");
    if (!organizationId) {
      return res.status(400).json({ error: "organizationId query param is required" });
    }
    const credential = await this.authorized(req);
    if (!credential || credential.scope.organizationId !== organizationId) return this.deny(res);
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
   * Request an erasure. Idempotent on organization + `idempotencyKey`; reuse
   * for another subject is rejected rather than returning an existing receipt.
   */
  @Post("erasures")
  async create(
    @Req() req: Request,
    @Res() res: Response,
    @Body()
    body: {
      externalUserId?: string;
      organizationId?: string;
      idempotencyKey?: string;
      legalHoldPolicyId?: string | null;
    }
  ) {
    const { externalUserId, organizationId, idempotencyKey } = body ?? {};
    if (!externalUserId || !organizationId || !idempotencyKey) {
      return res.status(400).json({
        error: "externalUserId, organizationId and idempotencyKey are required",
      });
    }
    const credential = await this.authorized(req);
    if (!credential || credential.scope.organizationId !== organizationId) return this.deny(res);
    let receipt;
    try {
      receipt = await this.erasure.requestErasure({
        externalUserId,
        organizationId,
        idempotencyKey,
        legalHoldPolicyId: body.legalHoldPolicyId ?? null,
      });
    } catch (error) {
      if (error instanceof ErasureIdempotencyConflictError) {
        return res.status(409).json({ error: "IDEMPOTENCY_KEY_CONFLICT" });
      }
      throw error;
    }
    // 200 rather than 201 on a repeat: the caller did not create anything.
    return res.status(receipt.attempts > 1 ? 200 : 201).json(receipt);
  }

  @Get("erasures/:operationId")
  async get(@Req() req: Request, @Res() res: Response, @Param("operationId") operationId: string) {
    const credential = await this.authorized(req);
    if (!credential) return this.deny(res);
    if (
      !(await this.erasure.operationBelongsToOrganization(
        operationId,
        credential.scope.organizationId
      ))
    ) {
      return this.deny(res);
    }
    const receipt = await this.erasure.getErasure(operationId);
    if (!receipt) return res.status(404).json({ error: "NOT_FOUND" });
    return res.json(receipt);
  }

  /** Retry re-runs only the stores that did not settle. */
  @Post("erasures/:operationId/retry")
  async retry(
    @Req() req: Request,
    @Res() res: Response,
    @Param("operationId") operationId: string,
    @Body() body: { externalUserId?: string }
  ) {
    const credential = await this.authorized(req);
    if (!credential) return this.deny(res);
    if (
      !(await this.erasure.operationBelongsToOrganization(
        operationId,
        credential.scope.organizationId
      ))
    ) {
      return this.deny(res);
    }
    if (!body?.externalUserId) {
      // Re-discovery needs the subject id: by the time Postgres has run, the
      // canonical row is gone and the operation cannot find the person again
      // from its own record.
      return res
        .status(400)
        .json({ error: "externalUserId is required to re-resolve the subject" });
    }
    const receipt = await this.erasure.retryErasureById(operationId, body.externalUserId);
    if (!receipt) return res.status(404).json({ error: "NOT_FOUND" });
    if (receipt.status === "blocked_legal_hold") {
      return res.status(409).json(receipt);
    }
    return res.json(receipt);
  }
}
