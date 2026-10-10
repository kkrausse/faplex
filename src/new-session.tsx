// New session: pick a machine (rows) and harness (columns) and a start directory, and optionally
// type a first prompt. With a prompt the session starts on it and the list comes back; without
// one the harness opens its own new chat. Combinations whose harness is missing or unsupported are
// greyed out. The choice and each machine's directory are remembered (last-pick.ts).
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";
import type { Harness } from "./session.ts";
import { dirKey, loadRemembered } from "./last-pick.ts";
import { sourceKey, type DashStore } from "./store.ts";
import { colors, providerColor, spinner } from "./theme.ts";

export type Pick = { machine: string; harness: Harness };

export function NewSession(props: {
  store: DashStore;
  active: () => boolean;
  initial?: Pick;
  /** Combinations with an unused new chat ready to reopen. */
  cached: (p: Pick) => boolean;
  onCancel: () => void;
  onPick: (p: Pick, dir: string, prompt?: string) => Promise<void>;
}) {
  const machines = props.store.machines;
  const harnesses = props.store.harnesses;
  const localDir = process.cwd();
  const remembered = loadRemembered().dirs;
  const [mi, setMi] = createSignal(Math.max(0, machines.findIndex((m) => m.id === props.initial?.machine)));
  const [hi, setHi] = createSignal(Math.max(0, harnesses.indexOf(props.initial?.harness!)));
  const [dirs, setDirs] = createSignal<Record<string, string>>(
    Object.fromEntries(machines.map((m) => [m.id, remembered[dirKey(m.id, !!m.ssh)] ?? (m.ssh ? (m.dir ?? "~") : localDir)])),
  );
  // Typing goes to the prompt, so the grid is moved with the arrows only.
  const [prompt, setPrompt] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal("");

  const pick = (): Pick => ({ machine: machines[mi()]!.id, harness: harnesses[hi()]! });
  const problem = (p: Pick) => props.store.state.sources[sourceKey(p.machine, p.harness)]?.problem;
  const unavailable = (p: Pick) => {
    const k = problem(p)?.kind;
    return k === "missing" || k === "unsupported";
  };
  const dir = () => dirs()[pick().machine] ?? "~";

  async function start() {
    const p = pick();
    if (unavailable(p)) return setError(`${p.harness} on ${p.machine}: ${problem(p)!.message}`);
    setStarting(true);
    setError("");
    try {
      await props.onPick(p, dir(), prompt().trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setStarting(false);
  }

  useKeyboard((key) => {
    if (!props.active() || key.defaultPrevented || starting()) return;
    if (editing()) {
      if (key.name === "escape" || key.name === "tab") {
        key.preventDefault();
        setEditing(false);
      } else if (key.name === "return") {
        setEditing(false);
        start();
      }
      return;
    }
    const n = machines.length;
    // Keys taken here are kept from the prompt's input.
    const take = () => key.preventDefault();
    if (key.name === "up") take(), setMi((i) => (i + n - 1) % n);
    else if (key.name === "down") take(), setMi((i) => (i + 1) % n);
    // With text in the prompt, ← → move its cursor instead.
    else if (key.name === "right" && !prompt()) take(), setHi((i) => Math.min(harnesses.length - 1, i + 1));
    else if (key.name === "left" && !prompt()) take(), hi() === 0 ? props.onCancel() : setHi((i) => i - 1);
    else if (key.name === "tab") take(), setEditing(true);
    else if (key.name === "return") take(), start();
    else if (key.name === "escape") take(), prompt() ? setPrompt("") : props.onCancel();
  });

  const width = Math.max(...machines.map((m) => m.id.length)) + 2;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg} paddingLeft={1}>
      <text height={1} fg={colors.text} attributes={TextAttributes.BOLD}>New session</text>
      <box height={1} />
      <For each={machines}>
        {(m, r) => (
          <box height={1} flexDirection="row">
            <text fg={mi() === r() ? colors.selected : colors.dim}>{mi() === r() ? "❯ " : "  "}</text>
            <text fg={props.store.hostColor(m.id)} attributes={mi() === r() ? TextAttributes.BOLD : undefined}>{m.id.padEnd(width)}</text>
            <For each={harnesses}>
              {(h, c) => {
                const p = { machine: m.id, harness: h };
                const on = () => mi() === r() && hi() === c();
                return (
                  <text
                    fg={unavailable(p) ? colors.border : on() ? colors.selectedText : providerColor(h)}
                    bg={on() ? (unavailable(p) ? colors.surfaceRaised : colors.selected) : undefined}
                    attributes={on() ? TextAttributes.BOLD : undefined}
                  >
                    {` ${h}${props.cached(p) ? " ·ready" : ""} `}
                  </text>
                );
              }}
            </For>
          </box>
        )}
      </For>
      <box height={1} />
      <box height={1} flexDirection="row">
        <text fg={editing() ? colors.selected : colors.muted}>{"dir  "}</text>
        <Show when={editing()} fallback={<text fg={colors.text}>{dir()}</text>}>
          <input
            focused
            flexGrow={1}
            value={dir()}
            onInput={(v: string) => setDirs({ ...dirs(), [pick().machine]: v })}
            focusedBackgroundColor={colors.surfaceRaised}
            backgroundColor={colors.bg}
            textColor={colors.text}
          />
        </Show>
      </box>
      <box height={1} />
      <box height={1} flexDirection="row">
        <text fg={editing() ? colors.muted : colors.selected}>{"❯ "}</text>
        <Show when={!editing()} fallback={<text fg={colors.dim}>{prompt()}</text>}>
          <input
            // Focused a tick late, or the key that opened the picker would be typed into it.
            ref={(el: { focus: () => void }) => queueMicrotask(() => el.focus())}
            flexGrow={1}
            value={prompt()}
            onInput={(v: string) => setPrompt(v)}
            placeholder="type a first prompt, or ⏎ for an empty chat"
            focusedBackgroundColor={colors.bg}
            backgroundColor={colors.bg}
            textColor={colors.text}
          />
        </Show>
      </box>
      <Show when={problem(pick())}>
        <text height={1} fg={colors.dim}>{`${pick().machine}·${pick().harness}: ${problem(pick())!.message}`}</text>
      </Show>
      <Show when={error()}>
        <text fg={colors.error}>{error()}</text>
      </Show>
      <box flexGrow={1} />
      <text height={1} fg={colors.dim} wrapMode="none">
        {starting()
          ? `${spinner()} starting ${pick().harness} on ${pick().machine}…`
          : editing()
            ? "⏎ start here · esc/tab done"
            : prompt()
              ? "⏎ start it on this prompt · ↑↓ machine · tab edit dir · esc clear"
              : "↑↓ machine · ←→ harness · tab edit dir · ⏎ open a new chat · esc back"}
      </text>
    </box>
  );
}
