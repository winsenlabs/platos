import { Body, Controller, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "../auth/auth.service";
import { requireOperator, type RequestScope } from "../auth/scope.guard";
import { MemoryFeedbackBackfillService } from "./memory-feedback-backfill.service";

/** Environment-admin entrypoint for the explicit legacy feedback transition. */
@Controller("api/v1/agent/admin/memory-feedback")
export class MemoryFeedbackAdminController {
  constructor(
    private readonly backfill: MemoryFeedbackBackfillService,
    private readonly auth: AuthService
  ) {}

  @Post("backfill")
  async runBackfill(@Req() req: Request, @Body() body: { limit?: number } = {}) {
    const scope = (req as Request & { scope?: RequestScope }).scope;
    requireOperator(scope as RequestScope);
    const authorized = await this.auth.authorizeEnvironmentOperatorScope(
      scope as RequestScope,
      "secret:mutate"
    );
    return this.backfill.runBatch(
      {
        organizationId: authorized.organizationId,
        projectId: authorized.projectId,
        environmentId: authorized.environmentId,
      },
      { limit: body?.limit }
    );
  }
}
