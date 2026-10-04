export type Harness = "claude" | "opencode" | "codex";
export const HARNESSES: readonly Harness[] = ["claude", "opencode", "codex"];

/** done/failed/interrupted are finished runs; idle was never prompted (or has no outcome yet). */
export type Status = "needs" | "working" | "done" | "failed" | "interrupted" | "idle";

/** A latest-response snapshot, not cumulative billed usage. Missing fields mean unavailable. */
export type ContextUsage = { usedTokens: number; limitTokens?: number; measuredAt: number };
export type Subagents = { total: number; active: number; complete: boolean };
/** What is running besides the top level's own turn: subagents if any, else shells. `label` names the first. */
export type Background = { kind: "agent" | "shell"; count: number; label: string };

export type Session = {
  machine: string;
  harness: Harness;
  /** `machine/harness:id` */
  key: string;
  id: string;
  title: string;
  cwd: string;
  /** Native CLI command that takes over the terminal, machine-agnostic; absent when the session can't be opened here. */
  open?: { cmd: string[]; cwd: string };
  /** Why `open` is absent. */
  closedReason?: string;
  status: Status;
  /** Whether a prompt has been sent. Unknown is not treated as an empty draft. */
  prompted?: boolean;
  subagents?: Subagents;
  /** Absent when nothing is, or when the harness doesn't say. Independent of `status`. */
  background?: Background;
  context?: ContextUsage;
  detail: string;
  updatedAt: number;
  model: string;
  /** Archived in the harness itself. */
  archived: boolean;
  /** Something is still running that `stop` would end (a turn, or a Claude process that can wake itself). */
  stoppable: boolean;
};

export const sessionKey = (machine: string, harness: Harness, id: string) => `${machine}/${harness}:${id}`;

/** Live activity overrides stale metadata; an outcome alone doesn't make a known draft used. */
export const hasStarted = (s: Pick<Session, "status" | "prompted">) =>
  s.prompted === true || s.status === "working" || s.status === "needs" || (s.prompted !== false && s.status !== "idle");
export const isUnprompted = (s: Pick<Session, "status" | "prompted">) => s.prompted === false && !hasStarted(s);

/** How to recognize a new session once its source reports it. */
export type Claim = { id: string } | { firstNewIn: string };
