import type { ReactNode } from "react";
import type { RunSummary } from "./data";
import { StructuredValue } from "./structured";

type IconName = "check" | "cross" | "pause" | "chevron" | "search" | "file" | "image" | "video" | "download" | "branch" | "history" | "refresh" | "arrow" | "folder";
const paths: Record<IconName, ReactNode> = {
  check: <path d="m5 10 3.2 3.2L15 6.5" />,
  cross: <path d="m6.5 6.5 7 7m0-7-7 7" />,
  pause: <><path d="M8 7v6m4-6v6" /></>,
  chevron: <path d="m8 5 5 5-5 5" />,
  search: <><circle cx="8.5" cy="8.5" r="5" /><path d="m12.2 12.2 4 4" /></>,
  file: <><path d="M11.5 2.5h-7v15h11v-11zM11.5 2.5v4h4M7 10h6m-6 3h6" /></>,
  image: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><circle cx="7" cy="7.5" r="1" /><path d="m3 14 5-4 3 2 3-4 3 4" /></>,
  video: <><rect x="2.5" y="4" width="15" height="12" rx="2" /><path d="m8 7 5 3-5 3z" /></>,
  download: <><path d="M10 2.5v10m-4-4 4 4 4-4M3.5 13v4h13v-4" /></>,
  branch: <><circle cx="6" cy="4" r="2" /><circle cx="6" cy="16" r="2" /><circle cx="15" cy="5" r="2" /><path d="M6 6v8m0-4h5a4 4 0 0 0 4-3" /></>,
  history: <><path d="M3 8a7 7 0 1 1 .8 6M3 3v5h5m2-3v5l3 2" /></>,
  refresh: <><path d="M16.5 7A7 7 0 0 0 4 5L2.5 7m0-4v4h4m-3 6A7 7 0 0 0 16 15l1.5-2m-4 0h4v4" /></>,
  arrow: <path d="M4 10h12m-5-5 5 5-5 5" />,
  folder: <path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6A1.5 1.5 0 0 1 17.5 7v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15z" />,
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function tone(status: string) {
  if (["passed", "verified"].includes(status)) return "success";
  if (status === "failed") return "failure";
  if (["inconclusive", "unverified"].includes(status)) return "warning";
  return "neutral";
}

export function statusLabel(status: string) {
  if (!status) return "Not recorded";
  if (["running", "pending", "in_progress"].includes(status)) return "Unfinished";
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export function StatusIcon({ status, large = false }: { status: string; large?: boolean }) {
  const kind = tone(status);
  return <span className={`status-icon tone-${kind}${large ? " status-icon-large" : ""}`} aria-hidden="true">
    <Icon name={kind === "success" ? "check" : kind === "failure" ? "cross" : "pause"} />
  </span>;
}

export function Status({ status }: { status: string }) {
  return <span className={`status-text tone-${tone(status)}`}>{statusLabel(status)}</span>;
}

export function formatDate(value: string | null | undefined, short = false) {
  if (!value) return "Date not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date not recorded";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", ...(short ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit",
  }).format(date);
}

export function duration(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)}m ${Math.round(value % 60000 / 1000)}s`;
}

export function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function Empty({ title, children, heading: Heading = "h2" }: { title: string; children: ReactNode; heading?: "h1" | "h2" }) {
  return <div className="empty-state"><Icon name="folder" /><Heading>{title}</Heading><div>{children}</div></div>;
}

export function Problems({ problems, title = "Saved report notes" }: { problems: string[]; title?: string }) {
  const unique = [...new Set(problems.filter(Boolean))];
  if (!unique.length) return null;
  return <section className="notice" aria-label={title}><h3>{title}</h3><ul>{unique.map((problem, index) => <li key={index}>{problem}</li>)}</ul></section>;
}

export function Context({ values, label = "Recorded context" }: { values?: Record<string, unknown>; label?: string }) {
  if (!values || !Object.keys(values).length) return null;
  return <details className="context-details"><summary>{label}<Icon name="chevron" /></summary>
    <StructuredValue value={values} />
  </details>;
}

export function Counts({ checks }: { checks: RunSummary["checks"] }) {
  return <div className="counts" role="group" aria-label="Check counts">
    <span><i className="count-dot success-dot" />{checks.passed} passed</span>
    <span><i className="count-dot failure-dot" />{checks.failed} failed</span>
    <span><i className="count-dot warning-dot" />{checks.inconclusive} inconclusive</span>
  </div>;
}

export function Loading({ label = "Loading saved run…" }: { label?: string }) {
  return <div className="loading-state" role="status"><span>{label}</span><div /><div /><div /></div>;
}
