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

import { Module, type DynamicModule } from "@nestjs/common";

import type { AppModule } from "../app.module.js";
import type { LifecycleState } from "../health/readiness.js";
import { HEALTH_DEPENDENCIES, HealthController, type HealthDependencies } from "./health.controller.js";

@Module({})
export class CoreApiHttpModule {
  static forApplication(app: AppModule, state: LifecycleState): DynamicModule {
    const dependencies: HealthDependencies = { app, state };
    return {
      module: CoreApiHttpModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_DEPENDENCIES, useValue: dependencies }],
    };
  }
}
