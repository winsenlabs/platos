import "./sentry.server";

import { createRequestHandler } from "@remix-run/express";
import { broadcastDevReady, logDevReady } from "@remix-run/server-runtime";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import { nanoid } from "nanoid";
import path from "path";
import type { RateLimitMiddleware } from "~/services/apiRateLimit.server";
import type { RunWithHttpContextFunction } from "~/services/httpAsyncStorage.server";
import cluster from "node:cluster";
import os from "node:os";

const ENABLE_CLUSTER = process.env.ENABLE_CLUSTER === "1";
const cpuCount = os.availableParallelism();
const WORKERS =
  Number.parseInt(process.env.WEB_CONCURRENCY || process.env.CLUSTER_WORKERS || "", 10) || cpuCount;

function forkWorkers() {
  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }
}

function installPrimarySignalHandlers() {
  let didHandleSigterm = false;
  let didHandleSigint = false;
  let didGracefulExit = false;

  const forward = (signal: NodeJS.Signals) => {
    for (const id in cluster.workers) {
      const w = cluster.workers[id];
      if (w?.process?.pid) {
        try {
          process.kill(w.process.pid, signal);
        } catch {}
      }
    }
  };

  const gracefulExit = () => {
    if (didGracefulExit) return;
    didGracefulExit = true;

    const timeoutMs = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT || 30_000);
    // wait for workers to exit, then exit the primary too
    const maybeExit = () => {
      const alive = Object.values(cluster.workers || {}).some((w) => w && !w.isDead());
      if (!alive) process.exit(0);
    };
    setInterval(maybeExit, 1000);
    setTimeout(() => process.exit(0), timeoutMs);
  };

  process.on("SIGTERM", () => {
    if (didHandleSigterm) return;
    didHandleSigterm = true;
    forward("SIGTERM");
    gracefulExit();
  });
  process.on("SIGINT", () => {
    if (didHandleSigint) return;
    didHandleSigint = true;
    forward("SIGINT");
    gracefulExit();
  });
}

if (ENABLE_CLUSTER && cluster.isPrimary) {
  process.title = `node webapp-server primary`;
  console.log(`[cluster] Primary ${process.pid} is starting with ${WORKERS} workers`);
  forkWorkers();

  cluster.on("exit", (worker, code, signal) => {
    const intentional =
      // If we sent "shutdown", the worker will exit with code 0 after closing.
      code === 0 || worker.exitedAfterDisconnect;
    console.log(
      `[cluster] worker ${worker.process.pid} exited (code=${code}, signal=${signal}, intentional=${intentional})`
    );
    // If it wasn't during a shutdown, replace the worker.
    if (!intentional) cluster.fork();
  });

  installPrimarySignalHandlers();
} else {
  const app = express();

  if (process.env.DISABLE_COMPRESSION !== "1") {
    app.use(compression());
  }

  // http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
  app.disable("x-powered-by");

  // Remix fingerprints its assets so we can cache forever.
  app.use("/build", express.static("public/build", { immutable: true, maxAge: "1y" }));

  // Everything else (like favicon.ico) is cached for an hour. You may want to be
  // more aggressive with this caching.
  app.use(express.static("public", { maxAge: "1h" }));

  app.use(morgan("tiny"));

  process.title = ENABLE_CLUSTER
    ? `node webapp-worker-${cluster.isWorker ? cluster.worker?.id : "solo"}`
    : "node webapp-server";

  const MODE = process.env.NODE_ENV;
  const BUILD_DIR = path.join(process.cwd(), "build");
  const build = require(BUILD_DIR);

  const port = process.env.REMIX_APP_PORT || process.env.PORT || 3000;

  if (process.env.HTTP_SERVER_DISABLED !== "true") {
    const apiRateLimiter: RateLimitMiddleware = build.entry.module.apiRateLimiter;
    const runWithHttpContext: RunWithHttpContextFunction = build.entry.module.runWithHttpContext;

    app.use((req, res, next) => {
      // helpful headers:
      res.set("Strict-Transport-Security", `max-age=${60 * 60 * 24 * 365 * 100}`);

      // Add X-Robots-Tag header for test-cloud.trigger.dev
      if (req.hostname !== "cloud.trigger.dev") {
        res.set("X-Robots-Tag", "noindex, nofollow");
      }

      // /clean-urls/ -> /clean-urls
      if (req.path.endsWith("/") && req.path.length > 1) {
        const query = req.url.slice(req.path.length);
        const safepath = req.path.slice(0, -1).replace(/\/+/g, "/");
        res.redirect(301, safepath + query);
        return;
      }
      next();
    });

    app.use((req, res, next) => {
      // Generate a unique request ID for each request
      const requestId = nanoid();

      runWithHttpContext(
        { requestId, path: req.url, host: req.hostname, method: req.method },
        next
      );
    });

    if (process.env.DASHBOARD_AND_API_DISABLED !== "true") {
      if (process.env.ALLOW_ONLY_REALTIME_API === "true") {
        // Block all requests that do not start with /realtime
        app.use((req, res, next) => {
          // Make sure /healthcheck is still accessible
          if (!req.url.startsWith("/realtime") && req.url !== "/healthcheck") {
            res.status(404).send("Not Found");
            return;
          }

          next();
        });
      }

      app.use(apiRateLimiter);

      app.all(
        "*",
        // @ts-ignore
        createRequestHandler({
          build,
          mode: MODE,
        })
      );
    } else {
      // we need to do the health check here at /healthcheck
      app.get("/healthcheck", (req, res) => {
        res.status(200).send("OK");
      });
    }

    const server = app.listen(port, () => {
      console.log(
        `✅ server ready: http://localhost:${port} [NODE_ENV: ${MODE}]${
          ENABLE_CLUSTER && cluster.isWorker ? ` [worker ${cluster.worker?.id}/${process.pid}]` : ""
        }`
      );

      if (MODE === "development") {
        broadcastDevReady(build)
          .then(() => logDevReady(build))
          .catch(console.error);
      }
    });

    server.keepAliveTimeout = 65 * 1000;
    // Mitigate against https://github.com/triggerdotdev/trigger.dev/security/dependabot/128
    // by not allowing 2000+ headers to be sent and causing a DoS
    // headers will instead be limited by the maxHeaderSize
    server.maxHeadersCount = 0;

    let didCloseServer = false;

    function closeServer(signal: NodeJS.Signals) {
      if (didCloseServer) return;
      didCloseServer = true;

      server.close((err) => {
        if (err) {
          console.error("Error closing express server:", err);
        } else {
          console.log("Express server closed gracefully.");
        }
      });
    }

    process.on("SIGTERM", closeServer);
    process.on("SIGINT", closeServer);
  } else {
    require(BUILD_DIR);
    console.log(`✅ app ready (skipping http server)`);
  }
}
