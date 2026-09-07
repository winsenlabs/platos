import { Controller, Get, VERSION_NEUTRAL } from "@nestjs/common";
import { env } from "../shared/env";

@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  @Get("health")
  health() {
    return {
      status: "ok",
      service: "platos-agent",
      timestamp: new Date().toISOString(),
      version: env.PLATOS_VERSION || "0.0.1",
    };
  }
}
