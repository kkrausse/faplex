import { homedir } from "node:os";

export function relTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Exactly `width` columns: padded (on the left when `right`), or cut with an ellipsis. */
export function fit(s: string, width: number, right = false): string {
  const w = Bun.stringWidth(s);
  if (w <= width) return right ? " ".repeat(width - w) + s : s + " ".repeat(width - w);
  let cut = s.slice(0, Math.max(0, width - 1));
  while (cut && Bun.stringWidth(cut) > width - 1) cut = cut.slice(0, -1);
  return cut + "…";
}

/** How long ago, as a bare duration for a narrow column: `<1m`, `5m`, `2h`, `3d`. */
export function age(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "<1m";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const HOME = homedir();
export function shortPath(p: string | null | undefined, base?: string): string {
  if (!p) return "";
  if (base && p.startsWith(base + "/")) return p.slice(base.length + 1);
  const t = p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
  const parts = t.split("/");
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : t;
}
