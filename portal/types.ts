export type Storage = "groundwork" | "verify";
export type Status = "passed" | "failed" | "inconclusive";

export interface Artifact { path: string; sha256?: string }
export interface Source { revision: string | null; fingerprint: string; dirty: boolean }
export interface Requirement { id: string; expect: string; checks: string[]; behaviours: string[] }
export interface Plan { goal: string; requirements: Requirement[] }
export interface Counts { passed: number; failed: number; inconclusive: number; total: number }
export interface Measurement {
  name: string;
  value?: number;
  unit?: string;
  status?: string;
  reason?: string | null;
  min?: number;
  max?: number;
  baseline?: number;
  candidate?: number;
  regressionPercent?: number;
  maxRegressionPercent?: number;
}
export interface Stage {
  phase: string;
  status: string;
  command?: string;
  log?: string;
  exitCode?: number | null;
  durationMs?: number;
  reason?: string | null;
}
export interface Observation {
  id: string;
  covers: string[];
  status: string;
  observed: string;
  kind?: string;
  producer?: string;
  check?: string | null;
  trial?: number | null;
  evidence: Artifact[];
}
export interface Trial {
  index: number;
  phase: string;
  status: string;
  log?: string;
  durationMs?: number;
  exitCode?: number | null;
  reason?: string | null;
  source?: Source;
  stages: Stage[];
  observations: Observation[];
  artifacts: Artifact[];
  measurements: Measurement[];
  metrics: Measurement[];
  problems: string[];
  context?: Record<string, unknown>;
}
export interface Check {
  name: string;
  command: string;
  expect: string;
  status: string;
  log: string;
  durationMs: number;
  exitCode: number | null;
  reason?: string | null;
  kind?: string;
  covers: string[];
  artifacts: Artifact[];
  observations: Observation[];
  trials: Trial[];
  baseline: Trial[];
  measurements: Measurement[];
  problems: string[];
  trialSummary?: Counts;
  comparison?: { status: string; reason: string; measurements: Measurement[] } | null;
  context?: Record<string, unknown>;
}
export interface Coverage {
  id: string;
  expect: string;
  status: string;
  checks: string[];
  observations: string[];
  evidence: string[];
  reason?: string | null;
}
export interface Report {
  status: string;
  source?: Source;
  plan?: Plan | null;
  checks: Check[];
  coverage: Coverage[];
  observations: Observation[];
  problems: string[];
  stages?: Stage[];
  context?: Record<string, unknown>;
  omitted?: string[];
  selection?: {
    names?: string[];
    omitted?: string[];
    unmappedPaths?: string[];
    uncoveredBehaviours?: string[];
    reasons?: Record<string, string[]>;
  };
}
export interface RunSummary {
  id: string;
  projectId?: string;
  storage: Storage;
  kind: "local" | "pr";
  goal: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  checks: Counts;
  error?: string;
}
export interface EvidenceFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  type: "image" | "video" | "audio" | "pdf" | "text" | "file";
}
export interface Project { id: string; name: string; root: string; available: boolean }
export interface ProjectsResponse { projects: Project[]; problems: string[] }
export interface RunsResponse {
  project: { id?: string; name: string; root: string };
  latest: string | null;
  runs: RunSummary[];
  problems: string[];
}
export interface RunResponse {
  summary: RunSummary;
  report: Report | null;
  files: EvidenceFile[];
  problems: string[];
}

export interface CatalogueEntry {
  id: string;
  description: string;
  paths: string[];
  guide?: string;
  checks: string[];
}
export interface Behaviour extends CatalogueEntry {
  entry?: string;
  dependsOn: string[];
  consumers: string[];
}
export interface CatalogueResponse {
  behaviours: Behaviour[];
  invariants: CatalogueEntry[];
  checks: { id: string; expect: string; command: string; kind: string; required: boolean; covers: string[] }[];
  problems: string[];
}
export interface GuideResponse { path: string; content: string }
