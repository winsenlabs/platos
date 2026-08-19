import { buildPlatformToolHandlers } from "../src/mcp-platform/tools";
import { McpRouter } from "../src/mcp-platform/mcp-router";
import { MacroRecordingState } from "../src/mcp-platform/tools/macros";

function inertDependency(): any {
  const callable = () => undefined;
  return new Proxy(callable, {
    get: () => inertDependency(),
    apply: () => undefined,
  });
}

let router: McpRouter | null = null;
const fixed = {
  macroState: new MacroRecordingState(),
  getRouter: () => router as McpRouter,
};
const deps = new Proxy(fixed as Record<string, unknown>, {
  get(target, property) {
    if (property in target) return target[property as string];
    return inertDependency();
  },
});

const handlers = buildPlatformToolHandlers(deps as never);
router = new McpRouter(
  { buildScope: (token) => ({ ...token.scope, userId: token.mintedByUserId }) },
  inertDependency(),
);
router.registerAll(handlers);

process.stdout.write(
  JSON.stringify(
    handlers.map((handler) => ({
      name: handler.name,
      description: handler.description,
      inputSchema: handler.inputSchema,
      requiresAdminTier: handler.requiresAdminTier === true,
      category: handler.category ?? "uncategorized",
    })),
  ),
);
