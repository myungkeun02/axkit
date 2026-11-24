import { Contracts } from '../../core/contracts/index.js';
import type { FolderScan, RepoDetails } from '../../core/contracts/scan.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { remoteDisplay } from '../../core/remote/ids.js';
import type { ScanItem } from './items.js';

const MAX_README_CHARS = 4_000;
const MAX_COMMITS = 10;

export function displayOf(path: string, home: string): string {
  const remote = remoteDisplay(path);
  if (remote !== undefined) return remote;
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** What the summary model reads for a repository: languages, the readme start and recent commit subjects. */
export function repoBody(item: ScanItem, details: RepoDetails): string {
  const languages = details.languages
    .slice(0, 8)
    .map((language) => `${language.ext}:${language.files}`)
    .join(', ');
  const commits = details.commits
    .slice(0, MAX_COMMITS)
    .map((commit) => `${commit.at}|${commit.subject}`)
    .join('\n');
  const readme = (details.readme ?? '').slice(0, MAX_README_CHARS);
  return `name: ${item.title}\nlanguages: ${languages}\nreadme:\n${readme}\ncommits:\n${commits}`;
}

/** Enough of a résumé or plan for the summary and the talent pack (a few pages). */
export const RICH_CHARS = 16_000;
const PDF_PAGES = 6;

/**
 * Text of a PDF (its text layer, or on-device OCR; needs connector.macos-ocr) or a word file (macOS textutil).
 * Undefined when this Mac has no way to read it; the file then counts by its name only.
 */
export async function richText(ctx: PluginContext, scan: FolderScan, id: string, maxChars: number): Promise<string | undefined> {
  if (id.toLowerCase().endsWith('.pdf')) {
    const ocr = ctx.tryUse(Contracts.ocr);
    if (ocr === undefined) return undefined;
    const result = await ocr.recognize(id, { maxPages: PDF_PAGES });
    return result.text.slice(0, maxChars);
  }
  return await scan.documentText?.(id, maxChars);
}
