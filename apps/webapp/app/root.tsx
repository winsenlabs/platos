import type { LinksFunction, MetaFunction } from "@remix-run/node";
import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "@remix-run/react";
import stylesheet from "~/tailwind.css";
export const links: LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];
export const meta: MetaFunction = () => [{ title: "Platos" }, { name: "viewport", content: "width=device-width,initial-scale=1" }];
export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return <Document><main className="grid min-h-screen place-items-center bg-background-dimmed p-8 text-text-bright"><div><h1 className="text-2xl font-semibold">{notFound ? "This resource was not found" : "Platos could not render this route"}</h1><p className="mt-2 text-sm text-text-dimmed">{notFound ? "It may have been deleted or is outside the selected environment." : "The failed panel is isolated. Return to the dashboard and retry."}</p>{notFound && <Link className="mt-4 inline-block rounded border border-grid-bright px-3 py-2 text-sm text-indigo-300 hover:bg-charcoal-900" to="/">Return to dashboard</Link>}</div></main></Document>;
}
function Document({ children }: { children: React.ReactNode }) { return <html lang="en" className="h-full"><head><meta charSet="utf-8"/><Meta/><Links/></head><body className="h-full overflow-hidden bg-background-dimmed"><>{children}</><ScrollRestoration/><Scripts/></body></html>; }
export default function App() { return <Document><Outlet/></Document>; }
