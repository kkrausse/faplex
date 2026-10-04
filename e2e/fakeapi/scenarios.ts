// Canned replies, chosen by the text of the conversation's last user prompt. A scenario is a list
// of steps; the step used is the number of tool results that came back since that prompt, so a
// tool call is step 0 and what the model says after the tool ran (or was denied) is step 1.
// Each scenario is one small story: the prompt it matches, what the model says and the status
// line it ends with belong together, since all three show up on screen.
export type Step =
  /** A plain text answer that ends the turn. */
  | { text: string }
  /** A shell tool call; with default permissions the harness asks before running it (Needs input). `why` is the tool call's description where the harness's shell tool has one. */
  | { shell: string; say?: string; why?: string }
  /** Starts streaming `say`, then keeps the stream open until POST /_control/release?key=<hold>, then sends `text` (if any) and ends the response. */
  | { hold: string; say: string; text?: string };

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
  // --- Held streams (Working), one release key each, so a script can finish exactly one of them.
  {
    name: "migrate",
    match: /migrate the cron jobs/i,
    inputTokens: 17_900,
    detail: "cron jobs moved to systemd timers",
    steps: [{ hold: "migrate", say: "Listing the current crontab entries.", text: "All five cron jobs now run as systemd timers." }],
  },
  {
    // The follow-up that redirects the demo session below, once Codex sends it (it queues a
    // message typed mid-turn; esc sends it at once). The recording leaves it queued, so this only
    // answers when the rig is driven by hand. Listed first: it is matched on the last prompt
    // alone, and must win over "demo" in the same conversation.
    name: "demo-steer",
    match: /20 seconds/i,
    inputTokens: 14_800,
    detail: "20 second GIF recorded",
    steps: [{ hold: "steer", say: "Got it: a GIF, 20 seconds at most. Dropping the narrated video and scripting four short steps instead.", text: "Recorded demo.gif: 20 seconds, four steps." }],
  },
  {
    // Released with nothing more to say: the harness then sends whatever the user typed meanwhile.
    name: "demo",
    match: /cool demo/i,
    inputTokens: 12_300,
    detail: "demo outline drafted",
    steps: [{ hold: "demo", say: "Reading the README to see what is worth showing. Planning a two minute narrated video." }],
  },
  {
    name: "release-notes",
    match: /release notes/i,
    inputTokens: 8_600,
    detail: "release notes drafted",
    steps: [{ hold: "notes", say: "Collecting the commits since v0.1.0.", text: "Release notes for v0.2 are in CHANGELOG.md." }],
  },
  {
    name: "flaky",
    match: /flaky checkout/i,
    inputTokens: 48_200,
    detail: "flaky test fixed: awaited the cart mock",
    steps: [{ hold: "flaky", say: "Reproducing the failure first.", text: "Fixed: the test now awaits the cart mock. 40 runs, 40 passes." }],
  },

  // --- A shell command the harness asks permission for (Needs input).
  {
    name: "clear-build",
    match: /stale build artifacts/i,
    inputTokens: 21_700,
    detail: "build/ cleared and recreated",
    steps: [
      { shell: "rm -rf build && mkdir build", why: "Clear the stale build directory", say: "build/ is full of artifacts from old runs. I'll delete it and recreate it empty." },
      { text: "Done: build/ deleted and recreated empty, so the next build starts clean." },
    ],
  },

  // --- Plain answers (Finished).
  {
    name: "lodash",
    match: /lodash/i,
    inputTokens: 9_300,
    detail: "lodash 4.17.21, lockfile updated",
    steps: [{ text: "Bumped lodash to 4.17.21 and updated the lockfile. Tests pass." }],
  },
  {
    name: "text",
    match: /./,
    inputTokens: 5_000,
    detail: "done",
    steps: [{ text: "Done." }],
  },
];

export const pick = (prompt: string): Scenario => scenarios.find((s) => s.match.test(prompt)) ?? scenarios[scenarios.length - 1]!;

/** Steps past the end repeat the last step, so a conversation always terminates. */
export const stepAt = (s: Scenario, n: number): Step => s.steps[Math.min(n, s.steps.length - 1)]!;
