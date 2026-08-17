import { Link, Outlet, useNavigation } from "@remix-run/react";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { MainBody } from "~/components/layout/AppLayout";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization, useOrganizations } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3EnvironmentPath, v3ProjectPath } from "~/utils/pathBuilder";

export default function Project() {
  const organizations = useOrganizations();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const loadingScope = navigation.state !== "idle";

  return (
    <div className="grid min-h-0 grid-cols-[15rem_1fr] overflow-hidden">
      <aside className="flex min-h-0 flex-col border-r border-grid-bright bg-background-dimmed p-3">
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-dimmed">Organization</p>
          <p className="truncate text-sm font-semibold text-text-bright">{organization.name}</p>
        </div>
        <nav aria-label="Scope navigation" className="min-h-0 flex-1 overflow-y-auto">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-dimmed">Environments</p>
          {project.environments.length === 0 ? (
            <div className="rounded border border-grid-bright p-3 text-sm text-text-dimmed">
              No active environments. Create one in project settings before opening environment tools.
            </div>
          ) : (
            <ul className="space-y-1">
              {project.environments.map((item) => (
                <li key={item.id}>
                  <Link
                    to={v3EnvironmentPath(organization, project, item)}
                    aria-current={item.id === environment.id ? "page" : undefined}
                    className={`block rounded px-2 py-1.5 text-sm ${
                      item.id === environment.id
                        ? "bg-charcoal-700 text-text-bright"
                        : "text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright"
                    }`}
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="mt-3 border-t border-grid-bright pt-3 text-xs text-text-dimmed">
          {organizations.length} organization{organizations.length === 1 ? "" : "s"} available
        </div>
      </aside>
      <MainBody>
        {loadingScope ? (
          <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
            <div className="rounded border border-grid-bright bg-background-dimmed px-5 py-4 text-sm text-text-dimmed">
              Loading authorized scope…
            </div>
          </div>
        ) : (
          <Outlet />
        )}
      </MainBody>
    </div>
  );
}

export function ErrorBoundary() {
  const organization = useOrganization();
  const project = useProject();
  return (
    <RouteErrorDisplay
      button={{ title: project.name, to: v3ProjectPath(organization, project) }}
    />
  );
}
