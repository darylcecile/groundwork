import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Report, RunDetail, RunSummary } from "./data";
import { fileURL, runStatus, runTitle } from "./data";
import { Checks, checkId, Stages } from "./checks";
import { EvidenceList, FileInspector, type OpenFile } from "./evidence";
import { Outcomes } from "./outcomes";
import { Context, Counts, Empty, formatDate, Icon, Problems, StatusIcon, statusLabel, tone } from "./primitives";

type Tab = "checks" | "outcomes" | "evidence";
const tabs: { id: Tab; label: string }[] = [{ id: "checks", label: "Checks" }, { id: "outcomes", label: "Outcomes" }, { id: "evidence", label: "Evidence" }];

function verdictDescription(summary: RunSummary, report: Report) {
  if (runStatus(summary) === "unfinished") return "No completed result was saved. This does not indicate whether a process is still active.";
  if (report.status === "passed") return report.plan
    ? "The saved assessment passed its selected checks and recorded coverage."
    : "The selected checks passed. No requirement plan was recorded.";
  if (report.status === "failed") return "The saved assessment includes a failure. Review the checks and outcomes below.";
  return "The saved assessment is incomplete or inconclusive. Review its notes, checks, and outcome coverage.";
}

function Verdict({ summary, report }: { summary: RunSummary; report: Report }) {
  const status = runStatus(summary);
  const verified = report.coverage.filter(item => item.status === "verified").length;
  return <section className="panel verdict-panel" aria-label="Saved verdict">
    <div className="verdict-main"><StatusIcon status={status} large /><div><h2 className={`verdict-title tone-${tone(status)}`}>{status === "unfinished" ? "Unfinished run" : `${statusLabel(status)} · saved result`}</h2><p className="verdict-description">{verdictDescription(summary, report)}</p></div></div>
    <Counts checks={summary.checks} />
    {report.coverage.length > 0 && <p className="coverage-summary">{verified} of {report.coverage.length} requirements verified{report.coverage.some(item => item.status === "failed") ? ` · ${report.coverage.filter(item => item.status === "failed").length} failed` : ""}{report.coverage.some(item => item.status === "unverified") ? ` · ${report.coverage.filter(item => item.status === "unverified").length} unverified` : ""}</p>}
    <div className="source-context"><span><Icon name="branch" />{report.source?.revision ? <code title={report.source.revision}>{report.source.revision.slice(0, 10)}</code> : "Source revision not recorded"}</span>
      {report.source && <span>{report.source.dirty ? "Local changes included" : "Clean working tree at capture"}</span>}
      <span className="saved-context">Source and evidence not rechecked</span>
    </div>
  </section>;
}

function Selection({ report }: { report: Report }) {
  const omitted = report.omitted || report.selection?.omitted || [];
  const unmapped = report.selection?.unmappedPaths || [];
  const uncovered = report.selection?.uncoveredBehaviours || [];
  if (!omitted.length && !unmapped.length && !uncovered.length && !report.selection?.reasons) return null;
  return <details className="context-details"><summary>Check selection<Icon name="chevron" /></summary><div className="selection-copy">
    {!!omitted.length && <p><strong>Not selected:</strong> {omitted.join(", ")}</p>}
    {!!unmapped.length && <p><strong>Paths without mapped checks:</strong> {unmapped.join(", ")}</p>}
    {!!uncovered.length && <p><strong>Behaviours without checks:</strong> {uncovered.join(", ")}</p>}
    {report.selection?.reasons && <dl>{Object.entries(report.selection.reasons).map(([name, reasons]) => <div className="selection-reason" key={name}><dt>{name}</dt><dd>{reasons.join(" · ")}</dd></div>)}</dl>}
  </div></details>;
}

export function RunView({ detail, revision }: { detail: RunDetail; revision: number }) {
  const [tab, setTab] = useState<Tab>("checks");
  const [file, setFile] = useState<string | null>(null);
  const [focusedCheck, setFocusedCheck] = useState<string | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const { summary, report, files } = detail;
  const openFile: OpenFile = (path, trigger) => { previewTrigger.current = trigger || null; setFile(path); };
  const closeFile = () => { setFile(null); previewTrigger.current?.focus({ preventScroll: true }); };
  const openCheck = (name: string) => { setTab("checks"); setFile(null); setFocusedCheck(name); };
  useEffect(() => {
    if (!focusedCheck || tab !== "checks") return;
    const element = document.getElementById(checkId(focusedCheck)) as HTMLDetailsElement | null;
    if (element) {
      element.open = true;
      element.querySelector("summary")?.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest" });
    }
    setFocusedCheck(null);
  }, [focusedCheck, tab]);
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next]!.id);
    document.getElementById(`tab-${tabs[next]!.id}`)?.focus();
  }
  return <div className="report-content">
    <header className="run-heading"><div className="run-heading-text"><h1>{runTitle(summary)}</h1><div className="run-meta">
      <span>{summary.kind === "pr" ? "PR verification" : "Local verification"}</span><time dateTime={summary.startedAt || undefined}>{formatDate(summary.startedAt)}</time>
      {summary.storage === "verify" && <span>Legacy storage</span>}
      <code title={summary.id}>{summary.id}</code>
    </div></div><div className="run-actions"><a className="button" href={fileURL(summary, "result.json", undefined, true)} download aria-label="Download saved report"><Icon name="download" /><span>Report</span></a></div></header>
    {!report ? <><Problems title="Report unavailable" problems={detail.problems.length ? detail.problems : [summary.error || "This report could not be read."]} /><div className="panel"><Empty title="No readable report">The saved result is missing or incomplete. Available files can still be inspected below.</Empty></div><div className="mt-6"><EvidenceList files={files} onOpen={openFile} /></div></>
      : <>
        <Verdict summary={summary} report={report} />
        <Problems problems={[...report.problems, ...detail.problems]} />
        <div className="tabs" role="tablist" aria-label="Run details">{tabs.map((item, index) => <button key={item.id} id={`tab-${item.id}`} className="tab" role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => navigateTabs(event, index)}>
          {item.label}<span className="tab-count">{item.id === "checks" ? report.checks.length : item.id === "outcomes" ? report.coverage.length + report.observations.length : files.length}</span>
        </button>)}</div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
          {tab === "checks" && <>{!!report.stages?.length && <section className="panel pr-stages"><h2>Verification stages</h2><Stages stages={report.stages} onOpen={openFile} /></section>}<Checks checks={report.checks} onOpen={openFile} /><Selection report={report} /><Context values={report.context} /></>}
          {tab === "outcomes" && <Outcomes report={report} onOpen={openFile} onCheck={openCheck} />}
          {tab === "evidence" && <EvidenceList files={files} onOpen={openFile} />}
        </div>
      </>}
    {file && <FileInspector run={summary} path={file} files={files} revision={revision} onClose={closeFile} />}
  </div>;
}
