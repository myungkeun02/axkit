/**
 * Smishing checks in code. Links are only parsed as text here: nothing in this skill ever opens or follows one.
 * A message is suspicious on a strong sign alone (an .apk link, a lookalike domain, a bare IP link) or on a link or
 * call-back number together with a lure or a sender that does not match the organization the text claims to be.
 */
export type SmishingReason =
  | 'apk'
  | 'lookalike'
  | 'ip_link'
  | 'short_link'
  | 'odd_domain'
  | 'lure'
  | 'sender_mismatch'
  | 'callback';

export interface SmishingVerdict {
  suspicious: boolean;
  reasons: SmishingReason[];
  /** Hosts of the links, defanged for display ("kbstar-secure[.]com"); never a clickable link. */
  hosts: string[];
}

interface Brand {
  /** Words in a host that point at this organization. */
  tokens: readonly string[];
  /** Registrable domains the organization really uses. */
  official: readonly string[];
  /** How the text names it ("[국민은행]"). */
  names: RegExp;
}

const BRANDS: readonly Brand[] = [
  { tokens: ['kbstar', 'kbcard', 'kbbank'], official: ['kbstar.com', 'kbcard.com', 'kbfg.com'], names: /국민은행|KB국민|KB\s*카드/ },
  { tokens: ['shinhan'], official: ['shinhan.com', 'shinhancard.com'], names: /신한(은행|카드)/ },
  { tokens: ['wooribank', 'wooricard'], official: ['wooribank.com', 'wooricard.com'], names: /우리(은행|카드)/ },
  { tokens: ['hanabank', 'hanacard', 'kebhana'], official: ['hanabank.com', 'hanacard.co.kr', 'kebhana.com'], names: /하나(은행|카드)/ },
  { tokens: ['nonghyup', 'nhbank', 'nhcard'], official: ['nonghyup.com', 'nhbank.com', 'nhcard.co.kr'], names: /농협|NH(은행|카드)/ },
  { tokens: ['ibk'], official: ['ibk.co.kr'], names: /기업은행|IBK/ },
  { tokens: ['kakaobank'], official: ['kakaobank.com'], names: /카카오뱅크/ },
  { tokens: ['toss'], official: ['toss.im', 'tossbank.com'], names: /토스/ },
  { tokens: ['cjlogistics', 'cjlogis', 'doortodoor'], official: ['cjlogistics.com'], names: /CJ\s*대한통운|대한통운/ },
  { tokens: ['epost', 'koreapost'], official: ['epost.go.kr', 'koreapost.go.kr'], names: /우체국/ },
  { tokens: ['hanjin'], official: ['hanjin.com', 'hanjin.co.kr'], names: /한진택배/ },
  { tokens: ['lotteglogis'], official: ['lotteglogis.com'], names: /롯데택배|롯데글로벌/ },
  { tokens: ['hometax', 'nts'], official: ['hometax.go.kr', 'nts.go.kr'], names: /국세청|홈택스/ },
  { tokens: ['police'], official: ['police.go.kr'], names: /경찰청|경찰서/ },
  { tokens: ['spo', 'prosecutor'], official: ['spo.go.kr'], names: /검찰청|검찰/ },
  { tokens: ['nhis'], official: ['nhis.or.kr'], names: /건강보험/ },
  { tokens: ['govkr', 'gov24'], official: ['gov.kr', 'go.kr'], names: /정부24|행정안전부|주민센터|교통민원|과태료/ },
];

const SHORTENERS = new Set([
  'bit.ly', 'me2.do', 'han.gl', 'vo.la', 'url.kr', 'buly.kr', 'tinyurl.com', 'goo.gl', 'is.gd', 't.ly', 'shorturl.at',
  'cutt.ly', 'rb.gy', 'ow.ly', 'naver.me', 'zrr.kr', 'c11.kr', 'muz.so', 'tny.im', 'u.to',
]);
const ODD_TLDS = new Set([
  'xyz', 'top', 'icu', 'click', 'shop', 'live', 'vip', 'cc', 'tk', 'ml', 'ga', 'cf', 'gq', 'buzz', 'cyou', 'rest',
  'monster', 'sbs', 'cfd', 'online', 'site', 'work', 'support', 'info', 'club',
]);

const LINK = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"']*)?|https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/[^\s<>"']*)?)/gi;
const IP_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const APK = /\.apk\b|앱\s*(을\s*)?설치|보안\s*(앱|프로그램)\s*(을\s*)?설치|install\s+(the\s+)?app/i;
const LURES: readonly RegExp[] = [
  /주소\s*(지)?\s*(가\s*)?(불명|확인|오류|수정|변경|부정확)|주소\s*불일치|도로명\s*주소\s*(가\s*)?(잘못|미기재)/,
  /(반송|보관)\s*(예정|중|처리)|배송\s*(불가|실패|중단|지연\s*안내)|(미수령|수취인\s*부재)/,
  /과태료|범칙금|벌점|교통\s*위반|체납|압류|출석\s*요구|소환장|벌금/,
  /미납|연체|(즉시|긴급|오늘\s*중|금일\s*중|당일)\s*(납부|결제|확인|조치)|결제\s*(가\s*)?(실패|보류|중지)/,
  /(계정|계좌|카드)\s*(이\s*)?(정지|차단|잠금|해지\s*예정)|본인\s*(인증|확인)\s*(이\s*)?(필요|하세요|바랍니다)/,
  /환급(금)?|지원금\s*(신청|지급|대상)|당첨|무료\s*쿠폰|포인트\s*(소멸|만료)/,
  /부고|청첩장|모바일\s*초대장|돌잔치\s*초대/,
  /suspend|verify your|unpaid|overdue|final notice|delivery failed|update your address/i,
];
const CALLBACK_CLAIM = /(해외|국외)\s*(결제|승인|이용)|결제\s*승인|승인\s*완료|본인\s*(이\s*)?아닐\s*(경우|시)|본인이\s*아닌\s*경우/;
const PERSONAL_NUMBER = /(?:^|[^\d])(?:\+(?!82)\d{1,3}|00\d{1,2}|0(?:10|70)|\+82[\s-]?10)[\s-]?\d{3,4}[\s-]?\d{4}/;
const OFFICIAL_SENDER = /^(?:1[5-9]\d{2}-?\d{4}|0(?:2|[3-6]\d)-?\d{3,4}-?\d{4}|#\d+|\d{3,4})$/;

function hostOf(link: string): string {
  const withoutScheme = link.replace(/^https?:\/\//i, '');
  return (withoutScheme.split(/[/:?#]/)[0] ?? '').toLowerCase().replace(/\.$/, '');
}

function endsWithDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function distanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** A host that names a bank, courier or agency but is not one of its real domains, or misspells one. */
function isLookalike(host: string): boolean {
  const labels = host.split('.');
  for (const brand of BRANDS) {
    if (brand.official.some((domain) => endsWithDomain(host, domain))) return false;
  }
  return BRANDS.some((brand) => {
    const named = brand.tokens.some((token) =>
      token.length <= 3
        ? labels.some((label) => label === token || label.startsWith(`${token}-`))
        : host.replace(/-/g, '').includes(token),
    );
    const misspelt = brand.official.some((domain) => {
      const first = domain.split('.')[0] ?? '';
      return first.length >= 5 && labels.some((label) => label !== first && distanceAtMostOne(label, first));
    });
    return named || misspelt;
  });
}

export function linkHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(LINK)) {
    const raw = match[1] ?? '';
    // "3.5" or "kg.원" are not links; a bare host needs a known TLD shape
    if (!/^https?:\/\//i.test(raw) && !/[a-z0-9]{2,}\.[a-z]{2,}/i.test(raw)) continue;
    const host = hostOf(raw);
    if (host !== '') hosts.add(host);
  }
  return [...hosts];
}

export function defang(host: string): string {
  return host.replaceAll('.', '[.]');
}

function claimedBrand(text: string): Brand | undefined {
  return BRANDS.find((brand) => brand.names.test(text));
}

function senderMismatch(text: string, from: string | undefined): boolean {
  const sender = (from ?? '').replace(/\s/g, '');
  if (sender === '' || claimedBrand(text) === undefined) return false;
  if (OFFICIAL_SENDER.test(sender)) return false;
  return PERSONAL_NUMBER.test(` ${sender}`) || /^\+/.test(sender);
}

export function checkSmishing(text: string, from: string | undefined): SmishingVerdict {
  const hosts = linkHosts(text);
  const reasons = new Set<SmishingReason>();
  if (APK.test(text) && (hosts.length > 0 || /\.apk\b/i.test(text))) reasons.add('apk');
  for (const host of hosts) {
    if (IP_HOST.test(host)) reasons.add('ip_link');
    else if (SHORTENERS.has(host)) reasons.add('short_link');
    else if (isLookalike(host)) reasons.add('lookalike');
    if (ODD_TLDS.has(host.split('.').at(-1) ?? '')) reasons.add('odd_domain');
  }
  const lure = LURES.some((rule) => rule.test(text));
  if (lure) reasons.add('lure');
  if (senderMismatch(text, from)) reasons.add('sender_mismatch');
  const callback = CALLBACK_CLAIM.test(text) && PERSONAL_NUMBER.test(text);
  if (callback) reasons.add('callback');

  const strong = reasons.has('apk') || reasons.has('lookalike') || reasons.has('ip_link') || callback;
  const linked = hosts.length > 0;
  const oddLink = reasons.has('short_link') || reasons.has('odd_domain');
  const suspicious =
    strong ||
    (linked && (lure || reasons.has('sender_mismatch'))) ||
    (oddLink && claimedBrand(text) !== undefined);
  return { suspicious, reasons: suspicious ? [...reasons] : [], hosts: hosts.map(defang) };
}
