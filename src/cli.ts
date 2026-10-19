// The command line: host arguments for this run, `ps` / `kill`, the commands another program
// drives faplex with (`watch`, `open`, `new`), help and version.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { command } from "./procs.ts";
import { HARNESSES, type Harness } from "./session.ts";

const HELP = `faplex ${pkg.version} · one list for Claude Code, Codex and OpenCode sessions across machines

Usage:
  faplex               this machine plus the machines in the config file
  faplex <host>...     this machine plus only these, for this run: a machine \`id\`
                       from the config file, else an ssh alias/host
  faplex ps            list running dashboards
  faplex kill [all]    stop dashboards whose terminal is gone (all: every one)
  faplex -h, --help
  faplex -v, --version

For other programs (every machine in the config file):
  faplex watch --json  print the session list as one JSON line on every change
  faplex open <key> [--open <json>]
                       open a session by its \`machine/harness:id\` key; returns on
                       ctrl+] or ← at an empty prompt. --open is the session's
                       \`open\` from \`watch\`: it attaches at once, without listing
  faplex new --machine <id> --harness <${HARNESSES.join("|")}>
             [--dir <dir>] [--prompt <text>] [--tag <tag>]... [--background]
                       start a session and open it like \`open\`; tags are listed
                       with it by \`watch\`. --background returns once it is
                       running instead of opening it

Config (optional): ~/.config/faplex/config.json
  https://github.com/kkrausse/faplex#config
`;

export type Command =
  | { kind: "dashboard"; hosts: string[] }
  | { kind: "watch" }
  | { kind: "open"; key: string; open?: { cmd: string[]; cwd: string } }
  | { kind: "new"; machine: string; harness: Harness; dir?: string; prompt?: string; tags: string[]; background: boolean };

const usage = (message: string): never => {
  process.stderr.write(`faplex: ${message}\n\n${HELP}`);
  process.exit(1);
};

/** What this run does. Everything that isn't a dashboard or a session pane is done here and exits. */
export function parseCommand(args: string[]): Command {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.includes("-v") || args.includes("--version")) {
    console.log(pkg.version);
    process.exit(0);
  }
  if (args[0] === "watch") {
    if (args[1] !== "--json" || args.length > 2) usage("watch takes --json and nothing else");
    return { kind: "watch" };
  }
  if (args[0] === "open") {
    const [, key, flag, json] = args;
    if (!key?.includes("/") || !(args.length === 2 || (args.length === 4 && flag === "--open"))) usage("open takes one machine/harness:id key, optionally --open <json>");
    if (json === undefined) return { kind: "open", key: key! };
    let open: unknown;
    try {
      open = JSON.parse(json);
    } catch {}
    const o = open as { cmd?: unknown; cwd?: unknown } | undefined;
    if (!Array.isArray(o?.cmd) || !o.cmd.every((c) => typeof c === "string") || typeof o.cwd !== "string") return usage("--open takes {\"cmd\": [...], \"cwd\": \"...\"}");
    return { kind: "open", key: key!, open: { cmd: o.cmd as string[], cwd: o.cwd } };
  }
  if (args[0] === "new") {
    let values;
    try {
      ({ values } = parseArgs({
        args: args.slice(1),
        options: { machine: { type: "string" }, harness: { type: "string" }, dir: { type: "string" }, prompt: { type: "string" }, tag: { type: "string", multiple: true }, background: { type: "boolean" } },
      }));
    } catch (e) {
      return usage(e instanceof Error ? e.message : String(e));
    }
    const harness = values.harness as Harness;
    if (!values.machine) usage("new needs --machine");
    if (!HARNESSES.includes(harness)) usage(`new needs --harness, one of ${HARNESSES.join(", ")}`);
    return { kind: "new", machine: values.machine!, harness, dir: values.dir, prompt: values.prompt?.trim() || undefined, tags: values.tag ?? [], background: values.background ?? false };
  }
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) usage(`unknown option ${unknown}`);
  if (command(args)) process.exit(0);
  return { kind: "dashboard", hosts: args };
}
