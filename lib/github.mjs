import { spawnSync } from "node:child_process";
import { ensure, text } from "./model.mjs";

function response(output) {
  const match = output.match(/^HTTP\/\S+ (\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/);
  const headers = {};
  if (match) {
    for (const line of match[2].split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const body = match ? output.slice(match[0].length) : output;
  let data = null;
  if (body.trim()) {
    try { data = JSON.parse(body); } catch { data = body; }
  }
  return { data, status: match ? Number(match[1]) : null, headers };
}

function gh(args, { cwd = process.cwd(), env = process.env, input } = {}) {
  const result = spawnSync("gh", args, { cwd, env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  const parsed = response(result.stdout || "");
  const status = parsed.status || Number(result.stderr?.match(/\bHTTP (\d+)\b/)?.[1]) || null;
  const detail = result.error?.code === "ENOENT" ? "GitHub CLI (gh) is required for PR commands."
    : result.error?.message || result.stderr?.trim() || parsed.data?.message || `gh exited ${result.status ?? result.signal}`;
  const error = new Error(detail);
  error.status = status;
  error.response = { ...parsed, status };
  throw error;
}

function pullURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Use a PR number or an HTTPS pull request URL."); }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  ensure(url.protocol === "https:" && !url.username && !url.password && match,
    "Use a PR number or an HTTPS pull request URL.");
  return { host: url.host, owner: match[1], repo: match[2], number: Number(match[3]), url: url.href };
}

export function resolvePullRequest(reference, options = {}) {
  if (reference !== undefined) {
    ensure(text(reference), "Use a PR number or an HTTPS pull request URL.");
    if (!/^[1-9]\d*$/.test(reference)) pullURL(reference);
  }
  const raw = gh(["pr", "view", ...(reference === undefined ? [] : [reference]), "--json", "number,headRefOid,url"], options);
  const pull = JSON.parse(raw);
  const target = pullURL(pull.url);
  ensure(Number.isSafeInteger(pull.number) && pull.number === target.number && text(pull.headRefOid),
    "GitHub did not return a valid pull request target.");
  return { ...target, headSha: pull.headRefOid };
}

export function githubAPI(target, options = {}) {
  const args = ["api", "--hostname", target.host];
  return {
    async request(method, path, body) {
      const output = gh([...args, "--method", method, "--include", path,
        ...(body === undefined ? [] : ["--input", "-"])],
      { ...options, ...(body === undefined ? {} : { input: JSON.stringify(body) }) });
      const result = response(output);
      ensure(result.status !== null, "GitHub did not return an HTTP status.");
      return result;
    },
    async paginate(path) {
      const output = gh([...args, "--method", "GET", "--paginate", "--slurp", path], options);
      const pages = JSON.parse(output);
      ensure(Array.isArray(pages) && pages.every(Array.isArray), "GitHub did not return paginated records.");
      return pages.flat();
    },
  };
}
