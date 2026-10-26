import { useState } from "react";
import type { Coverage, Observation, Report } from "./data";
import { FileLinks, type OpenFile } from "./evidence";
import { Empty, Status, StatusIcon } from "./primitives";

export function ObservationRows({ observations, onOpen }: { observations: Observation[]; onOpen: OpenFile }) {
  return <>{observations.map((item, index) => <article className="outcome-row" key={`${item.id}-${index}`}>
    <div className="outcome-title"><StatusIcon status={item.status} /><div><p>{item.observed}</p></div><Status status={item.status} /></div>
    <div className="outcome-content">
      <div className="observation-meta">
        {item.kind && <span>{item.kind === "review" ? "Review" : item.kind === "measurement" ? "Measurement" : "Assertion"}</span>}
        {item.producer && <span>{item.producer === "agent" ? "Agent observation" : "Driver observation"}</span>}
        {item.check && <span>{item.check}{item.trial ? ` · trial ${item.trial}` : ""}</span>}
      </div>
      {!!item.covers?.length && <p className="observation-meta">Covers {item.covers.join(", ")}</p>}
      <FileLinks paths={item.evidence.map(file => file.path)} onOpen={onOpen} />
      {!item.evidence.length && <p className="outcome-reason">No evidence attached to this observation.</p>}
    </div>
  </article>)}</>;
}

function RequirementRow({ item, onOpen, onCheck }: { item: Coverage; onOpen: OpenFile; onCheck: (name: string) => void }) {
  return <article className="outcome-row">
    <div className="outcome-title"><StatusIcon status={item.status} /><div><p className="outcome-id">{item.id}</p><p>{item.expect}</p></div><Status status={item.status} /></div>
    <div className="outcome-content">
      {item.reason && <p className="outcome-reason">{item.reason}</p>}
      {!!item.checks.length && <div className="linked-checks"><span>Checks</span>{item.checks.map(name => <button key={name} onClick={() => onCheck(name)}>{name}</button>)}</div>}
      {!!item.observations.length && <p className="observation-meta">{item.observations.length} linked {item.observations.length === 1 ? "observation" : "observations"}</p>}
      <FileLinks paths={item.evidence} onOpen={onOpen} />
    </div>
  </article>;
}

export function Outcomes({ report, onOpen, onCheck }: { report: Report; onOpen: OpenFile; onCheck: (name: string) => void }) {
  const [status, setStatus] = useState("all");
  const observations = status === "all" ? report.observations : report.observations.filter(item => item.status === status);
  const verified = report.coverage.filter(item => item.status === "verified").length;
  return <>
    <section className="outcome-section">
      <div className="section-heading"><h2>Requirement coverage</h2>{report.coverage.length > 0 && <span className="quiet-count">{verified} of {report.coverage.length} verified</span>}</div>
      <div className="panel">{report.coverage.length
        ? report.coverage.map(item => <RequirementRow key={item.id} item={item} onOpen={onOpen} onCheck={onCheck} />)
        : <Empty title="No requirement plan recorded">This run has no saved requirements to assess. Its checks and observations are available separately.</Empty>}
      </div>
    </section>
    <section className="outcome-section">
      <div className="section-heading"><h2>Observations <span className="quiet-count">{report.observations.length}</span></h2>
        {report.observations.length > 5 && <select className="compact-select" aria-label="Filter observations by status" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="all">All observations</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="inconclusive">Inconclusive</option>
        </select>}
      </div>
      <div className="panel">{observations.length ? <ObservationRows observations={observations} onOpen={onOpen} />
        : <Empty title={report.observations.length ? "No matching observations" : "No observations recorded"}>{report.observations.length ? "Choose another status to see saved observations." : "This run contains no structured assertions, reviews, or measurements. Check logs may still contain useful evidence."}</Empty>}
      </div>
    </section>
  </>;
}
