import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:3100/api/health";

function expectedHealthBody(body) {
  return body?.status === "ok" && body?.service === "platos-agent";
}

function waitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let listening = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      if (listening) signal.removeEventListener("abort", onAbort);
      handler(value);
    };
    const onAbort = () => settle(reject, signal.reason);
    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    if (signal.aborted) {
      onAbort();
    } else {
      listening = true;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function waitForAgentRuntimeHealth({
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 30_000,
  pollIntervalMs = 500,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastStatus = "none";
  let lastObservation = "no-response";

  while (now() < deadline) {
    const remainingMs = deadline - now();
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(new Error("health deadline exceeded")), remainingMs);
    let response;
    try {
      try {
        response = await waitWithSignal(fetchImpl(endpoint, { signal: controller.signal }), controller.signal);
      } catch {
        lastObservation = controller.signal.aborted ? "headers-timeout" : "request-failed";
        if (controller.signal.aborted) break;
      }

      if (response) {
        lastStatus = response.status;
        if (response.status !== 200) {
          lastObservation = "non-200-status";
        } else {
          try {
            const body = await waitWithSignal(response.json(), controller.signal);
            if (expectedHealthBody(body)) return { status: response.status, body };
            lastObservation = "unexpected-body";
          } catch {
            lastObservation = controller.signal.aborted ? "body-timeout" : "invalid-json";
            if (controller.signal.aborted) break;
          }
        }
      }
    } finally {
      clearTimer(timer);
    }

    const remainingAfterPollMs = deadline - now();
    if (remainingAfterPollMs > 0) {
      await sleep(Math.min(pollIntervalMs, remainingAfterPollMs));
    }
  }

  throw new Error(
    `Agent runtime health did not become ready: ${endpoint}; lastStatus=${lastStatus}; lastObservation=${lastObservation}`,
  );
}

async function main() {
  const endpoint = process.env.PLATOS_AGENT_HEALTH_ENDPOINT ?? DEFAULT_ENDPOINT;
  const result = await waitForAgentRuntimeHealth({ endpoint });
  console.log(`Agent runtime health passed: ${result.status} ${endpoint}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
