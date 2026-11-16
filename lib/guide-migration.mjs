import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { markdownAnchors } from "./config.mjs";

export const guideMigrationMarker = "<!-- groundwork:guide-bootstrap -->";
const guideDirectory = ".groundwork/guides";
const bootstrapPath = ".groundwork/VERIFY.md";

function linesOf(content) {
  let offset = 0;
  let fence = null;
  return content.split(/(?<=\n)/).map(raw => {
    const text = raw.replace(/\r?\n$/, "");
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const code = !!fence || !!marker;
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) fence = marker[1];
    const line = { text, start: offset, end: offset + raw.length, code };
    offset += raw.length;
    return line;
  });
}

function codeLines(content) {
  const lists = [];
  let fence = null;
  return linesOf(content).filter(line => {
    const text = line.text.replace(/\t/g, "    ");
    const indent = text.match(/^ */)[0].length;
    if (fence) {
      const marker = text.slice(fence.indent).match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length) fence = null;
      return true;
    }
    if (!text.trim()) return false;
    while (lists.length && indent < lists.at(-1)) lists.pop();
    let base = lists.at(-1) ?? 0;
    if (indent >= base + 4) return true;
    const item = text.match(/^ *(?:[-+*]|\d+[.)]) +/);
    if (item) { base = item[0].length; lists.push(base); }
    const marker = text.slice(base).match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) { fence = { marker: marker[1], indent: base }; return true; }
    return false;
  });
}

function document(content) {
  const lines = linesOf(content);
  const headings = [];
  const anchors = [];
  const definitions = [];
  let previous = null;
  let known = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.code) { previous = null; continue; }
    const atx = line.text.match(/^ {0,3}(#{1,6})(?:[\t ]+|$)(.*?)(?:[\t ]+#+[\t ]*)?$/);
    const setext = previous?.text.trim() && line.text.match(/^ {0,3}(=+|-+)[\t ]*$/);
    const heading = atx ? { start: line.start, end: line.end, level: atx[1].length, title: atx[2] }
      : setext ? { start: previous.start, end: line.end, level: setext[1][0] === "=" ? 1 : 2, title: previous.text.trim() } : null;
    if (heading) headings.push(heading);
    previous = heading ? null : line;
    if (heading || /<[a-z][\w:-]*\b[^>]*>/i.test(line.text)) {
      // Prefixes retain the catalogue's duplicate-heading numbering across split documents.
      const current = markdownAnchors(content.slice(0, line.end));
      for (const anchor of current) if (!known.has(anchor)) anchors.push({ anchor, start: heading?.start ?? line.start });
      known = current;
    }
    if (/^ {0,3}\[(?:\\.|[^\]\\])+\]:/.test(line.text)) {
      let end = index + 1;
      while (end < lines.length && !lines[end].code && /^(?:[\t ]+\S| {0,3}["'(])/.test(lines[end].text)) end++;
      definitions.push({ start: line.start, end: lines[end - 1].end });
    }
  }
  for (const heading of headings) {
    heading.headingStart = heading.start;
    for (let index = lines.findIndex(line => line.start === heading.start) - 1; index >= 0; index--) {
      const line = lines[index];
      if (line.code) break;
      if (!line.text.trim()) continue;
      if (!/^ {0,3}(?:<a\b(?=[^>]*\s(?:id|name)\s*=)[^>]*>\s*(?:<\/a>\s*)?)+$/i.test(line.text)) break;
      heading.start = line.start;
    }
  }
  return { headings, anchors, definitions };
}

function sectionRanges(content, headings, definitions) {
  const ranges = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (heading.level !== 2) continue;
    const end = headings.slice(index + 1).find(next => next.level <= 2)?.start ?? content.length;
    const children = headings.slice(index + 1).filter(next => next.start < end && next.level === 3);
    let introduction = content.slice(heading.end, children[0]?.start ?? end);
    for (const definition of definitions) {
      if (heading.end <= definition.start && definition.end <= (children[0]?.start ?? end)) {
        introduction = introduction.replace(content.slice(definition.start, definition.end), "");
      }
    }
    introduction = introduction.replace(/<!--[\s\S]*?-->/g, "").replace(/<a\b[^>]*>\s*<\/a>/gi, "");
    if (children.length && !introduction.trim()) {
      for (let child = 0; child < children.length; child++) {
        ranges.push({ ...children[child], end: children[child + 1]?.start ?? end });
      }
    } else if (content.slice(heading.end, end).trim()) ranges.push({ ...heading, end });
  }
  return ranges;
}

function slug(title) {
  return title.toLowerCase().replace(/\s*\{#[^{}]+\}\s*$/, "").replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "guide";
}

function reserveNames(root, accept = () => false) {
  const existing = new Map();
  const key = value => value.normalize("NFD").toLowerCase();
  for (const path of [guideDirectory, ".verify/guides"]) {
    try {
      for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
        const files = existing.get(key(entry.name)) ?? [];
        files.push({ name: entry.name, content: entry.isFile() ? readFileSync(join(root, path, entry.name), "utf8") : null });
        existing.set(key(entry.name), files);
      }
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const occupied = new Set();
  const reserve = (name, origin, piece) => {
    const suffix = createHash("sha256").update(origin).digest("hex").slice(0, 8);
    let filename = `${name}.md`;
    for (let attempt = 0; occupied.has(key(filename)) || (existing.get(key(filename)) ?? []).some(file =>
      file.name !== filename || file.content === null || !accept(file.content, `${guideDirectory}/${filename}`, piece)); attempt++) {
      filename = `${name}-${suffix}${attempt ? `-${attempt + 1}` : ""}.md`;
    }
    occupied.add(key(filename));
    return `${guideDirectory}/${filename}`;
  };
  return { reserve, filenames: [...existing.values()].flat().map(file => file.name),
    contents: path => (existing.get(key(posix.basename(path))) ?? []).map(file => file.content),
  };
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function rewriteTarget(value, fromPath, toPath, references, url = true) {
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) return value;
  const match = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!match) return value;
  const [, file, query = "", fragment = ""] = match;
  const target = file ? posix.normalize(posix.join(posix.dirname(fromPath), url ? decode(file.replace(/\\([\\()])/g, "$1")) : file)) : fromPath;
  const anchor = decode(fragment.slice(1));
  const mapped = (fragment && references.get(`${target}#${anchor}`)) || references.get(target);
  if (fromPath === toPath && !mapped) return value;
  const hash = mapped?.indexOf("#") ?? -1;
  const destination = mapped ? (hash < 0 ? mapped : mapped.slice(0, hash)) : target;
  const nextFragment = hash < 0 ? fragment : `#${encodeURIComponent(mapped.slice(hash + 1))}`;
  const path = destination === toPath && (nextFragment || query) ? "" : posix.relative(posix.dirname(toPath), destination) || posix.basename(toPath);
  return `${url ? encodeURI(path).replace(/[?#]/g, character => encodeURIComponent(character)) : path}${query}${nextFragment}`;
}

function destinationAt(content, start) {
  while (/\s/.test(content[start] ?? "") && start < content.length) start++;
  const angle = content[start] === "<";
  if (angle) start++;
  let end = start;
  let depth = 0;
  for (; end < content.length; end++) {
    const character = content[end];
    if (character === "\\") { end++; continue; }
    if (angle) { if (character === ">") break; continue; }
    if (character === "(") depth++;
    else if (character === ")") { if (!depth) break; depth--; }
    else if (/\s/.test(character) && !depth) break;
  }
  return { start, end, angle };
}

/** Rewrite Markdown destinations, leaving fenced/indented code and inline examples intact. */
export function rewriteMarkdown(content, fromPath, toPath, references = new Map()) {
  if (typeof fromPath === "object") ({ from: fromPath, to: toPath } = fromPath);
  toPath ??= fromPath;
  const edits = [];
  const protectedLines = codeLines(content);
  const protectedAt = offset => protectedLines.some(line => line.start <= offset && offset < line.end);
  const replace = (start, end, angle = false) => {
    const before = content.slice(start, end);
    let after = rewriteTarget(before, fromPath, toPath, references);
    if (!angle && after !== before) after = after.replace(/[()]/g, "\\$&");
    if (after !== before) edits.push({ start, end, text: after });
  };
  let brackets = 0;
  for (let index = 0; index < content.length; index++) {
    if (protectedAt(index)) continue;
    if (content[index] === "\\") { index++; continue; }
    if (content[index] === "`") {
      const marker = content.slice(index).match(/^`+/)[0];
      let end = index + marker.length;
      while ((end = content.indexOf(marker, end)) >= 0) {
        if (content[end - 1] !== "`" && content[end + marker.length] !== "`") break;
        end += marker.length;
      }
      index = end < 0 ? index + marker.length - 1 : end + marker.length - 1;
      continue;
    }
    if (content.startsWith("<!--", index)) {
      const end = content.indexOf("-->", index + 4);
      index = end < 0 ? content.length : end + 2;
      continue;
    }
    if (content[index] === "<") {
      const tag = content.slice(index).match(/^<([a-z][\w:-]*)\b[^>]*>/i);
      if (tag) {
        if (/^(pre|code|script|style)$/i.test(tag[1])) {
          const end = content.toLowerCase().indexOf(`</${tag[1].toLowerCase()}>`, index + tag[0].length);
          if (end >= 0) { index = end + tag[1].length + 2; continue; }
        }
        for (const attribute of tag[0].matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
          const value = attribute[1] ?? attribute[2] ?? attribute[3];
          const prefix = attribute[0].match(/^\s(?:href|src)\s*=\s*["']?/i)[0];
          const start = index + attribute.index + prefix.length;
          replace(start, start + value.length, true);
        }
        index += tag[0].length - 1;
        continue;
      }
    }
    if (content[index] === "[") brackets++;
    if (content[index] !== "]" || !brackets) continue;
    brackets--;
    const definition = content[index + 1] === ":" && /^ {0,3}\[[^\n]*$/.test(content.slice(content.lastIndexOf("\n", index) + 1, index));
    if (definition && content[content.lastIndexOf("[", index) + 1] === "^") continue;
    if (content[index + 1] !== "(" && !definition) continue;
    const destination = destinationAt(content, index + 2);
    replace(destination.start, destination.end, destination.angle);
    index = destination.end - 1;
  }
  let result = content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function renderPiece(piece, references) {
  let content = piece.spans.map(span => piece.source.content.slice(span.start, span.end)).join("");
  const anchors = document(content).anchors;
  const aliases = [];
  for (const original of piece.parsed.anchors) {
    let start = 0;
    for (const span of piece.spans) {
      if (span.start <= original.start && original.start < span.end) {
        start += original.start - span.start;
        if (!anchors.some(anchor => anchor.anchor === original.anchor && anchor.start === start)) aliases.push({ anchor: original.anchor, start });
        break;
      }
      start += span.end - span.start;
    }
  }
  for (const alias of aliases.reverse()) content = `${content.slice(0, alias.start)}<a id="${alias.anchor}"></a>\n\n${content.slice(alias.start)}`;
  const shared = piece.parsed.definitions.filter(definition => !piece.spans.some(span => span.start <= definition.start && definition.end <= span.end));
  for (const definition of shared) content += `\n${piece.source.content.slice(definition.start, definition.end)}`;
  content = rewriteMarkdown(content || "# Project context\n", piece.source.path, piece.path, references);
  if (piece.sections?.length) {
    const links = piece.sections.map(section => {
      const title = section.title.replace(/\s*\{#[^{}]+\}\s*$/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]*>/g, "").replace(/[\[\]]/g, "\\$&").trim();
      const anchor = piece.parsed.anchors.find(anchor => anchor.start === section.headingStart)?.anchor;
      const path = encodeURI(posix.relative(posix.dirname(piece.path), section.path));
      return `- [${title}](${path}${anchor === undefined ? "" : `#${encodeURIComponent(anchor)}`})`;
    });
    content += `${content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n"}## Verification guides\n\n${links.join("\n")}\n`;
  }
  return content;
}

/** Plan authored-guide conversion. Set source.split=false for declared whole-document inputs. */
export function planGuideMigration(root, sources) {
  const writes = new Map();
  const deletes = new Set();
  const references = new Map();
  const pieces = [];
  const documents = [];
  const allocations = [];
  const projectPath = `${guideDirectory}/project.md`;
  const projects = existsSync(join(root, projectPath)) || existsSync(join(root, ".verify/guides/project.md")) ? [projectPath] : [];
  const ordered = sources.map(source => typeof source === "string"
    ? { path: source, content: readFileSync(isAbsolute(source) ? source : join(root, source), "utf8") } : source).map(source => ({ ...source,
    path: posix.normalize(isAbsolute(source.path) ? relative(root, source.path).split(sep).join("/") : source.path),
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const source of ordered) {
    if (source.content.trimStart().startsWith(guideMigrationMarker)) {
      const contexts = [...source.content.matchAll(/\]\((guides\/[^)]+)\)/g)].map(link => `.groundwork/${decode(link[1])}`);
      projects.push(...contexts);
      const suffix = createHash("sha256").update(source.path).digest("hex").slice(0, 8);
      const context = contexts.find(path => new RegExp(`/project-${suffix}(?:-\\d+)?\\.md$`).test(path)) ?? contexts.find(path => path === projectPath);
      if (context && existsSync(join(root, context))) {
        const content = readFileSync(join(root, context), "utf8");
        references.set(source.path, context);
        for (const anchor of markdownAnchors(content)) references.set(`${source.path}#${anchor}`, `${context}#${anchor}`);
        const indexHeading = "\n## Verification guides\n\n";
        const index = content.lastIndexOf(indexHeading);
        if (index >= 0) {
          for (const link of content.slice(index + indexHeading.length).matchAll(/^- \[[^\n]*\]\(([^)#]+)#([^)]+)\)$/gm)) {
            const target = posix.join(posix.dirname(context), decode(link[1]));
            const anchor = decode(link[2]);
            references.set(`${source.path}#${anchor}`, `${target}#${anchor}`);
          }
        }
      }
      continue;
    }
    const parsed = document(source.content);
    if (/(?:^|\/)maps\//.test(source.path)) {
      references.set(source.path, source.path);
      for (const { anchor } of parsed.anchors) references.set(`${source.path}#${anchor}`, `${source.path}#${anchor}`);
      continue;
    }
    const ranges = source.split === false ? [] : sectionRanges(source.content, parsed.headings, parsed.definitions);
    const sections = ranges.map(range => ({ ...range,
      name: slug(range.title), origin: `${source.path}#${parsed.anchors.find(anchor => anchor.start === range.headingStart)?.anchor ?? range.title}`,
      source, spans: [{ start: range.start, end: range.end }], parsed,
    }));
    const project = { name: "project", origin: source.path, source, spans: [], parsed, sections };
    let offset = 0;
    for (const section of sections) {
      project.spans.push({ start: offset, end: section.start });
      pieces.push(section);
      offset = section.end;
    }
    project.spans.push({ start: offset, end: source.content.length });
    pieces.push(project);
    documents.push(project);
    allocations.push(project, ...sections);
    if (source.path !== bootstrapPath) deletes.add(source.path);
  }
  const rewrite = (content, fromPath, toPath) => rewriteMarkdown(content, fromPath, toPath, references);
  function allocate(accept) {
    const names = reserveNames(root, accept);
    for (const piece of allocations) piece.path = names.reserve(piece.name, piece.origin, piece);
    for (const project of documents) {
      references.set(project.source.path, project.path);
      for (const { anchor, start } of project.parsed.anchors) {
        const destination = project.sections.find(section => section.start <= start && start < section.end)?.path ?? project.path;
        references.set(`${project.source.path}#${anchor}`, `${destination}#${anchor}`);
      }
    }
    return names;
  }
  const initialNames = allocate(() => true);
  // Compare links by their source section while recovering siblings' collision-resolved names.
  // Reuse still requires exact rendered bytes after all destinations have been assigned.
  const candidateReferences = new Map();
  for (const piece of allocations) {
    const suffix = createHash("sha256").update(piece.origin).digest("hex").slice(0, 8);
    const base = `${piece.name}-${suffix}`;
    const candidates = initialNames.filenames.filter(name => name === `${piece.name}.md` || name === `${base}.md` ||
      (name.startsWith(`${base}-`) && /^\d+\.md$/.test(name.slice(base.length + 1))));
    for (const path of [piece.path, `${guideDirectory}/${piece.name}.md`, `${guideDirectory}/${base}.md`, ...candidates.map(name => `${guideDirectory}/${name}`)]) {
      if (!candidateReferences.has(path)) candidateReferences.set(path, `${guideDirectory}/origin-${suffix}.md`);
    }
  }
  const shape = (content, path) => rewriteMarkdown(content, path, `${guideDirectory}/shape.md`, candidateReferences);
  for (const piece of pieces) {
    piece.shape = shape(renderPiece(piece, references), piece.path);
  }
  const rejected = new Set();
  while (pieces.length) {
    const names = allocate((content, path, piece) => !rejected.has(path) && shape(content, path) === piece.shape);
    const rendered = new Map(pieces.map(piece => [piece.path, renderPiece(piece, references)]));
    const conflict = pieces.find(piece => names.contents(piece.path).some(content => content !== rendered.get(piece.path)));
    if (conflict) { rejected.add(conflict.path); continue; }
    for (const [path, content] of rendered) writes.set(path, content);
    break;
  }
  projects.push(...documents.map(project => project.path));
  if (!ordered.length && !projects.length) {
    const path = reserveNames(root).reserve("project", bootstrapPath);
    projects.push(path);
    writes.set(path, "# Project context\n\nRecord shared setup, constraints and evidence limits here. Feature journeys belong in their own guides.\n");
  }
  if (projects.length && (pieces.length || !ordered.length)) writes.set(bootstrapPath, `${guideMigrationMarker}\n# Project verification\n\n${[...new Set(projects)].map((path, index) =>
    `[${index ? "Additional project context" : "Project context"}](${posix.relative(".groundwork", path)})`).join(" · ")}\n\n` +
    "Use `groundwork view guide [query]` to discover the relevant behaviours, guides, maps and checks. " +
    "Read the matching documents before changing behaviour, then run the relevant checks with `groundwork verify`.\n\n" +
    "Add feature journeys in `.groundwork/guides/` and feature catalogue entries in `.groundwork/verify.d/`; " +
    "fragments are discovered automatically. Keep subsystem explanations in `.groundwork/maps/`. " +
    "Run commands from the project root.\n");
  return { writes, deletes, references, rewriteMarkdown: rewrite,
    relocate: (reference, { from = "", to = from } = {}) => rewriteTarget(reference, from, to, references, false),
  };
}
