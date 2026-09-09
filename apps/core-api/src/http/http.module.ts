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
import { APP_FILTER } from "@nestjs/core";

import type { AppModule } from "../app.module.js";
import type { LifecycleState } from "../health/readiness.js";
import { BffSessionController } from "../transports/bff/session.controller.js";
import { McpEntityTokensController } from "../transports/mcp/entity-tokens.controller.js";
import { McpPlatformTokensController } from "../transports/mcp/platform-tokens.controller.js";
import { REST_APPLICATION, type RestApplication } from "../transports/rest/dependencies.js";
import { EnvironmentEndUsersController } from "../transports/rest/environment-end-users.controller.js";
import { IdentitySessionController } from "../transports/rest/identity-session.controller.js";
import { OrganizationsController } from "../transports/rest/organizations.controller.js";
import { ProjectsController } from "../transports/rest/projects.controller.js";
import { DomainExceptionFilter } from "./domain-exception.filter.js";
import { HEALTH_DEPENDENCIES, HealthController, type HealthDependencies } from "./health.controller.js";
import { createIdempotencyGate } from "./idempotency-middleware.js";
import { NotFoundController } from "./not-found.controller.js";

/**
 * THE V1 BUSINESS SURFACE, DECLARED STATICALLY — AND THE ORDER IS THE REASON.
 *
 * These five controllers are in the DECORATOR's `controllers` array while the two
 * process-edge ones stay in `forApplication`'s, and that is not a stylistic split.
 * Nest's `DependenciesScanner.reflectControllers` reads
 * `[...reflectMetadata(class), ...dynamicMetadataByToken(...)]` — static first,
 * dynamic second — and Express matches in registration order. So a business route
 * declared here is registered AHEAD of `NotFoundController`'s `@All("{*path}")`,
 * which is the only arrangement in which it can ever be reached. Move one of these
 * into the dynamic array and every route in it answers 404 while every test that
 * mounts a controller directly keeps passing.
 *
 * IT IS ALSO WHAT THE MANIFEST GENERATOR READS. `assertMountedControllerPolicy` in
 * `apps/agent/scripts/generate-control-plane.mjs` resolves each core-api controller
 * to the module file whose `@Module({ controllers: [...] })` INLINE ARRAY lists it,
 * and refuses generation for a class it cannot find there. A controller added to
 * `apps/core-api/src/transports` and not to this array fails the generator by name
 * rather than silently leaving the census — the "strict root" the second scan root
 * was added to create.
 */
@Module({
  controllers: [
    IdentitySessionController,
    OrganizationsController,
    ProjectsController,
    EnvironmentEndUsersController,
    BffSessionController,
    // WIN-268 (M4.2) P1 — the two MCP token mints. They sit in this SAME array
    // and not in `forApplication`'s for the reason the banner above gives: only
    // a statically declared controller is registered ahead of
    // `NotFoundController`'s `@All("{*path}")`, and a mint that lost that race
    // would 404 while every unit test that constructs it kept passing. That is
    // precisely the state these two operations were in before this tranche.
    //
    // THEY ARE VERSION-NEUTRAL AND EVERY OTHER ENTRY IS NOT. ADR M0.4 §2 keeps
    // MCP paths out of the URL-major scheme, so `transports/mcp/mcp-surface.ts`
    // pins `VERSION_NEUTRAL` once and `route-manifest.test.ts` partitions this
    // array by surface — every REST controller under `/api/v1`, every MCP
    // controller under `/mcp` — and joins BOTH halves to the manifest.
    McpPlatformTokensController,
    McpEntityTokensController,
  ],
})
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

  /**
   * ORDER IN `controllers` IS PART OF THE CONTRACT, NOT A LIST.
   *
   * `NotFoundController` answers `{*path}` for every method, and Express matches
   * in registration order, so it is last and must stay last: promoted above
   * `HealthController` it would swallow `/livez` and take a fleet down. That is
   * exactly why it is a route rather than a guess inside the exception filter —
   * "nothing else matched" is expressed in the mechanism that decides matching —
   * and why `rest-chassis.test.ts` pins a real route still winning against it.
   */
  static forApplication(app: AppModule, state: LifecycleState): DynamicModule {
    const dependencies: HealthDependencies = { app, state };
    const restApplication: RestApplication = { app };
    return {
      module: CoreApiHttpModule,
      controllers: [HealthController, NotFoundController],
      providers: [
        { provide: HEALTH_DEPENDENCIES, useValue: dependencies },
        /**
         * What every V1 controller is handed. `useValue` for the reason the filter
         * below is: the value is THIS application, and a class the container
         * instantiated would have to be told which one by reflection — the wiring
         * this module refuses.
         */
        { provide: REST_APPLICATION, useValue: restApplication },
        {
          /**
           * WIN-267 (M4.1) / WIN-260 (c). The global exception filter.
           *
           * `APP_FILTER` AND NOT `app.useGlobalFilters(...)`, for the reason the
           * constructor above gives: `useGlobalFilters` installs onto the
           * application instance from outside, so the composition root would
           * have to remember to call it for every application it starts —
           * including the ones a test file starts — and a transport whose error
           * contract depends on a caller remembering is a transport with no
           * error contract. Declared here, it arrives with the module, so ANY
           * application built from `forApplication` has it.
           *
           * `useValue` and not `useClass`: the filter takes this application's
           * logger and this application's configured request-id header, and a
           * class the container instantiates would need both discovered by
           * reflection — the wiring this module refuses.
           */
          provide: APP_FILTER,
          useValue: new DomainExceptionFilter({
            logger: app.logger,
            requestIdHeader: app.configuration.requestIdHeader,
          }),
        },
      ],
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
