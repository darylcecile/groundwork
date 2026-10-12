import { describe, expect, test } from "bun:test";
import { collectScratch, decodeJSONL, modelMatches, normalizeCapture } from "../.groundwork/scripts/evals/native.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Captured from OpenCode 2.0.26 in an offline, credential-free Docker container.
// These fixtures deliberately contain no successful inference or invented paid trace.
const noRoute = { type: "error", timestamp: 1791755009959, sessionID: "ses_ed31440fefferOwQtnQA9Kz7ds",
  error: { type: "provider.no-route", message: "Model unavailable: nonexistent/model" } };
const emptySession = { info: { id: "ses_ed313ddbeffeoyNMY9xwi46V5Q", projectID: "global", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1791755035209, updated: 1791755035209 }, title: "No-model discovery probe", location: { directory: "/workspace" } }, messages: [] };

describe("native runtime evidence", () => {
  test("scratch capture retains observations without copying Bun runtime shared-library caches", () => {
    const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-scratch-"));
    try {
      const source = join(root, "tmp"), output = join(root, "evidence");
      mkdirSync(source); mkdirSync(output);
      writeFileSync(join(source, ".bun-0-ef2365266726f9da.so"), "runtime cache");
      mkdirSync(join(source, "node-compile-cache"));
      writeFileSync(join(source, "node-compile-cache/cache"), "node cache");
      writeFileSync(join(source, "observation.json"), '{"theme":"dark"}');
      const omitted = collectScratch(output, source);
      expect(readFileSync(join(output, "scratch/observation.json"), "utf8")).toBe('{"theme":"dark"}');
      expect(existsSync(join(output, "scratch/.bun-0-ef2365266726f9da.so"))).toBe(false);
      expect(existsSync(join(output, "scratch/node-compile-cache"))).toBe(false);
      expect(omitted).toContainEqual({ path: "/tmp/.bun-0-ef2365266726f9da.so", reason: "Bun runtime shared-library cache" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("keeps the actual error payload and reports corrupt stream lines", () => {
    const { events, invalid } = decodeJSONL(`${JSON.stringify(noRoute)}\nnot-json\n{\"type\":`);
    expect(events).toEqual([noRoute]);
    expect(invalid).toEqual([2, 3]);
  });

  test("a successful process or empty session export cannot fabricate a completed trial", () => {
    const result = normalizeCapture({ runtime: "opencode", raw: "", capture: { completed: true, exitCode: 0, sessionID: emptySession.info.id },
      sessions: [emptySession], expectedModel: "github-copilot/gpt-6-astra", targetSkill: "workflow" });
    expect(result.status).toBe("incomplete");
    expect(result.answer).toBe("");
    expect(result.activation).toBe("unknown");
    expect(result.modelMatches).toBe(false);
    expect(result.usage.inputTokens).toBeNull();
  });

  test("OpenCode completed skill tool calls establish loading without a separate skill message", () => {
    const skill = status => ({ type: "tool", name: "skill", state: { status, input: { id: "implement" },
      content: [{ type: "text", text: "Skill instructions (payload shortened from the observed V2 shape)" }] } });
    const decode = status => normalizeCapture({ runtime: "opencode", raw: "", capture: { completed: true, sessionID: "session" },
      expectedModel: "github-copilot/gpt-6-astra", expectedEffort: "high", targetSkill: "implement", sessions: [{ info: { id: "session" }, messages: [
        { type: "assistant", model: { providerID: "github-copilot", id: "gpt-6-astra", variant: "high" }, time: { completed: 1 }, finish: "stop",
          content: [skill(status), { type: "text", text: "Source-backed explanation." }] },
      ] }] });
    expect(decode("completed").activation).toBe("loaded");
    expect(decode("completed").loadedSkills).toEqual([{ name: "implement", sessionID: "session" }]);
    expect(decode("error").activation).toBe("not-loaded");
  });

  test("preserves native errors even when a completion flag is asserted", () => {
    const result = normalizeCapture({ runtime: "opencode", raw: JSON.stringify(noRoute), capture: { completed: true, exitCode: 0, sessionID: noRoute.sessionID },
      expectedModel: "github-copilot/gpt-6-astra", targetSkill: "explore" });
    expect(result.status).toBe("error");
    expect(result.traceComplete).toBe(false);
    expect(result.activation).toBe("unknown");
  });

  test("timeout remains incomplete, rather than becoming a successful graded result", () => {
    const result = normalizeCapture({ runtime: "opencode", raw: JSON.stringify(noRoute), capture: { completed: false, timedOut: true, exitCode: 124 },
      expectedModel: "github-copilot/gpt-6-astra", targetSkill: "implement" });
    expect(result.status).toBe("incomplete");
    expect(result.answer).toBe("");
  });

  test("capture failures are infrastructure errors rather than incomplete agent work", () => {
    const result = normalizeCapture({ runtime: "copilot-cli", raw: "", capture: { completed: true, traceErrors: ["Scratch evidence capture failed"] },
      expectedModel: "gpt-6-astra", targetSkill: "explore" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("Scratch evidence capture failed");
  });

  test("model attribution requires evidence and rejects a different served model", () => {
    // IDs came from authenticated no-inference model discovery; this is a comparison unit test.
    expect(modelMatches("gpt-6-astra", [])).toBe(false);
    expect(modelMatches("gpt-6-astra", ["claude-opus-5.5"])).toBe(false);
    expect(modelMatches("gpt-6-astra", ["gpt-6-astra", "grok-4.7"])).toBe(false);
  });

  test("Copilot authentication text is not a JSON trajectory or final answer", () => {
    const result = normalizeCapture({ runtime: "copilot-cli", raw: "Error: No authentication information found.\n",
      capture: { completed: false, error: "Authentication unavailable" }, expectedModel: "gpt-6-astra", targetSkill: "verify-work" });
    expect(result.status).toBe("error");
    expect(result.events).toEqual([]);
    expect(result.answer).toBe("");
    expect(result.usage.costUsd).toBeNull();
  });

  test("declared user lookup cannot turn a skills-repository lookup into success", () => {
    const helper = new URL("../.groundwork/scripts/evals/native.mjs", import.meta.url).pathname;
    const user = Bun.spawnSync(["bun", helper, "gh", "api", "user", "--jq", ".login"]);
    const repository = Bun.spawnSync(["bun", helper, "gh", "api", "repos/workspace-user/skills"]);
    expect(user.exitCode).toBe(0);
    expect(user.stdout.toString().trim()).toBe("workspace-user");
    expect(repository.exitCode).toBe(1);
  });
});
