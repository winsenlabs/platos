import { Controller, Get } from "@nestjs/common";
import { env } from "../shared/env";

@Controller()
export class HealthController {
  @Get("api/health")
  health() {
    return {
      status: "ok",
      service: "platos-agent",
      timestamp: new Date().toISOString(),
      version: env.PLATOS_VERSION || "0.0.1",
    };
  }
}
