import { Module } from "@nestjs/common";
import { DatabaseModule } from "../shared/database.provider";
import { RedisModule } from "../shared/redis.provider";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";
import { McpPlatformModule } from "./mcp-platform.module";

/** Minimal Nest context for Platform MCP stdio; no HTTP server or cron root. */
@Module({
  // Load AgentRuntimeModule before McpPlatformModule just like AppModule.
  // This preserves the runtime's circular-module initialization order without
  // importing ScheduleModule.forRoot() or starting the HTTP application.
  imports: [DatabaseModule, RedisModule, AgentRuntimeModule, McpPlatformModule],
})
export class McpStdioAppModule {}
