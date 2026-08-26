import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { PerformanceEvidenceService } from "./performance-evidence.service";

@Controller("api/v1/agent/internal/performance-evidence")
export class PerformanceEvidenceController {
  constructor(private readonly evidence: PerformanceEvidenceService) {}

  @Get(":requestId")
  consume(@Req() request: Request, @Param("requestId") requestId: string) {
    if (!this.evidence.authorize(request.headers)) {
      throw new UnauthorizedException({ code: "PERFORMANCE_EVIDENCE_FORBIDDEN" });
    }
    const validated = this.evidence.validateRequestId(requestId);
    const result = validated ? this.evidence.consume(validated) : null;
    if (!result) {
      throw new NotFoundException({ code: "PERFORMANCE_EVIDENCE_NOT_FOUND" });
    }
    return result;
  }
}
