import { createReadableStreamFromReadable, type EntryContext } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { wrapHandleErrorWithSentry } from "@sentry/remix";
import { renderToPipeableStream } from "react-dom/server";
import { PassThrough } from "node:stream";
const ABORT_DELAY = 15_000;
export default function handleRequest(request: Request, status: number, headers: Headers, context: EntryContext) {
  return new Promise<Response>((resolve, reject) => {
    let rendered = false;
    const { pipe, abort } = renderToPipeableStream(<RemixServer context={context} url={request.url} abortDelay={ABORT_DELAY}/>, {
      onShellReady() { rendered = true; const body = new PassThrough(); headers.set("Content-Type", "text/html"); resolve(new Response(createReadableStreamFromReadable(body), { status, headers })); pipe(body); },
      onShellError: reject,
      onError(error) { if (rendered) console.error(error); },
    });
    setTimeout(abort, ABORT_DELAY);
  });
}

export const handleError = wrapHandleErrorWithSentry((error, { request }) => {
  console.error(
    "Unhandled Remix server error",
    request instanceof Request
      ? { error, method: request.method, url: request.url }
      : { error },
  );
});
