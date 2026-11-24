import { memoryTexts } from './locale.js';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ANGLE_EMAIL = /<\s*([^<>\s]+@[^<>\s]+)\s*>/;
const QUOTES = /^["']|["']$/g;

export interface ParsedAddress {
  name?: string;
  email?: string;
}

/** The lowercased bare address in "Name <a@b>" or in a bare address. */
export function bareEmail(value: string): string | undefined {
  const angle = ANGLE_EMAIL.exec(value);
  if (angle?.[1] !== undefined) return angle[1].toLowerCase();
  const trimmed = value.trim();
  return EMAIL.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** Splits a mail "From" value into a display name and a bare address. */
export function parseAddress(value: string): ParsedAddress {
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  const angle = ANGLE_EMAIL.exec(trimmed);
  if (angle?.[1] !== undefined) {
    const name = trimmed.slice(0, angle.index).trim().replace(QUOTES, '').trim();
    return name.length > 0 ? { name, email: angle[1].toLowerCase() } : { email: angle[1].toLowerCase() };
  }
  if (EMAIL.test(trimmed)) return { email: trimmed.toLowerCase() };
  return { name: trimmed };
}

function stripLeading(value: string, prefixes: readonly string[]): string {
  let current = value;
  for (;;) {
    const prefix = prefixes.find(
      (candidate) => current.length > candidate.length && current.toLowerCase().startsWith(candidate),
    );
    if (prefix === undefined) return current;
    current = current.slice(prefix.length).replace(/^\.?\s*/, '');
  }
}

/** One-character particles only come off words that stay at least two characters: "지은" is a name. */
function stripTrailing(value: string, suffixes: readonly string[]): string {
  const ordered = [...suffixes].sort((a, b) => b.length - a.length);
  let current = value;
  for (;;) {
    const suffix = ordered.find((candidate) => {
      const rest = current.length - candidate.length;
      return rest >= (candidate.length >= 2 ? 1 : 2) && current.endsWith(candidate);
    });
    if (suffix === undefined) return current.trim();
    current = current.slice(0, -suffix.length).trim();
  }
}

/**
 * Stable key for a person: "민수님이랑" and "민수" share one key, and an address matches only itself.
 * An address input ("Name <a@b>") keys by the lowercased bare address.
 */
export function personKey(value: string, language = 'ko'): string {
  const email = bareEmail(value);
  if (email !== undefined) return email;
  const texts = memoryTexts(language);
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  const withoutPrefix = stripLeading(normalized, texts.personPrefixes);
  const withoutSuffix = stripTrailing(withoutPrefix, [...texts.particles, ...texts.personSuffixes]);
  return withoutSuffix.toLowerCase();
}

/** Bounded edit distance for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (previous[j] ?? 0) + 1;
      const deletion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
