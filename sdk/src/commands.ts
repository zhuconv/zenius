// Commands a build adds to `zenius` beside its own. Each module in
// src/extensions/ registers its command here when it loads: build.mjs bundles
// those modules with the CLI, and bin/zenius imports them when it runs the
// sources. A build without src/extensions has only the built-in commands, with
// nothing left pointing at the missing ones.

export type ExtraCommand = {
  /** Its lines in `zenius --help`, after the built-in commands, each ending in a newline. */
  usage: string;
  /** Runs with the arguments after the command's name, and the --instance option as given. */
  run: (rest: string[], instance: string | undefined) => Promise<number>;
};

export const EXTRA_COMMANDS = new Map<string, ExtraCommand>();

export function registerCommand(name: string, command: ExtraCommand): void {
  EXTRA_COMMANDS.set(name, command);
}
