import { maskedQuote, stripInjections } from './injection.js';
import type { InjectionHit } from './injection.js';

export interface InjectionReport {
  kind: string;
  /** The strongest hit's kind and score; the quote is masked. */
  hit: { kind: string; score: number; quote: string };
  count: number;
}

type Reporter = (report: InjectionReport) => void;

let reporter: Reporter | undefined;

/** The app wires this once to its audit log and notices; tests leave it unset. Returns the previous reporter. */
export function setInjectionReporter(next: Reporter | undefined): Reporter | undefined {
  const previous = reporter;
  reporter = next;
  return previous;
}

function report(kind: string, hits: readonly InjectionHit[]): void {
  if (reporter === undefined || hits.length === 0) return;
  const strongest = hits.reduce((best, hit) => (hit.score > best.score ? hit : best));
  try {
    reporter({ kind, count: hits.length, hit: { kind: strongest.kind, score: strongest.score, quote: maskedQuote(strongest.quote) } });
  } catch {
    // Reporting can never bring the stripped text back or stop the task.
  }
}

function escapeData(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Text from outside the owner, cleaned of instruction attempts. Use before any untrusted text reaches a model. */
export function guardText(kind: string, text: string): string {
  const result = stripInjections(text);
  report(kind, result.hits);
  return result.text;
}

/** Wraps non-owner text so the model is told it is data, never an instruction, after stripping injection lines. */
export function wrapData(kind: string, text: string): string {
  return `<data kind="${kind}">\n${escapeData(guardText(kind, text))}\n</data>`;
}

/** Every string inside a value with injection lines stripped (one bad mail no longer blanks the whole result). */
export function guardDeep<T>(kind: string, value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return guardText(kind, value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => guardDeep(kind, item, depth + 1)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, guardDeep(kind, item, depth + 1)])) as T;
  }
  return value;
}

/** Like wrapData for text already guarded piece by piece (guardDeep): only escaped, not stripped again as a whole. */
export function wrapGuarded(kind: string, text: string): string {
  return `<data kind="${kind}">\n${escapeData(text)}\n</data>`;
}
