import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("message encryption Compose configuration", () => {
  it("passes the primary and bounded historical read keys to the active agent service", () => {
    const compose = readFileSync(
      resolve(__dirname, "../../../../docker-compose.platos.yml"),
      "utf8"
    );

    const services = compose.slice(compose.indexOf("services:"), compose.indexOf("volumes:"));
    const agent = compose.match(/^  agent:\n[\s\S]*?(?=^  [a-zA-Z0-9_-]+:\n)/m)?.[0];

    expect(agent).toBeDefined();
    expect(agent).toContain('PLATOS_MESSAGE_ENCRYPTION_KEY: "${PLATOS_MESSAGE_ENCRYPTION_KEY:?required — 64 hex chars from openssl rand -hex 32}"');
    expect(agent).toContain(
      'PLATOS_MESSAGE_ENCRYPTION_KEY_V: "${PLATOS_MESSAGE_ENCRYPTION_KEY_V:-1}"'
    );
    for (let version = 1; version <= 5; version += 1) {
      expect(agent).toContain(
        `PLATOS_MESSAGE_ENCRYPTION_KEY_V${version}: "\${PLATOS_MESSAGE_ENCRYPTION_KEY_V${version}:-}"`
      );
    }
    expect(services).not.toMatch(/^  worker:/m);
  });
});
