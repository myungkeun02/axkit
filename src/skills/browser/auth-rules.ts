/**
 * Which verification steps the browser may complete by itself. Pure: no store, no network.
 * Money-grade sites and legal or money-moving steps always go to the owner first, whatever the allowed list says.
 */

/** Second-level labels under a country code ("example.co.kr", "example.com.au"). */
const COUNTRY_SLD = new Set(['co', 'or', 'go', 'ac', 'ne', 're', 'pe', 'com', 'net', 'org', 'gov', 'edu']);

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lower-cased host of an http(s) address, or undefined. */
export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return HOST.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** "www.mail.example.co.kr" → "example.co.kr". Good enough for matching a site to its mail and links. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const tld = labels.at(-1) ?? '';
  const sld = labels.at(-2) ?? '';
  const take = tld.length === 2 && COUNTRY_SLD.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** An allowed-list entry ("example.com" or "https://example.com/") matches the site and its subdomains. */
export function siteAllowed(host: string, sites: readonly string[]): boolean {
  const domain = registrableDomain(host);
  return sites.some((entry) => {
    const site = hostOf(entry.includes('://') ? entry : `https://${entry}`);
    return site !== undefined && registrableDomain(site) === domain;
  });
}

/** Banks, card companies, brokers and carriers (Korean pack first; owners add more in config). */
export const FINANCIAL_DOMAINS: readonly string[] = [
  'kbstar.com', 'shinhan.com', 'wooribank.com', 'hanabank.com', 'kebhana.com', 'ibk.co.kr', 'nonghyup.com',
  'kakaobank.com', 'tossbank.com', 'kbanknow.com', 'busanbank.co.kr', 'knbank.co.kr', 'epostbank.go.kr',
  'citibank.co.kr', 'standardchartered.co.kr', 'kfcc.co.kr',
  'hyundaicard.com', 'samsungcard.com', 'shinhancard.com', 'kbcard.com', 'lottecard.co.kr', 'bccard.com',
  'hanacard.co.kr', 'wooricard.com', 'nhcard.co.kr',
  'samsungpop.com', 'miraeasset.com', 'kiwoom.com', 'truefriend.com', 'nhqv.com', 'kbsec.com', 'shinhansec.com',
  'tossinvest.com',
  'kt.com', 'tworld.co.kr', 'sktelecom.com', 'uplus.co.kr', 'lguplus.co.kr',
  'paypal.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'americanexpress.com',
];

/** Steps that move money or sign something in the owner's name. */
const HIGH_RISK_TEXT = new RegExp(
  [
    '이체', '송금', '대출', '카드\\s*(?:발급|신청|재발급)', '계좌\\s*(?:개설|신설)', '비대면\\s*계좌',
    '명의\\s*(?:변경|이전)', '개통', '번호\\s*이동', '보험\\s*(?:가입|청약)', '인증서\\s*(?:발급|재발급)', '해지',
    'wire\\s*transfer', 'money\\s*transfer', '\\bloan\\b', 'open\\s+(?:an?\\s+)?account', 'cancel\\s+(?:my\\s+)?account',
  ].join('|'),
  'i',
);

export type AutoAuthDecision = 'ok' | 'confirm' | 'not_allowed';

export interface AutoAuthInput {
  pageUrl: string;
  pageText: string;
  goal: string;
  sites: readonly string[];
  financialSites: readonly string[];
}

/** Fail closed: an unknown host or a page outside the list never gets a code. */
export function decideAutoAuth(input: AutoAuthInput): AutoAuthDecision {
  const host = hostOf(input.pageUrl);
  if (host === undefined || !siteAllowed(host, input.sites)) return 'not_allowed';
  const domain = registrableDomain(host);
  const financial = [...FINANCIAL_DOMAINS, ...input.financialSites].some(
    (entry) => registrableDomain(entry.toLowerCase()) === domain,
  );
  if (financial || HIGH_RISK_TEXT.test(input.goal) || HIGH_RISK_TEXT.test(input.pageText)) return 'confirm';
  return 'ok';
}

const LINK = /https:\/\/[^\s"'<>)\]]+/g;
const LINK_PATH = /verif|confirm|auth|activate|magic|login|signin|인증/i;
const MAIL_CODE = /(?:인증|확인|verification|security|one[- ]time|login)[^\d\n]{0,40}(\d{4,8})\b|\b(\d{4,8})\b[^\d\n]{0,20}(?:인증|verification code|is your code)/i;

/** A verification link on the site's own domain, or a 4–8 digit code next to verification words. */
export function extractMailStep(
  body: string,
  domain: string,
): { kind: 'code'; code: string } | { kind: 'link'; url: string } | undefined {
  for (const raw of body.match(LINK) ?? []) {
    const host = hostOf(raw);
    if (host !== undefined && registrableDomain(host) === domain && LINK_PATH.test(raw)) return { kind: 'link', url: raw };
  }
  const match = MAIL_CODE.exec(body);
  const code = match?.[1] ?? match?.[2];
  return code === undefined ? undefined : { kind: 'code', code };
}

/** The address domain of a From header (`"Shop" <no-reply@mail.example.com>` → mail.example.com). */
export function fromDomain(from: string): string | undefined {
  const match = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(from);
  return match?.[1]?.toLowerCase();
}
