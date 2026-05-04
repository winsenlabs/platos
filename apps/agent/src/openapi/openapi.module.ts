import { Module } from "@nestjs/common";
import { OpenApiController } from "./openapi.controller";

@Module({
  controllers: [OpenApiController],
})
export class OpenApiModule {}
