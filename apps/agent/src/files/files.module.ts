import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";

@Module({
  imports: [AgentRuntimeModule],
  controllers: [FilesController],
})
export class FilesModule {}
