import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

export async function startBrowserHttpsProxy(): Promise<(() => Promise<void>) | undefined> {
  const upstreamValue = process.env.WIN235_BROWSER_UPSTREAM_URL;
  const browserValue = process.env.WIN235_WEBAPP_URL;
  if (!upstreamValue) return undefined;
  if (!browserValue) throw new Error("WIN235_WEBAPP_URL is required for the browser HTTPS proxy");

  const upstream = new URL(upstreamValue);
  const browser = new URL(browserValue);
  if (upstream.protocol !== "http:" || browser.protocol !== "https:") {
    throw new Error("Browser HTTPS proxy requires an HTTP upstream and HTTPS browser URL");
  }

  const scratch = await mkdtemp(
    path.join(process.env.RUNNER_TEMP ?? "/var/tmp", "win235-browser-tls-")
  );
  const keyPath = path.join(scratch, "key.pem");
  const certificatePath = path.join(scratch, "certificate.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", keyPath,
    "-out", certificatePath,
  ], { stdio: "ignore" });

  const server: Server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certificatePath) },
    (incoming, outgoing) => {
      const headers = { ...incoming.headers };
      headers.host = browser.host;
      headers["x-forwarded-host"] = browser.host;
      headers["x-forwarded-proto"] = "https";
      const proxied = httpRequest({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers,
      }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      proxied.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("Browser evidence proxy failed");
      });
      incoming.pipe(proxied);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(browser.port || 443), browser.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await rm(scratch, { recursive: true, force: true });
  };
}
