# faplex

**F**ake **a**gent (multi)**plex**er. Fake because it doesn't multiplex anything: the
harnesses already keep their sessions in daemons, so faplex only lists them and opens
the harness's own CLI on the one you pick.

One status list for Claude Code, OpenCode and Codex sessions, on this machine and
any others you can `ssh` to. Opening a session hands the whole terminal to the
harness's own CLI (in a PTY, over ssh for remote machines): its output and your keys
pass straight through, so faplex never reimplements a chat view and nothing the
harness prints (links, clipboard writes) is lost on the way. Each harness keeps its
sessions in a daemon, so leaving a session never stops the agent.

Needs [Bun](https://bun.sh). From a checkout:

```sh
bun install
ln -s "$PWD/bin/faplex" ~/.local/bin/faplex
faplex   # new local sessions start in the directory you run it from
```

`bin/faplex` runs the local checkout directly with Bun, preserving the directory you
launched it from. Run `bun install` after dependency changes. `bun start` also runs
straight from source; no standalone build or npx is needed for local development.

See [docs/design.md](docs/design.md) for how it works, and [Providers](#providers) for the
small interface a harness has to offer and how each of the three fills it.

## Trade-offs

faplex owns neither the terminal runtime nor the conversation. Each harness's daemon
owns execution and session identity; faplex asks it what exists, shows status, and
runs the harness's attach command when you open a row.

What that buys:

- **The native UI, untouched.** No chat view to reimplement and keep in step with each
  harness, and no emulator in the middle dropping links or clipboard writes.
- **Clients are disposable.** A session costs a TUI client only while you look at it
  (plus 15 minutes); the work carries on in the daemon. With one daemon for all sessions
  (OpenCode, Codex) that is most of the per-session cost. Claude still keeps a process
  per background session.
- **Sessions it didn't start show up.** Anything the daemon knows about is listed,
  whichever terminal or machine it came from.
- **Status from the live process**, not from scraping a pane or guessing from file
  mtimes.
- **Nothing to install on remotes** beyond the harnesses: ssh and POSIX `sh`.
- **faplex can die.** It holds no state the sessions depend on.

What it costs:

- **It needs a harness with a session daemon** and an attach-by-id CLI. A harness that
  only runs in the foreground can be listed at best (plain interactive `claude` rows
  are view-only).
- **Adapters track young, moving surfaces** (`claude agents --json`, the OpenCode 2.x
  service API, the Codex app-server socket), so harness updates can break a source.
- **No unified controls.** Permissions, history, diffs and rollback are whatever each
  harness's own UI gives you, and they differ.
- **New-session identity is sometimes a guess**: OpenCode and Codex don't hand back an
  id, so the new session is claimed as the first new one in that directory.
- **No layouts.** One session on screen at a time; splits are your terminal's job.

Compared with what else exists:

| | Owns | Sessions it sees | Idle session costs | Machines |
|---|---|---|---|---|
| **faplex** | nothing | whatever the harness daemons hold | daemon only | ssh |
| tmux-based managers ([Agent Deck](https://github.com/asheshgoplani/agent-deck), Claude Squad) | tmux sessions running the CLIs | the ones it launched | a live CLI per session | ssh (Agent Deck) |
| agent terminals ([Herdr](https://herdr.dev), [cmux](https://github.com/manaflow-ai/cmux)) | the terminal and its panes | agents running in its panes | a live CLI per pane | Herdr: yes |
| session indexers ([gctrl](https://www.npmjs.com/package/gctrl), [rejoin](https://pypi.org/project/rejoin/)) | nothing | whatever is on disk | nothing | local only |
| control planes ([Paseo](https://paseo.sh), [T3 Code](https://github.com/pingdotgg/t3code)) | the conversation UI and provider integration | the ones it runs | its own server | yes |

The indexers are the nearest relatives: same hands-off stance, but they read status off
session files, don't start sessions and stay on one machine. The others give you more
(persistent panes for any CLI, one UI for every provider) by owning more.

## Machines

`~/.config/faplex/machines.json` (created with just this machine if absent):

```json
[
  { "id": "laptop" },
  { "id": "devbox", "ssh": "devbox", "dir": "~/src", "short": "dev" },
  { "id": "pi", "ssh": "pi" }
]
```

- `id`: the name shown in the list. The entry without `ssh` is this machine; `"local"` there is
  shown as its Tailscale name (else its hostname).
- `short`: a shorter name for list rows (e.g. `"dev"`); the footer and new-session picker keep `id`.
- `ssh`: an alias/host from your ssh config (key auth; the dashboard never prompts).
- `dir`: default start directory for new sessions there (default `~`).
- `color`: label color for the host (hex); defaults to a palette color by position in the file.
- `path`: extra PATH entries on the host. `~/.local/bin`, `~/.bun/bin` and
  `~/.opencode/bin` are always added, since non-interactive ssh skips `.bashrc`.

All ssh traffic to a host shares one connection (ControlMaster sockets in
`~/.local/state/faplex/ssh`). sshd allows 10 sessions per connection by default
(`MaxSessions`); each open remote pane and the host's status loop take one.

## List

Sections: **Working**, **Needs input**, **Finished** (done, failed, interrupted, idle),
**Archived** (collapsed; tab shows it). Known unprompted drafts are hidden, not archived or deleted.
Row labels are `machine·harness`, the machine in
its host color and the harness in its own. Working is ordered by when each session
started working, so one you just answered lands at its bottom, next to Needs input.
In an open session the mouse belongs to the harness and your terminal, as if the CLI were run
directly. A session is archived when its
harness archived it, you archived it here, or it is finished and untouched for 7
days. Archiving here is not final: opening the session, or anything happening in it
afterwards (new input, a turn starting), brings it back. Rows are labelled `machine·harness`; the footer lists sources with problems
(red) and harnesses that aren't there (dim: not installed, unsupported, not running).

The list is a table: label (the machine's `short` name and the harness as `clau`, `codex` or
`openc`), session title (cut at 40 columns, or shorter on a narrow terminal so the right-hand
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

## Keys

List: ↑↓/jk move · ⏎/→ open · n new · x stop + archive · r restore · tab show archived ·
/ filter · q quit.

`x` moves the row to Archived at once, then in the background stops whatever is still running
in the session, so an archived session can't wake itself up later (a Claude `/loop` or
scheduled wakeup), and writes the mark. With Archived shown, the row is red with a spinner
until that is done. If the stop fails the session is archived anyway and stays red (the
Archived heading says how many are still running); `x` on it tries the stop again.
The conversation is kept either way; opening the session resumes it and takes it out of the archive.

New session: ↑↓ machine · ←→ harness · tab edit start dir · ⏎ open · esc back.
Combinations whose harness is missing or unsupported are greyed out.

In an open session, go back to the list with:

- ctrl+] anywhere
- ← on an empty prompt

Every other key, ctrl+c included, goes to the harness. The client stays alive in the
background (●) and repaints when reopened; clients not shown for 15 minutes are
closed. Opening a session clears the terminal's screen and scrollback first. An unused new chat is cached for reuse ("·ready"),
and ← on its empty prompt returns to the picker.

## Providers

What a harness needs to appear here, per machine:

- **A daemon that owns its sessions**, so they outlive any client, including the dashboard's pane.
- **Presence**: a cheap check that says installed / too old / daemon not running (shown dimly, not as errors).
- **List**: every session with id, title, cwd, last update, model, whether the harness archived it,
  and a status that maps onto `working | needs | done | failed | interrupted | idle`. Activity
  (working, needs input) must come from the live process, not from a self-reported note.
- **Change signal**: an event stream that triggers a re-list, or polling. Polling also re-lists on
  demand, which the dashboard asks for when you leave a pane.
- **Open**: a CLI that attaches to a session by id in a terminal (run over ssh for remote machines).
- **New**: a CLI that starts a session in a directory, plus a way to recognise it in the list (an
  id it prints, or the first new session in that directory).
- **Stop** (optional): end whatever is still running so nothing starts again unprompted. `x` runs it
  before archiving. A harness whose sessions can wake themselves (Claude's `/loop`, scheduled
  wakeups) must stop the process; one that only runs when prompted just interrupts the turn.

| Harness | Status | Open | New | Stop |
|---|---|---|---|---|
| Claude Code | per-host sh loop: `claude agents --json --all` + `~/.claude/jobs/<id>/state.json` every 2 s | `claude attach <id>` | `claude --bg`, then attach | `claude stop <id>` (ends the process and its wakeups; background sessions only) |
| OpenCode 2.x | background service HTTP API (`~/.local/state/opencode/service.json`, basic auth user `opencode`), re-read on `/api/event` events | `opencode -s <id>` | `opencode <dir>` | `POST /api/session/<id>/interrupt` |
| Codex | app-server daemon, WebSocket over `~/.codex/app-server-control/app-server-control.sock`, re-read on thread notifications | `codex resume <id>` | `codex -C <dir>` | `turn/interrupt` on the in-progress turn |

Remote OpenCode ports and Codex sockets are forwarded over the shared ssh connection.
OpenCode 1.x and Claude Code without `agents --json` show as unsupported.

Interactive Claude sessions (plain `claude` in another terminal) are listed but
marked `view`: `claude attach` only accepts background jobs.
