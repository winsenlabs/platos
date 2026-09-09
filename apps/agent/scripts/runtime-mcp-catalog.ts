import { buildPlatformToolHandlers } from "../src/mcp-platform/tools";
import { McpRouter } from "../src/mcp-platform/mcp-router";
import { MacroRecordingState } from "../src/mcp-platform/tools/macros";
// WIN-268 P1 — the contract block is READ OFF THE SAME MODULE THE SERVERS READ,
// and the digests are computed by the SAME functions the handshake calls. A
// second implementation of the hash in `generate-control-plane.mjs` would be a
// second spelling of the algorithm, and the manifest would then agree with a
// copy of the rule rather than with the rule.
import {
  ENTITY_MCP_SCOPES,
  MCP_PROTOCOL_VERSION,
  PLATFORM_MCP_SCOPES,
  PLATOS_MCP_CONTRACT_MAJOR,
  PLATOS_MCP_CONTRACT_VERSION,
  mcpCatalogDigest,
  mcpScopeSetDigest,
  toolSchemaHash,
} from "../src/http/mcp-surface";

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
  JSON.stringify({
    /**
     * The Platos MCP contract, as the running servers report it.
     *
     * It is emitted from the runtime rather than parsed out of the source so the
     * manifest records what a client would actually be told. `--check` byte-
     * compares the committed manifest against a fresh run, so editing the const
     * without regenerating fails, and editing the manifest without moving the
     * const fails the same way.
     */
    contract: {
      version: PLATOS_MCP_CONTRACT_VERSION,
      major: PLATOS_MCP_CONTRACT_MAJOR,
      protocolVersion: MCP_PROTOCOL_VERSION,
      // The digest of the PLATFORM catalog. `router.catalogDigest()` is the very
      // method `initialize` calls, so the manifest and the handshake cannot
      // disagree about what this server offers.
      catalogDigest: router.catalogDigest(),
      platformScopeSetDigest: mcpScopeSetDigest([PLATFORM_MCP_SCOPES]),
      entityScopeSetDigest: mcpScopeSetDigest([ENTITY_MCP_SCOPES]),
      platformScopes: [...PLATFORM_MCP_SCOPES],
      entityScopes: [...ENTITY_MCP_SCOPES],
      // ADR M0.4 §2 names a rate-table version. There is no MCP rate table in
      // this tree to derive one from; see `mcp-surface.ts`'s `rateTableVersion`
      // note. Recorded as null so the manifest states the absence rather than
      // omitting the field and leaving a reader to guess.
      rateTableVersion: null,
    },
    // A double-check on the catalog digest that a reader can reproduce by hand:
    // the digest above is over the whole sorted catalog, and this is the same
    // computation performed on the handler list this script assembled. If the
    // router ever registered a tool the builder did not return, the two differ.
    handlerCatalogDigest: mcpCatalogDigest(handlers),
    tools: handlers.map((handler) => ({
      name: handler.name,
      description: handler.description,
      inputSchema: handler.inputSchema,
      requiresAdminTier: handler.requiresAdminTier === true,
      category: handler.category ?? "uncategorized",
      // ADR M0.4 §5: `schemaHash = sha256(canonical(inputSchema))`, per tool.
      // This is what turns "a new required input is a breaking change" from a
      // sentence in an ADR into a value a diff can be taken over.
      schemaHash: toolSchemaHash(handler.inputSchema),
    })),
  }),
);
