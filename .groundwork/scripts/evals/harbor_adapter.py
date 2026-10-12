"""Pinned Harbor transport. All agent and submitted-code execution stays in Docker."""
import argparse
import asyncio
import importlib.metadata
import json
import shutil
import time
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial


class Options(InstalledAgentOptions):
    request_path: str


class GroundworkAgent(BaseInstalledAgent):
    options_model = Options

    @staticmethod
    def name():
        return "groundwork-native"

    async def install(self, environment):
        request = json.loads(Path(self.options.request_path).read_text())
        actor = Path(request["actorDirectory"])
        await environment.upload_dir(actor / "project", "/workspace")
        await environment.upload_dir(actor / "groundwork", "/opt/groundwork")
        await self.exec_as_root(environment, "chown -R node:node /workspace; mkdir -p /run/credentials; chmod 700 /run/credentials; chown node:node /run/credentials")
        await self.exec_as_agent(environment, "git -C /workspace init -q && git -C /workspace config user.name 'Workspace User' && git -C /workspace config user.email 'workspace@example.invalid' && git -C /workspace add . && git -C /workspace -c commit.gpgsign=false commit -qm 'Initial workspace' --allow-empty")
        await environment.upload_file(Path(request["credentialFile"]), "/run/credentials/native.json")
        await self.exec_as_root(environment, "chown node:node /run/credentials/native.json; chmod 600 /run/credentials/native.json")

    async def run(self, instruction, environment, context):
        request = json.loads(Path(self.options.request_path).read_text())
        remaining = int(request["deadline"] - time.time()) - 40
        if remaining < 1:
            raise TimeoutError("Trial deadline exhausted before native invocation")
        native = {"mode": "actor", "model": request["model"], "models": request["models"],
                  "prompt": instruction, "installSkills": request["installSkills"],
                  "timeoutSeconds": remaining}
        local = Path(request["taskDirectory"]) / "native-request.json"
        local.write_text(json.dumps(native))
        await environment.upload_file(local, "/opt/native-request.json")
        await self.exec_as_agent(environment, "node /opt/tools/native.mjs /opt/native-request.json", timeout_sec=remaining + 25)


GRADER = r"""import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { checkCase } from '/tests/corpus/corpus.mjs';
import { normalizeCapture } from '/opt/tools/native.mjs';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const request = read('/tests/request.json');
let result;
try {
  const capture = read('/logs/agent/capture.json');
  const raw = readFileSync('/logs/agent/raw.jsonl', 'utf8');
  const sessions = request.model.runtime === 'opencode' ? read('/logs/agent/sessions.json') : [];
  const normalized = normalizeCapture({ runtime: request.model.runtime, raw, capture, sessions,
    expectedModel: request.model.model, expectedEffort: request.model.effort, targetSkill: request.skill });
  const sources = read('/logs/agent/source-inventory.json').sources;
  for (const source of ['/workspace', '/logs/agent']) {
    if (!sources[source]) throw new Error('Original source inventory is missing');
    for (const [path, expected] of Object.entries(sources[source])) {
      if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new Error('Invalid source inventory path');
      const actual = createHash('sha256').update(readFileSync(join(source, path))).digest('hex');
      if (actual !== expected) throw new Error('Original source inventory does not match transferred artifacts');
    }
  }
  result = await checkCase(request.caseId, '/workspace', { answer: normalized.answer, events: normalized.events });
} catch (error) {
  result = { success: null, checks: [{ id: 'verifier-input', status: 'inconclusive', observed: String(error.message) }] };
}
writeFileSync('/logs/verifier/grade.json', JSON.stringify(result, null, 2));
writeFileSync('/logs/verifier/reward.json', JSON.stringify({ reward: result.success === true ? 1 : 0 }));
"""


def prepare_task(request):
    directory = Path(request["taskDirectory"])
    (directory / "environment").mkdir(parents=True)
    tests = directory / "tests"
    tests.mkdir()
    shutil.copytree(request["graderDirectory"], tests / "corpus")
    (directory / "instruction.md").write_text(request["prompt"])
    (tests / "request.json").write_text(json.dumps({key: request[key] for key in ("caseId", "skill", "model")}))
    (tests / "grade.mjs").write_text(GRADER)
    (tests / "test.sh").write_text("#!/bin/bash\nset -euo pipefail\nnode /tests/grade.mjs\n")
    config = f'''schema_version = "1.4"
artifacts = [
  {{ source = "/workspace", destination = "workspace" }},
  {{ source = "/logs/agent", destination = "native" }}
]
[agent]
timeout_sec = {max(1, int(request["deadline"] - time.time()) - 30)}
user = "node"
network_mode = "allowlist"
allowed_hosts = ["api.github.com", "api.githubcopilot.com", "*.githubcopilot.com", "copilot-proxy.githubusercontent.com", "models.dev"]
[environment]
docker_image = {json.dumps(request["image"])}
workdir = "/workspace"
cpus = 2
memory_mb = 4096
[verifier]
environment_mode = "separate"
timeout_sec = 30
network_mode = "no-network"
'''
    (directory / "task.toml").write_text(config)


async def run(request_path):
    request = json.loads(request_path.read_text())
    prepare_task(request)
    config = TrialConfig.model_validate({
        "trial_name": request["containerName"], "trials_dir": request["harborDirectory"],
        "task": {"path": request["taskDirectory"]},
        "agent": {"import_path": "harbor_adapter:GroundworkAgent", "model_name": request["model"]["model"],
                    "kwargs": {"request_path": str(request_path), "version": request["model"]["version"]},
                    "override_setup_timeout_sec": 90,
                    "env": {"HOME": "/home/node", "XDG_CONFIG_HOME": "/home/node/.config", "XDG_DATA_HOME": "/home/node/.local/share", "XDG_STATE_HOME": "/home/node/.local/state"}},
        "environment": {"type": "docker", "delete": True},
    })
    trial = await Trial.create(config)
    await trial.run()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("request", nargs="?")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()
    if args.version:
        print(importlib.metadata.version("harbor"))
    elif args.request:
        asyncio.run(run(Path(args.request).resolve()))
    else:
        parser.error("Supply an execution request")
