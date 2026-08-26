import { Form, Link, NavLink, Outlet } from "@remix-run/react";
import {
  Activity,
  Bot,
  Boxes,
  Brain,
  CheckSquare,
  ChevronDown,
  CircleDollarSign,
  Command,
  FlaskConical,
  FolderOpen,
  Home,
  Key,
  Link2,
  List,
  Menu,
  Moon,
  MessagesSquare,
  Network,
  Plug,
  Search,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Variable,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentAccountsPath,
  agentBudgetsPath,
  agentClustersPath,
  agentConnectPath,
  agentEntitiesPath,
  agentEvalsPath,
  agentFilesPath,
  agentGovernancePath,
  agentMcpsPath,
  agentMonitoringPath,
  agentProvidersPath,
  agentToolsPath,
  agentsPath,
  approvalsPath,
  auditPath,
  costPath,
  evalCriteriaPath,
  homePath,
  accountPath,
  memoriesPath,
  organizationTeamPath,
  jobsPath,
  skillsPath,
  threadsPath,
  v3ApiKeysPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3ProjectSettingsGeneralPath,
} from "~/utils/pathBuilder";
import { Button } from "./ProductPrimitives";

export type Workspace = {
  organization: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string };
  environment: { id: string; slug: string; name: string; type: string };
  environments?: Array<{ id: string; slug: string; name: string }>;
  operator: { id: string; email: string };
};

type PathBuilder = (o: Workspace["organization"], p: Workspace["project"], e: Workspace["environment"]) => string;
type NavigationItem = { label: string; build: PathBuilder; icon: LucideIcon; badge?: string; end?: boolean };

const sections: Array<{ heading: string; items: NavigationItem[] }> = [
  { heading: "Workspace", items: [
    { label: "Home", build: homePath, icon: Home, end: true },
    { label: "Threads", build: threadsPath, icon: MessagesSquare },
  ] },
  { heading: "Build", items: [
    { label: "Agents", build: agentsPath, icon: Bot },
    { label: "Connect", build: agentConnectPath, icon: Plug },
    { label: "Entities", build: agentEntitiesPath, icon: Boxes },
    { label: "MCP", build: agentMcpsPath, icon: Link2 },
    { label: "Tools", build: agentToolsPath, icon: Wrench },
    { label: "Providers", build: agentProvidersPath, icon: Network },
    { label: "Skills", build: skillsPath, icon: FlaskConical },
  ] },
  { heading: "Observe", items: [
    { label: "Monitoring", build: agentMonitoringPath, icon: Activity },
    { label: "Cost", build: costPath, icon: CircleDollarSign },
    { label: "Budgets", build: agentBudgetsPath, icon: Wallet },
    { label: "Audit log", build: auditPath, icon: ScrollText },
    { label: "End users", build: agentAccountsPath, icon: Users },
  ] },
  { heading: "Govern", items: [
    { label: "Governance", build: agentGovernancePath, icon: ShieldCheck },
    { label: "Approvals", build: approvalsPath, icon: CheckSquare },
    { label: "Evals", build: agentEvalsPath, icon: CircleDollarSign },
    { label: "Criteria", build: evalCriteriaPath, icon: List },
    { label: "Clusters", build: agentClustersPath, icon: Boxes },
  ] },
  { heading: "System", items: [
    { label: "Jobs", build: jobsPath, icon: Command },
    { label: "Memory", build: memoriesPath, icon: Brain },
    { label: "Files", build: agentFilesPath, icon: FolderOpen },
    { label: "Variables", build: v3EnvironmentVariablesPath, icon: Variable },
    { label: "API keys", build: v3ApiKeysPath, icon: Key },
    { label: "Settings", build: v3ProjectSettingsGeneralPath, icon: Settings },
  ] },
];

function Brand() {
  return <Link to="/" className="flex items-center gap-3 rounded-md px-2 py-1 text-text-bright"><span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ink)] text-[var(--bg)]" aria-hidden="true"><svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8"><path d="M7 18V6h5.5a4 4 0 0 1 0 8H7"/><path d="M11 10h6"/></svg></span><span><span className="block text-sm font-semibold tracking-tight">Platos</span><span className="block font-mono text-[10px] text-text-dimmed">agent runtime</span></span></Link>;
}

function EnvironmentBadge({ environment }: { environment: Workspace["environment"] }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--good-soft)] px-2 py-1 font-mono text-[10px] font-medium text-[var(--good)]"><span className="h-1.5 w-1.5 rounded-full bg-current" />{environment.name}</span>;
}

function ScopeSwitcher({ workspace }: { workspace: Workspace }) {
  const environments = workspace.environments?.length ? workspace.environments : [workspace.environment];
  return <details className="group relative mx-1 mb-2"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-grid-bright bg-background-bright px-3 py-2.5 hover:border-[var(--border-2)]"><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-text-bright">{workspace.organization.name}</div><div className="truncate text-[11px] text-text-dimmed">{workspace.project.name}</div></div><ChevronDown className="h-4 w-4 text-text-dimmed transition group-open:rotate-180" /></summary><div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-lg border border-grid-bright bg-background-bright p-2 shadow-xl"><div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">Environment</div>{environments.map((environment) => <Link key={environment.id} to={v3EnvironmentPath(workspace.organization, workspace.project, environment)} className={`flex items-center justify-between rounded-md px-2 py-2 text-xs hover:bg-charcoal-700 ${environment.id === workspace.environment.id ? "text-text-bright" : "text-text-dimmed"}`}><span>{environment.name}</span>{environment.id === workspace.environment.id && <span className="h-1.5 w-1.5 rounded-full bg-[var(--good)]" />}</Link>)}<Link to={`/orgs/${workspace.organization.slug}`} className="mt-1 block border-t border-grid-bright px-2 pt-2 text-xs text-[var(--accent)] hover:underline">Browse projects and environments</Link></div></details>;
}

function Navigation({ workspace, onNavigate }: { workspace: Workspace; onNavigate?: () => void }) {
  return <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">{sections.map((section) => <section key={section.heading} className="mb-3"><h2 className="px-2 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">{section.heading}</h2>{section.items.map((item) => { const Icon = item.icon; return <NavLink key={item.label} end={item.end} to={item.build(workspace.organization, workspace.project, workspace.environment)} onClick={onNavigate} className={({ isActive }) => `mb-0.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${isActive ? "bg-background-bright font-medium text-text-bright shadow-[inset_0_0_0_1px_var(--border)]" : "text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"}`}><Icon className="h-4 w-4 shrink-0" /><span className="flex-1">{item.label}</span>{item.badge && <span className="rounded-full bg-[var(--accent-soft)] px-1.5 font-mono text-[10px] text-[var(--accent)]">{item.badge}</span>}</NavLink>; })}</section>)}</nav>;
}

function OperatorPresence({ workspace }: { workspace: Workspace }) {
  const initials = workspace.operator.email.slice(0, 2).toUpperCase();
  return <div className="border-t border-grid-bright p-3"><div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--ink)] text-[10px] font-semibold text-[var(--bg)]">{initials}</span><div className="min-w-0 flex-1"><div className="truncate text-xs text-text-bright">{workspace.operator.email}</div><div className="flex items-center gap-1 text-[10px] text-[var(--good)]"><span className="h-1.5 w-1.5 rounded-full bg-current" />Connected</div></div></div><div className="mt-2 flex items-center gap-3 pl-9 text-[11px]"><Link to={accountPath()} className="text-text-dimmed hover:text-text-bright">Account</Link><Link to={organizationTeamPath(workspace.organization)} className="text-text-dimmed hover:text-text-bright">Organization</Link><Form method="post" action="/logout"><button className="text-text-dimmed hover:text-text-bright">Sign out</button></Form></div></div>;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => { setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"); }, []);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.style.colorScheme = next;
    localStorage.setItem("platos-theme", next);
    setTheme(next);
  }
  const Icon = theme === "dark" ? Sun : Moon;
  return <Button type="button" tone="ghost" onClick={toggle} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} className="h-9 w-9 px-0"><Icon className="h-4 w-4" /></Button>;
}

function GlobalSearchLauncher({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen((current) => !current); }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => { if (open) requestAnimationFrame(() => inputRef.current?.focus()); }, [open]);
  const links = useMemo(() => sections.flatMap((section) => section.items.map((item) => ({ ...item, section: section.heading, to: item.build(workspace.organization, workspace.project, workspace.environment) }))), [workspace]);
  const filtered = links.filter((item) => `${item.label} ${item.section}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <><button type="button" onClick={() => setOpen(true)} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-grid-bright bg-background-bright px-3 text-left text-sm text-text-dimmed hover:border-[var(--border-2)] sm:max-w-md"><Search className="h-4 w-4" /><span className="truncate">Search Platos</span><kbd className="ml-auto hidden rounded bg-charcoal-700 px-1.5 py-0.5 font-mono text-[10px] sm:inline">⌘K</kbd></button>{open && <div className="fixed inset-0 z-50 grid items-start justify-items-center bg-black/30 px-4 pt-[12vh]" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }}><div role="dialog" aria-modal="true" aria-label="Search Platos" className="w-full max-w-xl overflow-hidden rounded-xl border border-grid-bright bg-background-bright shadow-2xl"><div className="flex items-center gap-2 border-b border-grid-bright px-4"><Search className="h-4 w-4 text-text-dimmed" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} className="h-12 min-w-0 flex-1 bg-transparent text-sm text-text-bright outline-none" placeholder="Go to a Platos surface…" /><button type="button" onClick={() => setOpen(false)} aria-label="Close search"><X className="h-4 w-4" /></button></div><div className="max-h-[55vh] overflow-y-auto p-2">{filtered.length ? filtered.map((item) => { const Icon = item.icon; return <Link key={item.to} to={item.to} onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-charcoal-700"><Icon className="h-4 w-4 text-text-dimmed" /><span className="flex-1 text-sm text-text-bright">{item.label}</span><span className="text-xs text-text-dimmed">{item.section}</span></Link>; }) : <p className="p-6 text-center text-sm text-text-dimmed">No matching surface</p>}</div></div></div>}</>;
}

function Sidebar({ workspace, mobile, onNavigate }: { workspace: Workspace; mobile?: boolean; onNavigate?: () => void }) {
  return <aside className={`${mobile ? "flex" : "hidden md:flex"} min-h-0 flex-col border-r border-grid-bright bg-charcoal-850`}><div className="flex items-center justify-between px-3 py-3"><Brand />{mobile && <button type="button" onClick={onNavigate} aria-label="Close navigation" className="p-2"><X className="h-4 w-4" /></button>}</div><ScopeSwitcher workspace={workspace} /><div className="px-3 pb-2"><EnvironmentBadge environment={workspace.environment} /></div><Navigation workspace={workspace} onNavigate={onNavigate} /><OperatorPresence workspace={workspace} /></aside>;
}

export function AppShell({ workspace }: { workspace: Workspace }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return <div className="grid h-screen grid-cols-1 overflow-hidden bg-background-dimmed text-text-bright md:grid-cols-[240px_minmax(0,1fr)]"><Sidebar workspace={workspace} />{mobileOpen && <div className="fixed inset-0 z-40 grid grid-cols-[minmax(0,19rem)_1fr] md:hidden"><Sidebar workspace={workspace} mobile onNavigate={() => setMobileOpen(false)} /><button type="button" className="bg-black/30" onClick={() => setMobileOpen(false)} aria-label="Close navigation backdrop" /></div>}<div className="flex min-w-0 flex-col overflow-hidden"><header className="flex h-14 shrink-0 items-center gap-2 border-b border-grid-bright bg-background-dimmed px-3 sm:gap-3 sm:px-6"><button type="button" className="grid h-9 w-9 place-items-center rounded-md border border-grid-bright bg-background-bright md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="h-4 w-4" /></button><GlobalSearchLauncher workspace={workspace} /><div className="ml-auto flex items-center gap-1"><div className="hidden sm:block"><EnvironmentBadge environment={workspace.environment} /></div><ThemeToggle /></div></header><main className="min-w-0 flex-1 overflow-y-auto"><Outlet /></main></div></div>;
}

export const DashboardShell = AppShell;

export function Page({ children }: { children: ReactNode }) {
  return <div className="w-full px-4 py-5 sm:px-6 sm:py-7 lg:px-9">{children}</div>;
}
