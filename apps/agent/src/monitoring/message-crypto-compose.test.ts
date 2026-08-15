import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("message encryption Compose configuration", () => {
  it("passes bounded historical read keys to both worker and agent", () => {
    const compose = readFileSync(
      resolve(__dirname, "../../../../docker-compose.platos.yml"),
      "utf8"
    );

    const worker = compose.slice(compose.indexOf("  worker:"), compose.indexOf("  agent:"));
    const agent = compose.slice(compose.indexOf("  agent:"));

    for (const service of [worker, agent]) {
      expect(service).toContain('PLATOS_MESSAGE_ENCRYPTION_KEY: "${PLATOS_MESSAGE_ENCRYPTION_KEY:');
      expect(service).toContain(
        'PLATOS_MESSAGE_ENCRYPTION_KEY_V: "${PLATOS_MESSAGE_ENCRYPTION_KEY_V:-1}"'
      );
      for (let version = 1; version <= 5; version += 1) {
        expect(service).toContain(
          `PLATOS_MESSAGE_ENCRYPTION_KEY_V${version}: "\${PLATOS_MESSAGE_ENCRYPTION_KEY_V${version}:-}"`
        );
      }
    }
  });
});
