import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SOURCE_PORT } from '../../core/remote/protocol.js';

/**
 * The work Mac's side of remote sources lives in its own folder, apart from an assistant home (~/.ax-kit), so the
 * work Mac needs no assistant setup at all: `~/.ax-kit-source/` holds config.json, tokens.json and pairing.json.
 */
export function defaultSourceHome(home: string = homedir()): string {
  return process.env['AX_KIT_SOURCE_HOME'] ?? join(home, '.ax-kit-source');
}

export interface SourceConfig {
  /** "~/Documents" style; nothing outside these is ever read. */
  folders: string[];
  /** Share this Mac's Claude Code / Codex sessions. */
  sessions: boolean;
  port: number;
}

const schema = z.object({
  folders: z.array(z.string().trim().min(1).max(1_024)).max(50).default([]),
  sessions: z.boolean().default(true),
  port: z.number().int().min(1_024).max(65_535).default(DEFAULT_SOURCE_PORT),
});

export function sourceConfigFile(sourceHome: string): string {
  return join(sourceHome, 'config.json');
}

export async function readSourceConfig(sourceHome: string): Promise<SourceConfig | undefined> {
  let text: string;
  try {
    text = await readFile(sourceConfigFile(sourceHome), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Written owner-only (0600) through a temp file, so a crash never leaves half a file. */
export async function writeJsonPrivate(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export async function writeSourceConfig(sourceHome: string, config: SourceConfig): Promise<void> {
  await writeJsonPrivate(sourceConfigFile(sourceHome), config);
}
