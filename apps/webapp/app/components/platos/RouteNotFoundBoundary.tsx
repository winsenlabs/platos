import { isRouteErrorResponse, useRouteError, Link } from "@remix-run/react";

/**
 * EOBD.99 — shared `ErrorBoundary` for agent / thread / memory routes.
 *
 * Re-export from a route's module.ts file:
 *
 *   export { RouteNotFoundBoundary as ErrorBoundary } from "~/components/platos/RouteNotFoundBoundary";
 *
 * Styled 404 state for route `throw new Response(undefined, { status: 404 })`
 * calls; anything else (5xx, auth errors, thrown Errors) falls through
 * to the root `ErrorBoundary`.
 */
export function RouteNotFoundBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          padding: 32,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 32,
            fontWeight: 700,
            marginBottom: 12,
            color: "var(--color-text-bright, #e5e7eb)",
          }}
        >
          404 — not found
        </div>
        <div
          style={{
            maxWidth: 420,
            opacity: 0.7,
            marginBottom: 24,
            color: "var(--color-text-dimmed, #9ca3af)",
          }}
        >
          {error.statusText ||
            "The resource you're looking for was deleted, renamed, or never existed."}
        </div>
        <Link
          to="/"
          style={{
            display: "inline-block",
            padding: "10px 16px",
            borderRadius: 6,
            background: "var(--color-primary, #6366f1)",
            color: "#fff",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  // Fall through — the root ErrorBoundary handles every other failure.
  throw error;
}
