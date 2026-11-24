import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { monthOf, monthPlus } from '../../core/time/local-day.js';
import type { ReceiptsTexts } from './locale.js';
import { loadMonth } from './store.js';
import type { DocEntry } from './types.js';
import { DOC_KINDS } from './types.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const searchInput = z.object({
  text: z.string().min(1).max(200).optional().describe('Words matched against subject, sender, merchant and kind.'),
  month: z.string().regex(MONTH).optional().describe('Month to search in YYYY-MM. Defaults to the last 12 months.'),
  limit: z.number().int().min(1).max(30).optional().describe('Maximum results; defaults to 20.'),
});

const listInput = z.object({
  month: z.string().regex(MONTH).optional().describe('Month in YYYY-MM; defaults to the current month.'),
  kind: z.enum(DOC_KINDS).optional().describe('Only documents of this kind.'),
});

type SearchInput = z.infer<typeof searchInput>;
type ListInput = z.infer<typeof listInput>;

function haystack(entry: DocEntry, texts: ReceiptsTexts): string {
  return [entry.subject, entry.from, entry.merchant ?? '', entry.kind, texts.kindLabel(entry.kind)]
    .join('\n')
    .toLowerCase();
}

function newestFirst(entries: readonly DocEntry[]): DocEntry[] {
  return [...entries].sort((left, right) => right.at.localeCompare(left.at));
}

function recentMonths(now: Date, timeZone: string, count: number): string[] {
  const current = monthOf(now, timeZone);
  return Array.from({ length: count }, (_, index) => monthPlus(current, -index));
}

/** Tool "docs.search": metadata and vault-relative paths only, never file contents. */
export function docsSearchTool(ctx: PluginContext, texts: ReceiptsTexts): Tool<SearchInput, DocEntry[]> {
  return {
    name: 'docs.search',
    description:
      'Search the receipt and document index by words in the subject, sender, merchant or kind. ' +
      'Returns metadata and vault-relative file paths; it never returns file contents.',
    input: searchInput,
    effects: ['read'],
    async run(input) {
      const timeZone = ctx.assistant.timezone;
      const months = input.month !== undefined ? [input.month] : recentMonths(ctx.clock.now(), timeZone, 12);
      const loaded = await Promise.all(months.map((month) => loadMonth(ctx.kv, month)));
      const words = (input.text ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== '');
      const matched = loaded
        .flat()
        .filter((entry) => words.every((word) => haystack(entry, texts).includes(word)));
      return newestFirst(matched).slice(0, input.limit ?? 20);
    },
  };
}

/** Tool "docs.list": one month of the index, optionally filtered by kind. */
export function docsListTool(ctx: PluginContext): Tool<ListInput, DocEntry[]> {
  return {
    name: 'docs.list',
    description:
      'List indexed receipts and documents for a month, newest first. ' +
      'Returns metadata and vault-relative file paths; it never returns file contents.',
    input: listInput,
    effects: ['read'],
    async run(input) {
      const month = input.month ?? monthOf(ctx.clock.now(), ctx.assistant.timezone);
      const entries = await loadMonth(ctx.kv, month);
      const filtered = input.kind === undefined ? entries : entries.filter((entry) => entry.kind === input.kind);
      return newestFirst(filtered);
    },
  };
}

export function registerDocsTools(ctx: PluginContext, texts: ReceiptsTexts): void {
  ctx.registerTool(docsSearchTool(ctx, texts));
  ctx.registerTool(docsListTool(ctx));
}
