import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { REMOTE_NAME } from '../../core/remote/ids.js';

/** One paired Mac. Its token lives in the Keychain (`remote-source.<name>.token`), never in this file. */
export interface PairedRemote {
  name: string;
  /** "http://100.64.0.2:7787". */
  url: string;
  /** The other Mac's computer name, as it said when paired. */
  host: string;
  addedAt: string;
}

const fileSchema = z.object({
  remotes: z
    .array(z.object({ name: z.string().regex(REMOTE_NAME), url: z.string().url().max(300), host: z.string().max(200), addedAt: z.string().max(40) }))
    .max(16),
});

export const MAX_REMOTES = 16;

/** `<ax-kit home>/remotes.json`. */
export function remotesFile(home: string): string {
  return join(home, 'remotes.json');
}

function parse(text: string): PairedRemote[] {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.remotes : [];
  } catch {
    return [];
  }
}

export async function readRemotes(file: string): Promise<PairedRemote[]> {
  try {
    return parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

/** For wiring plugins at start, which is synchronous. A missing or broken file is no remotes. */
export function readRemotesSync(file: string): PairedRemote[] {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

export async function writeRemotes(file: string, remotes: readonly PairedRemote[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify({ remotes: remotes.slice(0, MAX_REMOTES) }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
