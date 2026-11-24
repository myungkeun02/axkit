import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Where people's command-line tools usually live on a Mac. A login service (launchd) starts with a minimal PATH, so a
 * CLI installed with Homebrew, npm or its own installer (claude → ~/.local/bin) is not found by name alone.
 */
export function commonBinDirs(home = homedir()): string[] {
  const dirs = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.claude', 'local'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin')];
  try {
    const nvm = join(home, '.nvm', 'versions', 'node');
    for (const version of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, version, 'bin'));
  } catch {
    // no nvm
  }
  return dirs;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const cache = new Map<string, string>();

/** The absolute path of a command: as given when absolute, else the first hit on PATH, then the usual install folders. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (isAbsolute(command)) return executable(command) ? command : undefined;
  const known = cache.get(command);
  if (known !== undefined && executable(known)) return known;
  const path = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
  for (const dir of [...path, ...commonBinDirs(home)]) {
    const candidate = join(dir, command);
    if (executable(candidate)) {
      cache.set(command, candidate);
      return candidate;
    }
  }
  return undefined;
}
