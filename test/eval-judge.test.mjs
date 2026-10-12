import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blindedPacket } from "../.groundwork/scripts/evals/judge.mjs";

test("judges retain task evidence and skill-loading facts without instruction variants or model identity", () => {
  const directory = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-blinding-"));
  try {
    writeFileSync(join(directory, "app.mjs"), "export const greeting = 'hello';\n");
    const events = [
      { type: "system.message", data: { content: "private-variant-system-instructions", contentBlocks: [{ text: "private-variant-system-instructions" }] } },
      { type: "hook.start", data: { input: "private-variant-hook-context" } },
      { type: "skill.invoked", data: { name: "implement", path: "/opt/groundwork/skills/implement/SKILL.md", content: "private-variant-rule-one" } },
      { type: "tool.execution_start", data: { toolCallId: "read", arguments: { command: "cat /opt/groundwork/skills/implement/SKILL.md" } } },
      { type: "tool.execution_complete", data: { toolCallId: "read", success: true, output: "private-variant-rule-two" } },
      { type: "tool.execution_start", data: { toolCallId: "verify", arguments: { command: "bun /opt/groundwork/skills/verify-work/verify.mjs verify" } } },
      { type: "tool.execution_complete", data: { toolCallId: "verify", success: true, output: "Fresh process observed the persisted setting" } },
      { type: "opencode.message", data: { type: "skill", skill: "verify-work", text: "private-variant-rule-three" } },
      { type: "opencode.message", data: { type: "assistant", content: [{ type: "tool", name: "skill", state: {
        status: "completed", input: { id: "implement" }, content: [{ type: "text", text: "private-variant-rule-native-v2" }],
      } }, { type: "tool", name: "shell", state: { status: "completed", input: { command: "bun /opt/groundwork/skills/verify-work/verify.mjs verify" },
        content: [{ type: "text", text: "OpenCode fresh process read the saved setting" }] } }] } },
      { type: "assistant.message", data: { content: "GPT-6 Astra inspected app.mjs; Claude Opus 5.5 agreed.", encryptedContent: "opaque-reasoning-payload" } },
    ];
    const packet = blindedPacket({ cases: [{ id: "greeting", prompt: "Explain the greeting.", rubric: ["Source-backed answer"], reference: "The greeting is hello." }],
      models: [{ model: "gpt-6-astra" }], judges: [{ model: "claude-opus-5.5" }], conditions: [] },
    { caseId: "greeting", answer: "app.mjs exports hello.", checks: [], events }, directory, "Assess this task.");
    expect(packet).not.toContain("private-variant-rule");
    expect(packet).not.toContain("private-variant-system");
    expect(packet).not.toContain("private-variant-hook");
    expect(packet).not.toContain("opaque-reasoning-payload");
    expect(packet).not.toContain("GPT-6 Astra");
    expect(packet).not.toContain("Claude Opus 5.5");
    expect(packet).toContain("skill.invoked");
    expect(packet).toContain("implement");
    expect(packet).toContain("export const greeting");
    expect(packet).toContain("Fresh process observed the persisted setting");
    expect(packet).toContain("OpenCode fresh process read the saved setting");
    expect(events[2].data.content).toBe("private-variant-rule-one");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
