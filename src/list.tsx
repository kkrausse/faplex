// Session list across machines and harnesses, modeled on paseo-tui's list: 1-cell status gutter,
// sections Working → Needs input → Finished → Archived, order within a section frozen while open
// so live updates change badges (and sections) but never shuffle rows. Working is ordered by when
// each session started working, so one you just answered lands at its bottom, next to Needs input.
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { Index, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { Session, Status } from "./session.ts";
import { isUnprompted } from "./session.ts";
import { QUIET } from "./errors.ts";
import type { DashStore } from "./store.ts";
import { colors, harnessShort, providerColor, spinner } from "./theme.ts";
import { age, fit, relTime, shortPath } from "./format.ts";
import { contextCell, subagentCell } from "./metrics.ts";

type Section = "needs" | "finished" | "working" | "archived";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "working", label: "Working" },
  { id: "needs", label: "Needs input" },
  { id: "finished", label: "Finished" },
  { id: "archived", label: "Archived" },
];

// When each session was first seen working (its updatedAt then); outlives list remounts.
const workingSince = new Map<string, number>();
const HEADER_H = 2;
const TITLE_MAX = 40;
const AGE_W = 3;
const GAP = " ";

const sectionOf = (s: Session, archived: boolean): Section =>
  archived ? "archived" : s.status === "needs" ? "needs" : s.status === "working" ? "working" : "finished";

export const label = (s: Pick<Session, "machine" | "harness">) => `${s.machine}·${s.harness}`;

type Item = { header: Section; count: number } | { row: Session; section: Section };

export function SessionList(props: {
  store: DashStore;
  initialSelected?: string;
  flash?: string;
  /** False while a session pane is showing; the list then ignores keys. */
  active: () => boolean;
  /** Sessions with a live embedded client. */
  live: () => ReadonlySet<string>;
  /** Unused new chats; kept out of the list. */
  hidden: () => ReadonlySet<string>;
  /** Rows for used new chats their source hasn't reported yet. */
  extra: () => Session[];
  onOpen: (s: Session) => void;
  onNew: () => void;
  onQuit: () => void;
}) {
  const { state } = props.store;
  const [selected, setSelected] = createSignal(props.initialSelected ?? "");
  const [filter, setFilter] = createSignal("");
  const [filtering, setFiltering] = createSignal(false);
  const [showArchived, setShowArchived] = createSignal(false);
  const [flash, setFlashRaw] = createSignal(props.flash ?? "");
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const setFlash = (m: string) => {
    setFlashRaw(m);
    clearTimeout(flashTimer);
    if (m) flashTimer = setTimeout(() => setFlashRaw(""), 4000);
  };
  if (props.flash) setFlash(props.flash);
  let scroll: ScrollBoxRenderable | undefined;

  const now = Date.now();
  const [timedOut, setTimedOut] = createSignal(false);
  setTimeout(() => setTimedOut(true), 5000);
  // A machine's archive marks come with its Claude loop record, usually after its OpenCode and
  // Codex rows. Until they are here its rows stay off the list, or every archived session would
  // show up in Finished for a moment.
  const marked = (machine: string) => timedOut() || state.marks[machine] !== undefined;
  const all = createMemo(() => [...props.extra(), ...props.store.rows()].filter((s) => !props.hidden().has(s.key) && !isUnprompted(s) && marked(s.machine)));
  const archivedOf = (s: Session) => props.store.archivedOf(s, now);
  const stopping = (s: Session) => !!state.archiving[s.key] && state.archiving[s.key]!.failed === undefined;
  /** The stop error of an archived session that is still running. */
  const stopFailed = (s: Session) => (s.stoppable ? state.archiving[s.key]?.failed : undefined);
  // Ready once every source answered, or after a few seconds so one slow host can't hold the order.
  const ready = () => timedOut() || Object.values(state.sources).every((s) => s.loaded);

  // Frozen once ready; until then rows sort live.
  const frozen = new Map<string, number>();
  const liveOrder = (a: Session, b: Session) => b.updatedAt - a.updatedAt;
  createEffect(() => {
    if (!ready() || frozen.size) return;
    all().slice().sort(liveOrder).forEach((s, i) => frozen.set(s.key, i));
  });
  const order = (a: Session, b: Session) =>
    frozen.size ? (frozen.get(a.key) ?? -1) - (frozen.get(b.key) ?? -1) || liveOrder(a, b) : liveOrder(a, b);
  createEffect(() => {
    const working = new Set<string>();
    for (const s of all())
      if (s.status === "working") {
        working.add(s.key);
        if (!workingSince.has(s.key)) workingSince.set(s.key, s.updatedAt);
      }
    for (const k of workingSince.keys()) if (!working.has(k)) workingSince.delete(k);
  });
  const since = (s: Session) => workingSince.get(s.key) ?? s.updatedAt;
  const workingOrder = (a: Session, b: Session) => since(a) - since(b) || a.key.localeCompare(b.key);

  const view = createMemo(() => {
    const q = filter().toLowerCase();
    const matched = all().filter(
      (s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || label(s).toLowerCase().includes(q),
    );
    const by = new Map<Section, Session[]>(SECTIONS.map((x) => [x.id, []]));
    for (const s of matched) by.get(sectionOf(s, archivedOf(s)))!.push(s);
    const items: Item[] = [];
    const list: Session[] = [];
    for (const { id } of SECTIONS) {
      const rows = by.get(id)!.sort(id === "working" ? workingOrder : order);
      if (!rows.length) continue;
      items.push({ header: id, count: rows.length });
      if (id === "archived" && !showArchived() && !q) continue;
      for (const s of rows) items.push({ row: s, section: id }), list.push(s);
    }
    return { items, list, archivedHidden: !showArchived() && !q ? by.get("archived")!.length : 0, stopFailed: by.get("archived")!.filter((s) => stopFailed(s) !== undefined).length };
  });

  const index = createMemo(() => Math.max(0, view().list.findIndex((s) => s.key === selected())));
  const current = () => view().list[index()];

  createEffect(() => {
    const list = view().list;
    if (ready() && list.length && !list.some((s) => s.key === selected())) setSelected(list[Math.min(index(), list.length - 1)]!.key);
  });
  createEffect(() => {
    let y = 0;
    for (const it of view().items) {
      if ("row" in it && it.row.key === selected()) break;
      y += "row" in it ? 1 : HEADER_H;
    }
    if (!scroll) return;
    const top = scroll.scrollTop, h = scroll.viewport.height;
    if (y < top) scroll.scrollTo(Math.max(0, y - 3));
    else if (y >= top + h - 1) scroll.scrollTo(y - h + 2);
  });

  const move = (d: number) => {
    const list = view().list;
    if (list.length) setSelected(list[Math.min(list.length - 1, Math.max(0, index() + d))]!.key);
  };

  /** Next row in the same section, else the previous one: where selection goes when this row leaves. */
  const neighbor = (s: Session) => {
    const its = view().items.filter((i): i is Extract<Item, { row: Session }> => "row" in i);
    const i = its.findIndex((x) => x.row.key === s.key);
    const sec = its[i]?.section;
    return (its[i + 1]?.section === sec ? its[i + 1] : its[i - 1]?.section === sec ? its[i - 1] : undefined)?.row.key;
  };

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // The row moves to Archived at once; the stop (so an archived session can't wake up again: a
  // Claude /loop or wakeup) and the mark follow in the background. A failed stop leaves it
  // archived and red, and `x` on it tries again.
  async function archive(s: Session) {
    if (!s.id) return setFlash("not started yet");
    if (stopping(s)) return;
    if (archivedOf(s) && !s.stoppable) return setFlash("already archived");
    const next = neighbor(s);
    if (!showArchived() && !archivedOf(s) && next) setSelected(next);
    if (s.stoppable) setFlash(`stopping ${s.title}…`);
    try {
      const failed = await props.store.archive(s);
      setFlash(failed === undefined ? `archived ${s.title}` : `archived ${s.title}, still running · stop failed: ${failed} · x on it retries`);
    } catch (e) {
      setFlash(`archive failed: ${message(e)}`);
    }
  }

  async function restore(s: Session) {
    if (!s.id) return setFlash("not started yet");
    if (s.archived) return setFlash(`archived in ${s.harness} itself · restore it there`);
    if (!archivedOf(s)) return setFlash("not archived");
    try {
      await props.store.mark(s, false);
      setFlash(`restored ${s.title}`);
    } catch (e) {
      setFlash(`restore failed: ${message(e)}`);
    }
  }

  useKeyboard((key) => {
    if (!props.active() || key.defaultPrevented) return;
    if (filtering()) {
      if (key.name === "escape") {
        setFiltering(false);
        setFilter("");
      } else if (key.name === "return") setFiltering(false);
      return;
    }
    const s = current();
    if (key.name === "up" || key.name === "k") move(key.shift ? -8 : -1);
    else if (key.name === "down" || key.name === "j") move(key.shift ? 8 : 1);
    else if ((key.name === "return" || key.name === "right" || key.name === "l") && s) {
      if (s.open) props.onOpen(s);
      else setFlash(s.closedReason ?? "can't open this session here");
    } else if (key.name === "/") {
      key.preventDefault();
      setFiltering(true);
    } else if (key.name === "n") props.onNew();
    else if (key.name === "tab") setShowArchived(!showArchived());
    else if (key.name === "x" && s) void archive(s);
    else if (key.name === "r" && s) void restore(s);
    else if (key.name === "escape" && filter()) setFilter("");
    else if (key.name === "q" || (key.ctrl && key.name === "c")) props.onQuit();
  });

  const counts = createMemo(() => {
    const c = { needs: 0, working: 0 };
    for (const s of all()) if (s.status === "needs" || s.status === "working") c[s.status]++;
    return c;
  });
  // Real failures first (red), then quiet "not here" states grouped by reason (dim).
  const problems = createMemo(() => {
    const srcs = Object.values(state.sources).filter((s) => s.problem);
    const errors = srcs.filter((s) => !QUIET.has(s.problem!.kind)).map((s) => `${label(s)}: ${s.problem!.message}`);
    const quiet = new Map<string, string[]>();
    for (const s of srcs.filter((s) => QUIET.has(s.problem!.kind))) quiet.set(s.problem!.message, [...(quiet.get(s.problem!.message) ?? []), label(s)]);
    return { errors: errors.join(" · "), quiet: [...quiet].map(([msg, who]) => `${who.join(", ")} ${msg}`).join(" · ") };
  });
  // Rows carry the short label (`short` host name, cut harness name); the footer has the full one.
  const host = (s: Session) => props.store.hostShort(s.machine);
  const labelWidth = createMemo(() => Math.max(0, ...view().list.map((s) => host(s).length + 1 + harnessShort(s.harness).length)) + 1);
  const stateCell = (s: Session) => (props.live().has(s.key) ? "●" : s.open ? "" : "view");
  const dims = useTerminalDimensions();
  // Column widths fit the rows on screen. A column no row has anything for takes no space;
  // otherwise it is at least as wide as its heading.
  const cols = createMemo(() => {
    const list = view().list;
    const width = (head: string, cell: (s: Session) => string, max = Infinity) => {
      const w = Math.max(0, ...list.map((s) => Bun.stringWidth(cell(s))));
      return w ? Math.min(max, Math.max(w, head.length)) : 0;
    };
    const right = {
      subagents: width("subs", (s) => subagentCell(s.subagents)),
      context: width("tok", (s) => contextCell(s.context)),
      state: width("", stateCell),
    };
    // On a narrow terminal the title gives way (cut with an ellipsis) so the right columns stay on screen.
    const taken = 2 + labelWidth() + [right.subagents, right.context, right.state, AGE_W].reduce((n, w) => n + (w ? w + GAP.length : 0), 0);
    return { title: width("session", (s) => s.title, Math.max(8, Math.min(TITLE_MAX, dims().width - taken))), ...right };
  });
  /** A fixed-width cell with its leading gap, or nothing when the column is empty. */
  const cell = (text: string, width: number, right = false) => (width ? GAP + fit(text, width, right) : "");

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text fg={props.store.hostColor(props.store.here)} attributes={TextAttributes.BOLD}>{props.store.here}</text>
          <text fg={colors.text} attributes={TextAttributes.BOLD}>
            {` · agents · ${counts().needs} need you · ${counts().working} working`}
          </text>
        </box>
        <text wrapMode="none" fg={colors.dim}>{ready() ? "" : "loading…"}</text>
      </box>
      <box height={1} flexShrink={0} flexDirection="row">
        <box flexDirection="row" flexGrow={1} flexBasis={0} minWidth={0} overflow="hidden" paddingLeft={2}>
          <text wrapMode="none" flexShrink={0} fg={colors.dim}>{fit("", labelWidth()) + fit("session", cols().title) + GAP + "status"}</text>
        </box>
        <text wrapMode="none" flexShrink={0} fg={colors.dim}>
          {cell("subs", cols().subagents, true) + cell("tok", cols().context, true) + cell("", cols().state) + cell("age", AGE_W, true)}
        </text>
      </box>
      <scrollbox ref={scroll} flexGrow={1} minHeight={0} scrollY scrollX={false} viewportCulling contentOptions={{ flexDirection: "column" }} verticalScrollbarOptions={{ visible: false }}>
        <Index each={view().items}>
          {(it) => {
            const header = () => {
              const i = it();
              return "header" in i ? i : undefined;
            };
            // Keeps the last row while the slot turns into a header, until the row view is disposed.
            let last: Session | undefined;
            const s = () => {
              const i = it();
              return "row" in i ? (last = i.row) : last!;
            };
            const active = () => current()?.key === s().key;
            const st = (): Status => s().status;
            // Red while its stop is running, and for as long as a failed stop leaves it running.
            const ending = () => stopping(s()) || stopFailed(s()) !== undefined;
            const color = () =>
              ending() ? colors.error : st() === "needs" ? colors.permission : st() === "failed" ? colors.error : st() === "working" ? colors.selected : colors.muted;
            const gutter = () =>
              stopping(s()) ? spinner() : stopFailed(s()) !== undefined ? "×" : st() === "working" ? spinner() : st() === "needs" ? "!" : st() === "failed" ? "×" : st() === "interrupted" ? "-" : active() ? "❯" : " ";
            const statusText = () =>
              stopping(s()) ? (s().stoppable ? "stopping…" : "archiving…") : stopFailed(s()) !== undefined ? `still running · stop failed: ${stopFailed(s())}` : st() === "failed" || st() === "interrupted" ? st() : "";
            const row = () => (
              <box height={1} flexShrink={0} flexDirection="row" backgroundColor={active() ? colors.surfaceRaised : colors.bg} onMouseDown={() => setSelected(s().key)}>
                <box width={1} flexShrink={0}>
                  <text fg={active() && !ending() && !"needs working failed".includes(st()) ? colors.selected : color()}>{gutter()}</text>
                </box>
                <box flexDirection="row" flexGrow={1} flexBasis={0} minWidth={0} overflow="hidden" paddingLeft={1}>
                  <text wrapMode="none" flexShrink={0} fg={props.store.hostColor(s().machine)}>{host(s())}</text>
                  <text wrapMode="none" flexShrink={0} fg={providerColor(s().harness)}>{`·${harnessShort(s().harness)}`.padEnd(labelWidth() - host(s()).length)}</text>
                  <text wrapMode="none" flexShrink={0} fg={active() ? colors.selected : s().open ? colors.text : colors.muted} attributes={active() ? TextAttributes.BOLD : undefined}>
                    {fit(s().title, cols().title)}
                  </text>
                  <text wrapMode="none" flexShrink={1} fg={color()}>{GAP + (ending() ? statusText() : s().detail || statusText()).split("\n")[0]}</text>
                </box>
                {/* An empty text still takes a column, so an absent column renders nothing at all. */}
                <Show when={cols().subagents}>
                  <text wrapMode="none" flexShrink={0} fg={s().subagents?.active ? colors.selected : colors.muted}>{cell(subagentCell(s().subagents), cols().subagents, true)}</text>
                </Show>
                <Show when={cols().context}>
                  <text wrapMode="none" flexShrink={0} fg={colors.muted}>{cell(contextCell(s().context), cols().context, true)}</text>
                </Show>
                <Show when={cols().state}>
                  <text wrapMode="none" flexShrink={0} fg={props.live().has(s().key) ? colors.success : colors.dim}>{cell(stateCell(s()), cols().state)}</text>
                </Show>
                <text wrapMode="none" flexShrink={0} fg={colors.muted}>{cell(age(s().updatedAt), AGE_W, true)}</text>
              </box>
            );
            // Index reuses slots by position, so a slot can switch between header and row.
            return (
              <Show when={header()} keyed fallback={row()}>
                {(h) => (
                  <box height={HEADER_H} flexShrink={0} border={["top"]} borderColor={colors.border} flexDirection="row">
                    <text fg={h.header === "needs" ? colors.permission : colors.text} attributes={TextAttributes.BOLD}>{SECTIONS.find((x) => x.id === h.header)!.label}</text>
                    <text fg={colors.dim}>{` ${h.count}${h.header === "archived" && view().archivedHidden ? " · tab to show" : ""}`}</text>
                    <Show when={h.header === "archived" && view().stopFailed}>
                      <text fg={colors.error}>{` · ${view().stopFailed} still running (stop failed)`}</text>
                    </Show>
                  </box>
                )}
              </Show>
            );
          }}
        </Index>
      </scrollbox>
      <box height={4} flexShrink={0} flexDirection="column" border={["top"]} borderColor={current()?.status === "needs" ? colors.permission : colors.border}>
        <text height={1} wrapMode="none" fg={colors.muted}>
          {current() ? [label(current()!), current()!.title, current()!.model, shortPath(current()!.cwd)].filter(Boolean).join(" · ") : ""}
        </text>
        <text height={1} wrapMode="none" fg={colors.text}>{[
          current()?.detail.split("\n")[0],
          current()?.context && `${current()!.context!.usedTokens.toLocaleString()}${current()!.context!.limitTokens ? ` / ${current()!.context!.limitTokens!.toLocaleString()}` : ""} context tokens · last response ${relTime(current()!.context!.measuredAt)}`,
        ].filter(Boolean).join(" · ")}</text>
        <text height={1} wrapMode="none" fg={colors.dim}>
          {current() ? (current()!.open ? `⏎ ${current()!.open!.cmd.join(" ")}` : current()!.closedReason) : ""}
        </text>
      </box>
      <Show when={problems().errors || problems().quiet}>
        <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
          <text wrapMode="none" flexShrink={0} fg={colors.error}>{problems().errors ? `${problems().errors}  ` : ""}</text>
          <text wrapMode="none" fg={colors.dim}>{problems().quiet}</text>
        </box>
      </Show>
      <box height={1} flexShrink={0} flexDirection="row">
        <Show
          when={filtering()}
          fallback={
            <text fg={colors.dim} wrapMode="none">
              {flash() ? `${flash()} · ` : ""}
              {filter() ? `filter: ${filter()} · ` : ""}↑↓ move · ⏎ open · n new · x stop+archive · r restore · tab archived · / filter · q quit · ctrl+] back from a session
            </text>
          }
        >
          <text fg={colors.selected}>/ </text>
          <input focused flexGrow={1} value={filter()} onInput={(v: string) => setFilter(v)} focusedBackgroundColor={colors.bg} backgroundColor={colors.bg} textColor={colors.text} />
        </Show>
      </box>
    </box>
  );
}
