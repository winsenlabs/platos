import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Links, LiveReload, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { ShortcutsProvider } from "./components/primitives/ShortcutsProvider";
import { Toast } from "./components/primitives/Toast";
import { TimezoneSetter } from "./components/TimezoneSetter";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { usePostHog } from "./hooks/usePostHog";
import { getUser } from "./services/session.server";
import { getTimezonePreference } from "./services/preferences/uiPreferences.server";
import { appEnvTitleTag } from "./utils";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const headers = () => ({
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=(), usb=()",
});

export const meta: MetaFunction = ({ data }) => {
  const typedData = data as UseDataFunctionReturn<typeof loader>;
  return [
    { title: typedData?.appEnv ? `Platos${appEnvTitleTag(typedData.appEnv)}` : "Platos" },
    {
      name: "viewport",
      content: "width=1024, initial-scale=1",
    },
    {
      name: "robots",
      content:
        // Managed-cloud production hostname = do-not-block-indexing. Keep the
        // trigger.dev hostname check for self-hosters still on the legacy cloud;
        // platos.dev production hosts also opt into indexing.
        typeof window === "undefined" ||
        (window.location.hostname !== "cloud.trigger.dev" &&
          window.location.hostname !== "app.platos.dev")
          ? "noindex, nofollow"
          : "index, follow",
    },
  ];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await getSession(request.headers.get("cookie"));
  const toastMessage = session.get("toastMessage") as ToastMessage;
  const posthogProjectKey = env.POSTHOG_PROJECT_KEY;
  // Browser uses POSTHOG_API_HOST. Set to "/ingest" to route through a
  // first-party Caddy/Nginx reverse proxy (dodges ad-blockers); leave at the
  // default public host for vanilla self-hosted setups.
  const posthogApiHost = env.POSTHOG_API_HOST;
  const features = featuresForRequest(request);
  const timezone = await getTimezonePreference(request);

  const kapa = {
    websiteId: env.KAPA_AI_WEBSITE_ID,
  };

  return typedjson(
    {
      user: await getUser(request),
      toastMessage,
      posthogProjectKey,
      posthogApiHost,
      features,
      appEnv: env.APP_ENV,
      appOrigin: env.APP_ORIGIN,
      triggerCliTag: env.TRIGGER_CLI_TAG,
      kapa,
      timezone,
    },
    { headers: { "Set-Cookie": await commitSession(session) } }
  );
};

export type LoaderType = typeof loader;

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  if (options.formAction === "/resources/environment") {
    return false;
  }

  return options.defaultShouldRevalidate;
};

export function ErrorBoundary() {
  return (
    <>
      <html lang="en" className="h-full">
        <head>
          <meta charSet="utf-8" />

          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-background-dimmed">
          <ShortcutsProvider>
            <AppContainer>
              <MainCenteredContainer>
                <RouteErrorDisplay />
              </MainCenteredContainer>
            </AppContainer>
          </ShortcutsProvider>
          <Scripts />
        </body>
      </html>
    </>
  );
}

export default function App() {
  const { posthogProjectKey, posthogApiHost, kapa } = useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey, posthogApiHost);

  return (
    <>
      <html lang="en" className="h-full">
        <head>
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-background-dimmed">
          <ShortcutsProvider>
            <TimezoneSetter />
            <Outlet />
            <Toast />
          </ShortcutsProvider>
          <ScrollRestoration />
          <ExternalScripts />
          <Scripts />
          <LiveReload />
        </body>
      </html>
    </>
  );
}
