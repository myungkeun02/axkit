import type { MailMessage } from '../../core/contracts/index.js';
import { bareAddress } from './triage-config.js';

export type SpoofReason = 'dmarc' | 'spf-dkim' | 'display-name';

/** "PayPal <billing@paypal.com>" style name hiding another address: "ceo@acme.com <x@gmail.com>". */
function displayNameSpoof(from: string): boolean {
  const name = /^(.*)<[^>]+>\s*$/.exec(from)?.[1] ?? '';
  const inName = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(name)?.[0]?.toLowerCase();
  return inName !== undefined && inName !== bareAddress(from);
}

/**
 * Signs that the sender is not who the mail says: the receiving server's DMARC failed, SPF failed without a passing
 * DKIM, or the display name carries a different address. Undefined when nothing looks wrong (or nothing was checked).
 */
export function spoofReason(message: MailMessage): SpoofReason | undefined {
  const auth = message.auth;
  if (auth?.dmarc === 'fail') return 'dmarc';
  if ((auth?.spf === 'fail' || auth?.spf === 'softfail') && auth.dkim !== 'pass') return 'spf-dkim';
  if (displayNameSpoof(message.from)) return 'display-name';
  return undefined;
}

const AUTOMATED = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[s]?|notifications?|alerts?|newsletter|news|marketing|info@.*mailchimp)/i;

/**
 * Whether a person is waiting for an answer from the owner: not a robot address, not a mailing list, not a notice. The
 * model may still suggest a reply; this decides whether one is written without asking.
 */
export function needsReply(message: MailMessage, kind: string): boolean {
  if (kind === 'notice') return false;
  if (message.bulk === true) return false;
  const local = bareAddress(message.from).split('@')[0] ?? '';
  return !AUTOMATED.test(local);
}

const FACT = [
  /\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/g,
  /\d{1,2}\s?월\s?\d{1,2}\s?일/g,
  /\d{1,2}\/\d{1,2}/g,
  /(오전|오후)?\s?\d{1,2}\s?시(\s?\d{1,2}\s?분)?/g,
  /\d{1,2}:\d{2}/g,
  /\d[\d,.]*\s?(원|만\s?원|억|천만|백만|달러|\$|%|개월|명|개|건)/g,
  /\$\s?\d[\d,.]*/g,
];

function compact(text: string): string {
  return text.replace(/[\s,]/g, '').toLowerCase();
}

/**
 * Dates, times, amounts and counts in a draft that none of its sources (the mail, free times, found files, a pack's
 * facts, the owner profile) contain: the owner should check them before sending. Code only; nothing is changed.
 */
export function unsupportedFacts(draft: string, sources: readonly string[]): string[] {
  const haystack = compact(sources.join('\n'));
  const found = new Set<string>();
  for (const pattern of FACT) {
    for (const match of draft.matchAll(pattern)) {
      const value = match[0].trim();
      if (value === '' || haystack.includes(compact(value))) continue;
      // "14:00" in a draft is fine when the source says "14:00–16:00" or "오후 2시" spelled out differently is not:
      // only exact text is trusted, so the owner sees anything new.
      found.add(value);
    }
  }
  return [...found].slice(0, 6);
}
