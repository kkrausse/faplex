# faplex design

Layers, bottom up:

```
machine helpers (machines.ts)    on() · forward() · exec/sh/lines · shared ssh connection
harness streams                  claude.ts (host loop) · opencode.ts · codex.ts
sources / store (store.ts)       one supervised fiber per machine × harness → Solid store
UI (list.tsx, new-session.tsx,   Solid + OpenTUI; an open session is the harness CLI in a PTY
    main.tsx)
```

Effect is used for the source side only (streams, scoped resources, retry
schedules, Schema decoding). The store is the bridge: each stream item replaces
that source's rows in a Solid store; the UI never sees Effect.

## Machines

A machine is `{ id, ssh?, dir?, path? }` from `~/.config/faplex/config.json` (config.ts), or
`{ id: arg, ssh: arg }` for a command-line argument that names no configured machine. The one
without `ssh` is this machine; it is always in the list and is called `local` unless an entry
names it. Nothing is looked up to name it and nothing is written at startup.
There is no machine service, just two helpers:

- `on(machine, cmd, { cwd?, tty? })`: `cmd` unchanged locally; remotely an
  `ssh` argv running `PATH=<path entries>:~/.local/bin:~/.bun/bin:~/.opencode/bin:$PATH;
  cd <cwd> && exec <cmd>` (shell-quoted, `~` expanded on the host; `-t` for
  panes, `-T -o BatchMode=yes` otherwise).
- `forward(machine, target)`: local address unchanged; remotely `ssh -O forward
  -L` on the shared connection (a free local TCP port, or a local Unix socket
  for Codex pointing at the remote absolute path, resolved from the remote
  `$HOME`), with `ssh -O cancel` when the Effect scope closes.

### SSH channel model

Every ssh uses `ControlMaster=auto`, `ControlPath=~/.local/state/faplex/ssh/%C`
(mode 700; falls back to `/tmp/faplex-<uid>` if that path would exceed the
~104 byte Unix socket limit) and `ControlPersist=10m`. The master is opened once
per host under a semaphore, so one TCP connection per host carries:

- the host loop (one long-lived session),
- short commands (`cat service.json`, socket checks, archive writes, `claude --bg`),
- port/socket forwards (OpenCode SSE + requests, Codex RPC; these are channels,
  not sessions),
- each open pane (one session each).

sshd's `MaxSessions` (default 10) caps sessions per connection. A pane refused for
that reason prints a message saying so. Quitting interrupts every source (which
cancels forwards) and leaves the connection itself: other dashboards share it, and ssh
closes it after 10 unused minutes (`ControlPersist`), which also makes a restart within
that time skip the connection setup.

Each dashboard registers its pid in `~/.local/state/faplex/run`. `faplex ps` lists them and
`faplex kill` ends the orphaned ones (adopted by init, or without a terminal); a dashboard
also quits by itself on SIGHUP/SIGTERM, when its stdin or stdout fails, and when it notices
it was handed to init. Quit has a 3 s deadline, since tearing down against a dead terminal
or a stuck ssh used to hang and leave the dashboard polling every host.

## Harness streams

Each source emits the complete current list on every item.

| Harness | Mechanism | Why |
|---|---|---|
| Claude | one POSIX `sh` loop per host printing a framed record every 2 s, and on demand (a line on its stdin) | no subscribe API; remotes may have only `sh` (no jq/python/bun) |
| OpenCode 2.x | `/api/event` SSE; relevant events (session.*, permission.*, form.*) trigger a re-list; 60 s resync | the server has an event stream |
| Codex | app-server notifications (`thread/started`, `thread/status/changed`, `thread/archived`, ...) trigger a re-list; 60 s resync | the daemon broadcasts thread notifications to every client |

Triggers arriving while a list is in flight collapse into one more list
(`Stream.buffer` sliding, capacity 1).

### Claude host loop

Frames, one record per tick:

```
@@archive
<~/.config/faplex/archive.json>
@@claude <exit code> | @@claude missing
<claude agents --json --all>
@@job <id> <mtime>          followed by state.json, or
@@job <id> <mtime> same     when unchanged since the last tick
@@end
```

A ticker subshell and the loop's stdin feed one pipe, and each line on it is one record, so the
dashboard gets a record at once by writing a newline. It does that when you leave a session pane
(a prompt you just sent shows as working without waiting for the tick) and after `claude stop`.
The loop emits every tick even when nothing changed; no record for ~3 ticks fails
the stream and the supervisor restarts the command. Local uses the same loop. A
host without `claude` still runs it for its archive marks. The Paseo check (local
`ps`) only runs for the local machine.

### OpenCode

`cat` of `service.json` via `on`, plus `opencode --version` and a `kill -0` of its
pid on that host. CLI missing → not installed; CLI 1.x → unsupported (different
API); no file or dead pid → not running (stale). Then `forward` to the host:port
the url names (a service may bind a non-loopback address, e.g. its Tailscale one).

OpenCode and OpenCode Mini are separate picker/list identities (`oc` / `ocm`) backed
by one stream and stop connection per machine. Mini launches create a session through
`opencode api` with metadata `faplex.interface: mini`, then attach via
`opencode mini -s <id>` with that directory as cwd. The metadata selects the row's
harness and resume command on every read; untagged sessions default to full OpenCode.
Backend failures update both source states, and sessions are partitioned, not duplicated.

### Codex

`[ -S ~/.codex/app-server-control/app-server-control.sock ]` on the host, forward
the socket, keep the existing hand-framed WebSocket JSON-RPC (`CodexRpc`).

## Sources and store

A source is machine × harness, keyed `machine/harness`. Its state is rows plus an
optional problem. Each source runs under `supervise`: a stream that ends or fails
records the problem and is retried, every 60 s for quiet problems (missing,
unsupported, stopped) and with exponential backoff capped at 30 s for real ones
(unreachable, decode, failed). Real failures keep the last rows on screen.
All external JSON (claude agents output, state.json, archive.json, OpenCode and
Codex responses) is decoded with `Schema`, so format drift is a per-source error.

## Session model

`{ machine, harness, key = machine/harness:id, id, title, cwd, open?: {cmd, cwd},
closedReason?, status, prompted?, detail, updatedAt, model, archived }`. `open.cmd` is
machine-agnostic; the pane wraps it with `on(machine, cmd, { cwd, tty: true })`.
Status: `needs | working | done | failed | interrupted | idle` (idle = never
prompted, e.g. a fresh `claude --bg`). A new session's claim is data:
`{ id }` (Claude/OpenCode Mini) or `{ firstNewIn: dir }` (OpenCode/Codex).

`claude --bg` refuses a folder that was never trusted ("Workspace not trusted"), and only the
plain CLI shows the trust prompt. The launch then returns `{ trust: true }` with `claude` as the
pane command, so the prompt comes up in the pane. While that pane is on screen the launch is
retried every second; once the prompt is accepted it succeeds, and the pane is swapped for
`claude attach` on the new background session. Declining exits the CLI as usual.

Status is the top level's own turn, not whether anything is running. Claude's process status is
`busy` for as long as anything the session started is running (a subagent, a dev server left up, a
shell loop that never exits), so a live process's job `tempo` decides: `blocked` is needs input,
`idle` is a turn that ended (finished by `state`, or still working if subagents are out, since
their results wake it). A dead process leaves its last tempo behind, so then only `state` counts.

`background?: { kind: "agent" | "shell", count, label }` is what else is running, whatever the
status: the running `fan` entries of the job state, subagents first. The list draws it next to
the gutter (`⑂` or `$`) and names it in the footer. Claude background sessions only so far.

`prompted` is independent of status: false means a known empty draft; absent
means unknown (do not hide it). Claude recognises its initial "send a prompt"
state, Codex supplies the first-prompt preview, and OpenCode checks for a user
message on idle sessions without an outcome (cached by update time). Live
activity also confirms a chat has started. Claiming a session ID does not.
The source confirms the first prompt; pressing Enter in a model picker is not
enough. "Back" from a new chat always goes to the list, prompted or not: the keys cannot say
whether a prompt went in (a paste delivers text and Enter as one chunk), and the source may take
a moment to report it. `n` reopens the picker on an unused one. Known drafts stay hidden even after their client is closed; nothing is
deleted or archived.

### Optional metrics

`subagents?: { total, active, complete }` counts all descendants, like the
session-manager plugin. OpenCode and Codex retain parent links while summarising
their native lists, then emit only roots. Codex explicitly requests subagent source
kinds (the API defaults to interactive threads only). Both follow pagination, capped
at 10 pages per list; incomplete scans render counts as lower bounds (`≥N`). Cycle
and duplicate-ID guards prevent double-counting. These are compact badges, not an
expandable child tree yet; not every child necessarily has an attachable CLI.

`context?: { usedTokens, limitTokens?, measuredAt }` is a latest-response snapshot,
not cumulative billed tokens. OpenCode uses the newest assistant usage after the
last completed compaction and before any revert boundary, matching the plugin's
formula (input + output + reasoning + cache read + cache write). It fetches the
newest 100 messages for active roots and refreshes previously observed roots when
they change. A revert boundary outside that page means unavailable. Model limits
are resolved in the session's location and cached for 60 seconds. Optional lookups
are bounded, time out, and fail independently of the basic list.

Codex takes `last.totalTokens`, never cumulative `total`, from received
`thread/tokenUsage/updated` events and uses `modelContextWindow` when available.
The connection keeps snapshots in memory; it does not resume threads or otherwise
mutate them to acquire a subscription. Initial availability and live event delivery
depend on the server's notification behavior.

Claude has no API for either, so the host loop reads them off disk. For each listed
session it finds `~/.claude/projects/*/<sessionId>.jsonl`, sends the last line of the
transcript's tail that is a response's usage or a compaction boundary (only when the
file's mtime changes), and counts `<sessionId>/subagents/agent-*.jsonl`. Context is
that response's `input + cache_creation + cache_read` tokens, matching Claude's own
status line (output tokens are not counted, unlike OpenCode). A compaction boundary
doesn't decode as usage, so context is unavailable until the next response. The window
is not recorded anywhere readable (the model id carries no `[1m]` marker even when
usage reaches 500k), so Claude rows have no `limitTokens`. The exact figure is only
handed to a status-line script, which would need a per-host opt-in bridge. Subagent total is the
transcript count (nested ones land in the same folder); active is the job state's
`fan` entries of kind `agent` without `doneAt`, so it is 0 for interactive sessions.

The list shows tokens used, not a percentage, for every harness: one harness can't
supply a limit, and a column mixing shares and counts doesn't read as a column.
Missing means unavailable, not zero. The footer shows exact tokens, the limit when
the harness reports one, and measurement age. Future providers can
leave either metric absent without changing the UI contract.

## List

Sections: **Working**, **Needs input**, **Finished** (done, failed, interrupted, idle),
**Archived** (collapsed; open only while the selection is in it: ↓ past the last row above it or tab goes in, moving back up or tab goes out). Known unprompted drafts are hidden, not archived or deleted.
Row labels are `machine·harness`, the machine in
its host color and the harness in its own. Rows are ordered by when they entered their
section: Working has its newest at the bottom, so one you just answered lands next to Needs
input; Needs input and Finished are stacks, newest on top.
In an open session the mouse belongs to the harness and your terminal, as if the CLI were run
directly. A session is archived when its
harness archived it, you archived it here, or it is finished and untouched for 24
hours (`archiveAfterHours`). Archiving here is not final: opening the session, or anything happening in it
afterwards (new input, a turn starting), brings it back. Rows are labelled `machine·harness`. One line above the list holds what needs acting on: sources
with real problems (red; an unreachable machine once, not once per harness) and daemons that
aren't running, with the command that starts them (`DAEMON_START` in session.ts). A source with a
real problem keeps its last known rows, drawn dim with the spinner stopped. Harnesses that aren't
there (not installed, unsupported) are listed dimly in the footer. With no rows at all the body
says how to start a session and lists the daemon commands a line each. Failed turns sort to the
top of Finished.

The list is a table: label (the machine's `short` name and the harness as `clau`, `codex` or
`oc` / `ocm`), session title (cut at 40 columns, or shorter on a narrow terminal so the right-hand
columns stay on screen; the footer has it in full), status line, then **subs**, **tok** and **age** (`<1m`, `5m`, `2h`, `3d`
since the last update). Columns are as wide as the rows on screen need, and a column
no row has a value for is left out. The working directory is in the footer only.

**subs** is `n/N` (active/total subagents), counting all descendants like the
session-manager plugin. Counts include finished descendants; `≥N` means the bounded
history scan was incomplete. Children are not separate top-level rows. For Claude the
total is the session's subagent transcripts; "active" is only known for background
sessions (their job state lists what the current turn has running).

**tok** is what is in the context window (`137k`), not a percentage: Claude's
window size isn't recorded anywhere readable, and a share of an assumed limit would
be a guess. Where a harness does report its limit, the footer shows it next to the
exact count.

- **OpenCode:** latest assistant-response usage and that model's location-specific
  context limit, fetched for active sessions. Completed sessions retain snapshots
  observed while they were active. Compaction/revert boundaries are respected.
- **Codex:** latest `thread/tokenUsage/updated` notification received on the live
  connection. No snapshot is available at initial connection until an event arrives;
  receiving events depends on the server's notification/subscription behavior.
  The dashboard does not resume threads to subscribe to usage.
- **Claude:** the last response's input tokens (fresh, cache-read and cache-write),
  read from the session transcript, which is how Claude's own status line counts it.
  No limit is known. Unavailable between a compaction and the next response.

These are latest-response snapshots, not continuously exact streaming usage or
lifetime billed tokens. The selected row's footer shows raw tokens and snapshot
age. Missing data is omitted, never displayed as 0%.

Archive marks live on each session's own host in `~/.config/faplex/archive.json`,
so every dashboard sees the same marks. A mark is the time of archiving on that host's
clock, and holds only while the session hasn't been updated since. Restoring (or opening
the session) overrides the 7-day rule; it can't undo an archive made in the harness itself.

## Stop

One verb per harness that ends whatever is still running, so nothing starts again unprompted.
`Session.stoppable` says whether there is anything to end. Claude sessions can wake themselves
(`/loop`, scheduled wakeups), and a finished background session keeps its process, so every
background session is stoppable until its state is `stopped`/`killed`; `claude stop` runs over
`exec` like any short command, and "No job matching" counts as already stopped. Codex and
OpenCode never wake on their own, so stopping is interrupting the running turn (stoppable =
active). They need the source's live connection (the RPC socket, the forwarded API), so each of
those streams publishes a stop function to the store while connected (`setStop`, released with
the stream's scope); stopping while a source is disconnected fails.

## Archive

Archived = harness archive, OR a dashboard mark with nothing happening since, OR (not
needs/working and `updatedAt` older than `archiveAfterHours`, default 24) unless explicitly restored. Marks live on
each host in `~/.config/faplex/archive.json` as `{ "harness:id": <ms> | true | false }`:
a number is when it was archived, read from that host's clock (`date +%s`) because the
sessions' `updatedAt` comes from the same clock; it holds while `updatedAt <= mark + 30 s`
(the stop itself touches the session once more), so later activity un-archives the session
on every dashboard without anyone writing anything. `true` is a mark from before
timestamps and always holds; `false` is an explicit restore, written by `r` and by opening
an archived session. `x`/`r` read, modify and replace the file on that host with a POSIX
`sh` write (temp file + `mv`), one write per host at a time within a dashboard. Last writer
wins between two dashboards archiving at the same moment. Every dashboard reads the file
through that host's loop record.

A host's marks arrive with its loop record, usually after its OpenCode and Codex rows, so
the list holds a machine's rows back until its marks are in (or 5 s passed). Otherwise
every archived session shows in Finished for a moment at startup.

`x` is optimistic. The store's `archiving` map counts the session as archived from the
keypress, so the row leaves its section once; the stop and the mark then run in the
background. Without that the row followed each step separately: out of Working when the
stop landed, into Finished, out again when the mark landed. A loop record read just before
the write also still carries the old file, so marks written by this dashboard win over
incoming records for 10 s. A failed stop still writes the mark and keeps the entry with
its error (red row, counted in the Archived heading) until the session stops or is
reopened; only a failed mark write puts the row back.

## UI

Sections Working → Needs input → Finished → Archived (collapsed). Rows are ordered
by when they entered their section (the moment we watched them move, else their
last update when first seen), so live updates move badges and sections, never
positions within a section. A newly working session joins the bottom of Working;
Needs input and Finished are stacks, so a session that just finished or just
asked for you is on top. Archived keeps the order it had once every source
answered (or after 5 s).

An open session owns the real terminal (`passthrough.ts`). The dashboard suspends
its renderer and copies bytes both ways without an emulator in between, because
OpenTUI's embedded terminal drops what it doesn't model (OSC 8 links, OSC 52).
Two things are kept on the side from the same output stream. A hidden emulator,
never drawn, tells whether the cursor sits at an empty prompt, which is what makes
← leave the session; its query replies are discarded since the real terminal
answers the harness. A record of the terminal modes the harness switched on
(private modes, kitty keyboard flags, modifyOtherKeys) is undone when returning to
the list and re-applied on reopening. A hidden client is kept one row short, so
reopening is a real resize and the harness repaints itself. Clients not shown for 15
minutes are closed (agents keep running in their daemons).

Input is the one place the bytes are looked at, and only for remote clients with `uploadDrops`
on (`drop.ts`; off by default, and then keys go to the PTY as before). A terminal turns a
dropped file into a paste of its local path, and faplex is the only layer that knows the session
is on another machine. A chunk is a drop when all of it, bracketed or not, is absolute paths to
local regular files of at most 200 MiB: separated by spaces or newlines, each backslash-escaped,
single- or double-quoted, or a `file://` URL. That check is a regex pass and a `stat` per path,
so typing isn't held; the only input ever waited for is a bracketed paste that starts like a
path and hasn't ended, for at most 1 s or 8 KiB.

Each file then goes through `exec` like any other command, with the file as stdin: a `sh`
script that exits early if the pasted path exists there too (it was meant as a remote path and
is left alone), makes `${TMPDIR:-/tmp}/faplex-<uid>/drops` under umask 077 and checks it owns
it, deletes files in it older than a day, and `cat`s stdin to `<8 hex>-<basename>`, the name
reduced to shell-safe characters. So the host interface stays "run a command, forward a port",
nothing is needed on the remote beyond POSIX sh, and nothing outside that directory is touched.
The paste is forwarded with the new paths in the framing and quoting it arrived in; unchanged
paths keep their exact text. Input arriving during the copy queues behind it. Any failure
forwards the original paste.
