import { createSignal } from "solid-js";

// Palette from paseo-tui / oc-plugin-session-manager.
export const colors = {
  bg: "#18181b",
  text: "#e4e4e7",
  muted: "#a1a1aa",
  dim: "#71717a",
  surfaceRaised: "#3f3f46",
  border: "#52525b",
  selected: "#fde047",
  selectedText: "#18181b",
  error: "#ef4444",
  permission: "#f59e0b",
  success: "#4ade80",
  claude: "#d97757",
  codex: "#e4e4e7",
  opencode: "#a78bfa",
  "opencode-mini": "#a78bfa",
};

// Per-machine label colors, clear of the harness and status colors.
export const HOST_COLORS = ["#38bdf8", "#f472b6", "#2dd4bf", "#a3e635", "#818cf8", "#fb7185"];

export const providerColor = (p: string) => (colors as Record<string, string>)[p] ?? colors.muted;

/** Harness names cut to fit a narrow label column. */
export const harnessShort = (h: string) => ({ claude: "clau", opencode: "oc", "opencode-mini": "ocm" } as Record<string, string>)[h] ?? h;

// One shared ticker so every working row spins in step without per-row timers.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const [tick, setTick] = createSignal(0);
setInterval(() => setTick((t) => (t + 1) % FRAMES.length), 80).unref?.();
export const spinner = () => FRAMES[tick()]!;
