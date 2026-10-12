import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root, loadExperiment } from "./experiment.mjs";
import { materializeTrial } from "./workspace.mjs";
import { checkInventory, concurrent, digest, ensure, inventory, readJSON, writeJSON } from "./util.mjs";
import { normalizeCapture, pins, workspaceContext } from "./native.mjs";

const runtimeFiles = [".groundwork/scripts/evals/runtime.mjs", ".groundwork/scripts/evals/native.mjs", ".groundwork/scripts/evals/harbor_adapter.py", ".groundwork/config/evals.Dockerfile",
  ".groundwork/scripts/evals/experiment.mjs", ".groundwork/scripts/evals/workspace.mjs", ".groundwork/scripts/evals/util.mjs"];
const safeID = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const scratch = join(root, ".groundwork/tmp");
const sourceHashes = () => Object.fromEntries([...runtimeFiles].sort().map(path => [path, digest(readFileSync(join(root, path)))]));
const hostEnv = () => ({ ...Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "SSH_AUTH_SOCK", "UV_CACHE_DIR"].filter(key => process.env[key]).map(key => [key, process.env[key]])), PYTHONDONTWRITEBYTECODE: "1" });

function runProcess(program, args, { timeoutMs = 120000, env = hostEnv() } = {}) {
  return new Promise((finish, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false, overflow = false, killer;
    const stop = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); killer = setTimeout(() => stop("SIGKILL"), 10000); }, timeoutMs);
    const receive = (bytes, error) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.length > 64 * 1024 * 1024) { overflow = true; stop("SIGKILL"); return; }
      if (error) stderr += bytes.toString(); else stdout += bytes.toString();
    };
    child.stdout.on("data", bytes => receive(bytes, false)); child.stderr.on("data", bytes => receive(bytes, true));
    child.on("error", error => { clearTimeout(timer); clearTimeout(killer); reject(error); });
    child.on("close", code => { clearTimeout(timer); clearTimeout(killer); finish({ code, stdout, stderr, timedOut, overflow }); });
  });
}

async function checked(program, args, options) {
  const result = await runProcess(program, args, options);
  ensure(result.code === 0 && !result.timedOut && !result.overflow, `${program} failed${result.timedOut ? " (timeout)" : ""}.`);
  return result.stdout.trim();
}

function validateModel(model) {
  ensure(model && ["copilot-cli", "opencode"].includes(model.runtime), "Unsupported native runtime.");
  ensure(model.version === (model.runtime === "copilot-cli" ? pins.copilot : pins.opencode), `Runtime must be pinned to ${model.runtime === "copilot-cli" ? pins.copilot : pins.opencode}.`);
  ensure(safeID(model.id) && typeof model.model === "string" && /^[a-zA-Z0-9./_-]+$/.test(model.model), "Invalid model identity.");
  ensure(!model.model.includes("/") || model.model.startsWith("github-copilot/"), "Only the authenticated GitHub Copilot provider is supported.");
  ensure(["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(model.effort), "Invalid model effort.");
}

async function credential(runtime) {
  if (runtime === "copilot-cli" && process.env.COPILOT_GITHUB_TOKEN?.trim()) return process.env.COPILOT_GITHUB_TOKEN.trim();
  const result = runtime === "copilot-cli" ? await runProcess("gh", ["auth", "token", "--hostname", "github.com"], { timeoutMs: 30000 }) :
    await runProcess("opencode", ["auth", "export", "github-copilot"], { timeoutMs: 30000 });
  ensure(result.code === 0 && !result.timedOut && result.stdout.trim(), `${runtime} credential relay is unavailable; sign in on the host.`);
  if (runtime === "copilot-cli") return result.stdout.trim();
  let entries; try { entries = JSON.parse(result.stdout); } catch { throw new Error("OpenCode credential export was not JSON."); }
  ensure(Array.isArray(entries), "Unsupported OpenCode credential export.");
  const active = entries.filter(entry => entry.integrationID === "github-copilot" && entry.active);
  ensure(active.length === 1, "Select exactly one active GitHub Copilot account in OpenCode.");
  return active;
}

async function ensureImage() {
  const hashes = sourceHashes(), sourceDigest = digest(hashes), tag = `groundwork-evals:${sourceDigest.slice(0, 20)}`;
  let inspected = await runProcess("docker", ["image", "inspect", tag, "--format", "{{json .}}"]);
  if (inspected.code !== 0) {
    mkdirSync(scratch, { recursive: true });
    const context = mkdtempSync(join(scratch, "eval-image-"));
    try {
      cpSync(join(root, ".groundwork/config/evals.Dockerfile"), join(context, "Dockerfile"));
      cpSync(join(root, ".groundwork/scripts/evals/native.mjs"), join(context, "native.mjs"));
      const build = await runProcess("docker", ["build", "--label", `org.groundwork.runtime-digest=${sourceDigest}`, "-t", tag, context], { timeoutMs: 600000 });
      writeFileSync(join(context, "build.log"), `${build.stdout}\n${build.stderr}`);
      ensure(build.code === 0 && !build.timedOut, `Runtime image build failed. Inspect ${join(context, "build.log")}.`);
      inspected = await runProcess("docker", ["image", "inspect", tag, "--format", "{{json .}}"]);
    } finally { /* Build logs are retained as inspectable setup evidence. */ }
  }
  ensure(inspected.code === 0, "Runtime image is unavailable.");
  const image = JSON.parse(inspected.stdout);
  ensure(image.Config.Labels?.["org.groundwork.runtime-digest"] === sourceDigest, "Runtime image provenance mismatch.");
  return { image: image.Id, tag, sourceDigest, files: hashes, pins, contextDigest: digest(workspaceContext) };
}

const uvArgs = adapter => ["run", "--no-project", "--python", "3.12", "--with", `harbor==${pins.harbor}`, "python", adapter];

async function removeContainer(name) {
  await runProcess("docker", ["rm", "--force", name], { timeoutMs: 15000 }).catch(() => {});
}

async function nativeContainer(request, output, image, name) {
  const deadline = Date.now() + request.timeoutSeconds * 1000;
  mkdirSync(scratch, { recursive: true }); mkdirSync(output, { recursive: true });
  const privateDir = mkdtempSync(join(scratch, "eval-private-")); chmodSync(privateDir, 0o700);
  const auth = join(privateDir, "credentials"); mkdirSync(auth, { mode: 0o700 });
  let result;
  try {
    writeFileSync(join(auth, "native.json"), JSON.stringify(await credential(request.model.runtime)), { mode: 0o600 });
    writeJSON(join(privateDir, "request.json"), { ...request, deadline: deadline / 1000 });
    result = await runProcess("docker", ["run", "--name", name, "--rm", "--cpus", "2", "--memory", "4g",
      "--mount", `type=bind,source=${auth},target=/run/credentials`,
      "--mount", `type=bind,source=${join(privateDir, "request.json")},target=/opt/native-request.json,readonly`,
      "--mount", `type=bind,source=${resolve(output)},target=/logs/agent`, image,
      "node", "/opt/tools/native.mjs", "/opt/native-request.json"], { timeoutMs: Math.max(1, deadline - Date.now()) });
    // Native code emits no credential contents. Avoid retaining opaque startup diagnostics.
    writeJSON(join(output, "transport.json"), { code: result.code, timedOut: result.timedOut, overflow: result.overflow });
    return result;
  } finally { await removeContainer(name); rmSync(privateDir, { recursive: true, force: true }); }
}

export async function preflight(config) {
  const models = [...config.models, ...config.judges]; models.forEach(validateModel);
  const docker = await checked("docker", ["version", "--format", "{{.Server.Version}}"]);
  const uv = await checked("uv", ["--version"]);
  const version = await checked("uv", [...uvArgs(join(root, ".groundwork/scripts/evals/harbor_adapter.py")), "--version"], { timeoutMs: 180000 });
  ensure(version === pins.harbor, "Unexpected Harbor framework version.");
  const runtime = await ensureImage(), facts = [];
  const capture = JSON.parse(await checked("docker", ["run", "--rm", "--user", "node", "--entrypoint", "node", runtime.image,
    "--input-type=module", "-e", "import {collectScratch} from '/opt/tools/native.mjs'; console.log(JSON.stringify({completed:true,omitted:collectScratch('/logs/agent')}));"]));
  for (const engine of new Set(models.map(model => model.runtime))) {
    const selected = models.filter(model => model.runtime === engine);
    const output = mkdtempSync(join(scratch, "eval-preflight-"));
    await nativeContainer({ mode: "preflight", model: selected[0], models: selected, timeoutSeconds: 60 }, output, runtime.image, `gw-preflight-${digest(output).slice(0, 16)}`);
    const fact = existsSync(join(output, "capture.json")) && readJSON(join(output, "capture.json"));
    ensure(fact?.completed && fact.modelReady, `${engine} auth/model preflight failed; inspect ${output}.`);
    facts.push({ runtime: engine, version: fact.nativeVersion, authenticated: true, modelReady: true, models: [...new Set(selected.map(model => model.model))], nesting: fact.nesting });
  }
  return { harbor: version, docker, uv, image: runtime.image, imageTag: runtime.tag, sourceDigest: runtime.sourceDigest, scratchCapture: capture,
    context: "fixed absent personal skills repository; remote skill acquisition disabled", runtimes: facts, inferenceCalls: 0 };
}

function verifyFrozen(run, experiment) {
  ensure(digest(inventory(join(run, "inputs/corpus"))) === experiment.corpusDigest, "The frozen corpus changed.");
  ensure(digest(inventory(join(run, "inputs/cli"))) === experiment.cli.digest, "The frozen common CLI changed.");
  for (const condition of experiment.conditions.filter(item => item.id !== "none")) ensure(digest(inventory(join(run, "inputs", condition.id))) === condition.digest, "The frozen skill treatment changed.");
  for (const id of experiment.caseIds) ensure(digest(inventory(join(run, "inputs/projects", id))) === digest(experiment.fixtures[id]), "The frozen project fixture changed.");
}

function validateSchedule(schedule, experiment) {
  ensure(Array.isArray(schedule), "Missing execution schedule.");
  const ids = new Set(), tuples = new Set();
  for (const slot of schedule) {
    const tuple = JSON.stringify([slot.caseId, slot.model, slot.condition, slot.attempt]);
    ensure(safeID(slot.id) && !ids.has(slot.id) && !tuples.has(tuple), "Invalid or duplicate scheduled trial.");
    ensure(experiment.caseIds.includes(slot.caseId) && experiment.models.some(model => model.id === slot.model) && experiment.conditions.some(condition => condition.id === slot.condition)
      && Number.isInteger(slot.attempt) && slot.attempt > 0 && slot.attempt <= experiment.attempts, "Scheduled trial is outside the frozen experiment.");
    ids.add(slot.id); tuples.add(tuple);
  }
}

async function freezeRuntime(run, experiment, schedule) {
  const path = join(run, "runtime-lock.json");
  if (existsSync(path)) {
    const lock = readJSON(path);
    ensure(lock.experimentDigest === experiment.digest && lock.scheduleDigest === digest(schedule), "Frozen runtime/schedule identity changed.");
    ensure(digest(lock.files) === digest(sourceHashes()), "Runtime sources changed after execution was frozen. Prepare a new experiment.");
    ensure(digest(inventory(join(run, "inputs/runtime"))) === digest(lock.files), "Frozen runtime source files changed.");
    return lock;
  }
  const runtime = await ensureImage();
  for (const path of runtimeFiles) { mkdirSync(dirname(join(run, "inputs/runtime", path)), { recursive: true }); cpSync(join(root, path), join(run, "inputs/runtime", path)); }
  const lock = { version: 1, ...runtime, experimentDigest: experiment.digest, scheduleDigest: digest(schedule) };
  writeJSON(path, lock); return lock;
}

async function graderFiles(run, destination, caseId) {
  mkdirSync(destination, { recursive: true });
  for (const path of ["corpus.mjs", "checks.mjs", "fixtures.mjs"]) cpSync(join(run, "inputs/corpus", path), join(destination, path));
  // Evaluator-owned modules are hash-checked first. No submitted module executes on the host.
  const { definitions } = await import(pathToFileURL(join(run, "inputs/corpus/cases.mjs")).href);
  const spec = definitions.find(item => item.id === caseId); ensure(spec, "Frozen grader case is missing.");
  const fields = ["id", "fixtureKey", "variant", "probe", "readOnly", "noCommands"];
  const minimal = Object.fromEntries(fields.filter(key => spec[key] !== undefined).map(key => [key, spec[key]]));
  writeFileSync(join(destination, "cases.mjs"), `export const definitions = ${JSON.stringify([minimal])};\n`);
}

async function cleanupHarbor(name) {
  for (const project of [name, `${name}__verifier__trial`]) {
    const containers = await runProcess("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { timeoutMs: 10000 }).catch(() => null);
    const ids = containers?.stdout.trim().split(/\s+/).filter(id => /^[a-f0-9]+$/.test(id)) || [];
    if (ids.length) await runProcess("docker", ["rm", "--force", ...ids], { timeoutMs: 15000 });
  }
}

function readNative(directory, model, skill) {
  const capture = readJSON(join(directory, "capture.json")), raw = readFileSync(join(directory, "raw.jsonl"), "utf8");
  const sessions = model.runtime === "opencode" ? readJSON(join(directory, "sessions.json")) : [];
  return normalizeCapture({ runtime: model.runtime, raw, capture, sessions, expectedModel: model.model, expectedEffort: model.effort, targetSkill: skill });
}

function collectedResult(path, request, transport) {
  const harborPath = join(request.harborDirectory, request.containerName);
  const harbor = existsSync(join(harborPath, "result.json")) ? readJSON(join(harborPath, "result.json")) : null;
  let native = { status: "error", answer: "", events: [], usage: { inputTokens: null, outputTokens: null, costUsd: null }, activation: "unknown", traceComplete: false };
  try { native = readNative(join(harborPath, "agent"), request.model, request.skill); } catch { native.error = "Native completion/transcript files are missing or malformed"; }
  if (transport.timedOut || native.timedOut || harbor?.exception_info?.exception_type === "AgentTimeoutError") native.status = "incomplete";
  else if (native.status !== "incomplete" && (harbor?.exception_info || transport.code !== 0 || transport.overflow)) native.status = "error";
  const gradePath = join(harborPath, "verifier/grade.json");
  const grade = existsSync(gradePath) ? readJSON(gradePath) : { success: null, checks: [{ id: "independent-verifier", status: "inconclusive", observed: "Separate verifier result is unavailable" }] };
  const project = join(harborPath, "artifacts/workspace");
  let sourceValid = false;
  if (existsSync(project)) {
    cpSync(project, join(path, "project"), { recursive: true, dereference: false });
    try {
      const sources = readJSON(join(harborPath, "agent/source-inventory.json")).sources;
      const nativeFiles = inventory(join(harborPath, "agent")); delete nativeFiles["source-inventory.json"];
      sourceValid = digest(inventory(join(path, "project"))) === digest(sources["/workspace"]) && digest(nativeFiles) === digest(sources["/logs/agent"]);
    } catch {}
  }
  return { ...native, checks: grade.checks, success: native.status === "completed" && sourceValid ? grade.success : null,
    evidenceValid: sourceValid && native.traceComplete && harbor?.verifier_environment_mode === "separate",
    harborException: harbor?.exception_info || null, verifierMode: harbor?.verifier_environment_mode || null,
    transport: { code: transport.code, timedOut: transport.timedOut, overflow: transport.overflow } };
}

function resultHashes(path) {
  const hashes = {};
  for (const part of ["project", "harbor"]) if (existsSync(join(path, part))) for (const [name, hash] of Object.entries(inventory(join(path, part)))) hashes[`${part}/${name}`] = hash;
  for (const file of ["started.json", "execution.json", "input-inventory.json", "transport.json"]) if (existsSync(join(path, file))) hashes[file] = digest(readFileSync(join(path, file)));
  return hashes;
}

async function executeSlot(run, experiment, slot, runtime) {
  const path = join(run, "trials", slot.id); mkdirSync(path, { recursive: true });
  if (existsSync(join(path, "started.json")) || existsSync(join(path, "result.json"))) {
    if (!existsSync(join(path, "execution.json"))) await cleanupHarbor(`gw-${slot.id.toLowerCase()}`);
    return;
  }
  const start = Date.now(), model = experiment.models.find(item => item.id === slot.model), task = experiment.cases.find(item => item.id === slot.caseId);
  console.log(`Trial: ${model.model} / ${slot.condition} / ${slot.caseId} / attempt ${slot.attempt}`);
  const identity = { version: 1, id: slot.id, experimentDigest: experiment.digest, caseId: slot.caseId, model: slot.model, condition: slot.condition, attempt: slot.attempt };
  writeFileSync(join(path, "started.json"), JSON.stringify({ ...identity, startedAt: new Date(start).toISOString(), runtimeDigest: runtime.sourceDigest, scheduleDigest: runtime.scheduleDigest }), { flag: "wx" });
  let result = { ...identity, status: "incomplete", answer: "", events: [], durationMs: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, activation: "unknown",
    checks: [], success: null, judgements: [], evidenceValid: false, artifactHashes: {} };
  writeJSON(join(path, "result.json"), result);
  const name = `gw-${slot.id.toLowerCase()}`, privateDir = mkdtempSync(join(scratch, "eval-private-")); chmodSync(privateDir, 0o700);
  try {
    const inputs = materializeTrial(run, experiment, slot, join(path, "input")); writeJSON(join(path, "input-inventory.json"), inputs);
    const grader = join(path, "grader"); await graderFiles(run, grader, slot.caseId);
    const authFile = join(privateDir, "native.json"); writeFileSync(authFile, JSON.stringify(await credential(model.runtime)), { mode: 0o600 });
    const request = { actorDirectory: inputs.directory, graderDirectory: grader, credentialFile: authFile, model,
      models: [...experiment.models, ...experiment.judges], installSkills: slot.condition !== "none", prompt: task.prompt, caseId: slot.caseId, skill: task.skill,
      taskDirectory: join(path, "task"), harborDirectory: join(path, "harbor"), image: runtime.image, containerName: name, deadline: start / 1000 + experiment.timeoutSeconds };
    const requestPath = join(privateDir, "request.json"); writeJSON(requestPath, request);
    const adapter = join(run, "inputs/runtime/.groundwork/scripts/evals/harbor_adapter.py");
    const transport = await runProcess("uv", [...uvArgs(adapter), requestPath], { timeoutMs: Math.max(1, experiment.timeoutSeconds * 1000 - (Date.now() - start)) });
    writeJSON(join(path, "transport.json"), { code: transport.code, timedOut: transport.timedOut, overflow: transport.overflow });
    result = { ...result, ...collectedResult(path, request, transport) };
  } catch (error) {
    result.status = Date.now() - start >= experiment.timeoutSeconds * 1000 ? "incomplete" : "error";
    result.error = error.message;
    result.checks = [{ id: "runtime-setup", status: "inconclusive", observed: error.message }];
  } finally {
    await cleanupHarbor(name).catch(() => { result.cleanupError = "Container cleanup failed"; result.evidenceValid = false; });
    rmSync(privateDir, { recursive: true, force: true });
    result.durationMs = Date.now() - start;
    const { artifactHashes, judgements, ...execution } = result;
    writeJSON(join(path, "execution.json"), execution);
    try { result.artifactHashes = resultHashes(path); } catch (error) { result.evidenceValid = false; result.error = error.message; }
    writeJSON(join(path, "result.json"), result);
    console.log(`Recorded: ${result.status}; evidence ${result.evidenceValid ? "complete" : "incomplete"}`);
  }
}

export async function runExperiment(directory) {
  const run = resolve(directory), experiment = loadExperiment(run); verifyFrozen(run, experiment);
  [...experiment.models, ...experiment.judges].forEach(validateModel);
  ensure(Number.isInteger(experiment.concurrency) && experiment.concurrency > 0 && experiment.concurrency <= 8, "Runtime concurrency must be between 1 and 8.");
  ensure(Number.isInteger(experiment.timeoutSeconds) && experiment.timeoutSeconds >= 60 && experiment.timeoutSeconds <= 7200, "Trial deadline must be between 60 and 7200 seconds.");
  const schedule = readJSON(join(run, "schedule.json")); validateSchedule(schedule, experiment);
  const lockPath = join(run, ".runtime-running");
  if (existsSync(lockPath)) {
    const owner = readFileSync(lockPath, "utf8");
    ensure(/^\d+$/.test(owner), "Execution lock is malformed; inspect it before resuming.");
    let live = true;
    try { process.kill(Number(owner), 0); } catch (error) { if (error.code === "ESRCH") live = false; }
    ensure(!live, "Another runtime process owns this experiment.");
    ensure(readFileSync(lockPath, "utf8") === owner, "Execution lock owner changed.");
    rmSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  try {
    const runtime = await freezeRuntime(run, experiment, schedule);
    mkdirSync(scratch, { recursive: true });
    await concurrent(schedule, experiment.concurrency, slot => executeSlot(run, experiment, slot, runtime));
  } finally { rmSync(lockPath, { force: true }); }
  return readTrials(run);
}

export function readTrials(directory, { allowArchived = false } = {}) {
  const run = resolve(directory), experiment = loadExperiment(run, { allowRunnerChanges: allowArchived }), trials = join(run, "trials");
  if (!existsSync(trials)) return [];
  let frozenValid = false;
  try {
    verifyFrozen(run, experiment);
    const lock = readJSON(join(run, "runtime-lock.json"));
    frozenValid = lock.experimentDigest === experiment.digest && lock.scheduleDigest === digest(readJSON(join(run, "schedule.json")))
      && digest(inventory(join(run, "inputs/runtime"))) === digest(lock.files) && digest(lock.files) === lock.sourceDigest;
  } catch {}
  const results = [];
  for (const name of readdirSync(trials).sort()) {
    const path = join(trials, name); if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || !existsSync(join(path, "result.json"))) continue;
    ensure(!lstatSync(join(path, "result.json")).isSymbolicLink(), "Trial result must be an actual local file.");
    const result = readJSON(join(path, "result.json")); let valid = frozenValid && result.experimentDigest === experiment.digest && result.id === name;
    let activation;
    try {
      const { artifactHashes, judgements, judgementsDigest, judgementHashes, ...execution } = result;
      valid &&= Object.keys(artifactHashes || {}).length > 0 && checkInventory(path, artifactHashes) && digest(resultHashes(path)) === digest(artifactHashes);
      valid &&= digest(readJSON(join(path, "execution.json"))) === digest(execution);
      const model = experiment.models.find(item => item.id === result.model), task = experiment.cases.find(item => item.id === result.caseId);
      const native = readNative(join(path, "harbor", `gw-${result.id.toLowerCase()}`, "agent"), model, task.skill);
      valid &&= native.answer === result.answer && digest(native.events) === digest(result.events) && native.modelMatches;
      if (valid) activation = { activation: native.activation, loadedSkills: native.loadedSkills,
        ...(native.activation !== result.activation ? { recordedActivation: result.activation } : {}) };
    } catch { valid = false; }
    results.push({ ...result, ...activation, evidenceValid: result.evidenceValid === true && valid });
  }
  return results;
}

export async function invokeJudge({ judge, prompt, directory, timeoutSeconds }) {
  validateModel(judge); ensure(typeof prompt === "string" && prompt.length > 0, "Judge prompt is empty.");
  ensure(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 1800, "Invalid judge deadline.");
  const output = join(resolve(directory), `judge-${judge.id}-native`); mkdirSync(output, { recursive: true });
  const started = join(output, "started.json"), identity = { model: judge, promptDigest: digest(prompt), timeoutSeconds };
  try {
    if (existsSync(started)) {
      await removeContainer(`gw-judge-${digest(output).slice(0, 20)}`);
      ensure(digest(readJSON(started)) === digest(identity), "Judge invocation identity changed.");
      const saved = readJSON(join(output, "evidence.json"));
      ensure(checkInventory(output, saved), "Saved judge evidence changed.");
    }
    else {
      writeFileSync(started, JSON.stringify(identity), { flag: "wx" });
      const run = dirname(dirname(resolve(directory))), lockPath = join(run, "runtime-lock.json");
      const runtime = existsSync(lockPath) ? await freezeRuntime(run, loadExperiment(run), readJSON(join(run, "schedule.json"))) : await ensureImage();
      writeJSON(join(output, "provenance.json"), runtime);
      await nativeContainer({ mode: "judge", model: judge, prompt, timeoutSeconds }, output, runtime.image, `gw-judge-${digest(output).slice(0, 20)}`);
      writeJSON(join(output, "evidence.json"), inventory(output));
    }
    const normalized = readNative(output, judge, "none");
    const transport = readJSON(join(output, "transport.json"));
    const calls = normalized.events.some(event => event.type === "tool.execution_start" || event.data?.toolRequests?.length || event.data?.content?.some?.(part => part.type === "tool"));
    const completed = normalized.status === "completed" && normalized.modelMatches && !calls && transport.code === 0 && !transport.timedOut && !transport.overflow;
    writeJSON(join(output, "result.json"), { completed, requestedModel: judge.model, servedModels: normalized.servedModels, usage: normalized.usage,
      status: normalized.status, traceGaps: normalized.traceGaps, toolCalls: calls });
    return { completed, output: normalized.answer, ...(completed ? {} : { error: normalized.error || "Judge output, served model, or tools-empty completion could not be established" }) };
  } catch (error) { return { completed: false, output: "", error: error.message }; }
}
