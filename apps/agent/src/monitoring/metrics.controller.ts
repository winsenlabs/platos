import { Controller, Get, Header, Res } from "@nestjs/common";
import type { Response } from "express";
import { MetricsService } from "./metrics.service";

/**
 * EOBD.41 — Prometheus scrape endpoint. Plain text format.
 *
 * Exposed at `/metrics`. Intentionally unauthenticated — the default
 * deployment binds the agent only on an internal network, and the
 * operator controls who can scrape. For internet-facing deployments,
 * put /metrics behind a reverse-proxy ACL.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  async scrape(@Res() res: Response): Promise<void> {
    const body = await this.metrics.snapshot();
    res.send(body);
  }
}
