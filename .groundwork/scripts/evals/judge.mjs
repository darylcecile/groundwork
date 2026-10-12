import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensure, files, digest, writeJSON, checkInventory, concurrent } from "./util.mjs";
import { loadExperiment } from "./experiment.mjs";
import { validateJudgement } from "./report.mjs";

const instructionRead = value => /\/(?:opt\/groundwork\/skills|\.agents\/skills|\.copilot\/skills|\.config\/opencode\/skills)\/[^"\n]*\.md|\/(?:\.agents|\.copilot|\.config\/opencode)\/AGENTS\.md/.test(JSON.stringify(value));

const eventFields = {
  "user.message": ["content", "attachments"],
  "assistant.message": ["content", "toolRequests", "phase"],
  "tool.execution_start": ["toolName", "toolCallId", "arguments"],
  "tool.execution_complete": ["toolCallId", "success", "result", "output", "error"],
  "tool.execution_partial_result": ["toolCallId", "partialOutput", "output", "delta"],
  "tool.execution_progress": ["toolCallId", "progressMessage"],
  "skill.invoked": ["name", "path"],
  "subagent.started": ["toolCallId", "agentName", "agentDisplayName", "agentType", "description"],
  "subagent.completed": ["toolCallId", "agentName", "result", "message"],
  "subagent.failed": ["toolCallId", "agentName", "error", "message"],
  "session.error": ["message", "errorType", "errorCode"],
};

function visibleEvent(event) {
  if (event.type === "opencode.message") {
    const data = event.data;
    if (data?.type === "skill") return { type: event.type, sessionID: event.sessionID, parentID: event.parentID,
      data: { type: "skill", skill: data.skill, text: "[skill instruction body withheld]" } };
    if (!["user", "assistant"].includes(data?.type)) return null;
    return { type: event.type, sessionID: event.sessionID, parentID: event.parentID, data: { type: data.type,
      content: (data.content || []).filter(part => ["text", "tool"].includes(part.type)).map(part => part.type === "text" ?
        { type: "text", text: part.text } : { type: "tool", name: part.name, id: part.id, state: part.state }) } };
  }
  const fields = eventFields[event.type];
  if (!fields) return null;
  const allowed = new Set([...fields, "parentToolCallId"]);
  return { id: event.id, type: event.type, agentId: event.agentId,
    data: Object.fromEntries(Object.entries(event.data || {}).filter(([key]) => allowed.has(key))) };
}

function blindedEvents(events) {
  const values = structuredClone((events || []).map(visibleEvent).filter(Boolean));
  const reads = new Set(values.filter(event => event.type === "tool.execution_start" && instructionRead(event.data?.arguments))
    .map(event => event.data?.toolCallId));
  for (const event of values) {
    const result = event.type === "tool.execution_complete" && event.data?.result;
    if (result && typeof result === "object" && typeof result.content === "string" && result.detailedContent === result.content) {
      delete result.detailedContent;
    }
    if (event.type === "skill.invoked" && event.data) event.data.content = "[skill instruction body withheld]";
    if (event.type === "tool.execution_complete" && reads.has(event.data?.toolCallId)) {
      for (const key of ["result", "output", "content"]) if (key in event.data) event.data[key] = "[instruction read result withheld]";
    }
    if (event.type === "opencode.message" && event.data?.type === "skill") event.data.text = "[skill instruction body withheld]";
    for (const part of Array.isArray(event.data?.content) ? event.data.content : []) {
      if (part.type === "tool" && part.state && (part.name === "skill" || instructionRead(part.state.input))) {
        for (const key of ["output", "result"]) if (key in part.state) part.state[key] = "[instruction read result withheld]";
        if ("content" in part.state) part.state.content = [{ type: "text", text: "[skill instruction body withheld]" }];
      }
    }
  }
  return values;
}

export function blindedPacket(experiment, trial, projectDirectory, instructions) {
  ensure(typeof instructions === "string" && instructions.trim(), "Frozen grading instructions are missing.");
  const task = experiment.cases.find(item => item.id === trial.caseId);
  ensure(task, "Trial has no matching task reference.");
  const source = {};
  for (const path of files(projectDirectory)) {
    if (path.startsWith(".git/") || path.startsWith("node_modules/") || path.startsWith(".groundwork/runs/")) continue;
    const contents = readFileSync(join(projectDirectory, path));
    if (contents.includes(0)) continue;
    source[path] = contents.toString("utf8");
  }
  let packet = JSON.stringify({ request: task.prompt, requirements: task.rubric, reference: task.reference,
    submission: trial.answer, observations: trial.checks, transcript: blindedEvents(trial.events), source });
  const identities = new Set([...experiment.models, ...experiment.judges].flatMap(item => [item.model]));
  for (const condition of experiment.conditions) if (/^[a-f0-9]{40,64}$/i.test(condition.revision || "")) identities.add(condition.revision);
  for (const identity of identities) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("-", "[-\\s]");
    packet = packet.replace(new RegExp(escaped, "gi"), "[identity withheld]");
  }
  const bytes = Buffer.byteLength(packet) + Buffer.byteLength(instructions);
  const maximum = experiment.maxJudgePacketBytes ?? 300000;
  ensure(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 2000000, "Invalid grading packet budget.");
  ensure(bytes <= maximum, `The complete grading packet is ${bytes} bytes, exceeding the ${maximum}-byte budget; this attempt needs a larger-context grading configuration.`);
  return `${instructions}\n${packet}`;
}

export function parseJudgement(output, judge) {
  const text = output.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const value = JSON.parse(text);
  const result = { ...value, judgeId: judge.id, model: judge.model, family: judge.family };
  validateJudgement(result);
  return result;
}

async function judgeLocked(directory, { readTrials, invokeJudge }) {
  const experiment = loadExperiment(directory);
  const instructions = readFileSync(join(directory, "inputs/corpus/rubric.md"), "utf8");
  const trials = readTrials(directory);
  const jobs = [];
  for (const trial of trials) {
    const actor = experiment.models.find(model => model.id === trial.model);
    ensure(actor, "Trial actor does not belong to the frozen experiment.");
    for (const judge of experiment.judges.filter(item => item.family !== actor.family)) jobs.push({ trial, judge });
  }
  // A trial's independent judges share no writable result file until all calls finish.
  const verdicts = new Map(trials.map(trial => [trial.id, []]));
  await concurrent(jobs, experiment.concurrency, async ({ trial, judge }) => {
    const path = join(directory, "trials", trial.id);
    const verdictPath = join(path, `judge-${judge.id}.json`);
    let verdict;
    try {
      ensure(trial.status === "completed" && trial.evidenceValid && trial.artifactHashes && checkInventory(path, trial.artifactHashes), "Complete unchanged execution evidence is unavailable.");
      const prompt = blindedPacket(experiment, trial, join(path, "project"), instructions);
      const packetDigest = digest(prompt);
      if (existsSync(verdictPath)) {
        const saved = JSON.parse(readFileSync(verdictPath, "utf8"));
        ensure(saved.packetDigest === packetDigest && saved.experimentDigest === experiment.digest, "Saved judge input no longer matches this attempt.");
        ensure(saved.verdictDigest === digest(saved.verdict) && saved.responseDigest === digest(readFileSync(join(path, `judge-${judge.id}-response.txt`))),
          "Saved judge evidence changed.");
        validateJudgement(saved.verdict);
        verdict = saved.verdict;
      } else {
        writeFileSync(join(path, `judge-${judge.id}-packet.txt`), prompt);
        const response = await invokeJudge({ judge, prompt, directory: path, timeoutSeconds: experiment.judgeTimeoutSeconds });
        writeFileSync(join(path, `judge-${judge.id}-response.txt`), response.output || "");
        ensure(response.completed, response.error || "The judge did not complete.");
        verdict = parseJudgement(response.output, judge);
        writeJSON(verdictPath, { experimentDigest: experiment.digest, packetDigest, packetBytes: Buffer.byteLength(prompt), verdict,
          verdictDigest: digest(verdict), responseDigest: digest(response.output || "") });
      }
    } catch (error) {
      verdict = { judgeId: judge.id, model: judge.model, family: judge.family, status: "unavailable", reason: error.message };
      writeJSON(join(path, `judge-${judge.id}-error.json`), verdict);
    }
    verdicts.get(trial.id).push(verdict);
  });
  for (const trial of trials) {
    trial.judgements = verdicts.get(trial.id).sort((left, right) => left.judgeId.localeCompare(right.judgeId));
    trial.judgementsDigest = digest(trial.judgements);
    const path = join(directory, "trials", trial.id);
    const evidence = trial.judgements.flatMap(judge => [`judge-${judge.judgeId}.json`, `judge-${judge.judgeId}-packet.txt`,
      `judge-${judge.judgeId}-response.txt`, `judge-${judge.judgeId}-error.json`]).filter(name => existsSync(join(path, name)));
    trial.judgementHashes = Object.fromEntries(evidence.map(name => [name, digest(readFileSync(join(path, name)))]));
    const stored = JSON.parse(readFileSync(join(path, "result.json"), "utf8"));
    writeJSON(join(path, "result.json"), { ...stored, judgements: trial.judgements,
      judgementsDigest: trial.judgementsDigest, judgementHashes: trial.judgementHashes });
  }
  return trials;
}

export async function judgeExperiment(directory, dependencies) {
  const lock = join(directory, "judging.lock");
  let descriptor;
  try { descriptor = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("This run already has a judge process. Confirm it stopped before removing a stale judging.lock.");
    throw error;
  }
  closeSync(descriptor);
  try { return await judgeLocked(directory, dependencies); }
  finally { unlinkSync(lock); }
}
