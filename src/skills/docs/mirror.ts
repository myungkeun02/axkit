import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocStore } from '../../core/contracts/docs.js';
import { renderDoc } from '../../core/docs/render.js';

export interface MirrorFs {
  mkdir(dir: string): Promise<void>;
  read(file: string): Promise<string | undefined>;
  write(file: string, data: string): Promise<void>;
}

export const NODE_MIRROR_FS: MirrorFs = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  },
  async read(file) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  async write(file, data) {
    await writeFile(file, data, { mode: 0o600 });
    // umask can widen the mode on create, so it is set again.
    await chmod(file, 0o600);
  },
};

/** Doc ids use ':' as a separator; on disk it becomes '__' so every id stays one path segment. */
export function fileNameOf(id: string): string {
  return `${id.replace(/[^a-z0-9._-]/g, '__')}.md`;
}

/**
 * Writes every structured document as Markdown into one folder next to the knowledge base, so the owner reads
 * team docs, decisions and the improvement log in the same place as the rest of the knowledge.
 * The store stays the source of truth; these files are a view and are rewritten only when they change.
 */
export async function mirrorDocs(
  docs: DocStore,
  dir: string,
  reviewLabel: string,
  fs: MirrorFs = NODE_MIRROR_FS,
): Promise<number> {
  await fs.mkdir(dir);
  let written = 0;
  for (const doc of await docs.list()) {
    const file = path.join(dir, fileNameOf(doc.id));
    const text = `${renderDoc(doc, { maxEntries: 50, reviewLabel })}\n`;
    if ((await fs.read(file)) === text) continue;
    await fs.write(file, text);
    written += 1;
  }
  return written;
}
