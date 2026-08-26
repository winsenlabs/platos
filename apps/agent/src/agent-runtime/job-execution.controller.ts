import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../shared/env";
import {
  parseJobExecutionRequest,
  JobExecutionService,
  type JobExecutionBody,
  type JobExecutionHttpResult,
} from "./job-execution.service";

type AuthErrorCode =
  | "INTERNAL_AUTH_NOT_CONFIGURED"
  | "INTERNAL_AUTH_REQUIRED"
  | "INTERNAL_AUTH_INVALID";

@Controller("api/v1/agent/internal/jobs")
export class JobExecutionController {
  constructor(private readonly executionService: JobExecutionService) {}

  @Post("execute")
  async execute(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<JobExecutionBody | { status: "failed"; error: { code: AuthErrorCode } }> {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      res.status(503);
      return { status: "failed", error: { code: "INTERNAL_AUTH_NOT_CONFIGURED" } };
    }

    const provided = req.headers["x-platos-internal-auth"];
    if (typeof provided !== "string" || provided.length === 0) {
      res.status(401);
      return { status: "failed", error: { code: "INTERNAL_AUTH_REQUIRED" } };
    }
    const providedBytes = Buffer.from(provided);
    const expectedBytes = Buffer.from(expected);
    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      res.status(401);
      return { status: "failed", error: { code: "INTERNAL_AUTH_INVALID" } };
    }

    const request = parseJobExecutionRequest(body);
    if (!request) {
      res.status(400);
      return { status: "failed", error: { code: "INVALID_REQUEST" } };
    }

    let result: JobExecutionHttpResult;
    try {
      result = await this.executionService.execute(request);
    } catch {
      res.status(503);
      return { status: "failed", error: { code: "JOB_SERVICE_UNAVAILABLE" } };
    }
    res.status(result.httpStatus);
    return result.body;
  }
}
