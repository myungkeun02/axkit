import type { Doc } from '../contracts/docs.js';

const DAY_LENGTH = 10;

function ymdOf(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toISOString().slice(0, DAY_LENGTH);
}

/** Markdown view of one document: title, review banner, body, then the newest dated entries. */
export function renderDoc(doc: Doc, opts: { maxEntries: number; reviewLabel: string }): string {
  const lines = [`# ${doc.title}`];
  if (doc.needsReview) {
    lines.push(`> ${opts.reviewLabel}${doc.reviewReason ? `: ${doc.reviewReason}` : ''}`);
  }
  if (doc.body.trim() !== '') lines.push(doc.body);
  const newest = [...doc.entries].sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.max(0, opts.maxEntries));
  for (const entry of newest) {
    lines.push(`- ${ymdOf(entry.at)} ${entry.text} (${entry.author.id})`);
  }
  return lines.join('\n');
}
