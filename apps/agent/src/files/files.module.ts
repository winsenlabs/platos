import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";
import { FileBrowserStore } from "./file-browser.store";

@Module({
  imports: [AgentRuntimeModule],
  controllers: [FilesController],
  // WIN-258 T6 — the eight attachment-browser queries, off the transport.
  providers: [FileBrowserStore],
})
export class FilesModule {}
