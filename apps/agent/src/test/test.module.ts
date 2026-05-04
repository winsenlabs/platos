import { Module } from "@nestjs/common";
import { TestController } from "./test.controller";
import { ToolGatewayModule } from "../tool-gateway/tool-gateway.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [ToolGatewayModule, AuthModule],
  controllers: [TestController],
})
export class TestModule {}
