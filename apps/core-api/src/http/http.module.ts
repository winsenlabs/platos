// The Nest module — the ONLY framework-shaped file besides `main.ts`.
//
// ADR M0.3 §4 names Nest as the composition-root framework, and this is where
// it stops. `app.module.ts` composes without it, every context is banned from
// importing it by rule (a), and `composition-root.mjs` proves the ban still
// bites now that the framework is genuinely present in the workspace rather
// than hypothetical.
//
// The module wires by VALUE, not by discovery. There is no `@Injectable()`
// scanning, no auto-wiring and no metadata-driven resolution: the composed
// `AppModule` is handed in and provided as-is. A container that assembles the
// system by reflection would move the composition decision out of the
// composition root and into whatever files happen to carry a decorator.

import "reflect-metadata";

import {
  Inject,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";

import type { AppModule } from "../app.module.js";
import type { LifecycleState } from "../health/readiness.js";
import { HEALTH_DEPENDENCIES, HealthController, type HealthDependencies } from "./health.controller.js";
import { createIdempotencyGate } from "./idempotency-middleware.js";

@Module({})
export class CoreApiHttpModule implements NestModule {
  /**
   * The module class takes the SAME value the health controller takes.
   *
   * Injected rather than read from a module-level variable: `configure()` is
   * called once per application instance, and `lifecycle.test.ts` starts and
   * stops several applications inside one test runner. A file-scoped `let`
   * holding "the app" would be shared by all of them, so the second application
   * to start would hand the first one's store to its own middleware — the exact
   * cross-wiring the composition root exists to make impossible.
   */
  constructor(@Inject(HEALTH_DEPENDENCIES) private readonly dependencies: HealthDependencies) {}

  static forApplication(app: AppModule, state: LifecycleState): DynamicModule {
    const dependencies: HealthDependencies = { app, state };
    return {
      module: CoreApiHttpModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_DEPENDENCIES, useValue: dependencies }],
    };
  }

  /**
   * M0.4 §2's `Idempotency-Key` gate, over every path.
   *
   * MODULE MIDDLEWARE AND NOT `nest.use`, for one reason: Nest registers this
   * AFTER `registerParserMiddleware`, so `request.rawBody` exists and the
   * fingerprint can cover what the caller actually sent. The correlation
   * middleware in `runtime/lifecycle.ts` is registered the other way round on
   * purpose — it must run before everything, and it needs no body.
   *
   * `*` INCLUDES PATHS WITH NO HANDLER. WIN-267 owns the routes; the envelope is
   * not the routes, and the eight one-time-secret mints this contract binds are
   * refused for a missing key today whether or not the handler behind them
   * exists yet.
   */
  configure(consumer: MiddlewareConsumer): void {
    const app = this.dependencies.app;
    consumer
      .apply(createIdempotencyGate({ store: app.requestIdempotency, logger: app.logger }))
      .forRoutes("*");
  }
}
