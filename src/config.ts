// ~/.config/faplex/config.json: the machines to list and two timings. Every key is optional and
// no file at all means this machine with the defaults. schema.json at the repo root is generated
// from the schema here (scripts/schema.ts), so editors can complete and check the file.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Schema } from "effect";

export interface Machine {
  readonly id: string;
  /** Name shown in list rows instead of `id`, to keep the label column narrow. */
  readonly short?: string;
  /** ssh alias/host; absent for the local machine. */
  readonly ssh?: string;
  /** Default start directory for new sessions (remote: may start with `~`). */
  readonly dir?: string;
  /** Extra PATH entries on the host, ahead of the defaults. */
  readonly path?: readonly string[];
  /** Label color (any hex); defaults to one from the host palette. */
  readonly color?: string;
}

export interface Config {
  /** The local machine and the remote ones, in list order. */
  readonly machines: readonly Machine[];
  /** A finished session untouched for this long is archived. */
  readonly archiveAfterMs: number;
  /** A session client that hasn't been on screen for this long is closed. */
  readonly closeHiddenAfterMs: number;
}

const text = (description: string) => Schema.optionalKey(Schema.String.annotate({ description }));
const positive = (description: string, standard: number) =>
  Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0)).annotate({ description, default: standard }));

const MachineSchema = Schema.Struct({
  id: text("Name shown in the list. Defaults to `ssh`, or to `local` for the entry without `ssh`."),
  short: text("Shorter name for list rows; the footer and the new-session picker keep `id`."),
  ssh: text("Alias or host from your ssh config (key auth; faplex never prompts). The entry without it is this machine."),
  dir: text("Default start directory for new sessions there (default `~`)."),
  path: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Extra PATH entries on the host. `~/.local/bin`, `~/.bun/bin` and `~/.opencode/bin` are always added." })),
  color: text("Label color for the host (hex). Defaults to a palette color by position."),
});

export const ConfigSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  machines: Schema.optionalKey(Schema.Array(MachineSchema).annotate({ description: "Machines to list besides this one. This machine is always listed; an entry without `ssh` names or configures it." })),
  archiveAfterHours: positive("A finished session untouched for this many hours moves to Archived: how quickly Finished empties.", 24),
  closeHiddenAfterMinutes: positive("A session client not shown for this many minutes is closed. The agent carries on in its daemon.", 15),
}).annotate({ title: "faplex config", description: "~/.config/faplex/config.json. Every key is optional." });

export const CONFIG_DIR = `${homedir()}/.config/faplex`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
// The file before there were settings: a bare array of machines. Read when config.json is absent.
const MACHINES_FILE = `${CONFIG_DIR}/machines.json`;

const bad = (file: string, what: string) => new Error(`${file.replace(homedir(), "~")}: ${what}`);

/** `Expected string\n  at ["machines"][0]["id"]` → `machines[0].id: Expected string`. */
const issue = (message: string) => {
  const [what = "", at] = message.split("\n");
  const path = at?.trim().replace(/^at /, "").replace(/\["([^"]+)"\]/g, ".$1").replace(/^\./, "");
  return path ? `${path}: ${what}` : what;
};

function read(file: string | undefined): typeof ConfigSchema.Type {
  if (!file) return {};
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw bad(file, `not valid JSON (${e instanceof Error ? e.message : e})`);
  }
  try {
    return Schema.decodeUnknownSync(ConfigSchema)(file === MACHINES_FILE ? { machines: json } : json);
  } catch (e) {
    throw bad(file, issue(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Read at startup; nothing is ever written. This machine is always first in line: the entry
 * without `ssh` if there is one, else `local`. With `hosts` (the command line), only those are
 * listed besides it: a configured machine by `id`, anything else as an ssh alias/host. Throws an
 * Error naming the file and the field when the file is bad.
 */
export function loadConfig(hosts: readonly string[] = []): Config {
  const file = [CONFIG_FILE, MACHINES_FILE].find((f) => existsSync(f));
  const raw = read(file);
  const entries: Machine[] = (raw.machines ?? []).map((m) => ({ ...m, id: m.id ?? m.ssh ?? "local" }));
  const local = entries.find((m) => !m.ssh) ?? { id: "local" };
  const named = [...new Set(hosts)].map((h) => entries.find((m) => m.id === h) ?? (h === local.id ? local : { id: h, ssh: h }));
  const machines = hosts.length ? [local, ...named.filter((m) => m.ssh)] : entries.includes(local) ? entries : [local, ...entries];
  const twice = machines.find((m, i) => machines.findIndex((o) => o.id === m.id) !== i);
  if (twice) throw bad(file ?? CONFIG_FILE, `machines: "${twice.id}" is there twice (give one of them another id)`);
  return {
    machines,
    archiveAfterMs: (raw.archiveAfterHours ?? 24) * 3600_000,
    closeHiddenAfterMs: (raw.closeHiddenAfterMinutes ?? 15) * 60_000,
  };
}
