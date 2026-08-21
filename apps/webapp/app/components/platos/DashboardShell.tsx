import { Form, Link, NavLink, Outlet } from "@remix-run/react";
import type { ReactNode } from "react";
import {
  agentAccountsPath, agentBudgetsPath, agentClustersPath, agentConnectPath,
  agentEntitiesPath, agentEvalsPath, agentGovernancePath, agentMonitoringPath,
  agentProvidersPath, agentToolsPath, agentsPath, approvalsPath, evalCriteriaPath,
  memoriesPath, platosTasksPath, skillsPath, v3ApiKeysPath, v3EnvironmentVariablesPath,
  v3ProjectSettingsGeneralPath,
} from "~/utils/pathBuilder";

export type Workspace = {
  organization: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string };
  environment: { id: string; slug: string; name: string; type: string };
  operator: { id: string; email: string };
};

const sections = [
  ["Build", [["Agents", agentsPath], ["Connect", agentConnectPath], ["Entities", agentEntitiesPath], ["Tools", agentToolsPath], ["Providers", agentProvidersPath], ["Skills", skillsPath]]],
  ["Observe", [["Monitoring", agentMonitoringPath], ["Budgets", agentBudgetsPath], ["End users", agentAccountsPath]]],
  ["Govern", [["Governance", agentGovernancePath], ["Approvals", approvalsPath], ["Evals", agentEvalsPath], ["Criteria", evalCriteriaPath], ["Clusters", agentClustersPath]]],
  ["System", [["Background work", platosTasksPath], ["Memory", memoriesPath], ["Variables", v3EnvironmentVariablesPath], ["API keys", v3ApiKeysPath], ["Settings", v3ProjectSettingsGeneralPath]]],
] as const;

export function DashboardShell({ workspace }: { workspace: Workspace }) {
  const { organization: o, project: p, environment: e } = workspace;
  return (
    <div className="grid h-screen grid-cols-1 overflow-hidden bg-background-dimmed text-text-bright md:grid-cols-[15rem_1fr]">
      <aside className="hidden min-h-0 flex-col border-r border-grid-bright bg-background-bright md:flex">
        <div className="border-b border-grid-bright px-4 py-3">
          <Link to="/" className="text-sm font-semibold tracking-tight">Platos</Link>
          <p className="mt-1 truncate text-xs text-text-dimmed">agent control plane</p>
        </div>
        <div className="border-b border-grid-bright px-4 py-3 text-xs">
          <div className="truncate font-medium">{o.name} / {p.name}</div>
          <div className="mt-1 flex items-center gap-2 text-text-dimmed"><span className="h-2 w-2 rounded-full bg-green-500" />{e.name}</div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {sections.map(([heading, items]) => (
            <section key={heading} className="mb-4">
              <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">{heading}</h2>
              {items.map(([label, build]) => (
                <NavLink key={label} to={build(o,p,e)} className={({isActive}) => `mb-0.5 block rounded px-2 py-1.5 text-sm ${isActive ? "bg-charcoal-700 text-white" : "text-text-dimmed hover:bg-charcoal-800 hover:text-white"}`}>{label}</NavLink>
              ))}
            </section>
          ))}
        </nav>
        <div className="border-t border-grid-bright px-3 py-3 text-xs text-text-dimmed">
          <div className="truncate">{workspace.operator.email}</div>
          <Form method="post" action="/logout"><button className="mt-2 text-text-bright hover:underline">Sign out</button></Form>
        </div>
      </aside>
      <main className="min-w-0 overflow-y-auto"><Outlet /></main>
    </div>
  );
}

export function Page({ children }: { children: ReactNode }) { return <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 sm:py-6">{children}</div>; }
