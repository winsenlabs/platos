/**
 * Phase 3 — Docs MCP module.
 *
 * Standalone module: just the service (which holds the doc index + the
 * Redis-backed rate-limit) and the controller. Doesn't import any of the
 * scope-bound modules — this surface is intentionally public.
 */

import { Module } from "@nestjs/common";
import { DocsMcpService } from "./docs-mcp.service";
import { DocsMcpController } from "./docs-mcp.controller";

@Module({
  controllers: [DocsMcpController],
  providers: [DocsMcpService],
  exports: [DocsMcpService],
})
export class DocsMcpModule {}
