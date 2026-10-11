import { catalogue } from "./config.mjs";
import { ensure } from "./model.mjs";

function singleLine(value = "") {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function findFeature(rows, query) {
  const exact = rows.find(row => row.id === query);
  if (exact) return exact;
  const search = query.toLowerCase();
  const matches = rows.filter(row => [row.id, row.description].some(value => value.toLowerCase().includes(search)));
  ensure(matches.length > 0, `Unknown feature "${singleLine(query)}". Run groundwork map to list recorded behaviour IDs.`);
  ensure(matches.length === 1, `Ambiguous feature "${singleLine(query)}". Matching IDs: ${matches.map(row => row.id).join(", ")}. Use an exact behaviour ID.`);
  return matches[0];
}

function links(label, edges, last = true) {
  const branch = last ? "`--" : "+--";
  const indent = last ? "    " : "|   ";
  return [
    `${branch} ${label} (recorded)${edges.length ? "" : ": none recorded"}`,
    ...edges.map((edge, index) => `${indent}${index === edges.length - 1 ? "`--" : "+--"} ${edge}`),
  ];
}

function dependencies(row) {
  return links("Depends on", row.dependsOn.map(id => `[${row.id}] -> [${id}]`));
}

function metadata(row) {
  return [
    `[${row.id}]`,
    `  Description: ${singleLine(row.description)}`,
    `  Entry: ${singleLine(row.entry) || "not recorded"}`,
    `  Implementation paths: ${singleLine(row.paths.join(", ")) || "not mapped"}`,
    `  Covering checks: ${row.checks.join(", ") || "not mapped"}`,
    `  Narrative guide: ${singleLine(row.guide) || "not recorded"}`,
  ];
}

export function renderMap(config, query = "") {
  ensure(typeof query === "string", "Feature query must be a string.");
  const rows = catalogue(config).filter(row => row.type === "behaviour");
  const focus = query.trim() ? findFeature(rows, query.trim()) : null;
  const lines = [
    `Feature map: ${focus ? focus.id : "all behaviours"}`,
    "Recorded direct relationships; checks are listed without running them.",
    "",
  ];
  if (!rows.length) {
    lines.push("No behaviours recorded. Add behaviours to .groundwork/verify.json (or legacy verify.json), then use groundwork map <feature>.");
    return { text: lines.join("\n"), ids: [] };
  }
  let displayed = rows;
  if (focus) {
    const consumers = rows.filter(row => row.dependsOn.includes(focus.id));
    const ids = [...new Set([focus.id, ...consumers.map(row => row.id), ...focus.dependsOn])];
    const byId = new Map(rows.map(row => [row.id, row]));
    displayed = ids.map(id => byId.get(id));
    lines.push(`[${focus.id}]`, ...links("Used by", consumers.map(row => `[${row.id}] -> [${focus.id}]`), false), ...dependencies(focus), "");
  } else {
    for (const row of rows) lines.push(`[${row.id}]`, ...dependencies(row), "");
  }
  lines.push("Recorded feature metadata (paths and guides are relative to the project root):");
  for (const row of displayed) lines.push(...metadata(row), "");
  return { text: lines.join("\n").trimEnd(), ids: displayed.map(row => row.id) };
}
