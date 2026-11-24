import { lstat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { isExcludedHomePath, relativeToHome } from '../../core/files/home.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { Tool } from '../../core/tools/types.js';
import type { FilesTexts } from './locale.js';
import { localStamp } from './tools.js';

export const FIND_MAX = 20;
const FIND_TIMEOUT_MS = 15_000;
/** Spotlight can answer thousands of lines; only this many are looked at. */
const MAX_LINES = 2_000;

const findInput = z.object({
  query: z.string().trim().min(1).max(200).describe('A file name (or part of one), or words inside the file.'),
  kind: z.enum(['name', 'content']).default('name').describe('"name" matches file names; "content" also searches inside files.'),
  limit: z.number().int().min(1).max(FIND_MAX).default(10).describe('How many files to return, at most 20.'),
});

export type FilesFindInput = z.infer<typeof findInput>;

export interface FoundFile {
  name: string;
  /** "~/Documents/a.pdf"; pass it to files.read (source "home") or files.share_to_app. */
  path: string;
  size: number;
  /** Local time in the owner's zone. */
  modifiedAt: string;
}

export interface FilesFindDeps {
  run: ProcessRunner;
  home: string;
  timeZone: string;
  texts: FilesTexts;
}

/** Spotlight arguments: always limited to home; a leading "-" never reaches mdfind as an option. */
export function mdfindArgs(query: string, kind: 'name' | 'content', home: string): string[] | undefined {
  const cleaned = query.replace(/^-+/, '').trim();
  if (cleaned === '') return undefined;
  return kind === 'name' ? ['-onlyin', home, '-name', cleaned] : ['-onlyin', home, cleaned];
}

/** Spotlight output → files under home that no exclusion rule covers, plain files only, at most `limit`. */
export async function filterFound(stdout: string, home: string, limit: number, timeZone: string): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n').slice(0, MAX_LINES)) {
    if (found.length >= limit) break;
    const path = line.trim();
    if (path === '' || !isAbsolute(path) || seen.has(path)) continue;
    seen.add(path);
    const rel = relativeToHome(path, home);
    if (rel === undefined || isExcludedHomePath(rel)) continue;
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    found.push({
      name: basename(path),
      path: `~/${rel}`,
      size: info.size,
      modifiedAt: localStamp(new Date(info.mtimeMs).toISOString(), timeZone),
    });
  }
  return found;
}

/** Tool "files.find": Mac-wide file search with Spotlight (mdfind) inside home. Read-only, metadata only. */
export function filesFindTool(deps: FilesFindDeps): Tool<FilesFindInput, FoundFile[]> {
  return {
    name: 'files.find',
    description:
      'Find files anywhere in the home folder on this Mac with Spotlight, by name or by contents. Returns names, paths, sizes and dates only. App data, hidden folders and files that look like keys or passwords are never shown.',
    input: findInput,
    effects: ['read'],
    async run(input) {
      const args = mdfindArgs(input.query, input.kind, deps.home);
      if (args === undefined) throw new Error(deps.texts.badQuery);
      let result;
      try {
        result = await deps.run('mdfind', args, { timeoutMs: FIND_TIMEOUT_MS });
      } catch {
        throw new Error(deps.texts.spotlightUnavailable);
      }
      if (result.timedOut || result.code !== 0) throw new Error(deps.texts.spotlightFailed);
      return await filterFound(result.stdout, deps.home, Math.min(input.limit, FIND_MAX), deps.timeZone);
    },
  };
}
