// The command line: host arguments for this run, `ps` / `kill`, help and version.
import pkg from "../package.json";
import { command } from "./procs.ts";

const HELP = `faplex ${pkg.version} · one list for Claude Code, Codex and OpenCode sessions across machines

Usage:
  faplex               this machine plus the machines in the config file
  faplex <host>...     this machine plus only these, for this run: a machine \`id\`
                       from the config file, else an ssh alias/host
  faplex ps            list running dashboards
  faplex kill [all]    stop dashboards whose terminal is gone (all: every one)
  faplex -h, --help
  faplex -v, --version

Config (optional): ~/.config/faplex/config.json
  https://github.com/kkrausse/faplex#config
`;

/** The hosts named on the command line. Everything that isn't a dashboard run is done here and exits. */
export function hostArgs(args: string[]): string[] {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.includes("-v") || args.includes("--version")) {
    console.log(pkg.version);
    process.exit(0);
  }
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) {
    process.stderr.write(`faplex: unknown option ${unknown}\n\n${HELP}`);
    process.exit(1);
  }
  if (command(args)) process.exit(0);
  return args;
}
