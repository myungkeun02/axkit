import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contracts } from '../../core/contracts/index.js';
import type { FileEntry, FileSource } from '../../core/contracts/files.js';
import { extensionOf } from '../../core/files/filter.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { RICH_CHARS } from './bodies.js';
import type { ScanItem } from './items.js';
import { RICH_EXTS, itemsFromDrive } from './items.js';

/** Safety stop for one account: 200 pages of 1,000 files. */
const MAX_PAGES = 200;
const FALLBACK_LIMIT = 1_000;
const MAX_RICH_BYTES = 30_000_000;
const PDF_PAGES = 10;

export interface DriveListing {
  items: ScanItem[];
  /** Which account's Drive reads each file. */
  readers: Map<string, FileSource>;
  accounts: number;
}

/** The main Drive and every other connected account's Drive. */
export function driveSources(ctx: PluginContext): FileSource[] {
  const main = ctx.tryUse(Contracts.filesDrive);
  const others = ctx.tryUse(Contracts.fileSources)?.list().filter((source) => source.label.startsWith('drive:')) ?? [];
  return [...(main !== undefined ? [main] : []), ...others.filter((source) => source !== main)];
}

async function listOne(source: FileSource, signal: AbortSignal, onPage: (count: number) => void): Promise<FileEntry[]> {
  if (source.everything === undefined) return (await source.recent?.({ limit: FALLBACK_LIMIT })) ?? [];
  const out: FileEntry[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (signal.aborted) break;
    const result = await source.everything(token !== undefined ? { pageToken: token } : {});
    out.push(...result.entries);
    onPage(out.length);
    token = result.next;
    if (token === undefined) break;
  }
  return out;
}

/**
 * Every file in every connected Drive: own files, files shared with the account and shared drives, page by page to the
 * end. A file two accounts can both open is read once. One failing account is logged and the others go on.
 */
export async function listDrive(ctx: PluginContext, signal: AbortSignal, onPage: (count: number) => void): Promise<DriveListing> {
  const readers = new Map<string, FileSource>();
  const entries: FileEntry[] = [];
  const sources = driveSources(ctx);
  let before = 0;
  for (const source of sources) {
    try {
      for (const entry of await listOne(source, signal, (count) => onPage(before + count))) {
        if (readers.has(entry.id)) continue;
        readers.set(entry.id, source);
        entries.push(entry);
      }
      before = entries.length;
    } catch (error) {
      ctx.log.warn('onboarding: a Drive could not be listed', { source: source.label, error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  const items = itemsFromDrive(entries).map((item) => {
    const reader = readers.get(item.id);
    const rich = !item.readable && RICH_EXTS.has(extensionOf(item.title)) && item.size <= MAX_RICH_BYTES && reader?.readBytes !== undefined;
    return rich ? { ...item, readable: true, rich: true } : item;
  });
  return { items, readers, accounts: sources.length };
}

/** A PDF or Word file from Drive: downloaded to a private temporary folder, converted on this Mac, then deleted. */
async function richDriveText(ctx: PluginContext, source: FileSource, item: ScanItem): Promise<string | undefined> {
  if (source.readBytes === undefined) return undefined;
  const ext = extensionOf(item.title);
  const pdf = ext === 'pdf';
  const ocr = pdf ? ctx.tryUse(Contracts.ocr) : undefined;
  const scanner = pdf ? undefined : ctx.tryUse(Contracts.folderScan);
  if ((pdf && ocr === undefined) || (!pdf && scanner === undefined)) return undefined;
  const bytes = await source.readBytes(item.id, MAX_RICH_BYTES);
  const dir = await mkdtemp(join(tmpdir(), 'ax-first-look-'));
  try {
    const path = join(dir, `document.${ext}`);
    await writeFile(path, bytes, { mode: 0o600 });
    if (ocr !== undefined) return (await ocr.recognize(path, { maxPages: PDF_PAGES })).text.slice(0, RICH_CHARS);
    return await scanner?.open([dir]).documentText?.(path, RICH_CHARS);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reads a listed Drive file through the account that can open it. */
export function driveReader(ctx: PluginContext, listing: DriveListing, maxBytes: number): (item: ScanItem) => Promise<string | undefined> {
  return async (item) => {
    const source = listing.readers.get(item.id);
    if (source === undefined || !item.readable) return undefined;
    if (item.rich === true) return await richDriveText(ctx, source, item);
    return await source.readText(item.id, maxBytes);
  };
}
