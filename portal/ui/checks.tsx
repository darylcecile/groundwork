import type { Check, Measurement, Stage, Trial } from "./data";
import { FileLinks, type OpenFile } from "./evidence";
import { ObservationRows } from "./outcomes";
import { Context, duration, Empty, Icon, Problems, Status, StatusIcon } from "./primitives";

export const checkId = (name: string) => `check-${encodeURIComponent(name)}`;

function number(value: number | undefined, unit?: string) {
  if (value === undefined) return "Not recorded";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)}${unit ? ` ${unit}` : ""}`;
}

function budget(metric: Measurement) {
  if (metric.min !== undefined && metric.max !== undefined) return `${number(metric.min)}–${number(metric.max, metric.unit)}`;
  if (metric.max !== undefined) return `≤ ${number(metric.max, metric.unit)}`;
  if (metric.min !== undefined) return `≥ ${number(metric.min, metric.unit)}`;
  return "Not set";
}

function Measurements({ values, comparison = false }: { values: Measurement[]; comparison?: boolean }) {
  if (!values.length) return null;
  return <div className="table-scroll" tabIndex={0} role="region" aria-label={comparison ? "Comparison measurements" : "Recorded measurements"}>
    <table><thead><tr><th scope="col">Measurement</th>{comparison ? <><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Regression / limit</th></> : <><th scope="col">Value</th><th scope="col">Budget</th></>}<th scope="col">Result</th></tr></thead>
      <tbody>{values.map((metric, index) => <tr key={`${metric.name}-${index}`}>
        <td><span>{metric.name}</span>{metric.reason && <p className="metric-reason">{metric.reason}</p>}</td>
        {comparison ? <><td>{number(metric.baseline, metric.unit)}</td><td>{number(metric.candidate, metric.unit)}</td><td>{number(metric.regressionPercent, "%")} / {number(metric.maxRegressionPercent, "%")}</td></>
          : <><td>{number(metric.value, metric.unit)}</td><td>{budget(metric)}</td></>}
        <td>{metric.status ? <Status status={metric.status} /> : <span className="muted">Recorded</span>}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function Stages({ stages, onOpen }: { stages: Stage[]; onOpen: OpenFile }) {
  return <ul className="stage-list">{stages.map((stage, index) => <li key={`${stage.phase}-${index}`}>
    <StatusIcon status={stage.status} /><span className="capitalize">{stage.phase}</span><Status status={stage.status} />
    {stage.durationMs !== undefined && <span className="muted">{duration(stage.durationMs)}</span>}
    {stage.exitCode !== undefined && <span className="muted">{stage.exitCode === null ? "No exit code" : `Exit ${stage.exitCode}`}</span>}
    {stage.log && <button className="file-link" title={stage.log} onClick={event => onOpen(stage.log!, event.currentTarget)}><Icon name="file" />{stage.phase} log</button>}
    {stage.reason && <p className="stage-reason">{stage.reason}</p>}
  </li>)}</ul>;
}

function TrialRow({ trial, onOpen }: { trial: Trial; onOpen: OpenFile }) {
  const measurements = trial.measurements.map(value => ({ ...value, ...trial.metrics.find(metric => metric.name === value.name) }));
  measurements.push(...trial.metrics.filter(metric => !trial.measurements.some(value => value.name === metric.name)));
  return <details className="trial"><summary><span><span className="capitalize">{trial.phase}</span> · trial {trial.index}</span><Status status={trial.status} /><span className="muted">{duration(trial.durationMs)}</span><Icon name="chevron" className="disclosure-chevron" /></summary>
    <div className="trial-body">
      {trial.reason && <p className="detail-copy">{trial.reason}</p>}
      {trial.source?.revision && <p className="check-info">Source <code>{trial.source.revision.slice(0, 10)}</code>{trial.source.dirty ? "with local changes" : "clean working tree"}</p>}
      <Stages stages={trial.stages} onOpen={onOpen} />
      <FileLinks paths={[...(trial.log ? [trial.log] : []), ...trial.artifacts.map(file => file.path)]} onOpen={onOpen} />
      <Measurements values={measurements} />
      <Problems problems={trial.problems} title="Trial notes" />
      {!!trial.observations.length && <details className="context-details"><summary>{trial.observations.length} saved observations<Icon name="chevron" /></summary><ObservationRows observations={trial.observations} onOpen={onOpen} /></details>}
      <Context values={trial.context} label="Trial context" />
    </div>
  </details>;
}

function CheckDetail({ check, onOpen }: { check: Check; onOpen: OpenFile }) {
  const trials = [...check.trials, ...check.baseline];
  return <div className="check-detail">
    <div className="detail-group"><h3 className="detail-label">Expected</h3><p className="detail-copy">{check.expect}</p></div>
    {check.reason && <div className="detail-group"><h3 className="detail-label">Saved result</h3><p className="detail-copy">{check.reason}</p></div>}
    {check.command && <pre className="command">{check.command}</pre>}
    <div className="check-info"><span>{check.exitCode === null ? "No exit code recorded" : `Exit code ${check.exitCode}`}</span>{check.kind && <span><span className="capitalize">{check.kind === "api" ? "API" : check.kind === "ui" ? "UI" : check.kind}</span> check</span>}{!!check.covers.length && <span>Covers {check.covers.join(", ")}</span>}</div>
    <FileLinks paths={[...(check.log ? [check.log] : []), ...check.artifacts.map(file => file.path)]} onOpen={onOpen} />
    <Problems problems={check.problems} title="Check notes" />
    {check.comparison && <div className="comparison"><div className="comparison-heading"><h3>Source comparison</h3><Status status={check.comparison.status} /></div><p className="detail-copy">{check.comparison.reason}</p><Measurements values={check.comparison.measurements} comparison /></div>}
    {!trials.length && <Measurements values={check.measurements} />}
    {!!trials.length && <div className="trial-list"><div className="section-heading"><h3>Trials</h3>{check.trialSummary && <span className="quiet-count">{check.trialSummary.passed} of {check.trialSummary.total} candidate trials passed</span>}</div>{trials.map((trial, index) => <TrialRow key={`${trial.phase}-${trial.index}-${index}`} trial={trial} onOpen={onOpen} />)}</div>}
    {!trials.length && !!check.observations.length && <details className="context-details"><summary>{check.observations.length} saved observations<Icon name="chevron" /></summary><ObservationRows observations={check.observations} onOpen={onOpen} /></details>}
    <Context values={check.context} />
  </div>;
}

export function Checks({ checks, onOpen }: { checks: Check[]; onOpen: OpenFile }) {
  if (!checks.length) return <div className="panel"><Empty title="No check results saved">This report has no recorded check results. Review its notes or observations for more context.</Empty></div>;
  return <div className="panel check-list">{checks.map(check => <details className="check-row" id={checkId(check.name)} key={check.name}>
    <summary><StatusIcon status={check.status} /><span className="check-summary-copy"><span className="check-name">{check.name}</span><span className="check-expect block">{check.expect}</span></span><Status status={check.status} /><span className="check-duration">{duration(check.durationMs)}</span><Icon name="chevron" className="disclosure-chevron" /></summary>
    <CheckDetail check={check} onOpen={onOpen} />
  </details>)}</div>;
}
