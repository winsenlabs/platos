import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  PERFORMANCE_EVIDENCE_ID_HEADER,
  PerformanceEvidenceService,
} from "./performance-evidence.service";

@Injectable()
export class PerformanceEvidenceMiddleware implements NestMiddleware {
  constructor(private readonly evidence: PerformanceEvidenceService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const rawRequestId = request.headers[PERFORMANCE_EVIDENCE_ID_HEADER];
    if (rawRequestId === undefined) {
      next();
      return;
    }
    const requestId = this.evidence.validateRequestId(rawRequestId);
    if (!requestId || !this.evidence.authorize(request.headers)) {
      response.status(403).json({ code: "PERFORMANCE_EVIDENCE_FORBIDDEN" });
      return;
    }
    try {
      this.evidence.runRequest(
        { requestId, method: request.method, path: request.originalUrl },
        () => {
          response.once("finish", () => this.evidence.complete(requestId, response.statusCode));
          next();
        }
      );
    } catch {
      response.status(400).json({ code: "PERFORMANCE_EVIDENCE_REQUEST_REJECTED" });
    }
  }
}
