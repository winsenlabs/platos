import "./sentry.server";

import { createRequestHandler } from "@remix-run/express";
import compression from "compression";
import express from "express";
import path from "node:path";
const app = express();
// Remix derives Request.url from Express' protocol and host. The deployed
// topology has one release/edge proxy, so trust that hop to preserve HTTPS
// origins inside actions.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(compression());
app.use("/build", express.static("public/build", { immutable: true, maxAge: "1y" }));
app.use(express.static("public", { maxAge: "1h" }));
app.get("/healthcheck", (_request, response) => response.status(200).send("OK"));
const build = require(path.join(process.cwd(), "build"));
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));
const port = Number(process.env.PORT ?? 3030);
app.listen(port, "0.0.0.0", () => console.log(`Platos dashboard ready on ${port}`));
