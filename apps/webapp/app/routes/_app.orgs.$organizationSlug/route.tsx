import { Outlet, type ShouldRevalidateFunction, type UIMatch } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { requireUser } from "~/services/session.server";
import { organizationPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationSlug: z.string().min(1),
  projectParam: z.string().optional(),
  envParam: z.string().uuid().optional(),
});

export function useCurrentPlan(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });
  return data?.currentPlan;
}

export const shouldRevalidate: ShouldRevalidateFunction = ({ currentParams, nextParams, currentUrl, nextUrl }) => {
  const current = ParamsSchema.safeParse(currentParams);
  const next = ParamsSchema.safeParse(nextParams);
  if (current.success && next.success) {
    if (current.data.organizationSlug !== next.data.organizationSlug) return true;
    if (current.data.projectParam !== next.data.projectParam) return true;
    if (current.data.envParam !== next.data.envParam) return true;
  }
  return currentUrl.pathname !== nextUrl.pathname;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = ParamsSchema.parse(params);
  const presenter = new OrganizationsPresenter();
  const scope = await presenter.call({
    user,
    request,
    organizationSlug,
    projectSlug: projectParam,
    environmentId: envParam,
  });
  return typedjson({
    ...scope,
    isImpersonating: user.isImpersonating,
    currentPlan: null,
    customDashboards: [],
    dashboardLimits: { used: 0, limit: 0 },
    widgetLimitPerDashboard: 0,
  });
};

export default function Organization() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const organization = useOptionalOrganization();
  return organization ? (
    <RouteErrorDisplay button={{ title: organization.name, to: organizationPath(organization) }} />
  ) : (
    <RouteErrorDisplay button={{ title: "Go to homepage", to: "/" }} />
  );
}
