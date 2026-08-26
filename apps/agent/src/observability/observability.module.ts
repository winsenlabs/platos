import { Module } from "@nestjs/common";
import { ClickhouseObservabilitySink } from "./clickhouse-observability-sink";
import { ObservabilityService, OBSERVABILITY_SINK_TOKEN } from "./observability.service";
import type { ObservabilitySink } from "./observability-sink";

/**
 * The observability projection module.
 *
 * The sink is provided under a token rather than constructed inside the service
 * so an installation — or a test — can substitute one without the service knowing
 * which analytical store it is talking to. The ClickHouse implementation is the
 * only one today; it resolves its endpoint per call, so this factory runs once
 * and configuration is still live.
 */
@Module({
  providers: [
    {
      provide: OBSERVABILITY_SINK_TOKEN,
      useFactory: (): ObservabilitySink => new ClickhouseObservabilitySink(),
    },
    ObservabilityService,
  ],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
