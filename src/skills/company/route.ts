import type { TeamConfig } from './types.js';

const SEPARATORS = new Set([':', ' ', ',']);

function mentionPattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9-])@${escaped}(?![a-z0-9-])`, 'i');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** "회사: ..." (also space or comma) hands the rest to company mode. */
export function parseCompanyRequest(text: string, prefix: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  const rest = trimmed.slice(prefix.length);
  const separator = rest[0];
  if (separator === undefined || !SEPARATORS.has(separator)) return undefined;
  const request = rest.slice(1).trim();
  return request === '' ? undefined : request;
}

/** Explicit @team wins; otherwise the team whose scope words appear most; ties keep config order. */
export function keywordTeam(text: string, teams: readonly TeamConfig[]): TeamConfig | undefined {
  const normalized = text.normalize('NFC').toLowerCase();
  for (const team of teams) {
    if (mentionPattern(team.id).test(normalized)) return team;
  }
  let best: TeamConfig | undefined;
  let bestScore = 0;
  for (const team of teams) {
    let score = 0;
    for (const word of team.scope) {
      score += countOccurrences(normalized, word.normalize('NFC').toLowerCase());
    }
    if (score > bestScore) {
      best = team;
      bestScore = score;
    }
  }
  return best;
}
