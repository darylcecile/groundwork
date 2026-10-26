import { useState } from "react";

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="muted">Not set</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (value === "") return <span className="muted">Empty</span>;
  return <span className={typeof value === "number" ? "tabular-nums" : undefined}>{String(value)}</span>;
}

function fieldName(key: string) {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

function Branch({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  if (value === null || typeof value !== "object") return <dl className="structured-field"><dt>{label}</dt><dd><Scalar value={value} /></dd></dl>;
  const length = Object.keys(value).length;
  return <div className="structured-branch"><details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{label}</span><span className="muted">{length} {Array.isArray(value) ? "items" : "fields"}</span></summary>
    {open && <StructuredValue value={value} depth={depth + 1} />}
  </details></div>;
}

export function StructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [limit, setLimit] = useState(40);
  if (value === null || typeof value !== "object") return <Scalar value={value} />;
  const entries = Object.entries(value);
  if (!entries.length) return <p className="muted structured-empty">{Array.isArray(value) ? "No items recorded." : "No fields recorded."}</p>;
  return <div className="structured-value">{entries.slice(0, limit).map(([key, child]) =>
    <Branch key={key} label={Array.isArray(value) ? `Item ${Number(key) + 1}` : fieldName(key)} value={child} depth={depth} />
  )}{entries.length > limit && <button className="text-button" onClick={() => setLimit(current => current + 40)}>Show more ({entries.length - limit} remaining)</button>}</div>;
}
