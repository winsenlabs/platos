/**
 * Theme I.10 — serves the OpenAPI spec + an in-browser Swagger UI page.
 *
 *   GET /api/v1/agent/openapi.json   → static OpenAPI 3.1 JSON
 *   GET /openapi                     → Swagger UI HTML (CDN-loaded)
 *
 * The spec lives in `openapi.spec.ts`. Swagger UI is pulled from the
 * official unpkg CDN so we don't have to bundle assets in the agent
 * image. Both routes are whitelisted in `scope.guard.ts` so they work
 * without auth — the spec is static, no scope-dependent data.
 */

import { Controller, Get, Header } from "@nestjs/common";
import { platosAgentOpenApiSpec } from "./openapi.spec";

@Controller()
export class OpenApiController {
  @Get("api/v1/agent/openapi.json")
  @Header("Content-Type", "application/json")
  @Header("Access-Control-Allow-Origin", "*")
  getSpec() {
    return platosAgentOpenApiSpec;
  }

  @Get("openapi")
  @Header("Content-Type", "text/html; charset=utf-8")
  getSwaggerUi(): string {
    // Swagger UI is intentionally served over the CDN so the agent
    // image stays lean. The `url` points at the JSON endpoint above;
    // relative URL keeps it compatible with reverse proxies that
    // rewrite paths.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Platos Agent — OpenAPI Explorer</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
<style>body{margin:0}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.addEventListener("load", function () {
    window.ui = SwaggerUIBundle({
      url: "/api/v1/agent/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis],
      layout: "BaseLayout",
      persistAuthorization: true,
    });
  });
</script>
</body>
</html>`;
  }
}
