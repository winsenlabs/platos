/**
 * Serves the generated WIN-129 operation inventory + Swagger UI.
 *
 *   GET /api/v1/agent/openapi.json   → generated OpenAPI 3.1 JSON
 *   GET /openapi                     → Swagger UI HTML (CDN-loaded)
 *
 * `openapi.generated.json` derives from the canonical control-plane
 * operation manifest. It inventories every Nest route, and since WIN-267 W2 the
 * V1 core-api operations additionally carry request and response schemas READ
 * OFF THE TYPESCRIPT TYPES of their handlers, with the ADR M0.4 section 2
 * failure envelope on every one of them. Operations that declare no wire DTO
 * carry `x-platos-schema-source: undeclared` and a reason rather than an
 * invented schema, so the document never claims a shape the controllers do not
 * declare. Swagger UI is pulled from the official unpkg CDN so the agent image
 * stays lean.
 */

import { Controller, Get, Header, Version, VERSION_NEUTRAL } from "@nestjs/common";
import { API_VERSION } from "../http/api-surface";
import platosAgentOpenApiSpec from "./openapi.generated.json";

@Controller({ version: API_VERSION })
export class OpenApiController {
  @Get("agent/openapi.json")
  @Header("Content-Type", "application/json")
  @Header("Access-Control-Allow-Origin", "*")
  getSpec() {
    return platosAgentOpenApiSpec;
  }

  @Get("openapi")
  @Version(VERSION_NEUTRAL)
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
