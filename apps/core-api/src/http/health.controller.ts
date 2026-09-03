// The process-edge health surface.
//
// NOT A BUSINESS TRANSPORT. `/livez` and `/readyz` describe the process, not the
// domain: they take no tenant, resolve no scope and call no use case. The six
// business transports under `src/transports/` are M4's, and nothing here
// pre-empts them — including the URL prefix and the `@Version` migration ADR M0.4
// §2 pins to M4, which is why these paths sit at the root and are not versioned.
// A liveness probe that moved when the API's major moved would be a liveness
// probe that fails a fleet on a routine release.

import { Controller, Get, HttpException, HttpStatus, Inject, Req } from "@nestjs/common";

import type { AppModule } from "../app.module.js";
import {
  detailedReadinessBody,
  evaluateReadiness,
  publicReadinessBody,
  type LifecycleState,
} from "../health/readiness.js";
import { constantTimeEquals } from "./token.js";

export const HEALTH_DEPENDENCIES = Symbol("platos.core-api.health-dependencies");

export interface HealthDependencies {
  readonly app: AppModule;
  readonly state: LifecycleState;
}

/** Only the shape this controller reads. Typed structurally to keep the process edge free of a framework-specific request type. */
interface InboundRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

function bearerToken(request: InboundRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/u.exec(header);
  return match?.[1] ?? null;
}

@Controller()
export class HealthController {
  constructor(@Inject(HEALTH_DEPENDENCIES) private readonly dependencies: HealthDependencies) {}

  /**
   * Liveness. Deliberately unconditional.
   *
   * If this handler runs at all, the event loop is turning and the process is
   * not wedged, which is the entire question. Making it depend on a downstream
   * store is how a database blip becomes a fleet-wide restart storm.
   */
  @Get("livez")
  liveness(): Record<string, unknown> {
    return { status: "alive", phase: this.dependencies.state.phase };
  }

  /** Alias for the conventional name; the same unconditional answer. */
  @Get("healthz")
  health(): Record<string, unknown> {
    return this.liveness();
  }

  @Get("readyz")
  readiness(@Req() request: InboundRequest): Record<string, unknown> {
    const verdict = evaluateReadiness(this.dependencies.app, this.dependencies.state);
    const configured = this.dependencies.app.configuration.adminHealthToken;
    const presented = bearerToken(request);
    const detailed =
      configured !== null && presented !== null && constantTimeEquals(configured, presented);
    const body = detailed ? detailedReadinessBody(verdict) : publicReadinessBody(verdict);
    if (verdict.ready) return body;
    // 503 rather than 200-with-a-flag: a load balancer reads the status line, and
    // a readiness endpoint that always returns 200 is a readiness endpoint that
    // has never removed a bad instance from rotation.
    throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
