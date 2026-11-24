export { wrapData } from '../../core/text/data.js';

/** Models sometimes wrap JSON in a fence or a sentence; keep the outermost object only. */
export function jsonObjectText(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
