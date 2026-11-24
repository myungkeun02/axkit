import type { HandoffReason } from '../../../core/contracts/index.js';
import { isHttpUrl } from '../url.js';
import type { BrowserAction, PageElement } from './types.js';

/**
 * Hard rules decided in code, whatever the model or the page says. The agent never pays, never presses a final
 * order / booking / transfer / delete button, never types into a password, card or ID field, never types a card or
 * resident-registration number, and never leaves the task's sites. Each of these hands the step to the owner instead.
 */

/** Pressing these moves money or makes a commitment in the owner's name. */
const PAY_BUTTON = /결제|지불|구매\s*하기|구매\s*확정|바로\s*구매|주문\s*하기|주문\s*확정|송금|이체|충전\s*하기|\bpay\b|pay now|place (?:your )?order|buy now|checkout|complete purchase|submit payment/i;
const COMMIT_BUTTON = /^\s*예매\s*$|예매\s*(?:하기|확정|완료)|예약\s*(?:확정|완료|하기)|신청\s*(?:하기|완료|확정)|제출|접수\s*하기|가입\s*하기|탈퇴|해지|삭제|취소\s*(?:하기|확정)|\bsubmit\b|confirm (?:booking|reservation)|\bbook now\b|\breserve\b|\bdelete\b|\bunsubscribe\b|send message|보내기|전송/i;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/;
const RESIDENT_NUMBER = /\b\d{6}\s*-\s*[1-8]\d{6}\b/;

/** Sites a login may pass through on the way back to the task's site. */
export const LOGIN_HOSTS: readonly string[] = [
  'nid.naver.com', 'accounts.kakao.com', 'kauth.kakao.com', 'accounts.google.com', 'appleid.apple.com',
  'login.microsoftonline.com', 'member.coupang.com', 'login.coupang.com',
];

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'reject'; error: string }
  | { kind: 'handoff'; reason: HandoffReason; note: string; button?: string };

export interface PolicyContext {
  /**
   * Hosts this task may visit (the start site's domain and any the owner named), plus LOGIN_HOSTS. The start page's own
   * redirect to its new address (letskorail.com → korail.com) is added when the run opens it.
   */
  allowedDomains: string[];
  /** An owner-approved checkpoint lets exactly this button be pressed once (a seat hold the owner approved). */
  approvedCommit?: string;
}

export function domainOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const tld = labels.at(-1) ?? '';
  const sld = labels.at(-2) ?? '';
  const take = tld.length === 2 && ['co', 'or', 'go', 'ac', 'ne', 're', 'com', 'net', 'org'].includes(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function allowedDomainsFor(startUrl: string, extra: readonly string[] = []): string[] {
  const hosts = [startUrl, ...extra]
    .map((entry) => {
      try {
        return new URL(entry.includes('://') ? entry : `https://${entry}`).hostname;
      } catch {
        return '';
      }
    })
    .filter((host) => host !== '');
  return [...new Set([...hosts.map(domainOf), ...LOGIN_HOSTS])];
}

export function inScope(url: string, ctx: PolicyContext): boolean {
  if (!isHttpUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ctx.allowedDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`) || domainOf(host) === allowed);
  } catch {
    return false;
  }
}

export function judgeAction(action: BrowserAction, element: PageElement | undefined, ctx: PolicyContext): Verdict {
  switch (action.kind) {
    case 'navigate':
      if (!isHttpUrl(action.url)) return { kind: 'reject', error: 'only http(s) addresses' };
      if (!inScope(action.url, ctx)) return { kind: 'reject', error: `${action.url} is outside this task's sites` };
      return { kind: 'allow' };
    case 'fill':
      if (element?.secret === true) {
        const reason: HandoffReason = /password|비밀번호|암호|pin|OTP|인증/i.test(element.name) ? 'login' : 'payment';
        return { kind: 'handoff', reason, note: `"${element.name}" is for the owner to type` };
      }
      if (CARD_NUMBER.test(action.text) || RESIDENT_NUMBER.test(action.text)) {
        return { kind: 'handoff', reason: 'payment', note: 'a card or ID number is for the owner to type' };
      }
      return { kind: 'allow' };
    case 'click': {
      const name = element?.name ?? '';
      // payment first: no approval on a card ever lets the browser pay
      if (PAY_BUTTON.test(name)) return { kind: 'handoff', reason: 'payment', note: `"${name}" moves money; the owner presses it` };
      if (ctx.approvedCommit !== undefined && name.trim() !== '' && name.trim() === ctx.approvedCommit.trim()) return { kind: 'allow' };
      if (COMMIT_BUTTON.test(name)) {
        return { kind: 'handoff', reason: 'other', note: `"${name}" is a final step; the owner confirms it`, button: name.trim().slice(0, 80) };
      }
      return { kind: 'allow' };
    }
    default:
      return { kind: 'allow' };
  }
}
