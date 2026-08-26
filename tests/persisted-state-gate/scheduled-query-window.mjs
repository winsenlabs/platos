const MINUTE_MS = 60_000;
const QUIET_WINDOW_START_MS = 10_000;
const QUIET_WINDOW_END_MS = 35_000;

export function scheduledQueryQuietWindowDelay(nowMs = Date.now()) {
  const millisecondsIntoMinute = ((nowMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  if (millisecondsIntoMinute < QUIET_WINDOW_START_MS) {
    return QUIET_WINDOW_START_MS - millisecondsIntoMinute;
  }
  if (millisecondsIntoMinute >= QUIET_WINDOW_END_MS) {
    return MINUTE_MS + QUIET_WINDOW_START_MS - millisecondsIntoMinute;
  }
  return 0;
}

export async function waitForScheduledQueryQuietWindow(options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const delay = scheduledQueryQuietWindowDelay(now());
  if (delay > 0) await sleep(delay);
  return delay;
}
