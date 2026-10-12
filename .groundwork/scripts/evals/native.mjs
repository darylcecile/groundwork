// Runs inside disposable containers. Importing this module only exposes pure decoders.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const pins = { harbor: "0.24.0", copilot: "1.0.95", sdk: "1.0.19", opencode: "2.0.26", bun: "1.3.14" };
export const workspaceContext = "This is an isolated local workspace. Personal skills-repository context is fixed to absent; no personal GitHub skills repository is configured here. Use the already installed skills and tools. Do not download or install additional skills, agents, plugins, or extensions. The local gh command reports this declared context without contacting GitHub. Use native subagents for delegation when the task or applicable skills call for it.";
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const bareModel = value => typeof value === "string" ? value.replace(/^github-copilot\//, "").split("#")[0] : null;
const unique = values => [...new Set(values.filter(Boolean))];
export const modelMatches = (expected, served) => served.length > 0 && served.every(model => bareModel(model) === bareModel(expected));
const writeJSON = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

export function decodeJSONL(text) {
  const events = [], invalid = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") throw new Error("Not an event");
      events.push(value);
    } catch { invalid.push(index + 1); }
  }
  return { events, invalid };
}

function copilotTrace(events) {
  const root = events.filter(event => !event.agentId && !event.data?.parentToolCallId);
  const messages = root.filter(event => event.type === "assistant.message" && !event.data?.toolRequests?.length && event.data?.phase !== "analysis");
  const usages = events.filter(event => event.type === "assistant.usage");
  const rootUsages = root.filter(event => event.type === "assistant.usage" && event.data?.initiator !== "sub-agent" && !["conversation-subagent", "conversation-background", "conversation-compaction", "conversation-sampling"].includes(event.data?.interactionType));
  const starts = events.filter(event => event.type === "subagent.started");
  const finished = new Set(events.filter(event => ["subagent.completed", "subagent.failed"].includes(event.type)).map(event => event.data?.toolCallId));
  const childMessages = events.filter(event => (event.agentId || event.data?.parentToolCallId) && event.type === "assistant.message");
  const gaps = starts.filter(event => !finished.has(event.data?.toolCallId)).map(() => "A native subagent did not finish");
  if (starts.length && !childMessages.length) gaps.push("Child message coverage is unavailable");
  if (starts.length && !usages.some(event => event.agentId || event.data?.parentToolCallId || event.data?.initiator === "sub-agent")) gaps.push("Child usage attribution is unavailable");
  const delegations = starts.map(event => {
    const call = event.data?.toolCallId;
    const matches = item => item.data?.parentToolCallId === call || (event.agentId && item.agentId === event.agentId);
    const child = childMessages.filter(matches), childUsage = usages.filter(matches);
    const requested = events.find(item => item.type === "tool.execution_start" && item.data?.toolCallId === call)?.data?.arguments?.model ?? null;
    const served = unique([...child.map(item => item.data?.model), ...childUsage.map(item => item.data?.model)]);
    if (!child.length) gaps.push(`Child transcript cannot be correlated to ${call}`);
    if (!childUsage.length) gaps.push(`Child usage cannot be correlated to ${call}`);
    if (!served.length || (requested && !modelMatches(requested, served))) gaps.push(`Child served model is missing or differs from its request: ${call}`);
    return { requested, selected: event.data?.model ?? null, served, agentId: event.agentId ?? null, toolCallId: call, finished: finished.has(call) };
  });
  const seenUsage = new Set();
  const measured = usages.filter(event => {
    const key = event.data?.accounting?.usageId || event.data?.apiCallId || event.id;
    if (!key || seenUsage.has(key)) return false;
    seenUsage.add(key); return true;
  });
  const sum = field => measured.length && measured.every(event => finite(event.data?.[field])) ? measured.reduce((total, event) => total + event.data[field], 0) : null;
  return {
    answer: messages.at(-1)?.data?.content || "",
    models: unique([...messages.map(event => event.data?.model), ...rootUsages.map(event => event.data?.model)]),
    efforts: unique(rootUsages.map(event => event.data?.reasoningEffort)),
    loaded: events.filter(event => event.type === "skill.invoked" && event.data?.content).map(event => ({ name: event.data.name, path: event.data.path, agentId: event.agentId ?? null })),
    errors: root.filter(event => event.type === "session.error").map(event => event.data?.message || "Native session error"),
    truncated: rootUsages.some(event => ["length", "content_filter", "error"].includes(event.data?.finishReason)),
    usage: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costUsd: null },
    delegations,
    gaps,
  };
}

function openCodeTrace(sessions, rootID) {
  const root = sessions.find(session => session.info?.id === rootID);
  const messages = root?.messages?.filter(message => message.type === "assistant") || [];
  const all = sessions.flatMap(session => (session.messages || []).map(message => ({ sessionID: session.info?.id, parentID: session.info?.parentID, message })));
  const assistant = all.filter(item => item.message.type === "assistant");
  const skillCalls = assistant.flatMap(({ sessionID, message }) => (message.content || []).filter(part =>
    part.type === "tool" && part.name === "skill" && part.state?.status === "completed" &&
    typeof part.state.input?.id === "string" && part.state.content?.some(item => item.type === "text" && item.text?.trim()))
    .map(part => ({ name: part.state.input.id, sessionID })));
  const final = messages.at(-1);
  const text = final?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") || "";
  const rootModels = messages.map(message => message.model && `${message.model.providerID}/${message.model.id}`);
  const links = assistant.flatMap(({ message }) => message.content?.filter(part => part.type === "tool" && part.name === "subagent").map(part => ({
    requested: part.state?.input?.model ?? null, sessionID: part.state?.metadata?.sessionID ?? null,
    finished: part.state?.status === "completed",
  })) || []);
  const gaps = [];
  if (!root) gaps.push("Root native session export is missing");
  for (const link of links) if (!link.sessionID || !sessions.some(session => session.info?.id === link.sessionID)) gaps.push("Child native session export is missing");
  for (const session of sessions.filter(item => item.info?.id !== rootID)) {
    const last = session.messages?.filter(message => message.type === "assistant").at(-1);
    if (!last?.time?.completed || last.finish !== "stop") gaps.push(`Child completion is unavailable: ${session.info.id}`);
    const requested = links.find(link => link.sessionID === session.info.id)?.requested;
    if (requested && !modelMatches(requested, last?.model ? [`${last.model.providerID}/${last.model.id}`] : [])) gaps.push(`Child served model mismatch: ${session.info.id}`);
  }
  const sum = get => assistant.length && assistant.every(item => finite(get(item.message))) ? assistant.reduce((value, item) => value + get(item.message), 0) : null;
  return {
    answer: text, models: unique(rootModels), efforts: unique(messages.map(message => message.model?.variant)),
    loaded: [...all.filter(item => item.message.type === "skill" && item.message.text).map(item => ({ name: item.message.skill, sessionID: item.sessionID })), ...skillCalls],
    errors: messages.filter(message => message.error || message.finish === "error").map(message => message.error?.message || "Native session error"),
    truncated: !final?.time?.completed || final.finish !== "stop",
    usage: { inputTokens: sum(message => message.tokens ? message.tokens.input + (message.tokens.cache?.read || 0) : null), outputTokens: sum(message => message.tokens?.output), costUsd: null },
    delegations: links.map(link => ({ ...link, served: sessions.find(session => session.info?.id === link.sessionID)?.messages?.find(message => message.type === "assistant")?.model ?? null })), gaps,
  };
}

export function normalizeCapture({ runtime, raw, capture, sessions = [], expectedModel, expectedEffort, targetSkill }) {
  const decoded = decodeJSONL(raw);
  const trace = runtime === "copilot-cli" ? copilotTrace(decoded.events) : openCodeTrace(sessions, capture?.sessionID);
  const served = trace.models.map(bareModel);
  const matching = modelMatches(expectedModel, served);
  const gaps = [...trace.gaps, ...(capture?.traceErrors || [])];
  if (decoded.invalid.length) gaps.push(`Malformed native JSONL on ${decoded.invalid.length} line(s)`);
  if (!matching) gaps.push(served.length ? "Served root model differs from the pinned model" : "Served root model is unavailable");
  const effortMatches = trace.efforts.length && expectedEffort ? trace.efforts.every(effort => effort === expectedEffort) : null;
  if (effortMatches === false) gaps.push("Served root effort differs from the pinned effort");
  if (!trace.answer.trim()) gaps.push("No final root answer");
  const rootError = trace.errors.length || decoded.events.some(event => event.type === "error");
  let status = "completed";
  if (capture?.timedOut) status = "incomplete";
  else if (capture?.error || capture?.traceErrors?.length || rootError || (capture?.exitCode != null && capture.exitCode !== 0)) status = "error";
  else if (capture?.completed !== true || trace.truncated || gaps.length) status = "incomplete";
  const required = targetSkill === "workflow" ? ["explore", "implement", "verify-work"] : [targetSkill];
  const loaded = new Set(trace.loaded.map(item => item.name));
  const activation = required.every(skill => loaded.has(skill)) ? "loaded" : status === "completed" && !gaps.length ? "not-loaded" : "unknown";
  // Deltas are retained in raw.jsonl. Consolidated native payloads form the readable transcript.
  const events = runtime === "copilot-cli" ? decoded.events.filter(event => !event.type.endsWith("_delta") && !event.ephemeral && !["assistant.message_start", "assistant.turn_start", "assistant.turn_end"].includes(event.type)) :
    sessions.flatMap(session => (session.messages || []).map(message => ({ type: "opencode.message", sessionID: session.info.id, parentID: session.info.parentID ?? null, data: message })));
  return { status, timedOut: capture?.timedOut === true, answer: trace.answer, events, usage: trace.usage, activation, loadedSkills: trace.loaded,
    requestedModel: expectedModel, servedModels: trace.models, modelMatches: matching, delegations: trace.delegations,
    requestedEffort: expectedEffort ?? null, servedEfforts: trace.efforts, effortMatches,
    traceComplete: gaps.length === 0, traceGaps: gaps, error: capture?.error || capture?.traceErrors?.[0] || trace.errors[0] || (rootError ? "Native error event" : null) };
}

function processCall(program, args, { input, timeoutMs = 30000, stdoutFile, stderrFile, redact = text => text } = {}) {
  return new Promise((resolveCall, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false, overflow = false;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const receive = (data, isError) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.length > 64 * 1024 * 1024) { overflow = true; kill(); return; }
      if (isError) stderr += data.toString(); else stdout += data.toString();
    };
    child.stdout.on("data", data => receive(data, false)); child.stderr.on("data", data => receive(data, true));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (stdoutFile) writeFileSync(stdoutFile, redact(stdout));
      if (stderrFile) writeFileSync(stderrFile, redact(stderr));
      resolveCall({ code, stdout, stderr, timedOut, overflow });
    });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}

async function checked(program, args, options) {
  const result = await processCall(program, args, options);
  if (result.code !== 0 || result.timedOut || result.overflow) throw new Error(`${program} operation failed${result.timedOut ? " (timeout)" : ""}`);
  return result.stdout;
}

function remainingMs(request) {
  const remaining = request.deadline ? Math.min(request.timeoutSeconds * 1000, request.deadline * 1000 - Date.now()) : request.timeoutSeconds * 1000;
  if (remaining <= 0) throw new Error("Native invocation timed out during setup");
  return remaining;
}

function credentialValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(credentialValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(credentialValues);
  return [];
}

async function openCodeAPI(method, path, data) {
  return JSON.parse(await checked("opencode", ["api", method, path, ...(data ? ["-d", JSON.stringify(data)] : [])]));
}

async function readyOpenCode(models, skills = []) {
  const deadline = Date.now() + 30000;
  let available = [], discovered = [];
  while (Date.now() < deadline) {
    available = (await openCodeAPI("get", "/api/model?location%5Bdirectory%5D=/workspace")).data || [];
    discovered = (await openCodeAPI("get", "/api/skill?location%5Bdirectory%5D=/workspace")).data || [];
    if (models.every(model => available.some(item => item.providerID === "github-copilot" && item.id === bareModel(model.model) && item.variants.some(variant => variant.id === model.effort))) && skills.every(skill => discovered.some(item => item.id === skill))) {
      return { available, discovered };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
  throw new Error("OpenCode model/skill readiness deadline exceeded");
}

function configureOpenCode(request, judge) {
  const path = join(process.env.HOME, ".config/opencode"); mkdirSync(path, { recursive: true });
  const agents = judge ? { judge: { mode: "primary", system: "Answer the supplied request. Do not use tools.", steps: 1, permissions: [{ action: "*", resource: "*", effect: "deny" }] } } :
    { general: { permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } };
  for (const id of ["general", "explore", "compaction", "title", "summary"]) agents[id] = { ...agents[id], model: `github-copilot/${bareModel(request.model.model)}#${request.model.effort}` };
  const config = { "$schema": "https://opencode.ai/config.json", experimental: { subagent_depth: 3 }, agents };
  if (!judge) {
    const guide = join(path, "AGENTS.md");
    const existing = existsSync(guide) ? readFileSync(guide, "utf8") : "";
    writeFileSync(guide, `${existing}\n\n## Workspace context\n\n${workspaceContext}\nAuthorized delegation models: ${(request.models || [request.model]).map(item => `${item.model}#${item.effort}`).join(", ")}.\n`);
  }
  writeJSON(join(path, "opencode.json"), config);
}

async function collectOpenCode(rootID, output) {
  const sessions = [], queue = [rootID], seen = new Set();
  while (queue.length) {
    const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
    if (seen.size > 128) throw new Error("Native session tree exceeds capture limit");
    sessions.push(JSON.parse(await checked("opencode", ["session", "export", id])));
    let cursor;
    do {
      const page = await openCodeAPI("get", `/api/session?parentID=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      queue.push(...page.data.map(item => item.id)); cursor = page.cursor?.next;
    } while (cursor);
  }
  writeJSON(join(output, "sessions.json"), sessions);
  return sessions;
}

async function runOpenCode(request, credential, output, redact) {
  configureOpenCode(request, request.mode === "judge");
  await checked("opencode", ["auth", "import"], { input: JSON.stringify(credential) });
  await openCodeAPI("post", "/api/session", { title: "Workspace", location: { directory: "/workspace" } });
  const requiredSkills = request.mode === "actor" && request.installSkills ? ["explore", "implement", "verify-work"] : [];
  const ready = await readyOpenCode(request.models || [request.model], requiredSkills);
  writeJSON(join(output, "discovery.json"), { version: pins.opencode, skills: ready.discovered.map(item => ({ id: item.id, path: item.path })), models: ready.available.map(item => ({ id: item.id, providerID: item.providerID, variants: item.variants.map(variant => variant.id) })) });
  if (request.mode === "preflight") {
    const agents = (await openCodeAPI("get", "/api/agent?location%5Bdirectory%5D=/workspace")).data;
    const general = agents.find(agent => agent.id === "general");
    if (general?.permissions.findLast(rule => ["*", "subagent"].includes(rule.action) && rule.resource === "*")?.effect !== "allow") throw new Error("OpenCode native subagent permission is unavailable");
    return { completed: true, nativeVersion: pins.opencode, modelReady: true, supportsCrossModel: true, nesting: "configured-depth-3" };
  }
  const model = { providerID: "github-copilot", id: bareModel(request.model.model), variant: request.model.effort };
  const session = (await openCodeAPI("post", "/api/session", { title: "Workspace task", location: { directory: "/workspace" }, model, agent: request.mode === "judge" ? "judge" : "build" })).data;
  const result = await processCall("opencode", ["run", "--auto", "--session", session.id, "--model", `github-copilot/${model.id}#${model.variant}`, "--format", "json", "--thinking", "--", request.prompt], {
    timeoutMs: remainingMs(request), stdoutFile: join(output, "raw.jsonl"), stderrFile: join(output, "stderr.txt"), redact,
  });
  const traceErrors = [];
  if (result.timedOut) await openCodeAPI("post", `/api/session/${session.id}/interrupt`, {}).catch(() => traceErrors.push("Session interrupt was unavailable"));
  try { await collectOpenCode(session.id, output); } catch (error) { traceErrors.push(error.message); }
  return { completed: result.code === 0 && !result.timedOut && !result.overflow, timedOut: result.timedOut, exitCode: result.code, sessionID: session.id,
    error: result.overflow ? "Native output exceeded capture limit" : null, traceErrors };
}

async function runCopilot(request, credential, output, redact) {
  if (JSON.parse(readFileSync("/opt/tools/node_modules/@github/copilot-sdk/package.json", "utf8")).version !== pins.sdk) throw new Error("Unexpected Copilot SDK version");
  const { CopilotClient, RuntimeConnection, approveAll } = await import("@github/copilot-sdk");
  const judge = request.mode === "judge";
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: "/opt/tools/node_modules/.bin/copilot", args: ["--disable-builtin-mcps", "--no-remote", "--secret-env-vars=COPILOT_SDK_AUTH_TOKEN"] }),
    mode: judge ? "empty" : "copilot-cli", workingDirectory: "/workspace", baseDirectory: join(process.env.HOME, ".copilot"), gitHubToken: credential, useLoggedInUser: false, logLevel: "none" });
  let session, timedOut = false, completed = false, error = null;
  const traceErrors = [];
  const approvedModels = new Set((request.models || [request.model]).map(model => bareModel(model.model)));
  const nativeAgents = ["explore", "task", "general-purpose", "code-review", "research", "security-review"];
  let skillCatalog = [];
  const append = event => {
    appendFileSync(join(output, "raw.jsonl"), `${redact(JSON.stringify(event))}\n`);
    if (event.type === "skill.invoked" && !skillCatalog.some(item => item.name === event.data?.name && item.path === event.data?.path)) traceErrors.push("Skill invocation outside the frozen native catalog");
  };
  try {
    await client.start();
    const status = await client.getStatus(), auth = await client.getAuthStatus(), models = await client.listModels();
    if (status.version !== pins.copilot || !auth.isAuthenticated) throw new Error("Pinned Copilot runtime authentication failed");
    for (const model of request.models || [request.model]) if (!models.some(item => item.id === bareModel(model.model))) throw new Error(`Configured model is unavailable: ${model.id}`);
    session = await client.createSession({ model: bareModel(request.model.model), reasoningEffort: request.model.effort, workingDirectory: "/workspace", onPermissionRequest: approveAll,
      enableConfigDiscovery: !judge, enableOnDemandInstructionDiscovery: !judge, skipCustomInstructions: judge,
      enableFileHooks: false, enableSessionStore: false, enableSkills: !judge, memory: { enabled: false }, skipEmbeddingRetrieval: true, remoteSession: "off",
      ...(judge ? { availableTools: [], includedBuiltinSkills: [], systemMessage: { mode: "replace", content: "Answer the supplied assessment request. No tools are available." } } :
        { systemMessage: { mode: "append", content: `${workspaceContext}\nAuthorized delegation model IDs: ${(request.models || [request.model]).map(item => item.model).join(", ")}. When applicable, use these exact IDs for native cross-model delegation.` },
          hooks: { onPreToolUse: input => {
            if (input.toolName !== "task") return;
            const args = input.toolArgs;
            if (!nativeAgents.includes(args?.agent_type) || (args?.model && !approvedModels.has(bareModel(args.model)))) return { permissionDecision: "deny", permissionDecisionReason: "Use a built-in native agent with one of the explicitly authorized model IDs." };
          } } }),
      onEvent: append, streaming: true, includeSubAgentStreamingEvents: true });
    if (!judge) await session.rpc.tools.updateSubagentSettings({ subagents: { maxDepth: 3, maxConcurrency: 2,
      agents: Object.fromEntries(nativeAgents.map(name => [name, { model: bareModel(request.model.model), effortLevel: request.model.effort }])) } });
    const skills = await session.rpc.skills.list();
    skillCatalog = skills.skills || [];
    writeJSON(join(output, "discovery.json"), { version: status.version, skills: skills.skills?.map(item => ({ name: item.name, path: item.path })) || [] });
    if (!judge && request.installSkills && !["explore", "implement", "verify-work"].every(name => skills.skills?.some(item => item.name === name))) throw new Error("Groundwork native skill discovery is incomplete");
    if (request.mode === "preflight") {
      await session.rpc.tools.initializeAndValidate();
      const tools = await session.rpc.tools.getCurrentMetadata();
      if (!tools.tools?.find(tool => tool.name === "task")?.input_schema?.properties?.model) throw new Error("Copilot native cross-model task tool is unavailable");
      return { completed: true, nativeVersion: status.version, sdkVersion: pins.sdk, protocolVersion: status.protocolVersion, authenticated: true, modelReady: true, supportsCrossModel: true, nesting: "depth-3-usage-billing-gated" };
    }
    const response = await session.sendAndWait({ prompt: request.prompt }, remainingMs(request));
    completed = Boolean(response?.data?.content);
  } catch (failure) {
    timedOut = /timeout|timed out/i.test(failure.message); error = timedOut ? null : redact(failure.message);
    if (session) await session.abort().catch(() => traceErrors.push("Session abort was unavailable"));
  } finally {
    if (session) await session.disconnect().catch(() => traceErrors.push("Session disconnect failed"));
    const shutdownErrors = await client.stop().catch(() => [new Error("Runtime shutdown failed")]);
    if (shutdownErrors.length) { traceErrors.push("Runtime shutdown failed"); await client.forceStop().catch(() => {}); }
    const state = join(process.env.HOME, ".copilot/session-state");
    if (existsSync(state)) cpSync(state, join(output, "session-state"), { recursive: true, dereference: false });
  }
  return { completed, timedOut, error, sessionID: session?.sessionId ?? null, traceErrors };
}

function hashTree(directory, redact, prefix = "", hashes = {}) {
  if (!existsSync(directory)) return hashes;
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, file = join(directory, path), info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`Evidence contains an unsupported symbolic link: ${path}`);
    if (info.isDirectory()) hashTree(directory, redact, path, hashes);
    else if (info.isFile()) {
      const bytes = readFileSync(file), safe = Buffer.from(redact(bytes.toString("latin1")), "latin1");
      if (!bytes.equals(safe)) writeFileSync(file, safe);
      hashes[path] = createHash("sha256").update(safe).digest("hex");
    }
  }
  return hashes;
}

export function collectScratch(output, scratchRoot = "/tmp") {
  const omitted = [], destination = join(output, "scratch"); let bytes = 0;
  function copy(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === "opencode") { omitted.push({ path: "/tmp/opencode", reason: "private runtime state; projected sessions captured separately" }); continue; }
      if (path === "node-compile-cache") { omitted.push({ path: "/tmp/node-compile-cache", reason: "Node runtime compilation cache" }); continue; }
      if (/^\.bun-\d+-[a-f0-9]+\.so$/.test(name)) { omitted.push({ path: `/tmp/${path}`, reason: "Bun runtime shared-library cache" }); continue; }
      const source = join(directory, name), info = lstatSync(source), target = join(destination, path);
      if (info.isDirectory()) {
        try { copy(source, path); }
        catch (error) {
          if (error.code !== "EACCES" || info.uid === process.getuid()) throw error;
          omitted.push({ path: `/tmp/${path}`, reason: "non-agent-owned directory" });
        }
      }
      else if (info.isFile()) {
        if (info.uid !== process.getuid()) { omitted.push({ path: `/tmp/${path}`, reason: "non-agent-owned file" }); continue; }
        bytes += info.size; if (bytes > 128 * 1024 * 1024) throw new Error("Scratch evidence exceeds 128 MiB capture bound");
        mkdirSync(dirname(target), { recursive: true }); cpSync(source, target);
      } else omitted.push({ path: `/tmp/${path}`, reason: "non-regular filesystem entry" });
    }
  }
  copy(scratchRoot); return omitted;
}

async function main() {
  if (process.argv[2] === "gh") {
    const args = process.argv.slice(3);
    if (args[0] === "api" && ["user", "/user"].includes(args[1])) { console.log(args.includes("--jq") ? "workspace-user" : '{"login":"workspace-user"}'); return; }
    console.error("No personal skills repository is configured in this workspace; remote GitHub operations are disabled."); process.exitCode = 1; return;
  }
  const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const output = request.output || "/logs/agent"; mkdirSync(output, { recursive: true });
  const credential = JSON.parse(readFileSync("/run/credentials/native.json", "utf8")); rmSync("/run/credentials/native.json");
  const secrets = credentialValues(credential).filter(value => value.length > 20);
  const redact = text => secrets.reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), text);
  let capture;
  try {
    const version = await checked(request.model.runtime === "copilot-cli" ? "copilot" : "opencode", ["--version"]);
    if (version.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1] !== request.model.version) throw new Error("Unexpected native runtime version");
    if ((await checked("bun", ["--version"])).trim() !== pins.bun) throw new Error("Unexpected Bun version");
    if (request.mode === "actor" && request.installSkills) await checked("bun", ["/opt/groundwork/skills/verify-work/verify.mjs", "install"]);
    if (request.mode === "actor") await checked("git", ["config", "--global", "user.name", "Workspace User"]);
    capture = request.model.runtime === "copilot-cli" ? await runCopilot(request, credential, output, redact) : await runOpenCode(request, credential, output, redact);
  } catch (error) {
    const timedOut = /timeout|timed out/i.test(error.message);
    capture = { completed: false, error: timedOut ? null : redact(error.message), timedOut };
  }
  capture.version = 1; capture.runtime = request.model.runtime; capture.requestedModel = request.model.model;
  writeJSON(join(output, "capture.json"), capture);
  try {
    const omitted = request.mode === "actor" ? collectScratch(output) : [];
    const project = hashTree("/workspace", redact);
    const native = hashTree(output, redact);
    writeJSON(join(output, "source-inventory.json"), { version: 1, sources: { "/workspace": project, "/logs/agent": native, "/tmp": hashTree(join(output, "scratch"), redact) },
      captured: ["/workspace", "/logs/agent", "/home/node/.copilot/session-state", "/tmp agent-owned regular files -> /logs/agent/scratch"], omitted, excluded: ["runtime credential database", "runtime caches"] });
  } catch (error) {
    capture.traceErrors = [...(capture.traceErrors || []), error.message]; writeJSON(join(output, "capture.json"), capture);
  }
  if (request.mode === "preflight") console.log(JSON.stringify(capture));
  process.exitCode = capture.completed ? 0 : capture.timedOut ? 124 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Native runtime setup failed; credential-bearing diagnostics withheld."); process.exitCode = 1; });
}
