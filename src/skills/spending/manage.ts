/**
 * Where an owner cancels well-known recurring services. Public service names only: this table is guidance text,
 * never an action. The skill has no tool that cancels, pays or sends anything.
 */
const MANAGE: readonly (readonly [RegExp, string])[] = [
  [/netflix|넷플릭스/i, 'https://www.netflix.com/account'],
  [/youtube\s*(?:premium|music)|유튜브\s*(?:프리미엄|뮤직)/i, 'https://www.youtube.com/paid_memberships'],
  [/spotify|스포티파이/i, 'https://www.spotify.com/account/subscription/'],
  [/apple|애플|icloud|아이클라우드|app\s*store/i, 'https://apps.apple.com/account/subscriptions'],
  [/google\s*play|구글\s*플레이/i, 'https://play.google.com/store/account/subscriptions'],
  [/chatgpt|openai/i, 'https://chatgpt.com/#settings/Subscription'],
  [/claude|anthropic/i, 'https://claude.ai/settings/billing'],
  [/github/i, 'https://github.com/settings/billing'],
  [/notion/i, 'https://www.notion.so/my-account'],
  [/adobe/i, 'https://account.adobe.com/plans'],
  [/microsoft|office\s*365/i, 'https://account.microsoft.com/services'],
  [/disney|디즈니/i, 'https://www.disneyplus.com/account'],
  [/amazon\s*prime|prime\s*video|아마존\s*프라임/i, 'https://www.amazon.com/gp/primecentral'],
  [/dropbox|드롭박스/i, 'https://www.dropbox.com/account/plan'],
  [/figma/i, 'https://www.figma.com/settings'],
  [/vercel/i, 'https://vercel.com/account/billing'],
  [/cloudflare/i, 'https://dash.cloudflare.com/'],
  [/amazon\s*web\s*services|\baws\b/i, 'https://console.aws.amazon.com/billing/'],
  [/canva|캔바/i, 'https://www.canva.com/settings/billing'],
  [/zoom|줌/i, 'https://zoom.us/billing'],
  [/쿠팡\s*와우|coupang\s*wow/i, 'https://www.coupang.com'],
  [/네이버\s*플러스|naver\s*plus|네이버플러스/i, 'https://nid.naver.com/membership/my'],
  [/티빙|tving/i, 'https://www.tving.com/my/main'],
  [/웨이브|wavve/i, 'https://www.wavve.com/my'],
  [/왓챠|watcha/i, 'https://watcha.com/settings'],
  [/밀리의\s*서재|millie/i, 'https://www.millie.co.kr'],
  [/멜론|melon/i, 'https://www.melon.com'],
  [/지니|genie/i, 'https://www.genie.co.kr'],
];

/** The account page for a known service, or undefined when the name is not in the table. */
export function manageUrl(merchant: string): string | undefined {
  return MANAGE.find(([pattern]) => pattern.test(merchant))?.[1];
}
