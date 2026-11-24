import type { SpendCategory } from '../../../core/contracts/index.js';
import type { CategoryRule } from './rules-ko.js';
import { KO_RULES } from './rules-ko.js';

const EN_RULES: readonly CategoryRule[] = [
  { category: 'food', pattern: /uber\s*eats|doordash|grubhub|restaurant|burger|pizza|bakery|deli|kitchen/ },
  { category: 'cafe', pattern: /starbucks|blue\s*bottle|cafe|coffee|espresso/ },
  { category: 'groceries', pattern: /supermarket|grocery|groceries|whole\s*foods|trader\s*joe|costco|aldi|kroger/ },
  { category: 'transport', pattern: /\buber\b|\blyft\b|taxi|transit|metro|subway\s*fare|parking|fuel|gas\s*station|toll/ },
  { category: 'shopping', pattern: /amazon|ebay|etsy|shopify|walmart|target|ikea|uniqlo/ },
  { category: 'subscription', pattern: /netflix|spotify|youtube|disney\+|hulu|apple\s*music|icloud|google\s*one|adobe|notion|figma|slack/ },
  { category: 'health', pattern: /pharmacy|clinic|hospital|dental|dentist|medical/ },
  { category: 'culture', pattern: /cinema|movie\s*theater|bookstore|museum|theater/ },
  { category: 'travel', pattern: /hotel|airbnb|airline|flight|booking\.com|expedia|agoda|delta|united\s*airlines/ },
  { category: 'living', pattern: /utility|electricity|water\s*bill|internet|mobile\s*bill|insurance/ },
  { category: 'education', pattern: /udemy|coursera|skillshare|academy|course|tuition/ },
  { category: 'transfer', pattern: /\btransfer\b|remittance|withdrawal/ },
];

/** AI and infra names sit first: "GitHub Copilot" is AI, plain GitHub is infra. */
export const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'ai',
    pattern: /openai|chatgpt|anthropic|claude|cursor|github\s*copilot|copilot|perplexity|midjourney|deepseek|gemini|eleven\s*labs|replicate|hugging\s*face|mistral|groq|together\s*ai|\bpoe\b/,
  },
  {
    category: 'infra',
    pattern: /\baws\b|amazon\s*web\s*services|google\s*cloud|\bgcp\b|vercel|cloudflare|netlify|railway|render\.com|fly\.io|digital\s*ocean|heroku|supabase|firebase|github|gitlab|sentry|datadog|linode|hetzner|\bovh\b|namecheap|godaddy|가비아|카페24|네이버\s*클라우드|ncloud|tailscale/,
  },
  ...KO_RULES,
  ...EN_RULES,
];

/** Category from merchant words alone; undefined when no rule knows the merchant. */
export function ruleCategory(merchant: string): SpendCategory | undefined {
  const text = merchant.toLowerCase();
  return CATEGORY_RULES.find((rule) => rule.pattern.test(text))?.category;
}
