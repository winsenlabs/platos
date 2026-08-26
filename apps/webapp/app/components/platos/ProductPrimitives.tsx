import { Form, Link, useSearchParams } from "@remix-run/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useState } from "react";

export type ButtonTone = "primary" | "secondary" | "danger" | "ghost";

const buttonTones: Record<ButtonTone, string> = {
  primary: "border-transparent bg-primary text-white hover:brightness-110",
  secondary: "border-grid-bright bg-background-bright text-text-bright hover:border-[var(--border-2)]",
  danger: "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] hover:brightness-95",
  ghost: "border-transparent bg-transparent text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright",
};

export function Button({ tone = "secondary", className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return <button {...props} type={type} className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${buttonTones[tone]} ${className}`} />;
}

export type StatusTone = "good" | "warning" | "danger" | "accent" | "muted";
const statusTones: Record<StatusTone, string> = {
  good: "bg-[var(--good-soft)] text-[var(--good)]",
  warning: "bg-[var(--warn-soft)] text-[var(--warn)]",
  danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
  muted: "bg-charcoal-700 text-text-dimmed",
};

export function StatusChip({ children, tone = "muted" }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusTones[tone]}`}>{children}</span>;
}

export function statusTone(value: unknown): StatusTone {
  const normalized = String(value ?? "unknown").trim().toLowerCase();
  if (["healthy", "working", "active", "connected", "dispatchable", "complete", "completed", "success", "stable", "approved", "enabled", "available"].includes(normalized)) return "good";
  if (["failed", "failure", "broken", "disconnected", "undispatchable", "rejected", "blocked", "revoked", "error", "unavailable"].includes(normalized)) return "danger";
  if (["pending", "waiting", "degraded", "stale", "paused", "idle", "warning", "disabled"].includes(normalized)) return "warning";
  if (["current", "canary", "linked", "selected", "running"].includes(normalized)) return "accent";
  return "muted";
}

export function Alert({ title, children, tone = "accent" }: { title?: string; children: ReactNode; tone?: StatusTone }) {
  const classes = statusTones[tone];
  return <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg border border-current/20 p-4 ${classes}`}>{title && <div className="font-semibold">{title}</div>}<div className={title ? "mt-1 text-sm" : "text-sm"}>{children}</div></div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-grid-bright bg-background-bright p-10 text-center"><h2 className="text-lg font-semibold text-text-bright">{title}</h2><p className="mx-auto mt-2 max-w-xl text-sm text-text-dimmed">{description}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

export function PanelFailure({ error, retry = true }: { error: { code: string; message: string }; retry?: boolean }) {
  return <Alert title="Panel unavailable" tone="danger"><p>{error.message}</p><div className="mt-3 flex flex-wrap items-center gap-3"><code className="text-xs">{error.code}</code>{retry && <Form method="get"><Button type="submit" tone="danger" className="min-h-8 py-1 text-xs">Retry</Button></Form>}</div></Alert>;
}

export function DataTable({ headers, rows, empty, rowKeys }: { headers: string[]; rows: ReactNode[][]; empty?: ReactNode; rowKeys?: string[] }) {
  if (!rows.length && empty) return <>{empty}</>;
  return <div className="max-h-[70vh] overflow-auto rounded-lg border border-grid-bright bg-background-bright"><table className="w-full min-w-max text-left text-sm"><thead className="sticky top-0 z-[1] bg-background-bright text-xs uppercase tracking-wide text-text-dimmed"><tr>{headers.map((header) => <th key={header} scope="col" className="border-b border-grid-bright px-3 py-2 font-medium">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={rowKeys?.[index] ?? index} className="border-b border-grid-dimmed last:border-0 hover:bg-[var(--surface-2)]">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-[var(--pad-row)] align-top text-text-bright">{cell}</td>)}</tr>)}</tbody></table></div>;
}

type PaginationShape = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

function paginationShape(value: unknown): PaginationShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const raw = root.pagination;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const page = raw as Record<string, unknown>;
  const numbers = ["page", "pageSize", "total", "totalPages", "from", "to"] as const;
  if (numbers.some((key) => typeof page[key] !== "number" || !Number.isFinite(page[key] as number))) return null;
  if (typeof page.hasPrevious !== "boolean" || typeof page.hasNext !== "boolean") return null;
  return page as unknown as PaginationShape;
}

export function CollectionSearch({ label = "Search all results", placeholder = "Search", searchParam = "search", pageParam = "page" }: { label?: string; placeholder?: string; searchParam?: string; pageParam?: string }) {
  const [searchParams] = useSearchParams();
  const preserved = Array.from(searchParams.entries()).filter(([name]) => name !== searchParam && name !== pageParam);
  return <Form method="get" role="search" className="flex min-w-0 flex-1 flex-wrap gap-2">
    {preserved.map(([name, value]) => <input key={`${name}-${value}`} type="hidden" name={name} value={value} />)}
    <label className="min-w-[12rem] flex-1 text-xs text-text-dimmed"><span className="sr-only">{label}</span><input name={searchParam} defaultValue={searchParams.get(searchParam) ?? ""} placeholder={placeholder} className="min-h-9 w-full rounded-md border border-grid-bright bg-background-bright px-3 text-sm text-text-bright" /></label>
    <Button type="submit">Search</Button>
    {searchParams.get(searchParam) && <Link to={preserved.length ? `?${new URLSearchParams(preserved).toString()}` : "?"} className="inline-flex min-h-9 items-center px-2 text-xs text-text-dimmed hover:text-text-bright">Clear</Link>}
  </Form>;
}

export function PaginationRange({ data, label = "Collection pagination", pageParam = "page", pageSizeParam = "pageSize" }: { data: unknown; label?: string; pageParam?: string; pageSizeParam?: string }) {
  const pagination = paginationShape(data);
  const [searchParams] = useSearchParams();
  if (!pagination) {
    const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
    return root && Object.prototype.hasOwnProperty.call(root, "pagination")
      ? <Alert tone="danger" title="Pagination unavailable">The server returned malformed range metadata. Results are not presented as complete.</Alert>
      : null;
  }
  const pageHref = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set(pageParam, String(page));
    next.set(pageSizeParam, String(pagination.pageSize));
    return `?${next.toString()}`;
  };
  const range = pagination.total === 0 ? "No results" : `${pagination.from.toLocaleString()}–${pagination.to.toLocaleString()} of ${pagination.total.toLocaleString()}`;
  return <nav aria-label={label} className="mt-3 flex flex-col gap-2 border-t border-grid-dimmed pt-3 text-xs text-text-dimmed sm:flex-row sm:items-center sm:justify-between">
    <p role="status" aria-live="polite">{range}{pagination.totalPages > 0 ? ` · Page ${pagination.page} of ${pagination.totalPages}` : ""}</p>
    <div className="flex gap-2">
      {pagination.hasPrevious ? <Link rel="prev" to={pageHref(pagination.page - 1)} className="inline-flex min-h-9 items-center rounded-md border border-grid-bright px-3 font-medium text-text-bright hover:bg-[var(--surface-2)]">Previous</Link> : <span aria-disabled="true" className="inline-flex min-h-9 items-center rounded-md border border-grid-dimmed px-3 opacity-50">Previous</span>}
      {pagination.hasNext ? <Link rel="next" to={pageHref(pagination.page + 1)} className="inline-flex min-h-9 items-center rounded-md border border-grid-bright px-3 font-medium text-text-bright hover:bg-[var(--surface-2)]">Next</Link> : <span aria-disabled="true" className="inline-flex min-h-9 items-center rounded-md border border-grid-dimmed px-3 opacity-50">Next</span>}
    </div>
  </nav>;
}

export function StatTile({ title, value, hint }: { title: string; value: ReactNode; hint?: string }) {
  return <div className="rounded-lg border border-grid-bright bg-background-bright p-[var(--pad-card)]"><div className="text-xs uppercase tracking-wide text-text-dimmed">{title}</div><div className="mt-2 text-2xl font-semibold text-text-bright">{value}</div>{hint && <div className="mt-1 text-xs text-text-dimmed">{hint}</div>}</div>;
}

export function ProvenanceNote({ children }: { children: ReactNode }) {
  return <p className="mt-4 border-l-2 border-[var(--accent)] pl-3 text-xs text-text-dimmed"><span className="font-medium text-text-bright">Source:</span> {children}</p>;
}

export function RevealOnceSecret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(true);
  if (!visible) return <Alert tone="warning">Secret hidden. It will not be available from loader data.</Alert>;
  return <div className="mt-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-[var(--warn)]"><div className="text-xs font-semibold uppercase">Reveal once — copy before leaving</div><code className="mt-2 block break-all select-all text-text-bright">{value}</code><div className="mt-3 flex gap-2"><Button type="button" onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true)); }} className="min-h-8 py-1 text-xs">{copied ? "Copied" : "Copy secret"}</Button><Button type="button" tone="ghost" onClick={() => setVisible(false)} className="min-h-8 py-1 text-xs">Hide</Button></div><p className="mt-2 text-xs text-text-dimmed">This value came only from the mutation response.</p></div>;
}

export type BreadcrumbItem = { label: string; to?: string };
export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return <nav aria-label="Breadcrumb"><ol className="flex flex-wrap items-center gap-2 text-xs text-text-dimmed">{items.map((item, index) => <li key={`${item.label}-${index}`} className="flex items-center gap-2">{index > 0 && <span aria-hidden="true">/</span>}{item.to ? <Link to={item.to} className="hover:text-text-bright">{item.label}</Link> : <span aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>}</li>)}</ol></nav>;
}

export function PageHeader({ title, description, breadcrumbs, actions }: { title: string; description?: string; breadcrumbs?: BreadcrumbItem[]; actions?: ReactNode }) {
  return <header className="mb-6"><div className="flex flex-wrap items-start justify-between gap-4"><div>{breadcrumbs && <Breadcrumbs items={breadcrumbs} />}<h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-bright">{title}</h1>{description && <p className="mt-1 max-w-3xl text-sm text-text-dimmed">{description}</p>}</div>{actions && <div className="flex flex-wrap gap-2">{actions}</div>}</div></header>;
}

export function Panel({ children, className = "", tone = "default" }: { children: ReactNode; className?: string; tone?: "default" | "danger" | "warning" | "accent" }) {
  const tones = {
    default: "border-grid-bright bg-background-bright",
    danger: "border-[var(--danger)] bg-[var(--danger-soft)]",
    warning: "border-[var(--warn)] bg-[var(--warn-soft)]",
    accent: "border-[var(--accent)] bg-[var(--accent-soft)]",
  } as const;
  return <section className={`rounded-lg border p-[var(--pad-card)] ${tones[tone]} ${className}`}>{children}</section>;
}

export function SectionHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-text-bright">{title}</h2>{description && <p className="mt-1 max-w-3xl text-xs text-text-dimmed">{description}</p>}</div>{actions && <div className="flex flex-wrap gap-2">{actions}</div>}</div>;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-grid-bright bg-background-bright p-2">{children}</div>;
}

export function FilterChip({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return <span className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium ${active ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-grid-bright text-text-dimmed"}`}>{children}</span>;
}

export function ProgressBar({ value, max = 100, tone = "accent", label }: { value: number; max?: number; tone?: StatusTone; label?: string }) {
  const safeMax = max > 0 ? max : 1;
  const width = Math.max(0, Math.min(100, (value / safeMax) * 100));
  const colors: Record<StatusTone, string> = { good: "var(--good)", warning: "var(--warn)", danger: "var(--danger)", accent: "var(--accent)", muted: "var(--ink-4)" };
  return <div><div className="h-2 overflow-hidden rounded-full bg-[var(--bg-3)]"><div className="h-full rounded-full transition-[width]" style={{ width: `${width}%`, background: colors[tone] }} /></div>{label && <div className="mt-1 text-[11px] text-text-dimmed">{label}</div>}</div>;
}

export function TokenCompositionBar({ segments }: { segments: Array<{ label: string; value: number; tone: "read" | "write" | "input" | "output" }> }) {
  const positive = segments.filter((segment) => segment.value > 0);
  const total = positive.reduce((sum, segment) => sum + segment.value, 0);
  const colors = { read: "var(--good)", write: "var(--warn)", input: "var(--accent)", output: "var(--agent-violet)" } as const;
  if (!total) return <div className="text-sm text-text-dimmed">No token composition was persisted for this Turn.</div>;
  return <div><div className="flex h-3 overflow-hidden rounded-full bg-[var(--bg-3)]">{positive.map((segment) => <div key={segment.label} title={`${segment.label}: ${segment.value}`} style={{ width: `${(segment.value / total) * 100}%`, background: colors[segment.tone] }} />)}</div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{positive.map((segment) => <span key={segment.label} className="flex items-center gap-1.5 text-[11px] text-text-dimmed"><span className="h-2 w-2 rounded-full" style={{ background: colors[segment.tone] }} />{segment.label} · {segment.value.toLocaleString()}</span>)}</div></div>;
}

export function CodeBlock({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return <div className={`overflow-hidden rounded-lg border border-grid-bright bg-[var(--bg)] ${className}`}>{label && <div className="border-b border-grid-bright px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-text-dimmed">{label}</div>}<pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-text-bright">{children}</pre></div>;
}

export function InspectionRail({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <aside className={`space-y-4 xl:sticky xl:top-4 xl:self-start ${className}`}>{children}</aside>;
}

export function SegmentedControl({ options, value, onChange, label }: { options: Array<{ label: string; value: string }>; value: string; onChange: (value: string) => void; label: string }) {
  return <div role="group" aria-label={label} className="inline-flex rounded-lg border border-grid-bright bg-[var(--bg)] p-0.5">{options.map((option) => <button key={option.value} type="button" onClick={() => onChange(option.value)} aria-pressed={option.value === value} className={`rounded-md px-3 py-1.5 text-xs ${option.value === value ? "bg-background-bright text-text-bright shadow-sm" : "text-text-dimmed"}`}>{option.label}</button>)}</div>;
}
