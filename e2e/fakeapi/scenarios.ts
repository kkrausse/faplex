// Canned replies, chosen by the text of the conversation's last user prompt. A scenario is a list
// of steps; the step used is the number of tool results that came back since that prompt, so a
// tool call is step 0 and what the model says after the tool ran (or was denied) is step 1.
export type Step =
  /** A plain text answer that ends the turn. */
  | { text: string }
  /** A shell tool call; with default permissions the harness asks before running it (Needs input). */
  | { shell: string; say?: string }
  /** Starts streaming `say`, then keeps the stream open until POST /_control/release?key=<hold>, then sends `text`. */
  | { hold: string; say: string; text: string };

export interface Scenario {
  readonly name: string;
  readonly match: RegExp;
  readonly steps: readonly Step[];
  /** Reported input tokens, so the list's tok column is the same on every run. */
  readonly inputTokens?: number;
  /** One-line status for a finished Claude background job (its job-state classifier asks for one). */
  readonly detail?: string;
}

export const scenarios: readonly Scenario[] = [
  {
    name: "hold",
    match: /dependency audit|flaky checkout|migrate .* to/i,
    inputTokens: 48_200,
    detail: "audit done: 2 packages need a bump",
    steps: [{ hold: "work", say: "Looking at the lockfile first.", text: "Audit finished: 2 packages need a bump." }],
  },
  {
    name: "permission",
    match: /rate limit|clean up|drop the/i,
    inputTokens: 21_700,
    detail: "rate limiting added on public routes",
    steps: [
      { shell: "rm -rf build && mkdir build", say: "I need to clear the build directory before changing anything." },
      { text: "Build directory reset. Rate limiting is in place on the public routes." },
    ],
  },
  {
    name: "text",
    match: /./,
    inputTokens: 9_300,
    detail: "one handler and one test, both passing",
    steps: [{ text: "Done. The change is small: one handler and one test, both passing." }],
  },
];

export const pick = (prompt: string): Scenario => scenarios.find((s) => s.match.test(prompt)) ?? scenarios[scenarios.length - 1]!;

/** Steps past the end repeat the last text step, so a conversation always terminates. */
export const stepAt = (s: Scenario, n: number): Step => s.steps[Math.min(n, s.steps.length - 1)]!;
